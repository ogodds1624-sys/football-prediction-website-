import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

// Configure before the app is imported. Values here are fake test settings.
process.env.APP_URL = "http://localhost:3000";
process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-chars";
process.env.CURRENCY = "GHS";
process.env.DATABASE_FILE = ":memory:";
process.env.PAYSTACK_SECRET_KEY = "sk_test_fake";
process.env.FLW_SECRET_KEY = "FLWSECK_TEST-fake";
process.env.FLW_WEBHOOK_HASH = "flw-test-hash";
process.env.ADMIN_PASSCODE = "8057";

const { createApp } = await import("../src/app.js");
const { PLANS } = await import("../src/plans.js");

/* ---------- Fake payment providers ---------- */

const realFetch = globalThis.fetch;
// reference -> what the provider will report when asked to verify it
const providerRecords = new Map();
let initializeCalls = [];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.startsWith("https://api.paystack.co")) {
    if (target.endsWith("/transaction/initialize")) {
      const body = JSON.parse(options.body);
      initializeCalls.push({ provider: "paystack", ...body });
      return json({ status: true, data: { authorization_url: `https://checkout.paystack.com/${body.reference}` } });
    }
    const reference = decodeURIComponent(target.split("/transaction/verify/")[1]);
    const record = providerRecords.get(reference);
    return record ? json({ status: true, data: { id: 111, reference, ...record } }) : json({ status: false, message: "Not found" }, 404);
  }
  if (target.startsWith("https://api.flutterwave.com")) {
    if (target.endsWith("/payments")) {
      const body = JSON.parse(options.body);
      initializeCalls.push({ provider: "flutterwave", ...body });
      return json({ status: "success", data: { link: `https://checkout.flutterwave.com/${body.tx_ref}` } });
    }
    const reference = new URL(target).searchParams.get("tx_ref");
    const record = providerRecords.get(reference);
    return record ? json({ status: "success", data: { id: 222, tx_ref: reference, ...record } }) : json({ status: "error", message: "Not found" }, 404);
  }
  return realFetch(url, options);
};

/* ---------- Test helpers ---------- */

let server;
let baseUrl;

