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

/* Stripe Webhook */
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
      const boostUntil = Date.now() + (7 * 24 * 60 * 60 * 1000);
      await db.collection('users').updateOne(
        { username },
        { $set: { boostedUntil: boostUntil } }
      );
      console.log(`Boost activated for @${username}`);
    }
  }

  res.json({ received: true });
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* Rate Limiter */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

/* MongoDB Atlas Driver Connection */
const mongoUri = process.env.MONGODB_URI;
let db;

if (mongoUri) {
  const client = new MongoClient(mongoUri);
  client.connect()
    .then(() => {
      db = client.db('prodevunity');
      app.locals.db = db;
      console.log('✅ Connected successfully to MongoDB Atlas');
    })
    .catch(err => console.error('❌ MongoDB Connection Error:', err));
} else {
  console.warn('⚠️ MONGODB_URI not provided.');
}

/* Middleware JWT */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token missing' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

/* =========================== ENDPOINTS =========================== */

/* Endpoint per creare la sessione di pagamento Stripe */
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { username, boostType, amount } = req.body;
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: `Boost Profilo (${username || 'User'})`,
            },
            unit_amount: amount ? amount * 100 : 500, // 5.00 EUR di default
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      metadata: { username, boostType },
      success_url: `https://prodevunity.netlify.app/?status=success`,
      cancel_url: `https://prodevunity.netlify.app/?status=cancel`,
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe Checkout Error:', err);
    res.status(500).json({ error: 'Errore nella creazione del pagamento' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    let { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing data' });

    role = role === 'client' ? 'client' : 'dev';
    const prefix = role === 'dev' ? 'dev_' : 'client_';
    
    if (!username.startsWith('dev_') && !username.startsWith('client_')) {
      username = prefix + username;
    }

    const usersCol = db.collection('users');
    const existing = await usersCol.findOne({ username });
    if (existing) return res.status(400).json({ error: 'Username taken' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = 'ID-' + Math.floor(1000 + Math.random() * 9000);

    const newUser = {
      username,
      password: hashedPassword,
      role,
      userId,
      profile: { bio: role === 'dev' ? 'Developer on ProDevUnity' : 'Hiring Client' },
      boostedUntil: 0,
      createdAt: Date.now()
    };

    await usersCol.insertOne(newUser);
    const token = jwt.sign({ username, role, userId }, JWT_SECRET, { expiresIn: '30d' });

    res.json({ ok: true, username, role, userId, token });
  } catch (err) {
    res.status(500).json({ error: 'Registration error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const usersCol = db.collection('users');
    const user = await usersCol.findOne({ username });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ username: user.username, role: user.role, userId: user.userId }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, username: user.username, role: user.role, userId: user.userId, token });
  } catch (err) {
    res.status(500).json({ error: 'Login error' });
  }
});

app.get('/api/posts', async (req, res) => {
  try {
    if (!db) return res.json([]);
    const posts = await db.collection('posts').find().sort({ createdAt: -1 }).toArray();
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: 'Error fetching posts' });
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
    res.status(500).json({ error: 'Error creating post' });
  }
});

app.get('/api/accounts', async (req, res) => {
  try {
    if (!db) return res.json({});
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
    res.status(500).json({ error: 'Error fetching accounts' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
