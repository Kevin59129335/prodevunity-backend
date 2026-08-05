/**
 * ProDevUnity — backend completo
 * ---------------------------------------
 * Da qui in poi il backend è la fonte di verità di TUTTO il sito:
 * account, post, gruppi, notifiche, messaggi privati — non solo i
 * pagamenti. Il sito (index.html) parla con questo server invece di
 * salvare i dati solo nel browser di chi lo usa: così due persone
 * diverse vedono davvero le stesse cose.
 *
 * Storage: ancora file JSON dentro ./data, per restare semplice.
 * IMPORTANTE: su Render (piano gratuito) il filesystem NON è
 * persistente tra un riavvio/deploy e l'altro — serve un "Persistent
 * Disk" (economico, poco più di 1$/mese per 1GB) montato sulla
 * cartella ./data, altrimenti ogni redeploy azzera account e post.
 * Vedi il README, sezione 10.
 *
 * Pagamenti reali con Stripe: stessa logica di prima (vedi in fondo
 * al file), solo che ora usa lo stesso accounts.json degli account
 * del sito, invece di un file separato.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const PORT = process.env.PORT || 4242;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5500";
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 15);
const DAY = 24 * 60 * 60 * 1000;

if (!STRIPE_SECRET_KEY) {
  console.error("ERRORE: manca STRIPE_SECRET_KEY nel file .env — vedi .env.example");
  process.exit(1);
}

const stripe = Stripe(STRIPE_SECRET_KEY);
const app = express();
app.use(cors({ origin: FRONTEND_URL === "*" ? true : FRONTEND_URL }));

/* =========================== storage su file =========================== */
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  accounts: path.join(DATA_DIR, "accounts.json"),
  posts: path.join(DATA_DIR, "posts.json"),
  groups: path.join(DATA_DIR, "groups.json"),
  notifications: path.join(DATA_DIR, "notifications.json"),
  dms: path.join(DATA_DIR, "dms.json"),
  verify: path.join(DATA_DIR, "verify_codes.json"),
  ledger: path.join(DATA_DIR, "ledger.json"),
};
const DEFAULTS = {
  accounts: "{}", posts: "[]", groups: "[]",
  notifications: "{}", dms: "{}", verify: "{}", ledger: "[]",
};
for (const key of Object.keys(FILES)) {
  if (!fs.existsSync(FILES[key])) fs.writeFileSync(FILES[key], DEFAULTS[key]);
}

const readJSON = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

const getAccounts = () => readJSON(FILES.accounts);
const saveAccounts = (a) => writeJSON(FILES.accounts, a);
const getPosts = () => readJSON(FILES.posts);
const savePosts = (p) => writeJSON(FILES.posts, p);
const getGroups = () => readJSON(FILES.groups);
const saveGroups = (g) => writeJSON(FILES.groups, g);
const getNotifs = () => readJSON(FILES.notifications);
const saveNotifs = (n) => writeJSON(FILES.notifications, n);
const getDMs = () => readJSON(FILES.dms);
const saveDMs = (d) => writeJSON(FILES.dms, d);
const getLedger = () => readJSON(FILES.ledger);
const appendLedger = (entry) => {
  const arr = getLedger();
  arr.push({ id: uid(), createdAt: Date.now(), ...entry });
  writeJSON(FILES.ledger, arr);
};

const uid = () => Math.random().toString(36).slice(2, 10);
const dmKey = (a, b) => [a, b].sort().join("__");
const genInviteCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};

/* seed dell'account proprietario, se non esiste già */
(() => {
  const accounts = getAccounts();
  if (!accounts["p0ss3ss0r3"]) {
    accounts["p0ss3ss0r3"] = {
      password: "possessore",
      respect: 100, insultCount: 0, banUntil: 0, permaBanned: false,
      profile: { bio: "", languages: [], projects: [], problemsFaced: [], microcontrollers: [], boostedUntil: 0, createdAt: Date.now() },
      stripeAccountId: null, chargesEnabled: false,
    };
    saveAccounts(accounts);
  }
})();

