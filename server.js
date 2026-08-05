/**
 * ProDevUnity — backend completo (con MongoDB Atlas)
 * ---------------------------------------------------
 * Tutti i dati del sito — account, post, gruppi, notifiche, messaggi
 * privati — vivono ora su MongoDB Atlas (un database vero, gratuito,
 * che non si svuota mai da solo), non più in file JSON sul server.
 * Così il backend può anche "addormentarsi" sul piano gratuito di
 * Render senza perdere nulla: i dati stanno altrove.
 *
 * Serve una variabile d'ambiente MONGODB_URI con la stringa di
 * connessione del tuo cluster Atlas — vedi il README, sezione 0.
 *
 * Pagamenti reali con Stripe: stessa logica di sempre (in fondo al
 * file), solo che ora legge/scrive gli account su MongoDB.
 */

require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const Stripe = require("stripe");
const { MongoClient } = require("mongodb");

const PORT = process.env.PORT || 4242;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5500";
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 15);
const MONGODB_URI = process.env.MONGODB_URI;
const DAY = 24 * 60 * 60 * 1000;

if (!STRIPE_SECRET_KEY) {
  console.error("ERRORE: manca STRIPE_SECRET_KEY nel file .env — vedi .env.example");
  process.exit(1);
}
if (!MONGODB_URI) {
  console.error("ERRORE: manca MONGODB_URI nel file .env — vedi .env.example e il README, sezione 0.");
  process.exit(1);
}

const stripe = Stripe(STRIPE_SECRET_KEY);
const app = express();
app.use(cors({ origin: FRONTEND_URL === "*" ? true : FRONTEND_URL }));

/* =========================== limiti sulle richieste (anti-abuso) =========================== */
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: "Troppi tentativi. Riprova tra qualche minuto." } });
const verifyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: "Troppe richieste di codice. Riprova tra un'ora." } });
app.use("/api/", generalLimiter);

/* =========================== MongoDB =========================== */
let db;
async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db("prodevunity");
  console.log("Connesso a MongoDB Atlas.");
}
const col = (name) => db.collection(name);

const uid = () => Math.random().toString(36).slice(2, 10);
const dmKey = (a, b) => [a, b].sort().join("__");
const genInviteCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};

/* ---------- sessioni (token di accesso, al posto della "fiducia sulla parola") ---------- */
const SESSION_TTL = 30 * DAY;
async function createSession(username) {
  const token = crypto.randomBytes(32).toString("hex");
  await col("sessions").insertOne({ _id: token, username, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL });
  return token;
}
async function getSession(token) {
  const session = await col("sessions").findOne({ _id: token });
  if (!session || session.expiresAt < Date.now()) return null;
  return session;
}
async function deleteSession(token) { await col("sessions").deleteOne({ _id: token }); }

/* Ogni richiesta che tocca dati privati o fa un'azione deve passare da qui:
   legge il token da "Authorization: Bearer <token>" e verifica che sia valido.
   Da questo momento il server sa DAVVERO chi sta chiamando (req.user),
   non si fida più di un campo "author"/"username" scritto nel corpo. */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: "Accesso richiesto." });
    const session = await getSession(token);
    if (!session) return res.status(401).json({ ok: false, error: "Sessione scaduta, accedi di nuovo." });
    req.user = session.username;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Errore di autenticazione." });
  }
}

/* ---------- account ---------- */
async function getAccount(username) { return col("accounts").findOne({ _id: username }); }
async function saveAccount(username, doc) {
  const { _id, ...rest } = doc;
  await col("accounts").replaceOne({ _id: username }, { _id: username, ...rest }, { upsert: true });
}
async function getAllAccounts() { return col("accounts").find().toArray(); }
const publicAccount = (acc) => ({
  profile: acc.profile,
  respect: acc.respect,
  banUntil: acc.banUntil || 0,
  permaBanned: !!acc.permaBanned,
});

