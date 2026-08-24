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

app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* Rate Limiter */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

/* MongoDB Atlas Connection */
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

/* =========================== ENDPOINTS CANALI & CHAT =========================== */

// Ottieni tutti i canali (pubblici e privati)
app.get('/api/channels', async (req, res) => {
  try {
    if (!db) return res.json([
      { name: 'nodejs-backend', type: 'public' },
      { name: 'stripe-payments', type: 'public' }
    ]);
    const channels = await db.collection('channels').find().toArray();
    if (!channels.some(c => c.name === 'nodejs-backend')) {
      channels.unshift({ name: 'nodejs-backend', type: 'public' }, { name: 'stripe-payments', type: 'public' });
    }
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: 'Error fetching channels' });
  }
});

// Crea un nuovo canale
app.post('/api/channels', async (req, res) => {
  try {
    const { name, type, password, creator } = req.body;
    if (!name) return res.status(400).json({ error: 'Channel name required' });

    const cleanName = name.replace(/[^a-zA-Z0-9-_]/g, '').toLowerCase();
    const channelsCol = db.collection('channels');
    
    const existing = await channelsCol.findOne({ name: cleanName });
    if (existing) return res.status(400).json({ error: 'Channel already exists' });

    const newChannel = {
      name: cleanName,
      type: type === 'private' ? 'private' : 'public',
      password: type === 'private' ? (password || '') : '',
      creator: creator || 'anonymous',
      createdAt: Date.now()
    };

    await channelsCol.insertOne(newChannel);
    res.json({ ok: true, channel: newChannel });
  } catch (err) {
    res.status(500).json({ error: 'Error creating channel' });
  }
});

// Verifica la password di un canale privato
app.post('/api/channels/verify', async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!db) return res.json({ ok: true });

    const channel = await db.collection('channels').findOne({ name });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    if (channel.type === 'private' && channel.password !== password) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Verification error' });
  }
});

// Recupera i messaggi di un canale
app.get('/api/chat/:channel', async (req, res) => {
  try {
    if (!db) return res.json([]);
    const { channel } = req.params;
    const messages = await db.collection('chat_messages')
      .find({ channel })
      .sort({ createdAt: 1 })
      .limit(50)
      .toArray();
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Error fetching chat messages' });
  }
});

// Invia un nuovo messaggio nella chat
app.post('/api/chat', async (req, res) => {
  try {
    const { channel, sender, text } = req.body;
    if (!channel || !sender || !text) return res.status(400).json({ error: 'Missing fields' });

    const newMessage = { channel, sender, text, createdAt: Date.now() };
    const result = await db.collection('chat_messages').insertOne(newMessage);
    res.json({ ok: true, message: { ...newMessage, _id: result.insertedId } });
  } catch (err) {
    res.status(500).json({ error: 'Error sending message' });
  }
});

/* =========================== ALTRI ENDPOINTS =========================== */

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { username, boostType, amount } = req.body;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Credits / Boost (@${username || 'User'})` },
          unit_amount: amount ? Math.round(amount * 100) : 100,
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: { username, boostType: boostType || 'account' },
      success_url: `${process.env.FRONTEND_URL || 'https://prodevunity.netlify.app'}/?status=success`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://prodevunity.netlify.app'}/?status=cancel`,
    });
    res.json({ id: session.id, url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Stripe Checkout Error' });
  }
});

app.get('/api/groups', async (req, res) => {
  res.json([{ name: 'nodejs-backend' }, { name: 'stripe-payments' }]);
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
    const { author, title, language, description, code } = req.body;
    const newPost = { author, title, language: language || 'General', description, code: code || '', createdAt: Date.now() };
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
      map[u.username] = { id: u.userId, role: u.role, profile: u.profile, boostedUntil: u.boostedUntil || 0 };
    });
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: 'Error fetching accounts' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    const usersCol = db.collection('users');
    const existing = await usersCol.findOne({ username });
    if (existing) return res.status(400).json({ error: 'Username taken' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { username, password: hashedPassword, role, boostedUntil: 0, createdAt: Date.now() };
    await usersCol.insertOne(newUser);
    const token = jwt.sign({ username, role }, JWT_SECRET, { expiresIn: '30d' });

    res.json({ ok: true, username, role, token });
  } catch (err) {
    res.status(500).json({ error: 'Registration error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.collection('users').findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, username: user.username, role: user.role, token });
  } catch (err) {
    res.status(500).json({ error: 'Login error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
