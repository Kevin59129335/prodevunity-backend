require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const JWT_SECRET = process.env.JWT_SECRET || 'prodevunity-super-secret-jwt-key';

// Configurazione Pool MySQL con supporto alla porta dinamica (es. Railway 50825)
const db = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'prodevunity',
    port: Number(process.env.MYSQL_PORT) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

app.use(cors());

// Webhook Stripe Raw Body Handler (deve precedere express.json)
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const username = session.client_reference_id;
        const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
        const boostedUntil = Date.now() + oneWeekMs;

        if (username) {
            try {
                await db.execute('UPDATE users SET boosted_until = ? WHERE username = ?', [boostedUntil, username]);
            } catch (dbErr) {
                console.error('Webhook DB Update Error:', dbErr);
            }
        }
    }

    res.json({ received: true });
});

app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

/* AUTHENTICATION MIDDLEWARE */
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied: Token missing' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
}

function requireAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Admin privileges required' });
    }
}

/* ================= 1. AUTH & PROFILI ================= */

app.post('/api/register', async (req, res) => {
    try {
        let { username, password, role } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

        role = ['dev', 'client', 'admin'].includes(role) ? role : 'dev';
        const prefix = role === 'dev' ? 'dev_' : (role === 'client' ? 'client_' : 'admin_');
        if (!username.startsWith('dev_') && !username.startsWith('client_') && !username.startsWith('admin_')) {
            username = prefix + username;
        }

        const [existing] = await db.execute('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) return res.status(400).json({ error: 'Username already taken' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const customId = 'ID-' + Math.floor(1000 + Math.random() * 9000);
        const createdAt = Date.now();

        const [result] = await db.execute(
            'INSERT INTO users (username, password, role, user_custom_id, created_at) VALUES (?, ?, ?, ?, ?)',
            [username, hashedPassword, role, customId, createdAt]
        );

        const token = jwt.sign({ id: result.insertId, username, role }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ ok: true, id: result.insertId, username, role, token });
    } catch (err) {
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const [users] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);

        if (users.length === 0) return res.status(400).json({ error: 'Invalid credentials' });

        const user = users[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ ok: true, id: user.id, username: user.username, role: user.role, token });
    } catch (err) {
        res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/api/accounts', async (req, res) => {
    try {
        const [users] = await db.execute('SELECT id, username, role, bio, boosted_until FROM users');
        const map = {};
        users.forEach(u => {
            map[u.username] = {
                id: u.id,
                role: u.role,
                profile: { bio: u.bio },
                boostedUntil: u.boosted_until
            };
        });
        res.json(map);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching accounts' });
    }
});

/* ================= 2. COMMUNITY FEED & POSTS ================= */

app.get('/api/posts', async (req, res) => {
    try {
        const [posts] = await db.execute('SELECT * FROM posts ORDER BY created_at DESC LIMIT 50');
        res.json(posts);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching posts' });
    }
});

app.post('/api/posts', authenticateToken, async (req, res) => {
    try {
        const { title, language, description, code } = req.body;
        const author = req.user.username;
        const createdAt = Date.now();

        const [result] = await db.execute(
            'INSERT INTO posts (author, title, language, description, code, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [author, title, language || 'General', description, code || '', createdAt]
        );

        res.json({ ok: true, id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: 'Error saving post' });
    }
});

/* ================= 3. JOBS & APPLICATIONS ================= */

app.get('/api/jobs', async (req, res) => {
    try {
        const [jobs] = await db.execute('SELECT * FROM jobs WHERE status = "open" ORDER BY created_at DESC');
        res.json(jobs);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching jobs' });
    }
});

app.post('/api/jobs', authenticateToken, async (req, res) => {
    try {
        const { title, budget, category, description } = req.body;
        const client_username = req.user.username;
        const createdAt = Date.now();

        const [result] = await db.execute(
            'INSERT INTO jobs (client_username, title, budget, category, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [client_username, title, budget, category || 'General', description, createdAt]
        );

        res.json({ ok: true, id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: 'Error creating job offer' });
    }
});

