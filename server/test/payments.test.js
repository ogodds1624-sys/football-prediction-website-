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
    body: { name: "Kwame Mensah", email: `fan${userCount}@example.com`, password: "correct horse battery" },
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
    assert.equal(me.data.user.name, "Kwame Mensah");

    const login = await api("/api/auth/login", { method: "POST", body: { email: user.email, password: "correct horse battery" } });
    assert.equal(login.status, 200);
  });

  test("sign-up needs a name", async () => {
    const result = await api("/api/auth/register", {
      method: "POST",
      body: { name: " ", email: "noname@example.com", password: "correct horse battery" },
    });
    assert.equal(result.status, 400);
  });

  test("a signed-in member can set their name", async () => {
    const { cookie } = await newUser();
    const anonymous = await api("/api/me/name", { method: "POST", body: { name: "Ama Owusu" } });
    assert.equal(anonymous.status, 401);
    const blank = await api("/api/me/name", { method: "POST", cookie, body: { name: "" } });
    assert.equal(blank.status, 400);
    const saved = await api("/api/me/name", { method: "POST", cookie, body: { name: "  Ama   Owusu " } });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.user.name, "Ama Owusu");
    const me = await api("/api/me", { cookie });
    assert.equal(me.data.user.name, "Ama Owusu");
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

describe("members list", () => {
  test("lists accounts with name, plan and last visit, for the admin only", async () => {
    const { cookie, user } = await newUser();
    await api("/api/me", { cookie });

    const refused = await api("/api/admin/members", { cookie });
    assert.equal(refused.status, 401);

    const login = await api("/api/admin/login", { method: "POST", body: { passcode: "8057" } });
    const admin = login.headers.get("set-cookie").split(";")[0];
    const { data } = await api("/api/admin/members", { cookie: admin });
    assert.ok(data.totals.users >= 1);
    const member = data.members.find((entry) => entry.email === user.email);
    assert.equal(member.name, "Kwame Mensah");
    assert.equal(member.plan, "free");
    assert.deepEqual(member.payments, []);
    assert.ok(member.joinedAt);
    assert.ok(member.lastSeenAt, "visiting the site records a last visit");
    assert.equal(data.members[0].email, user.email, "most recent visitor comes first");
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

  test("a code belongs to the table it was saved with", async () => {
    const admin = await adminCookie();
    await api("/api/admin/booking-code", { method: "POST", cookie: admin, body: { date: "2026-10-08", tier: "vip", code: "VIPCODE1" } });
    await api("/api/admin/booking-code", { method: "POST", cookie: admin, body: { date: "2026-10-08", tier: "vvip", code: "VVIPCODE1" } });
    const { cookie } = await newUser();
    const vip = await api("/api/booking-code?date=2026-10-08&tier=vip", { cookie });
    const vvip = await api("/api/booking-code?date=2026-10-08&tier=vvip", { cookie });
    const free = await api("/api/booking-code?date=2026-10-08&tier=free", { cookie });
    assert.equal(vip.data.code, "VIPCODE1");
    assert.equal(vvip.data.code, "VVIPCODE1");
    assert.equal(free.data.code, null);
    const listed = await api("/api/admin/booking-code?date=2026-10-08", { cookie: admin });
    assert.equal(listed.data.codes.vip, "VIPCODE1");
    assert.equal(listed.data.codes.vvip, "VVIPCODE1");
  });
});

describe("payment gateway settings", () => {
  async function adminCookie() {
    const result = await api("/api/admin/login", { method: "POST", body: { passcode: "8057" } });
    return result.headers.get("set-cookie").split(";")[0];
  }

  test("everything starts empty and switched off", async () => {
    const admin = await adminCookie();
    const { data } = await api("/api/admin/gateway", { cookie: admin });
    assert.equal(data.checkout.businessName, "");
    assert.equal(data.checkout.whatsapp, "");
    for (const method of Object.values(data.checkout.methods)) {
      assert.equal(method.enabled, false);
      assert.deepEqual(method.accounts, []);
    }
    assert.ok(Object.values(data.rates).every((rate) => rate === null));
  });

  test("only the admin can read or change settings", async () => {
    assert.equal((await api("/api/admin/gateway")).status, 401);
    const { cookie } = await newUser();
    const asUser = await api("/api/admin/gateway/checkout", { method: "POST", cookie, body: { businessName: "Hacked" } });
    assert.equal(asUser.status, 401);
  });

  test("visitors only see switched-on methods with accounts", async () => {
    const admin = await adminCookie();
    await api("/api/admin/gateway/checkout", {
      method: "POST",
      cookie: admin,
      body: {
        businessName: "  O G Sports Hub  ",
        whatsapp: "+233 20 000 0000",
        email: "",
        methods: {
          momo: { enabled: true, accounts: [{ network: "MTN", number: "0200000000", name: "OG" }, { network: "", number: "", name: "" }] },
          ghBank: { enabled: false, accounts: [{ bank: "GCB", number: "1", name: "OG" }] },
          ngBank: { enabled: true, accounts: [] },
        },
      },
    });
    await api("/api/admin/gateway/rates", { method: "POST", cookie: admin, body: { ngn: "105.5", kes: "" } });

    const { data } = await api("/api/payments/options");
    assert.equal(data.checkout.businessName, "O G Sports Hub");
    assert.equal(data.checkout.whatsapp, "233200000000");
    assert.deepEqual(data.checkout.methods.map((method) => method.id), ["momo"]);
    assert.equal(data.checkout.methods[0].accounts.length, 1);
    assert.deepEqual(data.checkout.rates.map((rate) => [rate.id, rate.rate]), [["ngn", 105.5]]);
  });

  test("bad rates and emails are rejected", async () => {
    const admin = await adminCookie();
    const badRate = await api("/api/admin/gateway/rates", { method: "POST", cookie: admin, body: { ngn: "-5" } });
    assert.equal(badRate.status, 400);
    const badEmail = await api("/api/admin/gateway/checkout", { method: "POST", cookie: admin, body: { email: "not-an-email" } });
    assert.equal(badEmail.status, 400);
  });
});

describe("testimonials", () => {
  async function adminCookie() {
    const result = await api("/api/admin/login", { method: "POST", body: { passcode: "8057" } });
    return result.headers.get("set-cookie").split(";")[0];
  }

  test("only the admin can add; visitors can read", async () => {
    const { cookie } = await newUser();
    const asUser = await api("/api/admin/testimonials", { method: "POST", cookie, body: { name: "X", rating: 5, message: "Nice one" } });
    assert.equal(asUser.status, 401);

    const admin = await adminCookie();
    const added = await api("/api/admin/testimonials", {
      method: "POST",
      cookie: admin,
      body: { name: "Member One", location: "Kumasi, Ghana", rating: 4, message: "Clear tips every day." },
    });
    assert.equal(added.status, 201);

    const { data } = await api("/api/testimonials");
    assert.equal(data.testimonials[0].name, "Member One");
    assert.equal(data.testimonials[0].rating, 4);
    assert.equal(data.testimonials[0].id, undefined);
  });

  test("ratings must be 1 to 5 and deleting removes it", async () => {
    const admin = await adminCookie();
    const bad = await api("/api/admin/testimonials", { method: "POST", cookie: admin, body: { name: "A", rating: 9, message: "Hello there" } });
    assert.equal(bad.status, 400);

    const { data } = await api("/api/admin/testimonials", {
      method: "POST",
      cookie: admin,
      body: { name: "To Delete", rating: 5, message: "Temporary review" },
    });
    await api("/api/admin/testimonials/delete", { method: "POST", cookie: admin, body: { id: data.testimonial.id } });
    const list = await api("/api/testimonials");
    assert.ok(!list.data.testimonials.some((item) => item.name === "To Delete"));
  });
});

describe("member reviews", () => {
  async function adminCookie() {
    const result = await api("/api/admin/login", { method: "POST", body: { passcode: "8057" } });
    return result.headers.get("set-cookie").split(";")[0];
  }
  const review = { name: "Ama K.", location: "Accra, Ghana", rating: 5, message: "Really helpful daily tips." };

  test("visitors must sign in to send a review", async () => {
    const result = await api("/api/testimonials", { method: "POST", body: review });
    assert.equal(result.status, 401);
  });

  test("a member's review waits until the admin accepts it", async () => {
    const { cookie } = await newUser();
    const sent = await api("/api/testimonials", { method: "POST", cookie, body: review });
    assert.equal(sent.status, 201);

    const before = await api("/api/testimonials");
    assert.ok(!before.data.testimonials.some((item) => item.message === review.message));

    const second = await api("/api/testimonials", { method: "POST", cookie, body: { ...review, message: "Another one here" } });
    assert.equal(second.status, 409);

    const admin = await adminCookie();
    const list = await api("/api/admin/testimonials", { cookie: admin });
    const pending = list.data.testimonials.find((item) => item.message === review.message);
    assert.equal(pending.status, "pending");

    await api("/api/admin/testimonials/approve", { method: "POST", cookie: admin, body: { id: pending.id } });
    const after = await api("/api/testimonials");
    assert.ok(after.data.testimonials.some((item) => item.message === review.message));
  });

  test("members cannot approve reviews", async () => {
    const { cookie } = await newUser();
    const result = await api("/api/admin/testimonials/approve", { method: "POST", cookie, body: { id: 1 } });
    assert.equal(result.status, 401);
  });
});

describe("predictions", () => {
  const DATE = "2026-11-01";
  async function adminCookie() {
    const result = await api("/api/admin/login", { method: "POST", body: { passcode: "8057" } });
    return result.headers.get("set-cookie").split(";")[0];
  }
  async function memberWithPlan(plan) {
    const member = await newUser();
    const reference = await startCheckout(member.cookie, "paystack", plan);
    providerRecords.set(reference, { status: "success", amount: PLANS[plan].amount, currency: "GHS" });
    await api(`/api/payments/${reference}`, { cookie: member.cookie });
    return member;
  }

  before(async () => {
    const admin = await adminCookie();
    const saved = await api("/api/admin/matches", {
      method: "POST",
      cookie: admin,
      body: {
        date: DATE,
        matches: [
          { tier: "free", home: "Hearts", away: "Kotoko", tip: "Over 1.5", odds: "1.45" },
          { tier: "vip", home: "Enyimba", away: "Rangers", tip: "Home win", odds: "1.90" },
          { tier: "vvip", home: "Arsenal", away: "Chelsea", tip: "GG", odds: "1.70" },
        ],
      },
    });
    assert.equal(saved.status, 201);
  });

  function tipsByTier(matches) {
    return Object.fromEntries(matches.map((match) => [match.tier, match.tip]));
  }

  test("visitors see no tips at all; teams and odds stay visible", async () => {
    const { data } = await api(`/api/matches?date=${DATE}`);
    assert.deepEqual(tipsByTier(data.matches), { free: null, vip: null, vvip: null });
    assert.equal(data.matches.find((match) => match.tier === "free").home, "Hearts");
    const vip = data.matches.find((match) => match.tier === "vip");
    assert.equal(vip.home, "Enyimba");
    assert.equal(vip.odds, "1.90");
    assert.equal(vip.locked, true);
  });

  test("a free account unlocks free tips only", async () => {
    const { cookie } = await newUser();
    const { data } = await api(`/api/matches?date=${DATE}`, { cookie });
    assert.deepEqual(tipsByTier(data.matches), { free: "Over 1.5", vip: null, vvip: null });
  });

  test("VIP members unlock VIP only, VVIP members unlock VVIP only", async () => {
    const vip = await memberWithPlan("vip");
    const vipView = await api(`/api/matches?date=${DATE}`, { cookie: vip.cookie });
    assert.deepEqual(tipsByTier(vipView.data.matches), { free: "Over 1.5", vip: "Home win", vvip: null });

    const vvip = await memberWithPlan("vvip");
    const vvipView = await api(`/api/matches?date=${DATE}`, { cookie: vvip.cookie });
    assert.deepEqual(tipsByTier(vvipView.data.matches), { free: "Over 1.5", vip: null, vvip: "GG" });
    const vipMatch = vvipView.data.matches.find((match) => match.tier === "vip");
    assert.equal(vipMatch.locked, true);
    assert.equal(vipMatch.image, "");
  });

  test("admin can update, set results and delete; members cannot", async () => {
    const { cookie } = await newUser();
    const asMember = await api("/api/admin/matches", { method: "POST", cookie, body: { date: DATE, tier: "free", home: "A", away: "B", tip: "1" } });
    assert.equal(asMember.status, 401);

    const admin = await adminCookie();
    const { data } = await api(`/api/admin/matches?date=${DATE}`, { cookie: admin });
    const free = data.matches.find((match) => match.tier === "free");

    await api("/api/admin/matches/update", { method: "POST", cookie: admin, body: { ...free, tip: "Over 2.5" } });
    await api("/api/admin/matches/result", { method: "POST", cookie: admin, body: { id: free.id, result: "won" } });
    const after = await api(`/api/matches?date=${DATE}`, { cookie });
    const updated = after.data.matches.find((match) => match.tier === "free");
    assert.equal(updated.tip, "Over 2.5");
    assert.equal(updated.result, "won");

    await api("/api/admin/matches/delete", { method: "POST", cookie: admin, body: { id: free.id } });
    const gone = await api(`/api/matches?date=${DATE}`);
    assert.ok(!gone.data.matches.some((match) => match.tier === "free"));
  });

  test("bad matches are rejected", async () => {
    const admin = await adminCookie();
    const noTip = await api("/api/admin/matches", { method: "POST", cookie: admin, body: { date: DATE, tier: "vip", home: "A", away: "B", tip: "" } });
    assert.equal(noTip.status, 400);
    const badTier = await api("/api/admin/matches", { method: "POST", cookie: admin, body: { date: DATE, tier: "gold", home: "A", away: "B", tip: "1" } });
    assert.equal(badTier.status, 400);
  });
});

describe("results calendar", () => {
  test("summarises each day of a month without revealing tips", async () => {
    const admin = (await api("/api/admin/login", { method: "POST", body: { passcode: "8057" } })).headers.get("set-cookie").split(";")[0];
    await api("/api/admin/matches", {
      method: "POST",
      cookie: admin,
      body: { date: "2026-09-12", matches: [
        { tier: "free", home: "A", away: "B", tip: "1" },
        { tier: "vip", home: "C", away: "D", tip: "2" },
        { tier: "vvip", home: "E", away: "F", tip: "X" },
      ] },
    });
    const { data: list } = await api("/api/admin/matches?date=2026-09-12", { cookie: admin });
    await api("/api/admin/matches/result", { method: "POST", cookie: admin, body: { id: list.matches[0].id, result: "won" } });
    await api("/api/admin/matches/result", { method: "POST", cookie: admin, body: { id: list.matches[1].id, result: "lost" } });

    const { data } = await api("/api/matches/month?month=2026-09");
    assert.deepEqual(data.days, [{ date: "2026-09-12", total: 3, won: 1, lost: 1 }]);
    assert.equal(JSON.stringify(data).includes('"tip"'), false);
    assert.equal((await api("/api/matches/month?month=bad")).status, 400);
  });
});

describe("recovery tickets", async () => {
  const { todayKey, shiftDate } = await import("../src/recovery.js");
  const TODAY = todayKey();
  const YESTERDAY = shiftDate(TODAY, -1);
  const THREE_DAYS_AGO = shiftDate(TODAY, -3);

  async function adminCookie() {
    const result = await api("/api/admin/login", { method: "POST", body: { passcode: "8057" } });
    return result.headers.get("set-cookie").split(";")[0];
  }
  async function addTicket(admin, date, tier, results) {
    const matches = results.map((_, index) => ({ tier, home: `H${index}`, away: `A${index}`, tip: "1" }));
    const { data } = await api("/api/admin/matches", { method: "POST", cookie: admin, body: { date, matches } });
    for (const [index, result] of results.entries()) {
      if (result !== "pending") {
        await api("/api/admin/matches/result", { method: "POST", cookie: admin, body: { id: data.matches[index].id, result } });
      }
    }
  }
  async function memberWho(boughtPlan, onDate) {
    const member = await newUser();
    const admin = await adminCookie();
    if (boughtPlan) {
      const activated = await api("/api/admin/members/activate", {
        method: "POST",
        cookie: admin,
        body: { email: member.user.email, plan: boughtPlan, date: onDate },
      });
      assert.equal(activated.status, 201);
    }
    return member;
  }
  const check = (member, email = member.user.email) =>
    api("/api/recovery", { method: "POST", cookie: member.cookie, body: { email, date: TODAY } });

  before(async () => {
    const admin = await adminCookie();
    // Yesterday: VIP ticket lost, VVIP ticket won. Today: bonus tips posted.
    await addTicket(admin, YESTERDAY, "vip", ["won", "lost"]);
    await addTicket(admin, YESTERDAY, "vvip", ["won", "won"]);
    await addTicket(admin, THREE_DAYS_AGO, "vvip", ["lost"]);
    await api("/api/admin/matches", {
      method: "POST",
      cookie: admin,
      body: { date: TODAY, matches: [{ tier: "recovery", home: "Bonus FC", away: "Comeback Utd", tip: "Over 1.5", odds: "1.40" }] },
    });
  });

  test("visitors must sign in", async () => {
    const result = await api("/api/recovery", { method: "POST", body: { email: "x@example.com", date: TODAY } });
    assert.equal(result.status, 401);
  });

  test("the email must match the signed-in account", async () => {
    const member = await memberWho("vip", YESTERDAY);
    const result = await check(member, "someone-else@example.com");
    assert.equal(result.status, 400);
  });

  test("a VIP ticket that lost yesterday unlocks today's bonus tips", async () => {
    const member = await memberWho("vip", YESTERDAY);
    const { data } = await check(member);
    assert.equal(data.status, "eligible");
    assert.equal(data.lostDate, YESTERDAY);
    assert.equal(data.validUntil, shiftDate(YESTERDAY, 2));
    assert.equal(data.tips[0].home, "Bonus FC");
  });

  test("a ticket that won does not qualify", async () => {
    const member = await memberWho("vvip", YESTERDAY);
    const { data } = await check(member);
    assert.equal(data.status, "won");
    assert.equal(data.tips, undefined);
  });

  test("a lost ticket older than 2 days has expired", async () => {
    const member = await memberWho("vvip", THREE_DAYS_AGO);
    const { data } = await check(member);
    assert.equal(data.status, "expired");
  });

  test("members without a purchase are told so", async () => {
    const member = await memberWho(null);
    const { data } = await check(member);
    assert.equal(data.status, "none");
  });

  test("a purchase made today waits for its results", async () => {
    const member = await memberWho("vip", TODAY);
    const { data } = await check(member);
    assert.equal(data.status, "pending");
  });

  test("bonus tips never appear in the public tables or calendar", async () => {
    const { data } = await api(`/api/matches?date=${TODAY}`);
    assert.ok(!data.matches.some((match) => match.tier === "recovery"));
    const month = await api(`/api/matches/month?month=${TODAY.slice(0, 7)}`);
    assert.ok(!month.data.days.some((day) => day.date === TODAY));
  });

  test("activating today unlocks the member's VIP tips straight away", async () => {
    const member = await memberWho("vip", TODAY);
    const me = await api("/api/me", { cookie: member.cookie });
    assert.equal(me.data.user.plan, "vip");
  });

  test("activation needs an existing account", async () => {
    const admin = await adminCookie();
    const result = await api("/api/admin/members/activate", { method: "POST", cookie: admin, body: { email: "nobody@example.com", plan: "vip" } });
    assert.equal(result.status, 404);
  });
});

describe("plan prices", () => {
  async function adminCookie() {
    const result = await api("/api/admin/login", { method: "POST", body: { passcode: "8057" } });
    assert.equal(result.status, 200);
    return result.headers.get("set-cookie").split(";")[0];
  }

  test("only the admin can change VIP and VVIP prices", async () => {
    const admin = await adminCookie();
    try {
      const before = await api("/api/payments/options");
      assert.deepEqual(before.data.plans.map((plan) => [plan.id, plan.amount]), [["vip", 50], ["vvip", 100]]);

      const { cookie } = await newUser();
      const asMember = await api("/api/admin/plans", { method: "POST", cookie, body: { vip: 1, vvip: 2 } });
      assert.equal(asMember.status, 401);

      const bad = await api("/api/admin/plans", { method: "POST", cookie: admin, body: { vip: "0", vvip: "80" } });
      assert.equal(bad.status, 400);

      const saved = await api("/api/admin/plans", { method: "POST", cookie: admin, body: { vip: "75.50", vvip: "120" } });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.data.plans, { vip: 75.5, vvip: 120 });

      const after = await api("/api/payments/options");
      assert.deepEqual(after.data.plans.map((plan) => [plan.id, plan.amount]), [["vip", 75.5], ["vvip", 120]]);

      await api("/api/admin/gateway/checkout", {
        method: "POST",
        cookie: admin,
        body: { methods: { momo: { enabled: true, accounts: [{ network: "MTN", number: "0240000000", name: "OG" }] } } },
      });
      const receipt = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const buyer = await newUser();
      const sent = await api("/api/payments/manual", {
        method: "POST",
        cookie: buyer.cookie,
        body: { plan: "vvip", methodId: "momo", accountIndex: 0, receipt },
      });
      assert.equal(sent.status, 201);
      const list = await api("/api/admin/manual-payments", { cookie: admin });
      const payment = list.data.payments.find((item) => item.email === buyer.user.email);
      assert.equal(payment.amount, 120);
    } finally {
      await api("/api/admin/plans", { method: "POST", cookie: admin, body: { vip: "50", vvip: "100" } });
    }
  });
});

describe("manual plan payment", () => {
  const receipt = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  async function adminCookie() {
    const result = await api("/api/admin/login", { method: "POST", body: { passcode: "8057" } });
    assert.equal(result.status, 200);
    return result.headers.get("set-cookie").split(";")[0];
  }

  test("a receipt for a real account activates the plan when confirmed", async () => {
    const admin = await adminCookie();
    await api("/api/admin/gateway/checkout", {
      method: "POST",
      cookie: admin,
      body: {
        methods: {
          momo: { enabled: true, accounts: [{ network: "Telecel Cash", number: "0500000000", name: "OG Sports" }] },
        },
      },
    });

    const { cookie, user } = await newUser();
    const denied = await api("/api/payments/manual", {
      method: "POST",
      body: { plan: "vip", methodId: "momo", accountIndex: 0, receipt },
    });
    assert.equal(denied.status, 401);

    const sent = await api("/api/payments/manual", {
      method: "POST",
      cookie,
      body: { plan: "vip", methodId: "momo", accountIndex: 0, receipt },
    });
    assert.equal(sent.status, 201);

    const again = await api("/api/payments/manual", {
      method: "POST",
      cookie,
      body: { plan: "vip", methodId: "momo", accountIndex: 0, receipt },
    });
    assert.equal(again.status, 409);

    const waiting = await api("/api/payments/manual?plan=vip", { cookie });
    assert.equal(waiting.status, 200);
    assert.equal(waiting.data.payment.status, "pending");
    assert.equal(waiting.data.payment.plan, "vip");
    const stranger = await newUser();
    const hidden = await api("/api/payments/manual?plan=vip", { cookie: stranger.cookie });
    assert.equal(hidden.data.payment, null);

    const list = await api("/api/admin/manual-payments", { cookie: admin });
    const payment = list.data.payments.find((item) => item.email === user.email);
    assert.equal(payment.plan, "vip");
    assert.equal(payment.amount, 50);
    assert.equal(payment.network, "Telecel Cash");

    const proof = await api(`/api/admin/manual-payments/${payment.id}/receipt`, { cookie: admin });
    assert.equal(proof.status, 200);
    assert.equal(proof.headers.get("content-type"), "image/png");

    const asMember = await api(`/api/admin/manual-payments/${payment.id}/confirm`, { method: "POST", cookie, body: {} });
    assert.equal(asMember.status, 401);

    const confirmed = await api(`/api/admin/manual-payments/${payment.id}/confirm`, { method: "POST", cookie: admin, body: {} });
    assert.equal(confirmed.status, 200);

    const me = await api("/api/me", { cookie });
    assert.equal(me.data.user.plan, "vip");
    const decided = await api("/api/payments/manual?plan=vip", { cookie });
    assert.equal(decided.data.payment.status, "confirmed");
    const kept = await api("/api/admin/manual-payments", { cookie: admin });
    assert.equal(kept.data.payments.some((item) => item.id === payment.id), false);
    const members = await api("/api/admin/members", { cookie: admin });
    const member = members.data.members.find((entry) => entry.email === user.email);
    assert.equal(member.name, user.name);
    assert.equal(member.plan, "vip");
    assert.deepEqual(member.payments, [{ plan: "vip", amount: 50, currency: "GHS" }]);
  });

  test("rejecting a payment leaves the plan unchanged and allows another receipt", async () => {
    const admin = await adminCookie();
    const { cookie, user } = await newUser();
    const sent = await api("/api/payments/manual", {
      method: "POST",
      cookie,
      body: { plan: "vvip", methodId: "momo", accountIndex: 0, receipt },
    });
    assert.equal(sent.status, 201);

    const list = await api("/api/admin/manual-payments", { cookie: admin });
    const payment = list.data.payments.find((item) => item.email === user.email);
    const asMember = await api(`/api/admin/manual-payments/${payment.id}/reject`, { method: "POST", cookie, body: {} });
    assert.equal(asMember.status, 401);

    const rejected = await api(`/api/admin/manual-payments/${payment.id}/reject`, { method: "POST", cookie: admin, body: {} });
    assert.equal(rejected.status, 200);
    const decided = await api("/api/payments/manual?plan=vvip", { cookie });
    assert.equal(decided.data.payment.status, "rejected");
    const again = await api(`/api/admin/manual-payments/${payment.id}/reject`, { method: "POST", cookie: admin, body: {} });
    assert.equal(again.status, 404);

    const me = await api("/api/me", { cookie });
    assert.equal(me.data.user.plan, "free");
    const waiting = await api("/api/admin/manual-payments", { cookie: admin });
    const row = waiting.data.payments.find((item) => item.id === payment.id);
    assert.equal(row.status, "rejected");
    assert.equal(row.name, user.name);
    assert.equal(row.email, user.email);
    assert.equal(row.amount, 100);

    const resent = await api("/api/payments/manual", {
      method: "POST",
      cookie,
      body: { plan: "vvip", methodId: "momo", accountIndex: 0, receipt },
    });
    assert.equal(resent.status, 201);
  });
});
