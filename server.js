require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const rateLimit = require('express-rate-limit');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const JWT_SECRET = process.env.JWT_SECRET || 'prodevunity-super-secret-jwt-key';

/* Stripe Webhook richiede il body raw prima di express.json() */
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { username, boostType } = session.metadata || {};

    if (boostType === 'account' && username) {
      const db = req.app.locals.db;
      const boostUntil = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 Giorni
      await db.collection('users').updateOne(
        { username },
        { $set: { boostedUntil: boostUntil } }
      );
      console.log(`Boost attivato con successo per @${username}`);
    }
  }

  res.json({ received: true });
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* Rate Limiting per prevenire attacchi */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Troppe richieste da questo IP, riprova più tardi.' }
});
app.use('/api/', limiter);

/* Connessione MongoDB Atlas */
const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/prodevunity');
let db;

client.connect()
  .then(() => {
    db = client.db('prodevunity');
    app.locals.db = db;
    console.log('✅ Connesso a MongoDB Atlas');
  })
  .catch(err => console.error('❌ Errore connessione MongoDB:', err));

/* Middleware Autenticazione JWT */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token mancante' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token non valido' });
    req.user = user;
    next();
  });
}

/* =========================== AUTHENTICATION =========================== */

app.post('/api/register', async (req, res) => {
  try {
    let { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Dati mancanti' });

    role = role === 'client' ? 'client' : 'dev';
    const prefix = role === 'dev' ? 'dev_' : 'client_';
    
    if (!username.startsWith('dev_') && !username.startsWith('client_')) {
      username = prefix + username;
    }

    const usersCol = db.collection('users');
    const existing = await usersCol.findOne({ username });
    if (existing) return res.status(400).json({ error: 'Username già in uso' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = 'ID-' + Math.floor(1000 + Math.random() * 9000);

    const newUser = {
      username,
      password: hashedPassword,
      role,
      userId,
      profile: { bio: role === 'dev' ? 'Developer su ProDevUnity' : 'Committente Progetti', languages: [] },
      boostedUntil: 0,
      createdAt: Date.now()
    };

    await usersCol.insertOne(newUser);
    const token = jwt.sign({ username, role, userId }, JWT_SECRET, { expiresIn: '30d' });

    res.json({ ok: true, username, role, userId, token });
  } catch (err) {
    res.status(500).json({ error: 'Errore durante la registrazione' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const usersCol = db.collection('users');
    const user = await usersCol.findOne({ username });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: 'Credenziali errate' });
    }

    const token = jwt.sign({ username: user.username, role: user.role, userId: user.userId }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, username: user.username, role: user.role, userId: user.userId, token });
  } catch (err) {
    res.status(500).json({ error: 'Errore durante il login' });
  }
});

/* =========================== POSTS / PROBLEMATICHE =========================== */

app.get('/api/posts', async (req, res) => {
  try {
    const posts = await db.collection('posts').find().sort({ createdAt: -1 }).toArray();
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: 'Errore caricamento post' });
  }
});

app.post('/api/posts', async (req, res) => {
  try {
    const { author, title, type, language, description, code } = req.body;
    const newPost = {
      author,
      title,
      type: type || 'problema',
      language: language || 'General',
      description,
      code: code || '',
      comments: [],
      createdAt: Date.now()
    };

    const result = await db.collection('posts').insertOne(newPost);
    res.json({ ok: true, post: { ...newPost, _id: result.insertedId } });
  } catch (err) {
    res.status(500).json({ error: 'Errore salvataggio post' });
  }
});

app.post('/api/posts/:id/comments', async (req, res) => {
  try {
    const { author, text } = req.body;
    const postId = req.params.id;

    const comment = { author, text, createdAt: Date.now() };
    await db.collection('posts').updateOne(
      { _id: new ObjectId(postId) },
      { $push: { comments: comment } }
    );

    res.json({ ok: true, comment });
  } catch (err) {
    res.status(500).json({ error: 'Errore invio commento' });
  }
});