app.post('/api/applications', authenticateToken, async (req, res) => {
    try {
        const { job_id, proposal_text } = req.body;
        const dev_username = req.user.username;

        const [existing] = await db.execute('SELECT id FROM job_applications WHERE job_id = ? AND dev_username = ?', [job_id, dev_username]);
        if (existing.length > 0) return res.status(400).json({ error: 'Application already sent for this job' });

        const createdAt = Date.now();
        await db.execute(
            'INSERT INTO job_applications (job_id, dev_username, proposal_text, status, created_at) VALUES (?, ?, ?, "pending", ?)',
            [job_id, dev_username, proposal_text, createdAt]
        );

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Error submitting application' });
    }
});

app.get('/api/applications/my', authenticateToken, async (req, res) => {
    try {
        const username = req.user.username;
        const isClient = req.user.role === 'client';

        const query = isClient ?
            `SELECT a.id, a.job_id, a.dev_username, a.proposal_text, a.status, a.created_at, j.title AS job_title, j.budget
             FROM job_applications a
             JOIN jobs j ON a.job_id = j.id
             WHERE j.client_username = ?
             ORDER BY a.created_at DESC` :
            `SELECT a.id, a.job_id, a.dev_username, a.proposal_text, a.status, a.created_at, j.title AS job_title, j.budget, j.client_username
             FROM job_applications a
             JOIN jobs j ON a.job_id = j.id
             WHERE a.dev_username = ?
             ORDER BY a.created_at DESC`;

        const [apps] = await db.execute(query, [username]);
        res.json(apps);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching applications' });
    }
});

app.patch('/api/applications/:id/status', authenticateToken, async (req, res) => {
    try {
        const { status } = req.body;
        if (!['accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

        await db.execute('UPDATE job_applications SET status = ? WHERE id = ?', [status, req.params.id]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Error updating application status' });
    }
});

/* ================= 4. CHAT & MESSAGES ================= */

app.get('/api/chat/:channel', async (req, res) => {
    try {
        const [messages] = await db.execute('SELECT * FROM chat_messages WHERE channel = ? ORDER BY created_at ASC LIMIT 100', [req.params.channel]);
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: 'Error loading chat messages' });
    }
});

app.post('/api/chat', authenticateToken, async (req, res) => {
    try {
        const { channel, text } = req.body;
        const sender = req.user.username;
        const createdAt = Date.now();

        await db.execute(
            'INSERT INTO chat_messages (channel, sender, text, created_at) VALUES (?, ?, ?, ?)',
            [channel, sender, text, createdAt]
        );

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Error sending message' });
    }
});

app.get('/api/channels', async (req, res) => {
    try {
        const [channels] = await db.execute('SELECT id, name, type, creator FROM channels ORDER BY name ASC');
        res.json(channels);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching channels' });
    }
});

/* ================= 5. STRIPE PAYMENTS ================= */

app.post('/api/stripe/checkout', authenticateToken, async (req, res) => {
    try {
        const { amount } = req.body;
        const unitAmount = Math.round((amount || 1.00) * 100);
        const frontendUrl = process.env.FRONTEND_URL || req.headers.origin || 'http://localhost:3000';

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            client_reference_id: req.user.username,
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: 'ProDevUnity Account Boost' },
                    unit_amount: unitAmount,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${frontendUrl}/directory.html?status=success`,
            cancel_url: `${frontendUrl}/directory.html?status=cancel`,
        });

        res.json({ id: session.id, url: session.url });
    } catch (err) {
        res.status(500).json({ error: 'Stripe Checkout generation failed' });
    }
});

/* ================= 6. ADMIN GOVERNANCE ================= */

app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [[users]] = await db.execute('SELECT COUNT(*) as count FROM users');
        const [[posts]] = await db.execute('SELECT COUNT(*) as count FROM posts');
        const [[messages]] = await db.execute('SELECT COUNT(*) as count FROM chat_messages');
        res.json({ totalUsers: users.count, totalPosts: posts.count, totalMessages: messages.count });
    } catch (err) {
        res.status(500).json({ error: 'Admin stats query failed' });
    }
});

/* 404 HANDLER */
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, '404.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 ProDevUnity Backend attivamente in ascolto sulla porta ${PORT}`);
});