before(async () => {
  server = createApp({ limitRequests: false }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  initializeCalls = [];
});

async function api(path, { method = "GET", body, cookie, headers = {} } = {}) {
  const response = await realFetch(`${baseUrl}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
}

let userCount = 0;
async function newUser() {
  userCount += 1;
  const result = await api("/api/auth/register", {
    method: "POST",
    body: { email: `fan${userCount}@example.com`, password: "correct horse battery" },
  });
  assert.equal(result.status, 201);
  const cookie = result.headers.get("set-cookie").split(";")[0];
  return { cookie, user: result.data.user };
}

async function startCheckout(cookie, provider, plan, extra = {}) {
  const result = await api("/api/payments/initialize", { method: "POST", cookie, body: { provider, plan, ...extra } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.reference;
}

function paystackSignature(body) {
  return crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(body).digest("hex");
}

/* ---------- Tests ---------- */

describe("accounts", () => {
  test("register, read session, log in again", async () => {
    const { cookie, user } = await newUser();
    assert.equal(user.plan, "free");

    const me = await api("/api/me", { cookie });
    assert.equal(me.data.user.email, user.email);

    const login = await api("/api/auth/login", { method: "POST", body: { email: user.email, password: "correct horse battery" } });
    assert.equal(login.status, 200);
  });

  test("wrong password and tampered cookie are rejected", async () => {
    const { cookie, user } = await newUser();
    const login = await api("/api/auth/login", { method: "POST", body: { email: user.email, password: "nope-nope-nope" } });
    assert.equal(login.status, 401);

    const [name, value] = cookie.split("=");
    const parts = decodeURIComponent(value).split(".");
    parts[0] = "999"; // pretend to be another user
    const forged = `${name}=${encodeURIComponent(parts.join("."))}`;
    const me = await api("/api/me", { cookie: forged });
    assert.equal(me.data.user, null);
  });

  test("non-JSON posts are refused (CSRF guard)", async () => {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: "email=a&password=b",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    assert.equal(result.status, 415);
  });
});

describe("initialize payment", () => {
  test("requires sign-in", async () => {
    const result = await api("/api/payments/initialize", { method: "POST", body: { provider: "paystack", plan: "vip" } });
    assert.equal(result.status, 401);
  });

  test("uses the server price even if the browser sends its own amount", async () => {
    const { cookie } = await newUser();
    await startCheckout(cookie, "paystack", "vip", { amount: 1 });
    assert.equal(initializeCalls[0].amount, PLANS.vip.amount);
    assert.equal(initializeCalls[0].currency, "GHS");
  });

  test("flutterwave receives major units", async () => {
    const { cookie } = await newUser();
    await startCheckout(cookie, "flutterwave", "vvip");
    assert.equal(initializeCalls[0].amount, (PLANS.vvip.amount / 100).toFixed(2));
  });

  test("unknown plan or provider is rejected", async () => {
    const { cookie } = await newUser();
    const badPlan = await api("/api/payments/initialize", { method: "POST", cookie, body: { provider: "paystack", plan: "gold" } });
    const badProvider = await api("/api/payments/initialize", { method: "POST", cookie, body: { provider: "paypal", plan: "vip" } });
    assert.equal(badPlan.status, 400);
    assert.equal(badProvider.status, 400);
  });
});

describe("verification and upgrade", () => {
  test("paystack success upgrades the user once, even if confirmed twice", async () => {
    const { cookie } = await newUser();
    const reference = await startCheckout(cookie, "paystack", "vip");
    providerRecords.set(reference, { status: "success", amount: PLANS.vip.amount, currency: "GHS" });

    const callback = await api(`/api/payments/callback/paystack?reference=${reference}`);
    assert.equal(callback.status, 303);

    const first = await api(`/api/payments/${reference}`, { cookie });
    assert.equal(first.data.payment.status, "success");
    assert.equal(first.data.user.plan, "vip");
    const expiry = first.data.user.planExpiresAt;

    // A repeated callback or webhook must not add another 30 days.
    await api(`/api/payments/callback/paystack?reference=${reference}`);
    const second = await api(`/api/payments/${reference}`, { cookie });
    assert.equal(second.data.user.planExpiresAt, expiry);
  });

  test("a payment for a smaller amount is rejected (fake/tampered payment)", async () => {
    const { cookie } = await newUser();
    const reference = await startCheckout(cookie, "paystack", "vvip");
    providerRecords.set(reference, { status: "success", amount: 100, currency: "GHS" });

    await api(`/api/payments/callback/paystack?reference=${reference}`);
    const result = await api(`/api/payments/${reference}`, { cookie });
    assert.equal(result.data.payment.status, "failed");
    assert.equal(result.data.user.plan, "free");
  });

  test("wrong currency is rejected", async () => {
    const { cookie } = await newUser();
    const reference = await startCheckout(cookie, "paystack", "vip");
    providerRecords.set(reference, { status: "success", amount: PLANS.vip.amount, currency: "NGN" });

    const result = await api(`/api/payments/${reference}`, { cookie });
    assert.equal(result.data.payment.status, "failed");
  });

  test("a redirect claiming success without a real payment changes nothing", async () => {
    const { cookie } = await newUser();
    const reference = await startCheckout(cookie, "flutterwave", "vip");
    providerRecords.set(reference, { status: "pending", amount: PLANS.vip.amount / 100, currency: "GHS" });

    await api(`/api/payments/callback/flutterwave?status=successful&tx_ref=${reference}&transaction_id=1`);
    const result = await api(`/api/payments/${reference}`, { cookie });
    assert.equal(result.data.payment.status, "pending");
    assert.equal(result.data.user.plan, "free");
  });

  test("flutterwave success upgrades to VVIP", async () => {
    const { cookie } = await newUser();
    const reference = await startCheckout(cookie, "flutterwave", "vvip");
    providerRecords.set(reference, { status: "successful", amount: PLANS.vvip.amount / 100, currency: "GHS" });

    const result = await api(`/api/payments/${reference}`, { cookie });
    assert.equal(result.data.payment.status, "success");
    assert.equal(result.data.user.plan, "vvip");
  });

  test("users cannot see each other's payments", async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const reference = await startCheckout(owner.cookie, "paystack", "vip");
    const result = await api(`/api/payments/${reference}`, { cookie: stranger.cookie });
    assert.equal(result.status, 404);
  });
});

describe("webhooks", () => {
  test("paystack webhook with a valid signature confirms the payment", async () => {
    const { cookie } = await newUser();
    const reference = await startCheckout(cookie, "paystack", "vip");
    providerRecords.set(reference, { status: "success", amount: PLANS.vip.amount, currency: "GHS" });

    const body = JSON.stringify({ event: "charge.success", data: { reference } });
    const result = await api("/api/webhooks/paystack", {
      method: "POST",
      body,
      headers: { "x-paystack-signature": paystackSignature(body) },
    });
    assert.equal(result.status, 200);

    const me = await api("/api/me", { cookie });
    assert.equal(me.data.user.plan, "vip");
  });

  test("paystack webhook with a bad signature is refused", async () => {
    const body = JSON.stringify({ event: "charge.success", data: { reference: "vip_whatever" } });
    const result = await api("/api/webhooks/paystack", {
      method: "POST",
      body,
      headers: { "x-paystack-signature": "0".repeat(128) },
    });
    assert.equal(result.status, 401);
  });

  test("a correctly signed webhook still cannot fake a payment the provider never received", async () => {
    const { cookie } = await newUser();
    const reference = await startCheckout(cookie, "paystack", "vip");
    providerRecords.set(reference, { status: "abandoned", amount: PLANS.vip.amount, currency: "GHS" });

    const body = JSON.stringify({ event: "charge.success", data: { reference, amount: PLANS.vip.amount, status: "success" } });
    await api("/api/webhooks/paystack", { method: "POST", body, headers: { "x-paystack-signature": paystackSignature(body) } });

    const me = await api("/api/me", { cookie });
    assert.equal(me.data.user.plan, "free");
  });

  test("flutterwave webhook requires the secret hash", async () => {
    const { cookie } = await newUser();
    const reference = await startCheckout(cookie, "flutterwave", "vip");
    providerRecords.set(reference, { status: "successful", amount: PLANS.vip.amount / 100, currency: "GHS" });
    const body = JSON.stringify({ event: "charge.completed", data: { tx_ref: reference } });

    const refused = await api("/api/webhooks/flutterwave", { method: "POST", body, headers: { "verif-hash": "wrong" } });
    assert.equal(refused.status, 401);

    const accepted = await api("/api/webhooks/flutterwave", { method: "POST", body, headers: { "verif-hash": "flw-test-hash" } });
    assert.equal(accepted.status, 200);
    const me = await api("/api/me", { cookie });
    assert.equal(me.data.user.plan, "vip");
  });
});

describe("static files", () => {
  test("the server folder and .env are never served", async () => {
    for (const path of ["/server/.env", "/server/src/config.js", "/server/package.json"]) {
      const result = await api(path);
      assert.equal(result.status, 404, path);
    }
  });
});

describe("booking codes", () => {
  async function adminCookie() {
    const result = await api("/api/admin/login", { method: "POST", body: { passcode: "8057" } });
    assert.equal(result.status, 200);
    return result.headers.get("set-cookie").split(";")[0];
  }

  test("wrong admin passcode is refused", async () => {
    const result = await api("/api/admin/login", { method: "POST", body: { passcode: "1234" } });
    assert.equal(result.status, 401);
  });

  test("only the admin can set a code, and it is cleaned up", async () => {
    const { cookie: userCookie } = await newUser();
    const asUser = await api("/api/admin/booking-code", { method: "POST", cookie: userCookie, body: { date: "2026-10-04", code: "ABC123" } });
    assert.equal(asUser.status, 401);

    const admin = await adminCookie();
    const saved = await api("/api/admin/booking-code", { method: "POST", cookie: admin, body: { date: "2026-10-04", code: " bc7k9q " } });
    assert.equal(saved.data.code, "BC7K9Q");

    const bad = await api("/api/admin/booking-code", { method: "POST", cookie: admin, body: { date: "2026-10-04", code: "<script>" } });
    assert.equal(bad.status, 400);
  });

  test("signed-in users get the code; visitors do not", async () => {
    const admin = await adminCookie();
    await api("/api/admin/booking-code", { method: "POST", cookie: admin, body: { date: "2026-10-05", code: "XY12Z9" } });

    const visitor = await api("/api/booking-code?date=2026-10-05");
    assert.equal(visitor.status, 401);

    const { cookie } = await newUser();
    const member = await api("/api/booking-code?date=2026-10-05", { cookie });
    assert.equal(member.data.code, "XY12Z9");

    const otherDay = await api("/api/booking-code?date=2026-10-06", { cookie });
    assert.equal(otherDay.data.code, null);
  });

  test("an empty code removes it", async () => {
    const admin = await adminCookie();
    await api("/api/admin/booking-code", { method: "POST", cookie: admin, body: { date: "2026-10-07", code: "DEL123" } });
    await api("/api/admin/booking-code", { method: "POST", cookie: admin, body: { date: "2026-10-07", code: "" } });
    const { cookie } = await newUser();
    const result = await api("/api/booking-code?date=2026-10-07", { cookie });
    assert.equal(result.data.code, null);
  });
});