const publicAccount = (acc) => ({
  profile: acc.profile,
  respect: acc.respect,
  banUntil: acc.banUntil || 0,
  permaBanned: !!acc.permaBanned,
});

/* =========================== moderazione (insulti / ban) =========================== */
const INSULT_WORDS = ["stupido", "stupida", "idiota", "cretino", "cretina", "scemo", "scema", "imbecille", "deficiente", "coglione", "stronzo", "stronza", "merda", "bastardo", "bastarda"];
const containsInsult = (text) => {
  const t = (text || "").toLowerCase();
  return INSULT_WORDS.some((w) => t.includes(w));
};
function applyModeration(username, text) {
  if (!containsInsult(text)) return { insult: false };
  const accounts = getAccounts();
  const acc = accounts[username];
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
  saveAccounts(accounts);
  return { insult: true, banMsg, respect: acc.respect, banUntil: acc.banUntil, permaBanned: acc.permaBanned };
}

function pushNotif(username, text, postId) {
  const notifs = getNotifs();
  const arr = notifs[username] || [];
  arr.unshift({ id: uid(), text, postId: postId || null, read: false, createdAt: Date.now() });
  notifs[username] = arr.slice(0, 200);
  saveNotifs(notifs);
}

const jsonBody = express.json({ limit: "5mb" });

/* =========================== AUTH =========================== */
app.post("/api/register", jsonBody, (req, res) => {
  const { username, password } = req.body;
  const uname = (username || "").trim().toLowerCase();
  if (uname.length < 3 || !password || password.length < 4) {
    return res.status(400).json({ ok: false, error: "Nome utente di almeno 3 caratteri e password di almeno 4 caratteri." });
  }
  const accounts = getAccounts();
  if (accounts[uname]) return res.status(400).json({ ok: false, error: "Esiste già un account con questo nome utente." });
  accounts[uname] = {
    password,
    respect: 100, insultCount: 0, banUntil: 0, permaBanned: false,
    profile: { bio: "", languages: [], projects: [], problemsFaced: [], microcontrollers: [], boostedUntil: 0, createdAt: Date.now() },
    stripeAccountId: null, chargesEnabled: false,
  };
  saveAccounts(accounts);
  res.json({ ok: true, username: uname, account: publicAccount(accounts[uname]) });
});

app.post("/api/login", jsonBody, (req, res) => {
  const { username, password } = req.body;
  const uname = (username || "").trim().toLowerCase();
  const accounts = getAccounts();
  const acc = accounts[uname];
  if (!acc) return res.status(400).json({ ok: false, error: "Nessun account trovato con queste credenziali." });
  if (acc.password !== password) return res.status(400).json({ ok: false, error: "Password errata." });
  if (acc.permaBanned) return res.status(403).json({ ok: false, error: "Questo account è stato bannato permanentemente per linguaggio offensivo ripetuto." });
  if (acc.banUntil && acc.banUntil > Date.now()) {
    const days = Math.ceil((acc.banUntil - Date.now()) / DAY);
    return res.status(403).json({ ok: false, error: `Account sospeso per linguaggio offensivo. Riprova tra ${days} giorn${days === 1 ? "o" : "i"}.` });
  }
  res.json({ ok: true, username: uname, account: publicAccount(acc) });
});

/* =========================== ACCOUNTS (profili pubblici) =========================== */
app.get("/api/accounts", (req, res) => {
  const accounts = getAccounts();
  const out = {};
  for (const [uname, acc] of Object.entries(accounts)) out[uname] = publicAccount(acc);
  res.json(out);
});

