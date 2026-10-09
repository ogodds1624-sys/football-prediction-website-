import path from "node:path";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  endAdminSession,
  endSession,
  findUserById,
  hashPassword,
  loadUser,
  markSeen,
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
import { COUNTRIES, getGateway, publicCheckout, saveCheckout, saveRates, usdtFromGhs } from "./gateway.js";
import {
  createMatches,
  deleteMatch,
  matchesForDate,
  matchFrom,
  monthSummary,
  oddsTotalsFor,
  publicMatch,
  saveOddsTotal,
  setResult,
  unlockedTiers,
  updateMatch,
} from "./matches.js";
import {
  confirmManualPayment,
  rejectManualPayment,
  confirmPayment,
  findPayment,
  listManualPayments,
  manualPaymentStatus,
  manualReceipt,
  publicPayment,
  startPayment,
  submitManualPayment,
} from "./payments.js";
import { activatePlan, checkRecovery, heldPlanCounts, listMembers, memberTotals, shiftDate, todayKey } from "./recovery.js";
import { PLANS, publicPlanPrices, readPlanSlots, savePlanPrices, savePlanSlots } from "./plans.js";
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

// Shared checks for reviews from members and from the admin.
function reviewFrom(body) {
  const review = {
    name: String(body?.name || "").trim().slice(0, 40),
    location: String(body?.location || "").trim().slice(0, 40),
    message: String(body?.message || "").trim().slice(0, 280),
    rating: Number(body?.rating),
  };
  if (!review.name || review.message.length < 5) {
    throw new HttpError(400, "Enter a name and a message of at least 5 characters.");
  }
  if (!Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5) {
    throw new HttpError(400, "Choose a rating from 1 to 5 stars.");
  }
  return review;
}

const BOOKING_TIERS = new Set(["free", "vip", "vvip", "recovery"]);

function bookingTier(value, fallback = "") {
  const tier = String(value || fallback);
  if (!BOOKING_TIERS.has(tier)) {
    throw new HttpError(400, "Choose a table for this booking code.");
  }
  return tier;
}

async function bookingCodeFor(date, tier) {
  const row = await one("SELECT code FROM booking_codes WHERE date = ? AND tier = ?", [date, tier]);
  return row ? row.code : null;
}

async function bookingCodesFor(date) {
  const { rows } = await execute("SELECT tier, code FROM booking_codes WHERE date = ?", [date]);
  return Object.fromEntries(rows.map((row) => [row.tier, row.code]));
}

const findUserByEmail = (email) => one("SELECT * FROM users WHERE email = ?", [email]);