/* seed dell'account proprietario, se non esiste già */
async function seedOwnerAccount() {
  const existing = await getAccount("p0ss3ss0r3");
  if (!existing) {
    await saveAccount("p0ss3ss0r3", {
      password: await bcrypt.hash("possessore", 10),
      respect: 100, insultCount: 0, banUntil: 0, permaBanned: false,
      profile: { bio: "", languages: [], projects: [], problemsFaced: [], microcontrollers: [], boostedUntil: 0, createdAt: Date.now() },
      stripeAccountId: null, chargesEnabled: false,
    });
    console.log("Account proprietario (p0ss3ss0r3) creato.");
  }
}

/* ---------- post ---------- */
async function getPosts() { return col("posts").find().sort({ createdAt: -1 }).toArray(); }
async function getPost(id) { return col("posts").findOne({ id }); }
async function insertPost(post) { await col("posts").insertOne(post); }
async function savePost(post) { await col("posts").replaceOne({ id: post.id }, post); }

/* ---------- gruppi ---------- */
async function getGroups() { return col("groups").find().sort({ createdAt: -1 }).toArray(); }
async function getGroup(id) { return col("groups").findOne({ id }); }
async function insertGroup(group) { await col("groups").insertOne(group); }
async function saveGroup(group) { await col("groups").replaceOne({ id: group.id }, group); }

/* ---------- notifiche ---------- */
async function getNotifs(username) {
  const doc = await col("notifications").findOne({ _id: username });
  return doc ? doc.items : [];
}
async function saveNotifs(username, items) {
  await col("notifications").replaceOne({ _id: username }, { _id: username, items }, { upsert: true });
}
async function pushNotif(username, text, postId) {
  const arr = await getNotifs(username);
  arr.unshift({ id: uid(), text, postId: postId || null, read: false, createdAt: Date.now() });
  await saveNotifs(username, arr.slice(0, 200));
}

/* ---------- messaggi privati ---------- */
async function getDM(a, b) {
  const doc = await col("dms").findOne({ _id: dmKey(a, b) });
  return doc ? doc.messages : [];
}
async function saveDM(a, b, messages) {
  await col("dms").replaceOne({ _id: dmKey(a, b) }, { _id: dmKey(a, b), messages }, { upsert: true });
}
async function getDMListFor(username) {
  const safe = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const docs = await col("dms").find({ _id: { $regex: `(^|__)${safe}(__|$)` } }).toArray();
  const out = [];
  for (const doc of docs) {
    if (!doc.messages || doc.messages.length === 0) continue;
    const parts = doc._id.split("__");
    const other = parts.find((p) => p !== username) || parts[0];
    out.push({ other, last: doc.messages[doc.messages.length - 1] });
  }
  out.sort((a, b) => b.last.createdAt - a.last.createdAt);
  return out;
}

/* ---------- ledger (incassi piattaforma) ---------- */
async function appendLedger(entry) { await col("ledger").insertOne({ id: uid(), createdAt: Date.now(), ...entry }); }
async function getLedger() { return col("ledger").find().toArray(); }

/* ---------- codici di verifica email/SMS ---------- */
async function getVerifyCode(key) { return col("verify_codes").findOne({ _id: key }); }
async function saveVerifyCode(key, entry) { await col("verify_codes").replaceOne({ _id: key }, { _id: key, ...entry }, { upsert: true }); }
async function deleteVerifyCode(key) { await col("verify_codes").deleteOne({ _id: key }); }

/* =========================== moderazione (insulti / ban) =========================== */
const INSULT_WORDS = ["stupido", "stupida", "idiota", "cretino", "cretina", "scemo", "scema", "imbecille", "deficiente", "coglione", "stronzo", "stronza", "merda", "bastardo", "bastarda"];
const normalizeForModeration = (text) => (text || "")
  .toLowerCase()
  .replace(/[^a-zàèéìòù0-9\s]/g, "")
  .replace(/(.)\1{2,}/g, "$1$1");
