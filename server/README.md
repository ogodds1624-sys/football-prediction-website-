# Football Predictions – payments server

Accounts plus VIP/VVIP payments through **Paystack** and **Flutterwave**.
**WEEKLY ROLLOVER** is a separate paid prediction table with seven-day access.
Its initial Ghana price is GHS 100; base and country-specific prices and slot
limits are editable in the Control Room. It supports screenshot uploads,
tips, results, total odds, booking codes, online payments and manual receipts.
Buying Weekly Rollover replaces a daily plan and starts seven days from approval.
Renewing it while active adds seven days to its expiry. Buying VIP, VVIP or Boom
while Weekly Rollover is active does not replace or extend weekly access.
It unlocks only Free and Weekly Rollover tips, not the other paid tables;
weekly purchases do not qualify for daily VIP/VVIP recovery tickets.
Existing database tables are migrated transactionally without losing records.
Runs on **Vercel** (database: **Turso**) or on your own computer (database: a local SQLite file).

In the Control Room's Members section, payment receipts appear above the account
list. The approval table lists only pending receipts; approved and rejected
receipts stay saved but no longer appear in that table.
Past approved receipts do not redirect members away from checkout: they can buy
again after expiry or renew. A pending receipt still opens the waiting screen,
and approval of that pending receipt returns the member to the predictions page.
Account and payment API responses are not cached. An open predictions page
refreshes signed-in access every ten seconds, when returning to the tab, and
before opening checkout. Approved members see their owned table's booking code
instead of another Buy Plan prompt; a failed refresh does not downgrade their
displayed plan or open checkout.
Paid members' predictions and booking codes also refresh with the access check,
even when the plan label has not changed. This replaces stale locked responses
after renewals and retries a temporary prediction-loading failure.
While the admin page is open, it checks for payments every 10 seconds and
shows a dismissible alert for new pending receipts across all admin sections.
It also checks when you return to the tab; closed-page browser notifications are
not enabled. The Nigerian email alerts below work independently of the admin page.

### Nigerian receipt email alerts

When a Nigerian member taps **I've sent the money** and successfully submits a
receipt, Gmail SMTP sends a notification to **andrewturkenterprise@gmail.com**.
This applies to all paid plans. The email includes the member's name/email, plan,
amount, bank/network, receipt ID and a Control Room link. Receipt files remain
behind admin login; they are not attached. An email is not proof of payment and
does not approve a transfer. Repeated clicks on an already pending receipt do not
send another notification. Other countries do not trigger emails.

To enable delivery on Vercel:
1. Enable **2-Step Verification** on the Gmail account used as the sender.
2. Create a Google **App Password** for this website.
3. Add `GMAIL_USER` (sender Gmail address) and `GMAIL_APP_PASSWORD` in Vercel's
   project environment variables. Do not use your normal Gmail password or paste
   either password in chat/source code.
4. Redeploy, then submit a test Nigerian receipt and check the recipient inbox.

The receipt is saved before email delivery. Missing settings, SMTP errors or a
rejected recipient leave the receipt available for approval. Delivery status
is stored and shown beside the admin receipt. Failed delivery also shows a
warning on the member's confirmation screen, including after a refresh, and
logs a server error with the receipt ID. Failed alerts are not retried
automatically; review the Control Room and fix Gmail settings for future alerts.

```
package.json          dependencies and npm scripts (run them from the repo root)
vercel.json           Vercel routing: /api/* goes to the server, everything else is the website
api/index.js          Vercel entry point
server/
  .env.example        template for your keys (copy to .env)
  src/config.js       loads and checks .env
  src/db.js           tables users + payments (Turso online, SQLite file locally)
  src/plans.js        default plan prices and durations (live prices are set in the Control Room)
  src/auth.js         passwords (scrypt) and signed login cookies
  src/providers/      paystack.js, flutterwave.js
  src/payments.js     start payment, verify, upgrade user
  src/app.js          all routes
  test/               automated tests (no real keys needed)
```

