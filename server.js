const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 10000;

// ==========================================
// MIDDLEWARE & CORS
// ==========================================
app.use(express.json());
app.use(cookieParser());

// Permette le chiamate sicure dal frontend su Netlify
app.use(cors({
    origin: process.env.FRONTEND_URL || 'https://prodevunity.netlify.app',
    credentials: true
}));

// ==========================================
// CONNESSIONE DATABASE MYSQL (RAILWAY)
// ==========================================
const db = mysql.createPool({
    host: process.env.MYSQL_HOST || 'altaria.proxy.rlwy.net',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || 'IGLzxPzWHWEriHnJfSEmeICxmZlBgXaH',
    database: process.env.MYSQL_DATABASE || 'prodevunity',
    port: process.env.MYSQL_PORT || 50825,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-prodevunity-2026';

// ==========================================
// ROTTE AUTENTICAZIONE (/api/auth)
// ==========================================

// 1. REGISTRAZIONE
app.post('/api/auth/register', async (req, res) => {
    const { username, email, password, role } = req.body;
    try {
        if (!username || !password) {
            return res.status(400).json({ error: 'Username e password sono obbligatori.' });
        }

        const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Username già in uso.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const userRole = role === 'client' ? 'client' : 'dev';

        await db.query(
            'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)',
            [username, email || '', hashedPassword, userRole]
        );

        res.status(201).json({ ok: true, message: 'Registrazione completata con successo.' });
    } catch (err) {
        console.error('Errore durante la registrazione:', err);
        res.status(500).json({ error: 'Errore interno del server.' });
    }
});

// 2. LOGIN
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Credenziali non valide.' });
        }

        const user = rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Credenziali non valide.' });
        }

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
        console.error('Errore durante il login:', err);
        res.status(500).json({ error: 'Errore interno del server.' });
    }
});

// 3. RECUPERO SESSIONE CORRENTE (/api/auth/me)
app.get('/api/auth/me', async (req, res) => {
    const token = req.cookies.token;
    if (!token) {
        return res.status(401).json({ error: 'Nessuna sessione attiva.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const [rows] = await db.query('SELECT id, username, role, bio FROM users WHERE id = ?', [decoded.id]);
        
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Utente non trovato.' });
        }

        res.json({ ok: true, user: rows[0] });
    } catch (err) {
        res.status(401).json({ error: 'Token non valido o scaduto.' });
    }
});

// 4. LOGOUT
app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token', {
        httpOnly: true,
        secure: true,
        sameSite: 'none'
    });
    res.json({ ok: true, message: 'Logout effettuato.' });
});

// ==========================================
// AVVIO SERVER
// ==========================================
app.listen(PORT, () => {
    console.log(`Server attivo sulla porta ${PORT}`);
});
