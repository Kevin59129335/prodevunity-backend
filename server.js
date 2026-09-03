const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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
        database: process.env.MYSQL_DATABASE || 'prodevunity',
        port: process.env.MYSQL_PORT || 50825
    };

const db = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-prodevunity-2026';

// Middleware Autenticazione
async function authenticateToken(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Non autorizzato' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token non valido' });
    }
}

// ==========================================
// AUTENTICAZIONE (/api/auth)
// ==========================================

app.post('/api/auth/register', async (req, res) => {
    const { username, email, password, role } = req.body;
    try {
        if (!username || !password) {
            return res.status(400).json({ error: 'Username e password obbligatori.' });
        }

        const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Username già registrato.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const userRole = role === 'client' ? 'client' : 'dev';

        await db.query(
            'INSERT INTO users (username, email, password, role, bio) VALUES (?, ?, ?, ?, ?)',
            [username, email || '', hashedPassword, userRole, 'Sviluppatore su ProDevUnity']
        );

        res.status(201).json({ ok: true, message: 'Registrazione completata.' });
    } catch (err) {
        console.error('ERRORE REGISTER:', err);
        res.status(500).json({ error: 'Errore DB: ' + err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        if (rows.length === 0) return res.status(401).json({ error: 'Credenziali non valide.' });

        const user = rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(401).json({ error: 'Credenziali non valide.' });

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
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
            user: { id: user.id, username: user.username, role: user.role, bio: user.bio || '' }
        });
    } catch (err) {
        console.error('ERRORE LOGIN:', err);
        res.status(500).json({ error: 'Errore DB: ' + err.message });
    }
});

app.get('/api/auth/me', async (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Nessuna sessione.' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const [rows] = await db.query('SELECT id, username, role, bio FROM users WHERE id = ?', [decoded.id]);
        if (rows.length === 0) return res.status(401).json({ error: 'Non trovato.' });

        res.json({ ok: true, user: rows[0] });
    } catch (err) {
        res.status(401).json({ error: 'Token non valido.' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token', { httpOnly: true, secure: true, sameSite: 'none' });
    res.json({ ok: true });
});

// ==========================================
// FEED & POSTS (/api/posts)
// ==========================================

app.get('/api/posts', async (req, res) => {
    try {
        const [posts] = await db.query('SELECT p.*, u.username as author FROM posts p LEFT JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC');
        res.json(posts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/posts', authenticateToken, async (req, res) => {
    const { title, description, code } = req.body;
    try {
        await db.query(
            'INSERT INTO posts (user_id, title, description, code) VALUES (?, ?, ?, ?)',
            [req.user.id, title, description, code || '']
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// CHAT (/api/chat)
// ==========================================

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
        await db.query(
            'INSERT INTO chat_messages (user_id, channel, text) VALUES (?, ?, ?)',
            [req.user.id, channel || 'general', text]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`Server avviato su porta ${PORT}`));