Locally it needs **Node.js 22.13 or newer** (for Node's built-in SQLite).

---

## 1. Where the API keys go

Every provider gives you two keys:

| Key | Where it lives | Can the public see it? |
|---|---|---|
| **Secret key** (`sk_...`, `FLWSECK...`) | `server/.env` only | **Never.** Anyone with it can refund, read and move your money. |
| **Public key** (`pk_...`, `FLWPUBK...`) | `.env` (optional) | Yes, it's designed for browsers. This app doesn't need it because it uses redirect checkout. |

Setup:

```bash
cd server
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Then open `.env` and paste your keys. Rules:

- `.env` is in `.gitignore`. **Never commit it, email it, or paste it in chat.**
- Never put a secret key in any `.html` or browser `.js` file. Everything in those files is visible to visitors.
- On Vercel (or any host), set the same names as **environment variables** in the dashboard instead of uploading `.env`. See section 7.
- If a secret key ever leaks, open the provider dashboard and **regenerate it** straight away.

Generate the `SESSION_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 2. Run it

From the **repo root** (the folder with `index.html`):

```bash
npm install
npm test          # 18 tests, uses fake providers, no keys needed
npm run dev       # restarts when files change
```

Open **http://localhost:3000** (not the HTML file directly, which can't reach the API).

## 3. Test in sandbox mode first

Both providers give you separate **test keys** that never move real money.

**Paystack**
1. Dashboard → toggle **Test Mode** (top of the page) → Settings → **API Keys & Webhooks**.
2. Copy the `sk_test_...` key into `PAYSTACK_SECRET_KEY`.
3. Pay with test card **4084 0840 8408 4081**, any future expiry, CVV **408**, PIN **0000**, OTP **123456**.
   Paystack's docs list more test cards and mobile-money test numbers (search "Paystack test payments").

**Flutterwave**
1. Dashboard → switch to **Test mode** → Settings → **API Keys**.
2. Copy the `FLWSECK_TEST-...` key into `FLW_SECRET_KEY`.
3. Pay with test card **5531 8866 5214 2950**, expiry **09/32**, CVV **564**, PIN **3310**, OTP **12345**.
   Flutterwave's docs list current test cards (search "Flutterwave testing helpers").

Test cards change from time to time, so check the providers' docs if one is refused.

Then walk through it: create an account → BUY PLAN → pay with a test card → you land on
`payment-result.html` showing "Payment successful", and your email in the header shows **VIP**.

## 4. How a payment works (and why it can't be faked)

```
Browser                       Your server                          Paystack / Flutterwave
   | BUY PLAN (plan only) --->  |                                          |
   |                            | price from plans.js, save "pending" ---->| initialize
   | <----- checkout URL ------ |                                          |
   | ------------------------------- user pays on provider's page -------->|
   | <------------------------- redirect to /api/payments/callback --------|
   |                            | ---- "what happened to ref X?" --------->| verify
   |                            | <--- status, amount, currency -----------|
   |                            | checks all match → mark paid + upgrade   |
   |                            | <---- webhook (signed) ------------------| (also, in background)
```

Protections in the code:

- **The browser never sends a price.** `plans.js` sets it on the server.
- **Redirects aren't trusted.** Someone can type `?status=successful` into the address bar. The server ignores that and asks the provider directly.
- **Every confirmation is checked against what we saved.** Status must be success, and reference, amount and currency must all match. A user can't pay GH₵ 1 for a GH₵ 100 plan.
- **Webhooks are checked twice.** First the signature (Paystack: HMAC-SHA512; Flutterwave: secret hash). Then the server still re-verifies with the provider's API before upgrading anyone.
- **No double upgrades.** The callback, webhook and result page may all confirm the same payment, but a database transaction applies it only once.
- **Other protections:**
  - Passwords are hashed with scrypt.
  - Login cookies are signed, `HttpOnly`, and `Secure` in production.
  - JSON-only POSTs block cross-site form attacks.
  - Sign-in and payment start are rate limited.
  - The `server/` folder is never served to the web.

## 5. Webhooks

Webhooks let the provider tell your server about a payment even if the user closes the browser before the redirect. That makes them your safety net.

**URLs to register:**

| Provider | Dashboard setting | URL |
|---|---|---|
| Paystack | Settings → API Keys & Webhooks → **Webhook URL** | `https://yourdomain.com/api/webhooks/paystack` |
| Flutterwave | Settings → Webhooks → **URL** | `https://yourdomain.com/api/webhooks/flutterwave` |

For Flutterwave, also fill in **Secret hash** with the same value as `FLW_WEBHOOK_HASH` in `.env`.
For Paystack, nothing extra is needed because it signs with your secret key.

**Testing webhooks on your own computer.** Providers can't reach `localhost`, so open a tunnel:

```bash
npx ngrok http 3000        # or: cloudflared tunnel --url http://localhost:3000
```

Use the `https://....ngrok-free.app` address it prints as the webhook URL. Set `APP_URL` to the same address and restart the server.

The server answers `200` once a webhook is handled. If verification fails because of a network problem, it answers `500` so the provider tries again later.

## 6. Going live checklist

- [ ] All tests pass (`npm test`) and a full sandbox payment works on both providers.
- [ ] Swap test keys for **live** keys (`sk_live_...`, `FLWSECK-...` without `_TEST`) in the host's environment variables.
- [ ] `NODE_ENV=production` and `APP_URL=https://yourdomain.com` (HTTPS is required; the server refuses to start without it).
- [ ] Webhook URLs registered in **live** mode on both dashboards (test and live have separate settings).
- [ ] Prices in `src/plans.js` are correct, and `CURRENCY` is enabled on your provider accounts.
- [ ] Turn on Turso backups / point-in-time restore. The database holds your users and payments.

## API reference

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` | `{ email, password }` |
| POST | `/api/auth/login` | `{ email, password }` |
| POST | `/api/auth/logout` | |
| GET | `/api/me` | current user and active plan |
| GET | `/api/payments/options` | enabled providers, base and country-specific plan prices |
| POST | `/api/payments/initialize` | `{ provider: "paystack" \| "flutterwave", plan: "vip" \| "vvip" }` → `{ checkoutUrl, reference }` |
| GET | `/api/payments/callback/:provider` | where the provider redirects the user |
| GET | `/api/payments/:reference` | the signed-in user's payment status (re-verifies if pending) |
| POST | `/api/webhooks/paystack` | signed by Paystack |
| POST | `/api/webhooks/flutterwave` | carries `verif-hash` |

## 7. Deploy on Vercel with Turso

Vercel runs the server as short-lived functions with **no lasting disk**, so the
database lives on **Turso** (hosted SQLite, free tier available).

**1. Create the Turso database**

1. Sign up at **turso.tech** → **Create database** (pick the region closest to your users).
2. Open the database → **Connect** → copy the URL (`libsql://...turso.io`).
3. **Create token** → copy it.

**2. Vercel project settings**

- **Settings → General → Root Directory:** leave it **empty** (the repo root, where `index.html` and `vercel.json` are). Do **not** set it to `server`.
- **Framework Preset:** Other.

**3. Vercel environment variables** (Settings → Environment Variables):

| Name | Value |
|---|---|
| `SESSION_SECRET` | long random string (command in section 1) |
| `TURSO_DATABASE_URL` | `libsql://...turso.io` |
| `TURSO_AUTH_TOKEN` | the Turso token |
| `PAYSTACK_SECRET_KEY` | `sk_test_...` to start |
| `FLW_SECRET_KEY` | `FLWSECK_TEST-...` to start |
| `FLW_WEBHOOK_HASH` | random string, same as in Flutterwave's dashboard |
| `CURRENCY` | `GHS` (optional) |
| `ADMIN_PASSCODE` | passcode for the Control Room (checked on the server) |
| `APP_URL` | only if you use your own domain; otherwise your `.vercel.app` address is used |

Then **Deployments → ⋯ → Redeploy**. Variables only apply to new deployments.

**4. Check it**

- Open `https://<project>.vercel.app/api/payments/options`. It should list your plans and providers. If a setting is missing, it lists exactly which ones instead (the website pages keep working either way).
- If something fails, open **Deployments → the deployment → Logs**. A missing variable is named in the error, e.g. *"Missing environment variable TURSO_DATABASE_URL"*.
- Webhook URLs become `https://<project>.vercel.app/api/webhooks/paystack` and `.../flutterwave`.

Note: on Vercel the rate limits are counted per function instance, so they're a light
safeguard there. Payment safety does not depend on them; it comes from server-side
verification.