const containsInsult = (text) => {
  const t = normalizeForModeration(text);
  return INSULT_WORDS.some((w) => t.includes(w));
};
async function applyModeration(username, text) {
  if (!containsInsult(text)) return { insult: false };
  const acc = await getAccount(username);
  if (!acc) return { insult: false };
  acc.insultCount = (acc.insultCount || 0) + 1;
  acc.respect = Math.max(0, 100 - acc.insultCount * 15);
  let banMsg = null;
  if (acc.insultCount === 5 && !acc.permaBanned) {
    acc.banUntil = Date.now() + 7 * DAY;
    banMsg = "Hai usato un linguaggio offensivo per la 5ª volta: il tuo account è sospeso per 7 giorni.";
  } else if (acc.insultCount >= 15) {
    acc.permaBanned = true; acc.banUntil = 0;
    banMsg = "Hai continuato a usare un linguaggio offensivo dopo la sospensione: il tuo account è bannato permanentemente.";
  }
  await saveAccount(username, acc);
  return { insult: true, banMsg, respect: acc.respect, banUntil: acc.banUntil, permaBanned: acc.permaBanned };
}

const jsonBody = express.json({ limit: "5mb" });
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => { console.error(err); res.status(500).json({ ok: false, error: err.message }); });

/* =========================== AUTH =========================== */
app.post("/api/register", authLimiter, jsonBody, wrap(async (req, res) => {
  const { username, password } = req.body;
  const uname = (username || "").trim().toLowerCase();
  if (uname.length < 3 || !/^[a-z0-9_.-]+$/.test(uname) || !password || password.length < 4) {
    return res.status(400).json({ ok: false, error: "Nome utente di almeno 3 caratteri (solo lettere, numeri, _ . -) e password di almeno 4 caratteri." });
  }
  if (await getAccount(uname)) return res.status(400).json({ ok: false, error: "Esiste già un account con questo nome utente." });
  const acc = {
    password: await bcrypt.hash(password, 10),
    respect: 100, insultCount: 0, banUntil: 0, permaBanned: false,
    profile: { bio: "", languages: [], projects: [], problemsFaced: [], microcontrollers: [], boostedUntil: 0, createdAt: Date.now() },
    stripeAccountId: null, chargesEnabled: false,
  };
  await saveAccount(uname, acc);
  const token = await createSession(uname);
  res.json({ ok: true, username: uname, token, account: publicAccount(acc) });
}));

app.post("/api/login", authLimiter, jsonBody, wrap(async (req, res) => {
  const { username, password } = req.body;
  const uname = (username || "").trim().toLowerCase();
  const acc = await getAccount(uname);
  if (!acc) return res.status(400).json({ ok: false, error: "Nessun account trovato con queste credenziali." });
  const match = await bcrypt.compare(password || "", acc.password);
  if (!match) return res.status(400).json({ ok: false, error: "Password errata." });
  if (acc.permaBanned) return res.status(403).json({ ok: false, error: "Questo account è stato bannato permanentemente per linguaggio offensivo ripetuto." });
  if (acc.banUntil && acc.banUntil > Date.now()) {
    const days = Math.ceil((acc.banUntil - Date.now()) / DAY);
    return res.status(403).json({ ok: false, error: `Account sospeso per linguaggio offensivo. Riprova tra ${days} giorn${days === 1 ? "o" : "i"}.` });
  }
  const token = await createSession(uname);
  res.json({ ok: true, username: uname, token, account: publicAccount(acc) });
}));

app.post("/api/logout", requireAuth, wrap(async (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) await deleteSession(token);
  res.json({ ok: true });
}));

/* =========================== ACCOUNTS (profili pubblici) =========================== */
app.get("/api/accounts", wrap(async (req, res) => {
  const accounts = await getAllAccounts();
  const out = {};
  for (const acc of accounts) out[acc._id] = publicAccount(acc);
  res.json(out);
}));

app.patch("/api/accounts/:username", requireAuth, jsonBody, wrap(async (req, res) => {
  const { username } = req.params;
  if (req.user !== username) return res.status(403).json({ ok: false, error: "Non puoi modificare il profilo di qualcun altro." });
  const acc = await getAccount(username);
  if (!acc) return res.status(404).json({ ok: false, error: "Account non trovato." });
  const allowed = ["bio", "languages", "projects", "problemsFaced", "microcontrollers"];
  for (const k of allowed) if (req.body[k] !== undefined) acc.profile[k] = req.body[k];
  await saveAccount(username, acc);
  res.json({ ok: true, account: publicAccount(acc) });
}));

