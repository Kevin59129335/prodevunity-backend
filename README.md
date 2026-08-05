# ProDevUnity — backend

Questo server è ora il **cuore condiviso** del sito: account, post,
gruppi, notifiche e messaggi privati vivono qui, non più solo nel
browser di chi li scrive. È anche quello che rende **veri** i due
pagamenti del sito:

1. **Boost (1€ / 3 giorni)** — pagamento diretto sul tuo account Stripe.
2. **Pagamento tra privati** — chi paga viene addebitato tramite il tuo
   account Stripe, e Stripe gira automaticamente la quota al destinatario
   (che deve prima "collegarsi" con Stripe), trattenendo la commissione per te.

Non gestiamo mai numeri di carta a mano: tutto passa dalle pagine sicure
ospitate da Stripe (Checkout e onboarding). Questo è importante non solo
per sicurezza, ma perché gestire dati di carta direttamente comporta
obblighi legali (PCI-DSS) che un sito fatto in casa non rispetta.

## 0. MongoDB Atlas — il database gratuito che tiene i tuoi dati

I dati (account, post, gruppi, notifiche, messaggi) sono salvati su
**MongoDB Atlas**, un database vero e gratuito che non si svuota mai
da solo — a differenza di file salvati direttamente sul server, che
su Render (piano gratuito) verrebbero persi a ogni riavvio.

**Come crearlo, gratis, senza carta di credito:**

1. Vai su https://www.mongodb.com/cloud/atlas/register e registrati
2. Quando ti chiede di creare un cluster, scegli il piano **"M0 Free"**
   (gratuito per sempre) — scegli un provider/regione qualsiasi, va bene
   anche quello proposto di default
3. Ti chiederà di creare un utente database: scegli un nome utente e
   una password (salvale, ti servono subito dopo) — **diversi** dalle
   tue credenziali personali di Atlas
4. In **"Network Access"** (menu a sinistra) → **Add IP Address** →
   scegli **"Allow access from anywhere"** (0.0.0.0/0) — per un progetto
   così va bene, altrimenti Render non riuscirebbe a collegarsi
5. Torna sul cluster → **Connect** → **Drivers** → copia la stringa che
   inizia con `mongodb+srv://...` — dentro c'è un segnaposto `<password>`:
   sostituiscilo con la password scelta al punto 3
6. Metti quella stringa completa in `.env` come `MONGODB_URI`

## 1. Crea un account Stripe

Vai su https://dashboard.stripe.com/register — è gratuito, si paga solo
una commissione su ogni transazione andata a buon fine.

Assicurati che il tuo account abbia **Stripe Connect** attivo (Dashboard
→ Connect → Impostazioni): serve per collegare gli account dei singoli
sviluppatori che ricevono pagamenti tra privati.

## 2. Configura le chiavi

```bash
cp .env.example .env
```

Apri `.env` e incolla:
- `STRIPE_SECRET_KEY` — da Dashboard → Sviluppatori → Chiavi API. Usa
  prima quella **di test** (`sk_test_...`) per provare tutto senza
  spendere soldi veri (Stripe fornisce numeri di carta di test).
- `FRONTEND_URL` — l'indirizzo dove hai pubblicato `prodevunity-site.html`.

## 3. Installa e avvia in locale

```bash
npm install
npm start
```

Il server parte su `http://localhost:4242`.

## 4. Collega il webhook (necessario per registrare i pagamenti)

