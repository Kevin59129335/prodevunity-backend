require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const rateLimit = require('express-rate-limit');
const path = require('path');
const cookieParser = require('cookie-parser');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const JWT_SECRET = process.env.JWT_SECRET || 'prodevunity-super-secret-jwt-key';

// Configurazione Mailer SMTP
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mailtrap.io',
    port: Number(process.env.SMTP_PORT) || 2525,
    auth: {
        user: process.env.SMTP_USER || 'mock_user',
        pass: process.env.SMTP_PASS || 'mock_pass'
    }
});

// Configurazione Database Pool MySQL
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

app.use(cors({
    origin: process.env.FRONTEND_URL || true,
    credentials: true
}));

app.use(cookieParser());

// Webhook Stripe Raw Body Handler
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

app.use(express.json({ limit: '2mb' }));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

/* AUTHENTICATION MIDDLEWARE CON DUPLEX (HEADER O COOKIES) */
function authenticateToken(req, res, next) {
    let token = req.cookies.auth_token;
    if (!token) {
        const authHeader = req.headers['authorization'];
        token = authHeader && authHeader.split(' ')[1];
    }

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

/* ================= 1. AUTH, VERIFICA EMAIL & RECOVERY ================= */

// Controllo stato sessione utente via Cookie
app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const [users] = await db.execute('SELECT id, username, email, role FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ ok: true, user: users[0] });
    } catch (err) {
        res.status(500).json({ error: 'Session check failed' });
    }
});

// Registrazione Utente con Invio Email
app.post('/api/register', async (req, res) => {
    try {
        let { username, email, password, role } = req.body;
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, Email and Password are required.' });
        }
        
        username = username.trim();
        email = email.trim().toLowerCase();

        const rolePrefix = role === 'client' ? 'client_' : 'dev_';
        if (!username.startsWith('dev_') && !username.startsWith('client_')) {
            username = rolePrefix + username;
        }

        const [existing] = await db.execute('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
        if (existing.length > 0) return res.status(400).json({ error: 'Username or Email already registered.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const customId = 'ID-' + Math.floor(1000 + Math.random() * 9000);
        const createdAt = Date.now();

        await db.execute(
            'INSERT INTO users (username, email, password, role, user_custom_id, is_email_verified, email_verification_token, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
            [username, email, hashedPassword, role || 'dev', customId, verificationToken, createdAt]
        );

        const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/api/verify-email?token=${verificationToken}`;
        try {
            await transporter.sendMail({
                from: '"ProDevUnity Security" <noreply@prodevunity.com>',
                to: email,
                subject: 'Verify your ProDevUnity Account',
                html: `
                    <div style="font-family: sans-serif; padding: 20px; background: #0f1115; color: #fff;">
                        <h2>Welcome to ProDevUnity, @${username}!</h2>
                        <p>Click the link below to verify your account:</p>
                        <a href="${verifyUrl}" style="background: #3b82f6; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 5px; inline-block;">Verify Email</a>
                    </div>
                `
            });
        } catch (mailErr) {
            console.log("Email sending skipped/failed.");
        }

        res.json({ ok: true, message: 'Registration successful! Check your email to verify your account.' });
    } catch (err) {
        res.status(500).json({ error: 'Registration failed.' });
    }
});

// Endpoint di Verifica Email
app.get('/api/verify-email', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('Verification token is missing.');

    try {
        const [users] = await db.execute('SELECT id, username, role FROM users WHERE email_verification_token = ?', [token]);
        if (users.length === 0) return res.status(400).send('Invalid or expired verification token.');

        const user = users[0];
        await db.execute('UPDATE users SET is_email_verified = 1, email_verification_token = NULL WHERE id = ?', [user.id]);

        const jwtToken = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
        res.cookie('auth_token', jwtToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60 * 1000
        });

        res.redirect('/feed.html?verified=true');
    } catch (err) {
        res.status(500).send('Verification error.');
    }
});

// Login con Cookie HTTP-Only
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Credentials required' });

        const queryVal = username.trim();
        const [users] = await db.execute('SELECT * FROM users WHERE username = ? OR email = ?', [queryVal, queryVal]);
        if (users.length === 0) return res.status(400).json({ error: 'Invalid credentials' });

        const user = users[0];
        if (user.password && !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        if (!user.is_email_verified) {
            return res.status(403).json({ error: 'Account not verified. Please check your email inbox.' });
        }

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });

        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60 * 1000
        });

        res.json({ ok: true, id: user.id, username: user.username, role: user.role, token });
    } catch (err) {
        res.status(500).json({ error: 'Login failed' });
    }
});

// Logout
app.post('/api/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.json({ ok: true });
});

// Password Dimenticata
app.post('/api/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required.' });

        const [users] = await db.execute('SELECT id, username FROM users WHERE email = ?', [email.trim().toLowerCase()]);
        if (users.length === 0) return res.status(404).json({ error: 'No account found with this email.' });

        const resetToken = crypto.randomBytes(32).toString('hex');
        await db.execute('UPDATE users SET email_verification_token = ? WHERE id = ?', [resetToken, users[0].id]);

        const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password.html?token=${resetToken}`;
        
        try {
            await transporter.sendMail({
                from: '"ProDevUnity Security" <noreply@prodevunity.com>',
                to: email,
                subject: 'Password Reset Request',
                html: `<p>Click here to reset your password: <a href="${resetUrl}">${resetUrl}</a></p>`
            });
        } catch (mErr) {}

        res.json({ ok: true, message: 'Password reset link sent to your email.' });
    } catch (err) {
        res.status(500).json({ error: 'Error processing request.' });
    }
});

// Reset Password
app.post('/api/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required.' });

        const [users] = await db.execute('SELECT id FROM users WHERE email_verification_token = ?', [token]);
        if (users.length === 0) return res.status(400).json({ error: 'Invalid or expired token.' });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.execute('UPDATE users SET password = ?, email_verification_token = NULL WHERE id = ?', [hashedPassword, users[0].id]);

        res.json({ ok: true, message: 'Password updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Error resetting password.' });
    }
});

