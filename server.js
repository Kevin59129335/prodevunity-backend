/**
 * ProDevUnity — backend pagamenti reali
 * ---------------------------------------
 * Gestisce due tipi di pagamento reale con Stripe:
 *
 *  1) BOOST (1€ / 3 giorni) — un pagamento diretto: i soldi vanno
 *     semplicemente sul TUO account Stripe (quello configurato con
 *     STRIPE_SECRET_KEY). Non serve nessun collegamento speciale.
 *
 *  2) PAGAMENTO TRA PRIVATI — un utente paga un altro utente per un
 *     sito/un'app/del codice. Usa una "destination charge" di Stripe
 *     Connect: il soldi vengono addebitati sul TUO account (che è il
 *     merchant of record), e Stripe trasferisce automaticamente il 90%
 *     all'account Stripe collegato del destinatario, trattenendo il 10%
 *     come commissione della piattaforma (application_fee_amount).
 *
 * Per ricevere pagamenti come destinatario, un utente deve prima
 * "connettersi" con Stripe (account Express) tramite /api/connect/onboard.
 * Non gestiamo MAI numeri di carta direttamente: è Stripe stesso, tramite
 * pagine sicure ospitate da loro, a occuparsene (Checkout e onboarding).
 *
 * Storage: per semplicità i dati (mappa utente -> account Stripe, e il
 * "ledger" delle transazioni) sono salvati in due file JSON in ./data.
 * Per un sito con traffico reale, sostituire con un vero database
 * (Postgres, SQLite, ecc.) — i file JSON qui sono pensati per farti
 * partire subito, non per scalare.
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
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 10);

if (!STRIPE_SECRET_KEY) {
  console.error("ERRORE: manca STRIPE_SECRET_KEY nel file .env — vedi .env.example");
  process.exit(1);
}

const stripe = Stripe(STRIPE_SECRET_KEY);
const app = express();
app.use(cors({ origin: FRONTEND_URL === "*" ? true : FRONTEND_URL }));

/* ---------- invio email reale (verifica account) ---------- */
const nodemailer = require("nodemailer");
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;

let mailTransport = null;
if (EMAIL_USER && EMAIL_APP_PASSWORD) {
  mailTransport = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
  });
} else {
  console.warn("EMAIL_USER / EMAIL_APP_PASSWORD non configurati: l'invio email di conferma non funzionerà.");
}

const VERIFY_FILE = path.join(__dirname, "data", "verify_codes.json");
if (!fs.existsSync(path.join(__dirname, "data"))) fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
if (!fs.existsSync(VERIFY_FILE)) fs.writeFileSync(VERIFY_FILE, "{}");
const getVerifyCodes = () => JSON.parse(fs.readFileSync(VERIFY_FILE, "utf8"));
const saveVerifyCodes = (v) => fs.writeFileSync(VERIFY_FILE, JSON.stringify(v, null, 2));
const genSixDigitCode = () => String(Math.floor(100000 + Math.random() * 900000));