app.patch("/api/accounts/:username", jsonBody, (req, res) => {
  const { username } = req.params;
  const accounts = getAccounts();
  const acc = accounts[username];
  if (!acc) return res.status(404).json({ ok: false, error: "Account non trovato." });
  const allowed = ["bio", "languages", "projects", "problemsFaced", "microcontrollers"];
  for (const k of allowed) if (req.body[k] !== undefined) acc.profile[k] = req.body[k];
  saveAccounts(accounts);
  res.json({ ok: true, account: publicAccount(acc) });
});

/* =========================== POSTS =========================== */
app.get("/api/posts", (req, res) => res.json(getPosts()));

app.post("/api/posts", jsonBody, (req, res) => {
  const { author, type, title, description, code, language, groupId } = req.body;
  if (!author || !title || !code) return res.status(400).json({ ok: false, error: "parametri mancanti" });
  const posts = getPosts();
  const post = { id: uid(), author, type, title, description: description || "", code, language: language || "", groupId: groupId || null, createdAt: Date.now(), boostedUntil: 0, comments: [] };
  posts.unshift(post);
  savePosts(posts);
  res.json({ ok: true, post });
});

app.post("/api/posts/:id/comments", jsonBody, (req, res) => {
  const { author, text } = req.body;
  if (!author || !text) return res.status(400).json({ ok: false, error: "parametri mancanti" });
  const posts = getPosts();
  const post = posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: "post non trovato" });
  post.comments.push({ id: uid(), author, text, createdAt: Date.now() });
  savePosts(posts);
  if (post.author !== author) pushNotif(post.author, `${author} ha risposto al tuo post "${post.title}"`, post.id);
  const moderation = applyModeration(author, text);
  res.json({ ok: true, post, moderation });
});

/* =========================== GROUPS =========================== */
app.get("/api/groups", (req, res) => res.json(getGroups()));

app.post("/api/groups", jsonBody, (req, res) => {
  const { name, description, private: isPrivate, author } = req.body;
  if (!name || !author) return res.status(400).json({ ok: false, error: "parametri mancanti" });
  const groups = getGroups();
  const group = {
    id: uid(), name, description: description || "", private: !!isPrivate,
    inviteCode: isPrivate ? genInviteCode() : null,
    members: [author], projects: [], messages: [], createdAt: Date.now(),
  };
  groups.unshift(group);
  saveGroups(groups);
  res.json({ ok: true, group });
});

app.post("/api/groups/:id/join", jsonBody, (req, res) => {
  const { username } = req.body;
  const groups = getGroups();
  const group = groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ ok: false, error: "gruppo non trovato" });
  if (group.private) return res.status(403).json({ ok: false, error: "gruppo privato: serve il codice invito" });
  if (!group.members.includes(username)) group.members.push(username);
  saveGroups(groups);
  res.json({ ok: true, group });
});

app.post("/api/groups/join-by-code", jsonBody, (req, res) => {
  const { code, username } = req.body;
  const groups = getGroups();
  const group = groups.find((g) => g.private && g.inviteCode === (code || "").toUpperCase());
  if (!group) return res.status(404).json({ ok: false, error: "Nessun gruppo privato trovato con questo codice invito." });
  if (!group.members.includes(username)) group.members.push(username);
  saveGroups(groups);
  res.json({ ok: true, group });
});

app.post("/api/groups/:id/messages", jsonBody, (req, res) => {
  const { author, text, file } = req.body;
  if (!author) return res.status(400).json({ ok: false, error: "parametri mancanti" });
  const groups = getGroups();
  const group = groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ ok: false, error: "gruppo non trovato" });
  group.messages.push({ id: uid(), author, text: text || "", file: file || null, createdAt: Date.now() });
  saveGroups(groups);
  const moderation = applyModeration(author, text || "");
  res.json({ ok: true, group, moderation });
});

app.post("/api/groups/:id/projects", jsonBody, (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ ok: false, error: "parametri mancanti" });
  const groups = getGroups();
  const group = groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ ok: false, error: "gruppo non trovato" });
  group.projects.push({ id: uid(), title, description: description || "", createdAt: Date.now() });
  saveGroups(groups);
  res.json({ ok: true, group });
});