/* =========================== POSTS =========================== */
app.get("/api/posts", wrap(async (req, res) => res.json(await getPosts())));

app.post("/api/posts", requireAuth, jsonBody, wrap(async (req, res) => {
  const { type, title, description, code, language, groupId } = req.body;
  if (!title || !code) return res.status(400).json({ ok: false, error: "parametri mancanti" });
  const post = { id: uid(), author: req.user, type, title, description: description || "", code, language: language || "", groupId: groupId || null, createdAt: Date.now(), boostedUntil: 0, comments: [] };
  await insertPost(post);
  res.json({ ok: true, post });
}));

app.post("/api/posts/:id/comments", requireAuth, jsonBody, wrap(async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ ok: false, error: "parametri mancanti" });
  const post = await getPost(req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: "post non trovato" });
  post.comments.push({ id: uid(), author: req.user, text, createdAt: Date.now() });
  await savePost(post);
  if (post.author !== req.user) await pushNotif(post.author, `${req.user} ha risposto al tuo post "${post.title}"`, post.id);
  const moderation = await applyModeration(req.user, text);
  res.json({ ok: true, post, moderation });
}));

/* =========================== GROUPS =========================== */
app.get("/api/groups", wrap(async (req, res) => res.json(await getGroups())));

app.post("/api/groups", requireAuth, jsonBody, wrap(async (req, res) => {
  const { name, description, private: isPrivate } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: "parametri mancanti" });
  const group = {
    id: uid(), name, description: description || "", private: !!isPrivate,
    inviteCode: isPrivate ? genInviteCode() : null,
    members: [req.user], projects: [], messages: [], createdAt: Date.now(),
  };
  await insertGroup(group);
  res.json({ ok: true, group });
}));

app.post("/api/groups/:id/join", requireAuth, jsonBody, wrap(async (req, res) => {
  const group = await getGroup(req.params.id);
  if (!group) return res.status(404).json({ ok: false, error: "gruppo non trovato" });
  if (group.private) return res.status(403).json({ ok: false, error: "gruppo privato: serve il codice invito" });
  if (!group.members.includes(req.user)) group.members.push(req.user);
  await saveGroup(group);
  res.json({ ok: true, group });
}));

app.post("/api/groups/join-by-code", requireAuth, jsonBody, wrap(async (req, res) => {
  const { code } = req.body;
  const group = await col("groups").findOne({ private: true, inviteCode: (code || "").toUpperCase() });
  if (!group) return res.status(404).json({ ok: false, error: "Nessun gruppo privato trovato con questo codice invito." });
  if (!group.members.includes(req.user)) group.members.push(req.user);
  await saveGroup(group);
  res.json({ ok: true, group });
}));

app.post("/api/groups/:id/messages", requireAuth, jsonBody, wrap(async (req, res) => {
  const { text, file } = req.body;
  const group = await getGroup(req.params.id);
  if (!group) return res.status(404).json({ ok: false, error: "gruppo non trovato" });
  group.messages.push({ id: uid(), author: req.user, text: text || "", file: file || null, createdAt: Date.now() });
  await saveGroup(group);
  const moderation = await applyModeration(req.user, text || "");
  res.json({ ok: true, group, moderation });
}));

app.post("/api/groups/:id/projects", requireAuth, jsonBody, wrap(async (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ ok: false, error: "parametri mancanti" });
  const group = await getGroup(req.params.id);
  if (!group) return res.status(404).json({ ok: false, error: "gruppo non trovato" });
  group.projects.push({ id: uid(), title, description: description || "", createdAt: Date.now() });
  await saveGroup(group);
  res.json({ ok: true, group });
}));

/* =========================== NOTIFICATIONS =========================== */
app.get("/api/notifications/:username", requireAuth, wrap(async (req, res) => {
  if (req.user !== req.params.username) return res.status(403).json({ ok: false, error: "Non puoi vedere le notifiche di qualcun altro." });
  res.json(await getNotifs(req.params.username));
}));

