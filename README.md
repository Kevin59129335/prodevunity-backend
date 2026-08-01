# ProDevUnity — backend pagamenti reali

Questo piccolo server rende **veri** i due pagamenti del sito:

1. **Boost (1€ / 3 giorni)** — pagamento diretto sul tuo account Stripe.
2. **Pagamento tra privati** — chi paga viene addebitato tramite il tuo
   account Stripe, e Stripe gira automaticamente il 90% al destinatario
   (che deve prima "collegarsi" con Stripe), trattenendo il 10% per te.

Non gestiamo mai numeri di carta a mano: tutto passa dalle pagine sicure
ospitate da Stripe (Checkout e onboarding). Questo è importante non solo
per sicurezza, ma perché gestire dati di carta direttamente comporta
obblighi legali (PCI-DSS) che un sito fatto in casa non rispetta.

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

## Limiti di questa versione

- I dati (chi ha collegato Stripe, il registro dei pagamenti) sono
  salvati in due file JSON dentro `data/`. Va benissimo per partire e
  per pochi utenti, ma per un sito con traffico reale conviene
  sostituirli con un vero database (Postgres, MySQL, ecc.) — la
  struttura del codice rende il cambio abbastanza diretto: basta
  sostituire `readJSON`/`writeJSON` con le query al tuo database.
- Chi vuole ricevere pagamenti tra privati deve completare l'onboarding
  Stripe (documento d'identità, IBAN, ecc.) — è Stripe stessa a
  richiederlo per legge, non è qualcosa che possiamo saltare.