/* =========================== NOTIFICATIONS =========================== */
app.get("/api/notifications/:username", (req, res) => {
  const notifs = getNotifs();
  res.json(notifs[req.params.username] || []);
});

app.post("/api/notifications/:username/read", jsonBody, (req, res) => {
  const notifs = getNotifs();
  const arr = notifs[req.params.username] || [];
  notifs[req.params.username] = arr.map((n) => ({ ...n, read: true }));
  saveNotifs(notifs);
  res.json({ ok: true });
});

/* =========================== DIRECT MESSAGES =========================== */
app.get("/api/dm/:a/:b", (req, res) => {
  const dms = getDMs();
  res.json(dms[dmKey(req.params.a, req.params.b)] || []);
});

app.get("/api/dm-list/:username", (req, res) => {
  const dms = getDMs();
  const { username } = req.params;
  const out = [];
  for (const [key, arr] of Object.entries(dms)) {
    const parts = key.split("__");
    if (!parts.includes(username) || arr.length === 0) continue;
    const other = parts.find((p) => p !== username) || parts[0];
    out.push({ other, last: arr[arr.length - 1] });
  }
  out.sort((a, b) => b.last.createdAt - a.last.createdAt);
  res.json(out);
});

app.post("/api/dm/:a/:b", jsonBody, (req, res) => {
  const { author, text, file } = req.body;
  if (!author) return res.status(400).json({ ok: false, error: "parametri mancanti" });
  const dms = getDMs();
  const key = dmKey(req.params.a, req.params.b);
  const arr = dms[key] || [];
  arr.push({ id: uid(), author, text: text || "", file: file || null, createdAt: Date.now() });
  dms[key] = arr;
  saveDMs(dms);
  const other = [req.params.a, req.params.b].find((u) => u !== author) || req.params.b;
  pushNotif(other, `${author} ti ha scritto un messaggio privato`, null);
  const moderation = applyModeration(author, text || "");
  res.json({ ok: true, messages: arr, moderation });
});

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
const getVerifyCodes = () => readJSON(FILES.verify);
const saveVerifyCodes = (v) => writeJSON(FILES.verify, v);