app.post("/api/notifications/:username/read", requireAuth, jsonBody, wrap(async (req, res) => {
  if (req.user !== req.params.username) return res.status(403).json({ ok: false, error: "Non autorizzato." });
  const arr = await getNotifs(req.params.username);
  await saveNotifs(req.params.username, arr.map((n) => ({ ...n, read: true })));
  res.json({ ok: true });
}));

/* =========================== DIRECT MESSAGES =========================== */
app.get("/api/dm/:a/:b", requireAuth, wrap(async (req, res) => {
  if (req.user !== req.params.a && req.user !== req.params.b) return res.status(403).json({ ok: false, error: "Non puoi leggere questa conversazione." });
  res.json(await getDM(req.params.a, req.params.b));
}));

app.post("/api/dm/:a/:b", requireAuth, jsonBody, wrap(async (req, res) => {
  if (req.user !== req.params.a && req.user !== req.params.b) return res.status(403).json({ ok: false, error: "Non puoi scrivere in questa conversazione." });
  const { text, file } = req.body;
  if (!text && !file) return res.status(400).json({ ok: false, error: "parametri mancanti" });
  const arr = await getDM(req.params.a, req.params.b);
  arr.push({ id: uid(), author: req.user, text: text || "", file: file || null, createdAt: Date.now() });
  await saveDM(req.params.a, req.params.b, arr);
  const other = [req.params.a, req.params.b].find((u) => u !== req.user) || req.params.b;
  await pushNotif(other, `${req.user} ti ha scritto un messaggio privato`, null);
  const moderation = await applyModeration(req.user, text || "");
  res.json({ ok: true, messages: arr, moderation });
}));

app.get("/api/dm-list/:username", requireAuth, wrap(async (req, res) => {
  if (req.user !== req.params.username) return res.status(403).json({ ok: false, error: "Non autorizzato." });
  res.json(await getDMListFor(req.params.username));
}));

/* =========================== invio email reale (verifica account) =========================== */
const nodemailer = require("nodemailer");
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;

let mailTransport = null;
if (EMAIL_USER && EMAIL_APP_PASSWORD) {
  mailTransport = nodemailer.createTransport({ service: "gmail", auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD } });
} else {
  console.warn("EMAIL_USER / EMAIL_APP_PASSWORD non configurati: l'invio email di conferma non funzionerà.");
}

/* =========================== invio SMS reale (Twilio) =========================== */
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const TWILIO_DEFAULT_COUNTRY_CODE = process.env.TWILIO_DEFAULT_COUNTRY_CODE || "+39";

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER) {
  const Twilio = require("twilio");
  twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER non configurati: l'invio SMS di conferma non funzionerà.");
}

const normalizePhone = (raw) => {
  let n = raw.replace(/[\s()-]/g, "");
  if (n.startsWith("00")) n = "+" + n.slice(2);
  if (!n.startsWith("+")) n = TWILIO_DEFAULT_COUNTRY_CODE + n.replace(/^0+/, "");
  return n;
};
const genSixDigitCode = () => String(Math.floor(100000 + Math.random() * 900000));

app.post("/api/verify/send", verifyLimiter, jsonBody, wrap(async (req, res) => {
  const { identifier } = req.body;
  if (!identifier) return res.status(400).json({ error: "identifier mancante" });
  const isEmail = identifier.includes("@");
  const code = genSixDigitCode();
  const key = isEmail ? identifier.toLowerCase() : normalizePhone(identifier);

  if (isEmail) {
    if (!mailTransport) return res.status(500).json({ error: "Invio email non configurato sul server (mancano EMAIL_USER / EMAIL_APP_PASSWORD)." });
    await mailTransport.sendMail({
      from: `"ProDevUnity" <${EMAIL_FROM}>`,
      to: identifier,
      subject: "Il tuo codice di conferma ProDevUnity",
      text: `Il tuo codice di conferma è: ${code}\n\nScade tra 15 minuti.`,
      html: `<p>Il tuo codice di conferma è:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px;">${code}</p><p>Scade tra 15 minuti.</p>`,
    });
  } else {
    if (!twilioClient) return res.status(500).json({ error: "Invio SMS non configurato sul server (mancano le variabili TWILIO_...)." });
    await twilioClient.messages.create({ to: key, from: TWILIO_PHONE_NUMBER, body: `ProDevUnity: il tuo codice di conferma è ${code}. Scade tra 15 minuti.` });
  }

  await saveVerifyCode(key, { code, expiresAt: Date.now() + 15 * 60 * 1000 });
  res.json({ ok: true });
}));

