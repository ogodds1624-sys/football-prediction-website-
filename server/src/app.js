import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  endAdminSession,
  endSession,
  findUserById,
  hashPassword,
  loadUser,
  publicUser,
  requireAdmin,
  requireUser,
  safeEqual,
  startAdminSession,
  startSession,
  verifyPassword,
} from "./auth.js";
import { config } from "./config.js";
import { execute, one } from "./db.js";
import { HttpError, ProviderError } from "./errors.js";
import { confirmPayment, findPayment, publicPayment, startPayment } from "./payments.js";
import { PLANS } from "./plans.js";
import { enabledProviders, getProvider } from "./providers/index.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BOOKING_CODE_PATTERN = /^[A-Z0-9]{4,20}$/;

function dateFrom(value) {
  const date = String(value || "");
  if (!DATE_PATTERN.test(date)) {
    throw new HttpError(400, "Invalid date.");
  }
  return date;
}

async function bookingCodeFor(date) {
  const row = await one("SELECT code FROM booking_codes WHERE date = ?", [date]);
  return row ? row.code : null;
}

const findUserByEmail = (email) => one("SELECT * FROM users WHERE email = ?", [email]);

function webhookHandler(providerName) {
  return async (req, res) => {
    const provider = getProvider(providerName);
    // req.body is the raw Buffer here; the signature is computed over the exact bytes.
    if (!provider || !Buffer.isBuffer(req.body) || !provider.isValidWebhook(req.body, req.headers)) {
      res.sendStatus(401);
      return;
    }

    let event;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      res.sendStatus(400);
      return;
    }

    const reference = provider.referenceFromWebhook(event);
    if (reference) {
      // Never trust the webhook body for amount or status: confirmPayment
      // asks the provider's API again before upgrading anyone.
      await confirmPayment(reference);
    }
    res.sendStatus(200);
  };
}