app.post("/api/verify/send", jsonBody, async (req, res) => {
  try {
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

    const codes = getVerifyCodes();
    codes[key] = { code, expiresAt: Date.now() + 15 * 60 * 1000 };
    saveVerifyCodes(codes);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/verify/check", jsonBody, (req, res) => {
  try {
    const { identifier, code } = req.body;
    if (!identifier || !code) return res.status(400).json({ error: "parametri mancanti" });
    const isEmail = identifier.includes("@");
    const key = isEmail ? identifier.toLowerCase() : normalizePhone(identifier);
    const codes = getVerifyCodes();
    const entry = codes[key];
    if (!entry) return res.status(400).json({ ok: false, error: "Nessun codice richiesto per questo indirizzo/numero." });
    if (Date.now() > entry.expiresAt) return res.status(400).json({ ok: false, error: "Codice scaduto, richiedine uno nuovo." });
    if (entry.code !== String(code).trim()) return res.status(400).json({ ok: false, error: "Codice errato." });
    delete codes[key];
    saveVerifyCodes(codes);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================== STRIPE CONNECT =========================== */
app.post("/api/connect/onboard", jsonBody, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId mancante" });

    const accounts = getAccounts();
    let acc = accounts[userId];
    if (!acc) return res.status(404).json({ error: "Account non trovato. Registrati prima sul sito." });

    if (!acc.stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: userId.includes("@") ? userId : undefined,
        capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
      });
      acc.stripeAccountId = account.id;
      acc.chargesEnabled = false;
      saveAccounts(accounts);
    }

    const accountLink = await stripe.accountLinks.create({
      account: acc.stripeAccountId,
      refresh_url: `${FRONTEND_URL}?connect=refresh`,
      return_url: `${FRONTEND_URL}?connect=done&userId=${encodeURIComponent(userId)}`,
      type: "account_onboarding",
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/connect/status", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "userId mancante" });
    const accounts = getAccounts();
    const acc = accounts[userId];
    if (!acc || !acc.stripeAccountId) return res.json({ connected: false, chargesEnabled: false });

    const account = await stripe.accounts.retrieve(acc.stripeAccountId);
    acc.chargesEnabled = !!account.charges_enabled;
    saveAccounts(accounts);

    res.json({ connected: true, chargesEnabled: acc.chargesEnabled });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================== CHECKOUT — boost 1€ =========================== */
app.post("/api/checkout/boost", jsonBody, async (req, res) => {
  try {
    const { userId, kind, targetId } = req.body;
    if (!userId || !kind || !targetId) return res.status(400).json({ error: "parametri mancanti" });

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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================== CHECKOUT — pagamento tra privati =========================== */
app.post("/api/checkout/payment", jsonBody, async (req, res) => {
  try {
    const { fromUserId, toUserId, amountEuros } = req.body;
    const amount = Number(amountEuros);
    if (!fromUserId || !toUserId || !amount || amount <= 0) {
      return res.status(400).json({ error: "parametri mancanti o importo non valido" });
    }

    const accounts = getAccounts();
    const dest = accounts[toUserId];
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================== WEBHOOK =========================== */
app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Firma webhook non valida:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const meta = session.metadata || {};

    if (meta.type === "boost") {
      if (meta.kind === "post") {
        const posts = getPosts();
        const post = posts.find((p) => p.id === meta.targetId);
        if (post) { post.boostedUntil = Date.now() + 3 * DAY; savePosts(posts); }
      } else if (meta.kind === "account") {
        const accounts = getAccounts();
        const acc = accounts[meta.targetId];
        if (acc) { acc.profile.boostedUntil = Date.now() + 3 * DAY; saveAccounts(accounts); }
      }
      appendLedger({ type: "boost", userId: meta.userId, kind: meta.kind, targetId: meta.targetId, amountEuros: 1 });
    } else if (meta.type === "project_payment") {
      const amount = Number(meta.amountEuros);
      const feePercent = Number(meta.feePercent);
      const fee = Math.round(amount * (feePercent / 100) * 100) / 100;
      const net = Math.round((amount - fee) * 100) / 100;

      const dms = getDMs();
      const key = dmKey(meta.fromUserId, meta.toUserId);
      const arr = dms[key] || [];
      arr.push({ id: uid(), author: meta.fromUserId, type: "payment", amount, fee, net, feePct: feePercent, createdAt: Date.now() });
      dms[key] = arr;
      saveDMs(dms);
      pushNotif(meta.toUserId, `${meta.fromUserId} ti ha inviato un pagamento di ${net.toFixed(2)}€ (al netto della commissione piattaforma)`, null);

      appendLedger({ type: "project_payment", fromUserId: meta.fromUserId, toUserId: meta.toUserId, amountEuros: amount, feeEuros: fee, netEuros: net });
    }
  }

  res.json({ received: true });
});

app.get("/api/ledger/summary", (req, res) => {
  const arr = getLedger();
  const totalFees = arr.reduce((sum, e) => {
    if (e.type === "boost") return sum + e.amountEuros;
    if (e.type === "project_payment") return sum + e.feeEuros;
    return sum;
  }, 0);
  res.json({ totalFees: Math.round(totalFees * 100) / 100, entries: arr.length });
});

app.get("/", (req, res) => res.send("ProDevUnity backend attivo."));

app.listen(PORT, () => {
  console.log(`ProDevUnity backend in ascolto su http://localhost:${PORT}`);
});