/* =========================== JOBS & ESCROW (10% FEE) =========================== */

app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await db.collection('jobs').find().sort({ createdAt: -1 }).toArray();
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: 'Errore recupero lavori' });
  }
});

app.post('/api/jobs', authenticateToken, async (req, res) => {
  try {
    const { title, budget, description } = req.body;
    const newJob = {
      title,
      client: req.user.username,
      budget: parseFloat(budget),
      description,
      status: 'open', // open, in_progress, completed, cancelled
      applicants: [],
      assignedDev: null,
      previewDelivered: false,
      previewCode: '',
      createdAt: Date.now()
    };

    const result = await db.collection('jobs').insertOne(newJob);
    res.json({ ok: true, job: { ...newJob, _id: result.insertedId } });
  } catch (err) {
    res.status(500).json({ error: 'Errore creazione lavoro' });
  }
});

app.post('/api/jobs/:id/apply', authenticateToken, async (req, res) => {
  try {
    const jobId = req.params.id;
    await db.collection('jobs').updateOne(
      { _id: new ObjectId(jobId) },
      { $addToSet: { applicants: req.user.username } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Errore candidatura' });
  }
});

app.post('/api/jobs/:id/accept-applicant', authenticateToken, async (req, res) => {
  try {
    const { devUser } = req.body;
    const jobId = req.params.id;

    await db.collection('jobs').updateOne(
      { _id: new ObjectId(jobId), client: req.user.username },
      { $set: { assignedDev: devUser, status: 'in_progress' } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Errore accettazione candidato' });
  }
});

app.post('/api/jobs/:id/deliver-preview', authenticateToken, async (req, res) => {
  try {
    const { previewCode } = req.body;
    const jobId = req.params.id;

    await db.collection('jobs').updateOne(
      { _id: new ObjectId(jobId), assignedDev: req.user.username },
      { $set: { previewCode, previewDelivered: true } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Errore invio anteprima' });
  }
});

app.post('/api/jobs/:id/approve', authenticateToken, async (req, res) => {
  try {
    const jobId = req.params.id;
    const job = await db.collection('jobs').findOne({ _id: new ObjectId(jobId), client: req.user.username });

    if (!job) return res.status(404).json({ error: 'Lavoro non trovato' });

    const platformFee = job.budget * 0.10;
    const devPayout = job.budget * 0.90;

    await db.collection('jobs').updateOne(
      { _id: new ObjectId(jobId) },
      { $set: { status: 'completed' } }
    );

    res.json({ 
      ok: true, 
      devPayout, 
      platformFee,
      message: `Lavoro approvato. $${devPayout} rilasciati allo sviluppatore, $${platformFee} trattenuti dalla piattaforma.` 
    });
  } catch (err) {
    res.status(500).json({ error: 'Errore approvazione lavoro' });
  }
});

/* =========================== STRIPE BOOST CHECKOUT =========================== */

app.post('/api/checkout/boost', async (req, res) => {
  try {
    const { username } = req.body;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'ProDevUnity — Messa in Evidenza Profilo (7 Giorni)' },
          unit_amount: 100, // $1.00 / €1.00
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.headers.origin}?paid=boost`,
      cancel_url: `${req.headers.origin}?paid=cancel`,
      metadata: { username, boostType: 'account' }
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Errore durante la creazione del pagamento Stripe' });
  }
});

/* =========================== USERS & ACCOUNTS =========================== */

app.get('/api/accounts', async (req, res) => {
  try {
    const users = await db.collection('users').find().toArray();
    const map = {};
    users.forEach(u => {
      map[u.username] = {
        id: u.userId,
        role: u.role,
        profile: u.profile,
        boostedUntil: u.boostedUntil || 0
      };
    });
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: 'Errore recupero account' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server backend attivo sulla porta ${PORT}`);
});