app.post("/api/verify/check", jsonBody, wrap(async (req, res) => {
  const { identifier, code } = req.body;
  if (!identifier || !code) return res.status(400).json({ error: "parametri mancanti" });
  const isEmail = identifier.includes("@");
  const key = isEmail ? identifier.toLowerCase() : normalizePhone(identifier);
  const entry = await getVerifyCode(key);
  if (!entry) return res.status(400).json({ ok: false, error: "Nessun codice richiesto per questo indirizzo/numero." });
  if (Date.now() > entry.expiresAt) return res.status(400).json({ ok: false, error: "Codice scaduto, richiedine uno nuovo." });
  if (entry.code !== String(code).trim()) return res.status(400).json({ ok: false, error: "Codice errato." });
  await deleteVerifyCode(key);
  res.json({ ok: true });
}));

/* =========================== STRIPE CONNECT =========================== */
app.post("/api/connect/onboard", requireAuth, jsonBody, wrap(async (req, res) => {
  const { userId } = req.body;
  if (!userId || userId !== req.user) return res.status(403).json({ error: "Puoi collegare Stripe solo al tuo account." });
  const acc = await getAccount(userId);
  if (!acc) return res.status(404).json({ error: "Account non trovato. Registrati prima sul sito." });

  if (!acc.stripeAccountId) {
    const account = await stripe.accounts.create({
      type: "express",
      email: userId.includes("@") ? userId : undefined,
      capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
    });
    acc.stripeAccountId = account.id;
    acc.chargesEnabled = false;
    await saveAccount(userId, acc);
  }

  const accountLink = await stripe.accountLinks.create({
    account: acc.stripeAccountId,
    refresh_url: `${FRONTEND_URL}?connect=refresh`,
    return_url: `${FRONTEND_URL}?connect=done&userId=${encodeURIComponent(userId)}`,
    type: "account_onboarding",
  });
  res.json({ url: accountLink.url });
}));

app.get("/api/connect/status", requireAuth, wrap(async (req, res) => {
  const { userId } = req.query;
  if (!userId || userId !== req.user) return res.status(403).json({ error: "Puoi verificare solo il tuo account." });
  const acc = await getAccount(userId);
  if (!acc || !acc.stripeAccountId) return res.json({ connected: false, chargesEnabled: false });

  const account = await stripe.accounts.retrieve(acc.stripeAccountId);
  acc.chargesEnabled = !!account.charges_enabled;
  await saveAccount(userId, acc);
  res.json({ connected: true, chargesEnabled: acc.chargesEnabled });
}));

/* =========================== CHECKOUT — boost 1€ =========================== */
app.post("/api/checkout/boost", requireAuth, jsonBody, wrap(async (req, res) => {
  const { userId, kind, targetId } = req.body;
  if (!userId || userId !== req.user || !kind || !targetId) return res.status(400).json({ error: "parametri mancanti o non validi" });
  if (kind === "account" && targetId !== req.user) return res.status(403).json({ error: "Puoi mettere in evidenza solo il tuo profilo." });

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      price_data: {
        currency: "eur",
        product_data: { name: kind === "post" ? "ProDevUnity — metti in evidenza un post (3 giorni)" : "ProDevUnity — metti in evidenza il profilo (3 giorni)" },
        unit_amount: 100,
      },
      quantity: 1,
    }],
    success_url: `${FRONTEND_URL}?paid=boost&kind=${kind}&id=${encodeURIComponent(targetId)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${FRONTEND_URL}?paid=cancel`,
    metadata: { type: "boost", userId, kind, targetId },
  });
  res.json({ url: session.url });
}));