// limitRequests can be turned off for automated tests, which all share one IP.
export function createApp({ limitRequests = true } = {}) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // The site uses inline scripts and a CDN text reader, so the default CSP is off.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Missing settings: answer clearly instead of crashing. The pages still load.
  app.use("/api", (req, res, next) => {
    if (config.problems.length) {
      res.status(503).json({ error: "Server setup incomplete.", problems: config.problems });
      return;
    }
    next();
  });

  // Webhooks need the raw body to check signatures, so they come before express.json().
  const rawJson = express.raw({ type: "application/json", limit: "100kb" });
  app.post("/api/webhooks/paystack", rawJson, webhookHandler("paystack"));
  app.post("/api/webhooks/flutterwave", rawJson, webhookHandler("flutterwave"));

  app.use(express.json({ limit: "20kb" }));
  app.use(loadUser);

  // Browsers cannot send cross-site JSON without a CORS preflight (which we
  // never allow), so requiring JSON on writes blocks CSRF from other sites.
  app.use("/api", (req, res, next) => {
    if (req.method === "POST" && !req.is("application/json")) {
      res.status(415).json({ error: "Send JSON." });
      return;
    }
    next();
  });

  const noLimit = (req, res, next) => next();
  // Only failed sign-ins count, so many people on one mobile network IP are not blocked.
  const authLimiter = limitRequests
    ? rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, skipSuccessfulRequests: true, standardHeaders: "draft-8", legacyHeaders: false })
    : noLimit;
  // Counted per account (requireUser runs first), not per IP.
  const paymentLimiter = limitRequests
    ? rateLimit({ windowMs: 60 * 1000, limit: 10, keyGenerator: (req) => `user:${req.user.id}`, standardHeaders: "draft-8", legacyHeaders: false })
    : noLimit;

  /* ---------- Accounts ---------- */

  app.post("/api/auth/register", authLimiter, async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!EMAIL_PATTERN.test(email) || email.length > 200) {
      throw new HttpError(400, "Enter a valid email address.");
    }
    if (password.length < 8 || password.length > 200) {
      throw new HttpError(400, "Password must be at least 8 characters.");
    }
    if (await findUserByEmail(email)) {
      throw new HttpError(409, "An account with this email already exists. Sign in instead.");
    }
    const user = await one(
      "INSERT INTO users (email, password_hash) VALUES (?, ?) RETURNING id, email, plan, plan_expires_at",
      [email, await hashPassword(password)],
    );
    startSession(res, user.id);
    res.status(201).json({ user: publicUser(user) });
  });

  app.post("/api/auth/login", authLimiter, async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const user = await findUserByEmail(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw new HttpError(401, "Wrong email or password.");
    }
    startSession(res, user.id);
    res.json({ user: publicUser(user) });
  });

  app.post("/api/auth/logout", (req, res) => {
    endSession(res);
    res.json({ ok: true });
  });

  app.get("/api/me", (req, res) => {
    res.json({ user: req.user ? publicUser(req.user) : null });
  });

  /* ---------- Booking codes ---------- */

  // Signed-in users only, so the code never appears in the public page.
  app.get("/api/booking-code", requireUser, async (req, res) => {
    res.json({ code: await bookingCodeFor(dateFrom(req.query.date)) });
  });

  /* ---------- Admin ---------- */

  app.post("/api/admin/login", authLimiter, (req, res) => {
    if (!config.adminPasscode) {
      throw new HttpError(503, "Admin sign-in is not set up. Add ADMIN_PASSCODE to the server settings.");
    }
    if (!safeEqual(String(req.body?.passcode || ""), config.adminPasscode)) {
      throw new HttpError(401, "Incorrect passcode. Try again.");
    }
    startAdminSession(res);
    res.json({ ok: true });
  });

  app.post("/api/admin/logout", (req, res) => {
    endAdminSession(res);
    res.json({ ok: true });
  });

  app.get("/api/admin/booking-code", requireAdmin, async (req, res) => {
    res.json({ code: await bookingCodeFor(dateFrom(req.query.date)) });
  });

  // An empty code removes the day's booking code.
  app.post("/api/admin/booking-code", requireAdmin, async (req, res) => {
    const date = dateFrom(req.body?.date);
    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!code) {
      await execute("DELETE FROM booking_codes WHERE date = ?", [date]);
      res.json({ code: null });
      return;
    }
    if (!BOOKING_CODE_PATTERN.test(code)) {
      throw new HttpError(400, "Booking codes are 4 to 20 letters and numbers.");
    }
    await execute(
      `INSERT INTO booking_codes (date, code) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET code = excluded.code, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      [date, code],
    );
    res.json({ code });
  });

  /* ---------- Payments ---------- */

  app.get("/api/payments/options", (req, res) => {
    res.json({
      currency: config.currency,
      providers: enabledProviders(),
      plans: Object.values(PLANS).map((plan) => ({ id: plan.id, name: plan.name, amount: plan.amount / 100, days: plan.days })),
    });
  });

  app.post("/api/payments/initialize", requireUser, paymentLimiter, async (req, res) => {
    const siteUrl = config.appUrl || `${req.protocol}://${req.get("host")}`;
    const { checkoutUrl, reference } = await startPayment(req.user, req.body?.provider, req.body?.plan, siteUrl);
    res.json({ checkoutUrl, reference });
  });

  // The provider redirects the user here after checkout. We verify, then show the result page.
  app.get("/api/payments/callback/:provider", async (req, res) => {
    const reference = String(req.query.reference || req.query.tx_ref || "");
    if (reference) {
      try {
        await confirmPayment(reference);
      } catch (error) {
        // The result page re-checks, and the webhook will confirm it later.
        console.error(`Callback verification failed for ${reference}:`, error.message);
      }
    }
    res.redirect(303, `/payment-result.html?reference=${encodeURIComponent(reference)}`);
  });

  app.get("/api/payments/:reference", requireUser, async (req, res) => {
    let payment = await findPayment(req.params.reference);
    if (!payment || payment.user_id !== req.user.id) {
      throw new HttpError(404, "Payment not found.");
    }
    if (payment.status === "pending") {
      payment = (await confirmPayment(payment.reference)) || payment;
    }
    const user = await findUserById(req.user.id);
    res.json({ payment: publicPayment(payment), user: publicUser(user) });
  });

  app.use("/api", (req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  /* ---------- Front-end ---------- */

  // The site files sit next to server/, so never serve the server folder itself.
  app.use((req, res, next) => {
    if (/^\/server(\/|$)/i.test(req.path)) {
      res.sendStatus(404);
      return;
    }
    next();
  });
  app.use(express.static(config.siteDir, { dotfiles: "deny", index: "index.html" }));

  /* ---------- Errors ---------- */

  app.use((error, req, res, next) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    // Two sign-ups with the same email at the same moment.
    if (/UNIQUE constraint failed: users\.email/i.test(error.message)) {
      res.status(409).json({ error: "An account with this email already exists. Sign in instead." });
      return;
    }
    if (error.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON." });
      return;
    }
    console.error(error);
    if (error instanceof ProviderError) {
      res.status(502).json({ error: "The payment could not be started. Please try again in a moment." });
      return;
    }
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  return app;
}

