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
// MIDDLEWARES AUTENTICAZIONE & ADMIN
// ==========================================

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

function requireAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Accesso negato: privilegi Admin richiesti.' });
    }
}

// ==========================================
// 1. AUTENTICAZIONE (/api/auth)
// ==========================================

app.post('/api/auth/register', async (req, res) => {
    const { username, password, role } = req.body;
    try {
        if (!username || !password) return res.status(400).json({ error: 'Username e password obbligatori.' });

        const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) return res.status(400).json({ error: 'Username già registrato.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const userRole = role === 'client' ? 'client' : 'dev';
        const customId = (userRole === 'client' ? 'client_' : 'dev_') + Math.random().toString(36).substring(2, 9);
        const nowMs = Date.now();

        await db.query(
            'INSERT INTO users (username, password, role, user_custom_id, bio, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [username, hashedPassword, userRole, customId, 'Sviluppatore su ProDevUnity', nowMs]
        );

        res.status(201).json({ ok: true, message: 'Registrazione completata.' });
    } catch (err) {
        console.error("Errore registrazione DB:", err);
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

        // Mantiene il ruolo reale salvato su DB (dev, client, o admin)
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
        res.status(500).json({ error: 'Errore DB: ' + err.message });
    }
});

app.get('/api/auth/me', async (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Nessuna sessione attiva.' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const [rows] = await db.query('SELECT id, username, role, user_custom_id, bio FROM users WHERE id = ?', [decoded.id]);
        if (rows.length === 0) return res.status(401).json({ error: 'Utente non trovato.' });

        res.json({ ok: true, user: rows[0] });
    } catch (err) {
        res.status(401).json({ error: 'Sessione non valida.' });
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
        res.status(500).json({ error: 'Errore nel recupero dei post: ' + err.message });
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
        res.status(500).json({ error: 'Impossibile pubblicare il post: ' + err.message });
    }
});

// ==========================================
// 3. CANALI & CHAT (/api/chat)
// ==========================================

app.get('/api/chat/channels', async (req, res) => {
    const search = req.query.search || '';
    try {
        const [channels] = await db.query(
            'SELECT name, is_private FROM channels WHERE name LIKE ?',
            [`%${search}%`]
        );
        const [users] = await db.query(
            'SELECT username FROM users WHERE username LIKE ? LIMIT 10',
            [`%${search}%`]
        );
        res.json({ channels, users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat/channels', authenticateToken, async (req, res) => {
    const { name, isPrivate, passcode } = req.body;
    try {
        const [existing] = await db.query('SELECT id FROM channels WHERE name = ?', [name]);
        if (existing.length > 0) return res.status(400).json({ error: 'Canale già esistente.' });

        await db.query(
            'INSERT INTO channels (name, is_private, passcode) VALUES (?, ?, ?)',
            [name.toLowerCase().trim(), isPrivate ? 1 : 0, passcode || null]
        );
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
            res.status(403).json({ error: 'Codice di accesso errato.' });
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
        await db.query(
            'INSERT INTO chat_messages (user_id, channel, text, created_at) VALUES (?, ?, ?, ?)',
            [req.user.id, channel || 'general', text, nowMs]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 4. DIRECTORY SVILUPPATORI (/api/accounts)
// ==========================================

app.get('/api/accounts', async (req, res) => {
    try {
        const [users] = await db.query(
            'SELECT id, username, role, bio, created_at FROM users ORDER BY id DESC'
        );
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: 'Errore nel recupero sviluppatori: ' + err.message });
    }
});

// ==========================================
// 5. AZIONI RISERVATE ALL'ADMIN (/api/admin)
// ==========================================

// Eliminazione di un utente
app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.json({ ok: true, message: 'Utente eliminato.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Eliminazione di un post
app.delete('/api/admin/posts/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM posts WHERE id = ?', [req.params.id]);
        res.json({ ok: true, message: 'Post eliminato.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));