/* =========================== CHECKOUT — pagamento tra privati =========================== */
app.post("/api/checkout/payment", requireAuth, jsonBody, wrap(async (req, res) => {
  const { fromUserId, toUserId, amountEuros } = req.body;
  const amount = Number(amountEuros);
  if (!fromUserId || fromUserId !== req.user || !toUserId || !amount || amount <= 0) {
    return res.status(400).json({ error: "parametri mancanti o importo non valido" });
  }
  const dest = await getAccount(toUserId);
  if (!dest || !dest.stripeAccountId) return res.status(400).json({ error: "Il destinatario non ha ancora collegato un account Stripe." });
  if (!dest.chargesEnabled) return res.status(400).json({ error: "L'account Stripe del destinatario non è ancora attivo (onboarding non completato)." });

  const amountCents = Math.round(amount * 100);
  const feeCents = Math.round(amountCents * (FEE_PERCENT / 100));

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      price_data: { currency: "eur", product_data: { name: `Pagamento per un progetto — a @${toUserId} su ProDevUnity` }, unit_amount: amountCents },
      quantity: 1,
    }],
    payment_intent_data: { application_fee_amount: feeCents, transfer_data: { destination: dest.stripeAccountId } },
    success_url: `${FRONTEND_URL}?paid=project&from=${encodeURIComponent(fromUserId)}&to=${encodeURIComponent(toUserId)}&amount=${amount}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${FRONTEND_URL}?paid=cancel`,
    metadata: { type: "project_payment", fromUserId, toUserId, amountEuros: String(amount), feePercent: String(FEE_PERCENT) },
  });
  res.json({ url: session.url });
}));

/* =========================== WEBHOOK =========================== */
app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Firma webhook non valida:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  (async () => {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const meta = session.metadata || {};

      if (meta.type === "boost") {
        if (meta.kind === "post") {
          const post = await getPost(meta.targetId);
          if (post) { post.boostedUntil = Date.now() + 3 * DAY; await savePost(post); }
        } else if (meta.kind === "account") {
          const acc = await getAccount(meta.targetId);
          if (acc) { acc.profile.boostedUntil = Date.now() + 3 * DAY; await saveAccount(meta.targetId, acc); }
        }
        await appendLedger({ type: "boost", userId: meta.userId, kind: meta.kind, targetId: meta.targetId, amountEuros: 1 });
      } else if (meta.type === "project_payment") {
        const amount = Number(meta.amountEuros);
        const feePercent = Number(meta.feePercent);
        const fee = Math.round(amount * (feePercent / 100) * 100) / 100;
        const net = Math.round((amount - fee) * 100) / 100;

        const arr = await getDM(meta.fromUserId, meta.toUserId);
        arr.push({ id: uid(), author: meta.fromUserId, type: "payment", amount, fee, net, feePct: feePercent, createdAt: Date.now() });
        await saveDM(meta.fromUserId, meta.toUserId, arr);
        await pushNotif(meta.toUserId, `${meta.fromUserId} ti ha inviato un pagamento di ${net.toFixed(2)}€ (al netto della commissione piattaforma)`, null);

        await appendLedger({ type: "project_payment", fromUserId: meta.fromUserId, toUserId: meta.toUserId, amountEuros: amount, feeEuros: fee, netEuros: net });
      }
    }
    res.json({ received: true });
  })().catch((err) => { console.error(err); res.status(500).json({ received: false }); });
});

app.get("/api/ledger/summary", wrap(async (req, res) => {
  const arr = await getLedger();
  const totalFees = arr.reduce((sum, e) => {
    if (e.type === "boost") return sum + e.amountEuros;
    if (e.type === "project_payment") return sum + e.feeEuros;
    return sum;
  }, 0);
  res.json({ totalFees: Math.round(totalFees * 100) / 100, entries: arr.length });
}));

app.get("/", (req, res) => res.send("ProDevUnity backend attivo."));

async function start() {
  await connectDB();
  await seedOwnerAccount();
  app.listen(PORT, () => {
    console.log(`ProDevUnity backend in ascolto su http://localhost:${PORT}`);
  });
}
start().catch((err) => {
  console.error("Impossibile avviare il server:", err.message);
  process.exit(1);
});