In locale, installa la Stripe CLI (https://stripe.com/docs/stripe-cli) e lancia:

```bash
stripe listen --forward-to localhost:4242/api/webhook
```

Ti darà un `whsec_...` da mettere in `STRIPE_WEBHOOK_SECRET` nel `.env`.

In produzione, crea l'endpoint webhook da Dashboard → Sviluppatori →
Webhook, puntando a `https://tuo-backend.esempio.com/api/webhook`,
evento da ascoltare: `checkout.session.completed`. Copia il "signing
secret" che ti danno nello stesso posto.

## 5. Metti il backend online

Il modo più semplice è un servizio che tenga il processo Node sempre
acceso, ad esempio Render.com, Railway.app o Fly.io:

1. Carica questa cartella su un repository GitHub.
2. Collega il repository al servizio scelto.
3. Comando di avvio: `npm start`.
4. Aggiungi le stesse variabili di `.env` nelle impostazioni del servizio.
5. Una volta online, prendi l'URL pubblico (es. `https://prodevunity-backend.onrender.com`).

## 6. Collega il sito al backend

Apri `prodevunity-site.html`, cerca la riga:

```js
const API_BASE = "";
```

e mettici l'URL del backend appena pubblicato, ad esempio:

```js
const API_BASE = "https://prodevunity-backend.onrender.com";
```

## 7. Quando sei pronto per soldi veri

Passa da `sk_test_...` a `sk_live_...` nel `.env` (e ricrea il webhook
in modalità live, con il suo `whsec_...` live). Da quel momento i
pagamenti muovono soldi reali.

## 8. Email reale per il codice di conferma

Per inviare davvero il codice di conferma via email (invece di mostrarlo
a schermo, che è solo per la demo), il backend usa il tuo account Gmail:

1. Sul tuo account Google, attiva la **verifica in due passaggi** (se non
   ce l'hai già): https://myaccount.google.com/security
2. Vai su https://myaccount.google.com/apppasswords e crea una nuova
   "password per le app" (scegli un nome qualsiasi, es. "ProDevUnity").
   Google ti mostra una password di 16 caratteri: copiala.
3. Nel `.env` (o nelle variabili d'ambiente del tuo hosting) imposta:
   - `EMAIL_USER` = il tuo indirizzo Gmail
   - `EMAIL_APP_PASSWORD` = la password per le app appena generata
     (NON la password normale del tuo account Google)
   - `EMAIL_FROM` = di solito lo stesso indirizzo di `EMAIL_USER`

Da quel momento, ogni nuova registrazione riceve davvero un'email con
il codice, invece di mostrarlo in pagina.

**Limite di Gmail**: l'account gratuito ha un limite di circa 500 email
al giorno — va benissimo per iniziare, ma se il sito cresce molto
conviene passare a un servizio dedicato per l'invio email transazionale
(es. Resend, SendGrid, Postmark).

**Nota sui numeri di telefono**: questo sistema invia solo email. Se
qualcuno si registra con un numero di telefono invece di un'email, il
sito continua a mostrare il codice a schermo (demo) perché inviare un
vero SMS richiederebbe un servizio a parte (es. Twilio) — dimmi se
vuoi che aggiunga anche quello.

## 9. SMS reale per chi si registra con un numero di telefono

Per inviare davvero un SMS (invece di mostrare il codice a schermo)
serve Twilio (twilio.com), un servizio a pagamento (pochi centesimi a
messaggio) ma con un credito di prova gratuito all'iscrizione:

1. Crea un account su https://www.twilio.com/try-twilio
2. Nella dashboard trovi subito **Account SID** e **Auth Token**: copiali
3. Compra (o attiva, con il credito di prova) un numero di telefono
   Twilio da cui partiranno gli SMS: Dashboard → Phone Numbers → Buy a number
4. Nel `.env` (o nelle variabili d'ambiente del tuo hosting) imposta:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_PHONE_NUMBER` — il numero Twilio appena preso, formato
     internazionale (es. `+15551234567`)
   - `TWILIO_DEFAULT_COUNTRY_CODE` — il prefisso da aggiungere se un
     utente scrive il numero senza (default `+39` per l'Italia)

**Account di prova Twilio**: finché non passi a un account a
pagamento, puoi mandare SMS reali solo a numeri che hai prima
"verificato" tu stesso nella dashboard Twilio (Verified Caller IDs) —
è una limitazione di Twilio per i nuovi account, non del nostro
codice. Per mandare SMS a chiunque si registri, serve passare
all'account a pagamento (bastano pochi euro di credito).

## Limiti di questa versione

- Il piano gratuito M0 di MongoDB Atlas basta per una community non
  enorme (512 MB di dati, decine di migliaia di post/messaggi); se il
  sito crescesse molto, Atlas offre piani a pagamento senza dover
  cambiare codice.
- Le password degli account sono salvate in chiaro nel database (niente
  hashing) — accettabile per una fase di test con pochi utenti fidati,
  ma da correggere (es. con bcrypt) prima di trattarlo come un sito serio
  con dati sensibili.
- Chi vuole ricevere pagamenti tra privati deve completare l'onboarding
  Stripe (documento d'identità, IBAN, ecc.) — è Stripe stessa a
  richiederlo per legge, non è qualcosa che possiamo saltare.