// The name shown in the header: 2-60 characters, spaces tidied.
function readName(body) {
  const name = String(body?.name || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 60) {
    throw new HttpError(400, "Enter your name.");
  }
  return name;
}

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

  // Matches can carry a shrunk picture, so their admin routes accept larger bodies.
  const smallJson = express.json({ limit: "20kb" });
  const largeJson = express.json({ limit: "8mb" });
  app.use((req, res, next) =>
    (req.path.startsWith("/api/admin/matches") || req.path === "/api/payments/manual" ? largeJson : smallJson)(req, res, next),
  );
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
  // A few review submissions per hour per account.
  const reviewLimiter = limitRequests
    ? rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, keyGenerator: (req) => `review:${req.user.id}`, standardHeaders: "draft-8", legacyHeaders: false })
    : noLimit;
  const paymentLimiter = limitRequests
    ? rateLimit({ windowMs: 60 * 1000, limit: 10, keyGenerator: (req) => `user:${req.user.id}`, standardHeaders: "draft-8", legacyHeaders: false })
    : noLimit;

  /* ---------- Accounts ---------- */

  app.post("/api/auth/register", authLimiter, async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const name = readName(req.body);
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
      "INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?) RETURNING id, email, name, plan, plan_expires_at, country",
      [email, name, await hashPassword(password)],
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
    await markSeen(user);
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

  // Accounts made before sign-up asked for a name add one here.
  app.post("/api/me/name", requireUser, async (req, res) => {
    const user = await one(
      "UPDATE users SET name = ? WHERE id = ? RETURNING id, email, name, plan, plan_expires_at, country",
      [readName(req.body), req.user.id],
    );
    res.json({ user: publicUser(user) });
  });

  // Chosen on country.html after the account is created.
  app.post("/api/me/country", requireUser, async (req, res) => {
    const country = String(req.body?.country || "").trim().toLowerCase();
    if (!COUNTRIES.includes(country)) {
      throw new HttpError(400, "Choose a country.");
    }
    const user = await one(
      "UPDATE users SET country = ? WHERE id = ? RETURNING id, email, name, plan, plan_expires_at, country",
      [country, req.user.id],
    );
    res.json({ user: publicUser(user) });
  });

  /* ---------- Booking codes ---------- */

  // Signed-in users only, so the code never appears in the public page.
  app.get("/api/booking-code", requireUser, async (req, res) => {
    const tier = bookingTier(req.query.tier, "free");
    res.json({ code: await bookingCodeFor(dateFrom(req.query.date), tier) });
  });

  /* ---------- Predictions ---------- */

  // Signed-in members see free tips; VIP/VVIP tips only reach members with that plan.
  // Visitors see teams and odds only.
  app.get("/api/matches", async (req, res) => {
    const plan = req.user ? publicUser(req.user).plan : null;
    const unlocked = unlockedTiers(plan, req.user);
    // Recovery bonus tips are only given out through /api/recovery.
    const date = dateFrom(req.query.date);
    const matches = (await matchesForDate(date)).filter((match) => match.tier !== "recovery");
    const totals = await oddsTotalsFor(date);
    res.json({
      plan,
      matches: matches.map((match) => publicMatch(match, unlocked)),
      oddsTotals: { free: totals.free, vip: totals.vip, vvip: totals.vvip },
    });
  });

  // Which days of a month have predictions, with won/lost counts (no tips).
  app.get("/api/matches/month", async (req, res) => {
    res.json({ days: await monthSummary(req.query.month) });
  });

  /* ---------- Recovery tickets ---------- */

  // The member confirms their email; it must be the account they're signed in
  // with (signing in proved they own it). Then the purchase rules are checked.
  app.post("/api/recovery", requireUser, async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (email !== String(req.user.email).toLowerCase()) {
      throw new HttpError(400, "That email doesn't match the account you're signed in with.");
    }
    // The browser sends its own "today"; allow a day either side for time zones.
    const date = dateFrom(req.body?.date);
    const server = todayKey();
    if (date < shiftDate(server, -1) || date > shiftDate(server, 1)) {
      throw new HttpError(400, "Check your device's date and try again.");
    }
    res.json(await checkRecovery(req.user.id, date));
  });

  /* ---------- Testimonials ---------- */

  // Only reviews the admin has accepted are public.
  app.get("/api/testimonials", async (req, res) => {
    const { rows } = await execute(
      "SELECT name, location, rating, message FROM testimonials WHERE status = 'approved' ORDER BY id DESC LIMIT 30",
    );
    res.json({ testimonials: rows });
  });

  // Signed-in members send a review; it waits for the admin to accept it.
  app.post("/api/testimonials", requireUser, reviewLimiter, async (req, res) => {
    const review = reviewFrom(req.body);
    const waiting = await one("SELECT id FROM testimonials WHERE user_id = ? AND status = 'pending'", [req.user.id]);
    if (waiting) {
      throw new HttpError(409, "Your last review is still waiting for approval. Thanks for your patience!");
    }
    await execute(
      "INSERT INTO testimonials (name, location, rating, message, status, user_id) VALUES (?, ?, ?, ?, 'pending', ?)",
      [review.name, review.location, review.rating, review.message, req.user.id],
    );
    res.status(201).json({ ok: true });
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

  app.get("/api/admin/testimonials", requireAdmin, async (req, res) => {
    const { rows } = await execute(
      "SELECT id, name, location, rating, message, status, created_at FROM testimonials ORDER BY id DESC",
    );
    res.json({ testimonials: rows });
  });

  // Reviews the admin adds directly are shown straight away.
  app.post("/api/admin/testimonials", requireAdmin, async (req, res) => {
    const review = reviewFrom(req.body);
    const testimonial = await one(
      `INSERT INTO testimonials (name, location, rating, message, status) VALUES (?, ?, ?, ?, 'approved')
       RETURNING id, name, location, rating, message, status, created_at`,
      [review.name, review.location, review.rating, review.message],
    );
    res.status(201).json({ testimonial });
  });

  app.post("/api/admin/testimonials/approve", requireAdmin, async (req, res) => {
    await execute("UPDATE testimonials SET status = 'approved' WHERE id = ?", [Number(req.body?.id)]);
    res.json({ ok: true });
  });

  app.post("/api/admin/testimonials/delete", requireAdmin, async (req, res) => {
    await execute("DELETE FROM testimonials WHERE id = ?", [Number(req.body?.id)]);
    res.json({ ok: true });
  });

  app.get("/api/admin/matches", requireAdmin, async (req, res) => {
    const date = dateFrom(req.query.date);
    res.json({ matches: await matchesForDate(date), oddsTotals: await oddsTotalsFor(date) });
  });

  // Empty total clears the typed figure and Buy Plan multiplies the match odds again.
  app.post("/api/admin/odds-total", requireAdmin, async (req, res) => {
    const date = dateFrom(req.body?.date);
    const tier = String(req.body?.tier || "");
    res.json({ tier, total: await saveOddsTotal(date, tier, req.body?.total) });
  });

  // One match, or several at once (e.g. read from a SportyBet slip).
  app.post("/api/admin/matches", requireAdmin, async (req, res) => {
    const date = dateFrom(req.body?.date);
    const list = Array.isArray(req.body?.matches) ? req.body.matches : [req.body];
    if (!list.length || list.length > 50) {
      throw new HttpError(400, "Send between 1 and 50 matches.");
    }
    const matches = list.map((match) => matchFrom(match));
    res.status(201).json({ matches: await createMatches(date, matches) });
  });

  app.post("/api/admin/matches/update", requireAdmin, async (req, res) => {
    res.json({ match: await updateMatch(Number(req.body?.id), matchFrom(req.body)) });
  });

  app.post("/api/admin/matches/result", requireAdmin, async (req, res) => {
    await setResult(Number(req.body?.id), String(req.body?.result || ""));
    res.json({ ok: true });
  });

  app.post("/api/admin/matches/delete", requireAdmin, async (req, res) => {
    await deleteMatch(Number(req.body?.id));
    res.json({ ok: true });
  });

  app.get("/api/admin/members", requireAdmin, async (req, res) => {
    res.json({ totals: await memberTotals(), members: await listMembers() });
  });

  // Record a paid plan (e.g. MoMo) for a member's account.
  app.post("/api/admin/members/activate", requireAdmin, async (req, res) => {
    const date = req.body?.date ? dateFrom(req.body.date) : todayKey();
    res.status(201).json(await activatePlan(req.body?.email, req.body?.plan, date));
  });

  app.get("/api/admin/gateway", requireAdmin, async (req, res) => {
    res.json(await getGateway());
  });

  app.post("/api/admin/gateway/checkout", requireAdmin, async (req, res) => {
    res.json({ checkout: await saveCheckout(req.body) });
  });

  app.post("/api/admin/gateway/rates", requireAdmin, async (req, res) => {
    res.json({ rates: await saveRates(req.body) });
  });

  app.get("/api/admin/booking-code", requireAdmin, async (req, res) => {
    const date = dateFrom(req.query.date);
    if (req.query.tier) {
      res.json({ code: await bookingCodeFor(date, bookingTier(req.query.tier)) });
      return;
    }
    res.json({ codes: await bookingCodesFor(date) });
  });

  // An empty code removes that table's code for the day. A missing tier keeps the old free-table default.
  app.post("/api/admin/booking-code", requireAdmin, async (req, res) => {
    const date = dateFrom(req.body?.date);
    const tier = bookingTier(req.body?.tier, "free");
    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!code) {
      await execute("DELETE FROM booking_codes WHERE date = ? AND tier = ?", [date, tier]);
      res.json({ code: null, tier });
      return;
    }
    if (!BOOKING_CODE_PATTERN.test(code)) {
      throw new HttpError(400, "Booking codes are 4 to 20 letters and numbers.");
    }
    await execute(
      `INSERT INTO booking_codes (date, tier, code) VALUES (?, ?, ?)
       ON CONFLICT(date, tier) DO UPDATE SET code = excluded.code, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      [date, tier, code],
    );
    res.json({ code, tier });
  });

  /* ---------- Payments ---------- */

  // Public: plan prices, online providers and the manual checkout details.
  async function slotView() {
    const caps = await readPlanSlots();
    const taken = await heldPlanCounts();
    const left = (tier) => (caps[tier] == null ? null : Math.max(0, caps[tier] - taken[tier]));
    return {
      caps,
      available: { vip: left("vip"), vvip: left("vvip") },
    };
  }

  app.get("/api/payments/options", async (req, res) => {
    const prices = await publicPlanPrices();
    const { available } = await slotView();
    const checkout = await publicCheckout();
    res.json({
      currency: config.currency,
      providers: enabledProviders(),
      plans: Object.values(PLANS).map((plan) => ({
        id: plan.id,
        name: plan.name,
        amount: prices[plan.id],
        days: plan.days,
        usdtAmount: usdtFromGhs(prices[plan.id], {
          ngn: checkout.usdt.ngnPerGhs,
          usdtNgn: checkout.usdt.ngnPerUsdt,
        }).amount,
      })),
      slots: available,
      checkout,
    });
  });

  app.get("/api/admin/slots", requireAdmin, async (req, res) => {
    res.json(await slotView());
  });

  app.post("/api/admin/slots", requireAdmin, async (req, res) => {
    await savePlanSlots(req.body);
    res.json(await slotView());
  });

  app.get("/api/admin/plans", requireAdmin, async (req, res) => {
    res.json({ currency: config.currency, plans: await publicPlanPrices() });
  });

  app.post("/api/admin/plans", requireAdmin, async (req, res) => {
    const plans = await savePlanPrices(req.body);
    res.json({ currency: config.currency, plans });
  });

  app.post("/api/payments/initialize", requireUser, paymentLimiter, async (req, res) => {
    const siteUrl = config.appUrl || `${req.protocol}://${req.get("host")}`;
    const { checkoutUrl, reference } = await startPayment(req.user, req.body?.provider, req.body?.plan, siteUrl);
    res.json({ checkoutUrl, reference });
  });

  // A member has sent the transfer and uploaded the receipt.
  app.post("/api/payments/manual", requireUser, paymentLimiter, async (req, res) => {
    const payment = await submitManualPayment(req.user, req.body);
    res.status(201).json(payment);
  });

  // Whether this member already has a receipt waiting for this plan.
  app.get("/api/payments/manual", requireUser, async (req, res) => {
    const payment = await manualPaymentStatus(req.user.id, String(req.query.plan || ""));
    res.json({ payment });
  });

  app.get("/api/admin/manual-payments", requireAdmin, async (req, res) => {
    const { rows } = await listManualPayments();
    res.json({
      payments: rows.map((payment) => ({
        id: Number(payment.id),
        name: payment.name || "",
        email: payment.email,
        plan: payment.plan,
        amount: payment.amount / 100,
        currency: payment.currency,
        network: payment.network,
        status: payment.status,
        createdAt: payment.created_at,
      })),
    });
  });

  app.get("/api/admin/manual-payments/:id/receipt", requireAdmin, async (req, res) => {
    const receipt = await manualReceipt(Number(req.params.id));
    if (!receipt) {
      res.status(404).json({ error: "Receipt not found." });
      return;
    }
    res.set("Content-Type", receipt.type);
    res.set("Content-Disposition", "inline");
    res.set("Cache-Control", "private, no-store");
    res.send(receipt.bytes);
  });

  app.post("/api/admin/manual-payments/:id/confirm", requireAdmin, async (req, res) => {
    await confirmManualPayment(Number(req.params.id));
    res.json({ ok: true });
  });

  app.post("/api/admin/manual-payments/:id/reject", requireAdmin, async (req, res) => {
    await rejectManualPayment(Number(req.params.id));
    res.json({ ok: true });
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
  // The passcode page is admin.html. /admin is the address people type.
  // A route of "/admin/" also matches "/admin" when strict routing is off, so check the path here.
  app.use((req, res, next) => {
    if (req.path === "/admin/") {
      res.redirect(308, "/admin");
      return;
    }
    if (req.path === "/admin") {
      res.sendFile(path.join(config.siteDir, "admin.html"));
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
    if (error.type === "entity.too.large") {
      res.status(413).json({ error: "The submitted data is too large. Try a smaller file." });
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

