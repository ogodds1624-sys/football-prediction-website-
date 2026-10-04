import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { endSession, hashPassword, loadUser, publicUser, requireUser, startSession, verifyPassword } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { HttpError, ProviderError } from "./errors.js";
import { confirmPayment, publicPayment, startPayment } from "./payments.js";
import { PLANS } from "./plans.js";
import { enabledProviders, getProvider } from "./providers/index.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const insertUser = db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?) RETURNING id, email, plan, plan_expires_at");
const findUserByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
const findUserPayment = db.prepare("SELECT * FROM payments WHERE reference = ? AND user_id = ?");
const findUserById = db.prepare("SELECT id, email, plan, plan_expires_at FROM users WHERE id = ?");

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
    if (findUserByEmail.get(email)) {
      throw new HttpError(409, "An account with this email already exists. Sign in instead.");
    }
    const user = insertUser.get(email, await hashPassword(password));
    startSession(res, user.id);
    res.status(201).json({ user: publicUser(user) });
  });

  app.post("/api/auth/login", authLimiter, async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const user = findUserByEmail.get(email);
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

  /* ---------- Payments ---------- */

  app.get("/api/payments/options", (req, res) => {
    res.json({
      currency: config.currency,
      providers: enabledProviders(),
      plans: Object.values(PLANS).map((plan) => ({ id: plan.id, name: plan.name, amount: plan.amount / 100, days: plan.days })),
    });
  });

  app.post("/api/payments/initialize", requireUser, paymentLimiter, async (req, res) => {
    const { checkoutUrl, reference } = await startPayment(req.user, req.body?.provider, req.body?.plan);
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
    let payment = findUserPayment.get(req.params.reference, req.user.id);
    if (!payment) {
      throw new HttpError(404, "Payment not found.");
    }
    if (payment.status === "pending") {
      payment = (await confirmPayment(payment.reference)) || payment;
    }
    const user = findUserById.get(req.user.id);
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