/* OAuth Mock Routes */
app.get('/api/auth/github', (req, res) => { res.redirect('/feed.html?social_auth=success'); });
app.get('/api/auth/google', (req, res) => { res.redirect('/feed.html?social_auth=success'); });

/* ================= 2. ACCOUNTS & PROFILES ================= */
app.get('/api/accounts', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT u.id, u.username, u.role, u.bio, u.boosted_until,
                   COALESCE(AVG(r.rating), 0) as avgRating,
                   COUNT(r.id) as reviewCount
            FROM users u
            LEFT JOIN reviews r ON u.username = r.reviewed_username
            GROUP BY u.id
        `);

        const map = {};
        rows.forEach(u => {
            map[u.username] = {
                id: u.id,
                role: u.role,
                profile: { bio: u.bio },
                boostedUntil: u.boosted_until,
                rating: parseFloat(u.avgRating).toFixed(1),
                reviewCount: u.reviewCount
            };
        });
        res.json(map);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching accounts' });
    }
});

/* ================= 3. COMMUNITY FEED & POSTS ================= */
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
        if (!title || !description) return res.status(400).json({ error: 'Title and description required' });

        const author = req.user.username;
        const createdAt = Date.now();
        const [result] = await db.execute(
            'INSERT INTO posts (author, title, language, description, code, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [author, title.trim(), language || 'General', description.trim(), code || '', createdAt]
        );
        res.json({ ok: true, id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: 'Error saving post' });
    }
});

/* ================= 4. JOBS & APPLICATIONS ================= */
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
        if (!title || !budget || !description) return res.status(400).json({ error: 'Missing job fields' });

        const client_username = req.user.username;
        const createdAt = Date.now();
        const [result] = await db.execute(
            'INSERT INTO jobs (client_username, title, budget, category, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [client_username, title.trim(), budget.trim(), category || 'General', description.trim(), createdAt]
        );
        res.json({ ok: true, id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: 'Error creating job offer' });
    }
});

app.post('/api/applications', authenticateToken, async (req, res) => {
    try {
        const { job_id, proposal_text } = req.body;
        if (!job_id || !proposal_text) return res.status(400).json({ error: 'Proposal required' });

        const dev_username = req.user.username;
        const [existing] = await db.execute('SELECT id FROM job_applications WHERE job_id = ? AND dev_username = ?', [job_id, dev_username]);
        if (existing.length > 0) return res.status(400).json({ error: 'Application already sent for this job' });

        const createdAt = Date.now();
        await db.execute(
            'INSERT INTO job_applications (job_id, dev_username, proposal_text, status, created_at) VALUES (?, ?, ?, "pending", ?)',
            [job_id, dev_username, proposal_text.trim(), createdAt]
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

/* ================= 5. CHAT MESSAGES ================= */
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
        if (!channel || !text) return res.status(400).json({ error: 'Message cannot be empty' });

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

/* ================= 6. REVIEWS & VERIFIED FEEDBACK ================= */
app.post('/api/reviews', authenticateToken, async (req, res) => {
    try {
        const { job_id, reviewed_username, rating, comment } = req.body;
        const reviewer_username = req.user.username;

        const parsedRating = parseInt(rating, 10);
        if (isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5 || !comment || !comment.trim()) {
            return res.status(400).json({ error: 'Rating (1-5) and comment are required.' });
        }

        const [jobs] = await db.execute('SELECT * FROM jobs WHERE id = ?', [job_id]);
        if (jobs.length === 0) return res.status(404).json({ error: 'Job not found.' });
        const job = jobs[0];

        const [apps] = await db.execute(
            'SELECT * FROM job_applications WHERE job_id = ? AND status = "accepted"',
            [job_id]
        );

        if (apps.length === 0) {
            return res.status(403).json({ error: 'Verified reviews are allowed only for accepted/completed contracts.' });
        }

        const acceptedApp = apps[0];
        const isClient = (job.client_username === reviewer_username && acceptedApp.dev_username === reviewed_username);
        const isDev = (acceptedApp.dev_username === reviewer_username && job.client_username === reviewed_username);

        if (!isClient && !isDev) {
            return res.status(403).json({ error: 'You are not authorized to review this project.' });
        }

        const createdAt = Date.now();
        await db.execute(
            'INSERT INTO reviews (job_id, reviewer_username, reviewed_username, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [job_id, reviewer_username, reviewed_username, parsedRating, comment.trim(), createdAt]
        );

        res.json({ ok: true });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Review already submitted for this contract.' });
        }
        res.status(500).json({ error: 'Error submitting review.' });
    }
});

app.get('/api/users/:username/reviews', async (req, res) => {
    try {
        const { username } = req.params;
        const [reviews] = await db.execute('SELECT * FROM reviews WHERE reviewed_username = ? ORDER BY created_at DESC', [username]);
        const [stats] = await db.execute('SELECT AVG(rating) as avgRating, COUNT(*) as total FROM reviews WHERE reviewed_username = ?', [username]);

        res.json({
            averageRating: stats[0].avgRating ? parseFloat(stats[0].avgRating).toFixed(1) : "0.0",
            totalReviews: stats[0].total || 0,
            reviews
        });
    } catch (err) {
        res.status(500).json({ error: 'Error loading reviews.' });
    }
});

/* ================= 7. STRIPE PAYMENTS ================= */
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

/* ================= 8. ADMIN GOVERNANCE ================= */
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
    console.log(`ProDevUnity Backend listening on port ${PORT}`);
});