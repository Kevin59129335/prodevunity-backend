const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_fallback_key');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(cookieParser());
app.use(cors({
    origin: process.env.FRONTEND_URL || 'https://prodevunity.netlify.app',
    credentials: true
}));

const dbConfig = process.env.DATABASE_URL
    ? { uri: process.env.DATABASE_URL }
    : {
        host: process.env.MYSQL_HOST || 'altaria.proxy.rlwy.net',
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || 'IGLzxPzWHWEriHnJfSEmeICxmZlBgXaH',
        database: process.env.MYSQL_DATABASE || 'railway',
        port: process.env.MYSQL_PORT || 50825
    };

const db = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-prodevunity-2026';

// ==========================================
// AUTHENTICATION & ADMIN MIDDLEWARES
// ==========================================
async function authenticateToken(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

function requireAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Access denied: Admin privileges required.' });
    }
}

// ==========================================
// 1. AUTHENTICATION (/api/auth)
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    const { username, password, role } = req.body;
    try {
        if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
        const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) return res.status(400).json({ error: 'Username already registered.' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const userRole = role === 'client' ? 'client' : 'dev';
        const customId = (userRole === 'client' ? 'client_' : 'dev_') + Math.random().toString(36).substring(2, 9);
        const nowMs = Date.now();
        await db.query(
            'INSERT INTO users (username, password, role, user_custom_id, bio, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [username, hashedPassword, userRole, customId, 'Developer on ProDevUnity', nowMs]
        );
        res.status(201).json({ ok: true, message: 'Registration complete.' });
    } catch (err) {
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
        const user = rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(401).json({ error: 'Invalid credentials.' });
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, customId: user.user_custom_id },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.cookie('token', token, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });
        res.json({
            ok: true,
            user: { id: user.id, username: user.username, role: user.role, customId: user.user_custom_id, bio: user.bio || '' }
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

app.get('/api/auth/me', async (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'No active session.' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const [rows] = await db.query('SELECT id, username, role, user_custom_id, bio FROM users WHERE id = ?', [decoded.id]);
        if (rows.length === 0) return res.status(401).json({ error: 'User not found.' });
        res.json({ ok: true, user: rows[0] });
    } catch (err) {
        res.status(401).json({ error: 'Invalid session.' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token', { httpOnly: true, secure: true, sameSite: 'none' });
    res.json({ ok: true });
});

// ==========================================
// 2. FEED & POSTS (/api/posts)
// ==========================================
app.get('/api/posts', async (req, res) => {
    try {
        const [posts] = await db.query(
            'SELECT p.*, u.username as author FROM posts p LEFT JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC'
        );
        res.json(posts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/posts', authenticateToken, async (req, res) => {
    const { title, description, code } = req.body;
    try {
        const nowMs = Date.now();
        await db.query(
            'INSERT INTO posts (user_id, title, description, code, created_at) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, title, description, code || '', nowMs]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 3. CHANNELS & CHAT (/api/chat)
// ==========================================
app.get('/api/chat/channels', async (req, res) => {
    const search = req.query.search || '';
    try {
        const [channels] = await db.query('SELECT name, is_private FROM channels WHERE name LIKE ?', [`%${search}%`]);
        const [users] = await db.query('SELECT username FROM users WHERE username LIKE ? LIMIT 10', [`%${search}%`]);
        res.json({ channels, users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat/channels', authenticateToken, async (req, res) => {
    const { name, isPrivate, passcode } = req.body;
    try {
        const [existing] = await db.query('SELECT id FROM channels WHERE name = ?', [name]);
        if (existing.length > 0) return res.status(400).json({ error: 'Channel already exists.' });
        await db.query('INSERT INTO channels (name, is_private, passcode) VALUES (?, ?, ?)', [name.toLowerCase().trim(), isPrivate ? 1 : 0, passcode || null]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat/verify-passcode', async (req, res) => {
    const { channel, passcode } = req.body;
    try {
        const [rows] = await db.query('SELECT passcode, is_private FROM channels WHERE name = ?', [channel]);
        if (rows.length === 0 || !rows[0].is_private) return res.json({ ok: true });
        
        if (rows[0].passcode === passcode) {
            res.json({ ok: true });
        } else {
            res.status(403).json({ error: 'Incorrect passcode.' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/chat/:channel', async (req, res) => {
    try {
        const [messages] = await db.query(
            'SELECT m.*, u.username as sender FROM chat_messages m LEFT JOIN users u ON m.user_id = u.id WHERE m.channel = ? ORDER BY m.created_at ASC',
            [req.params.channel]
        );
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat', authenticateToken, async (req, res) => {
    const { channel, text } = req.body;
    try {
        const nowMs = Date.now();
        await db.query('INSERT INTO chat_messages (user_id, channel, text, created_at) VALUES (?, ?, ?, ?)', [req.user.id, channel || 'general', text, nowMs]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 4. DEVELOPER DIRECTORY (/api/accounts)
// ==========================================
app.get('/api/accounts', async (req, res) => {
    try {
        const [users] = await db.query('SELECT id, username, role, bio, created_at FROM users ORDER BY id DESC');
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 5. ADMIN ACTIONS (/api/admin)
// ==========================================
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [[{ usersCount }]] = await db.query('SELECT COUNT(*) as usersCount FROM users');
        const [[{ postsCount }]] = await db.query('SELECT COUNT(*) as postsCount FROM posts');
        const [[{ messagesCount }]] = await db.query('SELECT COUNT(*) as messagesCount FROM chat_messages');
        res.json({ usersCount, postsCount, messagesCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.json({ ok: true, message: 'User deleted.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/posts/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM posts WHERE id = ?', [req.params.id]);
        res.json({ ok: true, message: 'Post deleted.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 6. STRIPE PAYMENTS (/api/payments)
// ==========================================
app.post('/api/payments/connect-developer', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT stripe_account_id FROM users WHERE id = ?', [req.user.id]);
        let accountId = rows.length > 0 ? rows[0].stripe_account_id : null;
        
        if (!accountId) {
            let account;
            try {
                // Primary creation method (Express Account)
                account = await stripe.accounts.create({
                    type: 'express',
                    capabilities: {
                        card_payments: { requested: true },
                        transfers: { requested: true },
                    },
                });
            } catch (v1Err) {
                // Fallback for new Stripe Connect accounts (Controller syntax)
                account = await stripe.accounts.create({
                    controller: {
                        stripe_dashboard: { type: 'express' },
                        fees: { payer: 'application' },
                        losses: { payments: 'application' }
                    }
                });
            }
            accountId = account.id;
            await db.query('UPDATE users SET stripe_account_id = ? WHERE id = ?', [accountId, req.user.id]);
        }
        
        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: `${process.env.FRONTEND_URL || 'https://prodevunity.netlify.app'}/jobs.html`,
            return_url: `${process.env.FRONTEND_URL || 'https://prodevunity.netlify.app'}/jobs.html?stripe=success`,
            type: 'account_onboarding',
        });
        
        res.json({ url: accountLink.url });
    } catch (err) {
        res.status(500).json({ error: 'Stripe Connect Error: ' + err.message });
    }
});

app.post('/api/payments/create-checkout-session', authenticateToken, async (req, res) => {
    const { amountEuro, devId, jobTitle } = req.body;
    try {
        const [rows] = await db.query('SELECT stripe_account_id FROM users WHERE id = ?', [devId]);
        if (rows.length === 0 || !rows[0].stripe_account_id) {
            return res.status(400).json({ error: "The developer has not connected a Stripe account yet." });
        }
        
        const devStripeAccountId = rows[0].stripe_account_id;
        const totalAmountCents = Math.round(amountEuro * 100);
        const platformFeeCents = Math.round(totalAmountCents * 0.15); // 15% Platform fee
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: { name: `Job Assignment: ${jobTitle}` },
                    unit_amount: totalAmountCents,
                },
                quantity: 1,
            }],
            mode: 'payment',
            payment_intent_data: {
                application_fee_amount: platformFeeCents,
                transfer_data: { destination: devStripeAccountId },
            },
            success_url: `${process.env.FRONTEND_URL || 'https://prodevunity.netlify.app'}/jobs.html?payment=success`,
            cancel_url: `${process.env.FRONTEND_URL || 'https://prodevunity.netlify.app'}/jobs.html?payment=cancelled`,
        });
        
        res.json({ url: session.url });
    } catch (err) {
        res.status(500).json({ error: 'Stripe Checkout Error: ' + err.message });
    }
});

// ==========================================
// 7. JOBS BOARD & APPLICATIONS (/api/jobs)
// ==========================================
app.get('/api/jobs', authenticateToken, async (req, res) => {
    try {
        if (req.user.role === 'client') {
            const [jobs] = await db.query(`
                SELECT j.*,
                       (SELECT COUNT(*) FROM job_applications a WHERE a.job_id = j.id) as app_count
                FROM jobs j
                WHERE j.client_username = ?
                ORDER BY j.created_at DESC
            `, [req.user.username]);
            res.json({ ok: true, jobs });
        } else {
            const [jobs] = await db.query(`
                SELECT j.*,
                       (SELECT status FROM job_applications WHERE job_id = j.id AND dev_username = ? LIMIT 1) as my_application_status
                FROM jobs j
                WHERE j.status = 'open'
                ORDER BY j.created_at DESC
            `, [req.user.username]);
            res.json({ ok: true, jobs });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/jobs', authenticateToken, async (req, res) => {
    if (req.user.role !== 'client') return res.status(403).json({ error: 'Only clients can post jobs.' });
    const { title, budget, category, description } = req.body;
    try {
        await db.query(
            'INSERT INTO jobs (client_username, title, budget, category, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.username, title, budget, category || 'General', description, Date.now()]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/jobs/:id/apply', authenticateToken, async (req, res) => {
    if (req.user.role !== 'dev') return res.status(403).json({ error: 'Only developers can apply for jobs.' });
    const { proposal_text } = req.body;
    try {
        const [existing] = await db.query('SELECT id FROM job_applications WHERE job_id = ? AND dev_username = ?', [req.params.id, req.user.username]);
        if (existing.length > 0) return res.status(400).json({ error: 'You have already applied to this job.' });
        
        await db.query(
            'INSERT INTO job_applications (job_id, dev_username, proposal_text, created_at) VALUES (?, ?, ?, ?)',
            [req.params.id, req.user.username, proposal_text, Date.now()]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/jobs/:id/applications', authenticateToken, async (req, res) => {
    if (req.user.role !== 'client') return res.status(403).json({ error: 'Only clients can view applications.' });
    try {
        const [jobs] = await db.query('SELECT id FROM jobs WHERE id = ? AND client_username = ?', [req.params.id, req.user.username]);
        if (jobs.length === 0) return res.status(403).json({ error: 'Not your job or job not found.' });

        const [apps] = await db.query('SELECT * FROM job_applications WHERE job_id = ? ORDER BY created_at ASC', [req.params.id]);
        res.json({ ok: true, apps });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/applications/:id/status', authenticateToken, async (req, res) => {
    if (req.user.role !== 'client') return res.status(403).json({ error: 'Only clients can change status.' });
    const { status } = req.body;
    const appId = req.params.id;
    try {
        const [apps] = await db.query('SELECT job_id FROM job_applications WHERE id = ?', [appId]);
        if (apps.length === 0) return res.status(404).json({ error: 'Application not found.' });
        const jobId = apps[0].job_id;

        const [jobs] = await db.query('SELECT id FROM jobs WHERE id = ? AND client_username = ?', [jobId, req.user.username]);
        if (jobs.length === 0) return res.status(403).json({ error: 'Not your job.' });

        await db.query('UPDATE job_applications SET status = ? WHERE id = ?', [status, appId]);
        
        if (status === 'accepted') {
            await db.query("UPDATE jobs SET status = 'closed' WHERE id = ?", [jobId]);
            await db.query("UPDATE job_applications SET status = 'rejected' WHERE job_id = ? AND id != ?", [jobId, appId]);
        }

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