app.post("/api/verify/send", express.json(), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes("@")) return res.status(400).json({ error: "email non valida" });
    if (!mailTransport) return res.status(500).json({ error: "Invio email non configurato sul server (mancano EMAIL_USER / EMAIL_APP_PASSWORD)." });

    const code = genSixDigitCode();
    const codes = getVerifyCodes();
    codes[email.toLowerCase()] = { code, expiresAt: Date.now() + 15 * 60 * 1000 };
    saveVerifyCodes(codes);

    await mailTransport.sendMail({
      from: `"ProDevUnity" <${EMAIL_FROM}>`,
      to: email,
      subject: "Il tuo codice di conferma ProDevUnity",
      text: `Il tuo codice di conferma è: ${code}\n\nScade tra 15 minuti. Se non hai richiesto tu la registrazione, ignora questa email.`,
      html: `<p>Il tuo codice di conferma è:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px;">${code}</p><p>Scade tra 15 minuti. Se non hai richiesto tu la registrazione, ignora questa email.</p>`,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/verify/check", express.json(), (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: "parametri mancanti" });
    const codes = getVerifyCodes();
    const entry = codes[email.toLowerCase()];
    if (!entry) return res.status(400).json({ ok: false, error: "Nessun codice richiesto per questa email." });
    if (Date.now() > entry.expiresAt) return res.status(400).json({ ok: false, error: "Codice scaduto, richiedine uno nuovo." });
    if (entry.code !== String(code).trim()) return res.status(400).json({ ok: false, error: "Codice errato." });

    delete codes[email.toLowerCase()];
    saveVerifyCodes(codes);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ---------- storage su file (demo — sostituire con un vero DB in produzione) ---------- */
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const LEDGER_FILE = path.join(DATA_DIR, "ledger.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
if (!fs.existsSync(LEDGER_FILE)) fs.writeFileSync(LEDGER_FILE, "[]");

const readJSON = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

const getUsers = () => readJSON(USERS_FILE);
const saveUsers = (u) => writeJSON(USERS_FILE, u);
const appendLedger = (entry) => {
  const arr = readJSON(LEDGER_FILE);
  arr.push({ id: Math.random().toString(36).slice(2, 10), createdAt: Date.now(), ...entry });
  writeJSON(LEDGER_FILE, arr);
};

/* ================================================================
   1) STRIPE CONNECT — onboarding di chi vuole RICEVERE pagamenti
   ================================================================ */

// Crea (o riusa) un account Stripe Express per un utente, e restituisce
// il link di onboarding sicuro ospitato da Stripe.
app.post("/api/connect/onboard", express.json(), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId mancante" });

    const users = getUsers();
    let entry = users[userId];

    if (!entry || !entry.stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: userId.includes("@") ? userId : undefined,
        capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
      });
      entry = { stripeAccountId: account.id, chargesEnabled: false };
      users[userId] = entry;
      saveUsers(users);
    }

    const accountLink = await stripe.accountLinks.create({
      account: entry.stripeAccountId,
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

// Controlla se l'account collegato può già ricevere pagamenti
// (Stripe deve prima verificare i dati inseriti nell'onboarding).
app.get("/api/connect/status", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "userId mancante" });
    const users = getUsers();
    const entry = users[userId];
    if (!entry || !entry.stripeAccountId) return res.json({ connected: false, chargesEnabled: false });

    const account = await stripe.accounts.retrieve(entry.stripeAccountId);
    entry.chargesEnabled = !!account.charges_enabled;
    users[userId] = entry;
    saveUsers(users);

    res.json({ connected: true, chargesEnabled: entry.chargesEnabled });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ================================================================
   2) CHECKOUT — BOOST fisso da 1€ (va sul tuo account, nessuno split)
   ================================================================ */
app.post("/api/checkout/boost", express.json(), async (req, res) => {
  try {
    const { userId, kind, targetId } = req.body; // kind: 'post' | 'account'
    if (!userId || !kind || !targetId) return res.status(400).json({ error: "parametri mancanti" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: kind === "post" ? "ProDevUnity — metti in evidenza un post (3 giorni)" : "ProDevUnity — metti in evidenza il profilo (3 giorni)" },
          unit_amount: 100, // 1,00 €
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

/* ================================================================
   3) CHECKOUT — pagamento tra privati con il 10% di commissione
   ================================================================ */
app.post("/api/checkout/payment", express.json(), async (req, res) => {
  try {
    const { fromUserId, toUserId, amountEuros } = req.body;
    const amount = Number(amountEuros);
    if (!fromUserId || !toUserId || !amount || amount <= 0) {
      return res.status(400).json({ error: "parametri mancanti o importo non valido" });
    }

    const users = getUsers();
    const dest = users[toUserId];
    if (!dest || !dest.stripeAccountId) {
      return res.status(400).json({ error: "Il destinatario non ha ancora collegato un account Stripe." });
    }
    if (!dest.chargesEnabled) {
      return res.status(400).json({ error: "L'account Stripe del destinatario non è ancora attivo (onboarding non completato)." });
    }

    const amountCents = Math.round(amount * 100);
    const feeCents = Math.round(amountCents * (FEE_PERCENT / 100));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: `Pagamento per un progetto — a @${toUserId} su ProDevUnity` },
          unit_amount: amountCents,
        },
        quantity: 1,
      }],
      payment_intent_data: {
        application_fee_amount: feeCents,
        transfer_data: { destination: dest.stripeAccountId },
      },
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

/* ================================================================
   4) WEBHOOK — Stripe ti avvisa quando un pagamento va a buon fine
   ================================================================
   IMPORTANTE: questa rotta usa express.raw (non express.json) perché
   Stripe ha bisogno del corpo grezzo della richiesta per verificarne
   la firma. Va registrata PRIMA di qualunque app.use(express.json()).
*/
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
      appendLedger({ type: "boost", userId: meta.userId, kind: meta.kind, targetId: meta.targetId, amountEuros: 1 });
    } else if (meta.type === "project_payment") {
      const amount = Number(meta.amountEuros);
      const feePercent = Number(meta.feePercent);
      const fee = Math.round(amount * (feePercent / 100) * 100) / 100;
      appendLedger({
        type: "project_payment",
        fromUserId: meta.fromUserId,
        toUserId: meta.toUserId,
        amountEuros: amount,
        feeEuros: fee,
        netEuros: Math.round((amount - fee) * 100) / 100,
      });
    }
  }

  res.json({ received: true });
});

/* ================================================================
   5) Endpoint di sola lettura per far vedere il ledger nel pannello
      piattaforma del sito (facoltativo, utile per il totale incassato)
   ================================================================ */
app.get("/api/ledger/summary", (req, res) => {
  const arr = readJSON(LEDGER_FILE);
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
