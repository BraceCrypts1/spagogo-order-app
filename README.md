# Spagogo Order App

Ordering and payment site for **Fatima Spagogo**, a small spaghetti-delivery kitchen in Ibafo & Mowe, Ogun State, Nigeria.
A customer picks a meal, pays by card / bank transfer / USSD, and the kitchen receives a **paid** order on WhatsApp — no unpaid orders, no price set by the browser.

**Live demo (Paystack test mode):** https://lustrous-meerkat-6dc043.netlify.app
Test card: `4084 0840 8408 4081`, any future expiry, CVV `408`. No real money moves.

## What it does

- Order form with guest checkout; optional customer accounts (email + password, email confirmation, password reset).
- Server-side pricing: item × quantity + delivery fee (Ibafo free, Mowe from ₦500). The browser only sends *what* was chosen.
- Paystack checkout, then a signature-verified webhook approves the order.
- Confirmation page that asks the server whether the order is really paid before showing the WhatsApp hand-off button.
- Loyalty points: 1 point per ₦100, computed by a Postgres trigger on approved orders only.
- "My orders" page: order history with status (✓ approved, ✗ rejected, ● pending) and points.
- FAQ chatbot (Gemini) with structured output; an order intent in the chat pre-fills the form.

## How a payment flows

```
browser                 Netlify functions                 Paystack            Supabase (Postgres)
  │ Place Order ─────────▶ pay.mjs                                               │
  │                         validate, price in kobo ──────────────────────────▶ insert order (pending, amount)
  │                         initialize ────────────────▶ authorization_url      │
  │                         store reference ──────────────────────────────────▶ paystack_reference
  │ ◀── redirect to checkout                                                    │
  │ pays on Paystack ─────────────────────────────────▶                          │
  │                       paystack-webhook.mjs ◀─────── charge.success           │
  │                         HMAC-SHA512 check, amount + currency check ───────▶ status = approved → trigger awards points
  │ back on site ────────▶ verify-payment.mjs ──(if still pending)──▶ verify    │
  │ ◀── paid / failed / pending / error                                         │
  │ "Send order to kitchen on WhatsApp" (only when paid)                        │
```

Orders are created and their status changed only by the server functions, using the Supabase **secret** key. Row Level Security on `orders` gives the browser's publishable key no INSERT/UPDATE/DELETE at all and SELECT only on the signed-in customer's own rows.

## Stack

| Layer | What | Why |
|---|---|---|
| Frontend | Plain HTML / CSS / JS, no build step | Small site, fast on cheap phones, nothing to maintain |
| Hosting + API | Netlify (static + Functions, modern `Request`/`Response` format) | Free tier, Git deploys, secrets stay in env vars |
| Database + Auth | Supabase (Postgres, RLS, email auth with custom SMTP) | Real Postgres with row-level policies and triggers |
| Payments | Paystack (Standard checkout + webhooks) | Nigerian cards, transfers and USSD; test mode for the demo |
| Chatbot | Gemini via `chat.js` | Structured JSON output → safe form pre-fill |

## Security decisions

- **Prices, delivery fees and totals are computed on the server** (`pay.mjs`). Client-sent amounts, statuses or user ids are ignored.
- **Webhook signature is mandatory**: HMAC-SHA512 of the raw body with the Paystack secret key, compared in constant time. Then `event`, `data.status`, `data.amount` **and** currency must all match the stored order; a mismatch marks the order `error`, never `approved`.
- **Idempotent**: Paystack retries deliveries; an approved order is never touched again, and an `error` order is never auto-approved.
- **Two key classes**: the browser has only the Supabase *publishable* key (RLS enforced); the functions use the *secret* key from Netlify env vars. No key is in the repo.
- **Logged-in orders are attributed from the access token**, verified server-side against Supabase Auth — not from a user id sent by the browser.
- **The confirmation URL leaks nothing**: `verify-payment` returns item/amount only; name, phone and address are kept in the customer's own browser for the WhatsApp message.
- Points are set by a `BEFORE INSERT OR UPDATE` trigger that overwrites any client-supplied value.

## Repository layout

```
index.html                       order form, checkout, payment result panel, chat widget
auth.js                          login / signup / forgot / reset password (Supabase Auth)
orders.html, orders.js           "My orders" page
style.css
Netlify/functions/pay.mjs        price + save order + Paystack initialize
Netlify/functions/paystack-webhook.mjs   verify signature + amount → approve
Netlify/functions/verify-payment.mjs     "is this paid?" for the return page (+ declined → rejected)
Netlify/functions/chat.js        Gemini FAQ bot
sql/                             schema changes applied to the Supabase project, in order
netlify.toml                     functions directory
```

## Configuration

Netlify → Site configuration → Environment variables (Production scope):

| Variable | Used by |
|---|---|
| `PAYSTACK_SECRET_KEY` | `pay.mjs`, `paystack-webhook.mjs`, `verify-payment.mjs` |
| `SUPABASE_SECRET_KEY` | `pay.mjs`, `paystack-webhook.mjs`, `verify-payment.mjs` |
| `GEMINI_API_KEY` | `chat.js` |

Paystack → Settings → API Keys & Webhooks → **Webhook URL**:
`https://<site>/.netlify/functions/paystack-webhook`

Supabase: run the files in `sql/` in date order; enable email confirmation; add the site URL to Auth → URL configuration → Redirect URLs.

## Path to production

This is a working demo in Paystack **test mode**. To take real orders:

1. Complete Paystack business verification, switch to live keys, register the **live** webhook URL.
2. Replace the `wa.me` hand-off with a server-side send through the **WhatsApp Business (Cloud) API** so the kitchen is notified even if the customer closes the tab.
3. Custom domain + HTTPS (Netlify handles the certificate); tighten `Access-Control-Allow-Origin` in `chat.js`.
4. Raise Supabase Auth email rate limits, or move transactional email to a dedicated provider.
5. Add a staff view of orders (currently the Supabase dashboard is the "admin").

## Local development

```
npm i -g netlify-cli
netlify functions:serve --port 9999     # functions at http://localhost:9999/.netlify/functions/<name>
```

Serve the static files with any local server (or `netlify dev`) and point the Paystack test webhook at a public tunnel — Paystack cannot call `localhost`.
