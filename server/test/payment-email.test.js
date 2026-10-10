import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import nodemailer from "nodemailer";

process.env.SESSION_SECRET = "email-tests-secret-at-least-32-characters";
process.env.DATABASE_FILE = ":memory:";
process.env.APP_URL = "http://localhost:3000";
process.env.ADMIN_PASSCODE = "email-tests";
process.env.GMAIL_USER = "sender@example.com";
process.env.GMAIL_APP_PASSWORD = "fake-app-password";

const { createApp } = await import("../src/app.js");
const { config } = await import("../src/config.js");
const { NIGERIA_PAYMENT_EMAIL } = await import("../src/payment-email.js");
const { one, execute } = await import("../src/db.js");

let messages = [];
let transports = [];
let errors = [];
let deliveryError = null;
let accepted = [NIGERIA_PAYMENT_EMAIL];
mock.method(nodemailer, "createTransport", (options) => {
  transports.push(options);
  return {
    async sendMail(message) {
      messages.push(message);
      if (deliveryError) {
        throw deliveryError;
      }
      return { accepted };
    },
  };
});
mock.method(console, "error", (message) => errors.push(message));

let server;
let baseUrl;
let admin;
let userNumber = 0;
const receipt = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function api(route, { body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}

async function member(country) {
  userNumber += 1;
  const result = await api("/api/auth/register", {
    body: { email: `email-test-${userNumber}@example.com`, name: "Test Sender", password: "email testing password" },
  });
  assert.equal(result.status, 201);
  const cookie = result.headers.get("set-cookie").split(";")[0];
  assert.equal((await api("/api/me/country", { cookie, body: { country } })).status, 200);
  return { cookie, user: result.data.user };
}

const transfer = (plan = "vip", methodId = "ngBank") => ({ plan, methodId, accountIndex: 0, receipt });

before(async () => {
  server = createApp({ limitRequests: false }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await api("/api/admin/login", { body: { passcode: "email-tests" } });
  assert.equal(login.status, 200);
  admin = login.headers.get("set-cookie").split(";")[0];
  const checkout = await api("/api/admin/gateway/checkout", {
    cookie: admin,
    body: { methods: {
      ngBank: { enabled: true, accounts: [{ bank: "Test Bank", number: "1234567890", name: "Test Account" }] },
      momo: { enabled: true, accounts: [{ network: "MTN", number: "0241111111", name: "Test Ghana" }] },
      usdt: { enabled: true, accounts: [{ network: "TRC20", number: "TESTWALLET", name: "Test Wallet" }] },
    } },
  });
  assert.equal(checkout.status, 200);
});

beforeEach(() => {
  messages = [];
  transports = [];
  errors = [];
  deliveryError = null;
  accepted = [NIGERIA_PAYMENT_EMAIL];
});

after(() => {
  server.close();
  mock.restoreAll();
});

test("Nigerian receipts for every paid plan email the fixed recipient once after saving", async () => {
  for (const plan of ["vip", "vvip", "boom", "weekly"]) {
    const { cookie, user } = await member("nigeria");
    const result = await api("/api/payments/manual", { cookie, body: transfer(plan) });
    assert.equal(result.status, 201);
    assert.equal(result.data.emailNotification, "sent");
    const payment = await one("SELECT * FROM manual_payments WHERE id = ?", [result.data.id]);
    assert.equal(payment.status, "pending");
    assert.equal(payment.email_notification_status, "sent");
    const message = messages.at(-1);
    assert.equal(message.to, "andrewturkenterprise@gmail.com");
    assert.equal(message.from, config.gmail.user);
    assert.match(message.text, new RegExp(user.email.replace(/\./g, "\\.")));
    assert.ok(message.text.includes(`Receipt ID: ${result.data.id}`));
    assert.ok(message.text.includes(`Amount: NGN ${(payment.amount / 100).toFixed(2)}`));
    assert.ok(message.text.includes("http://localhost:3000/control-room.html#members"));
    assert.ok(message.text.includes("not yet approved"));
    assert.equal(message.attachments, undefined);
    assert.equal(message.text.includes(receipt), false);
    const count = messages.length;
    assert.equal((await api("/api/payments/manual", { cookie, body: transfer(plan) })).status, 409);
    assert.equal(messages.length, count);
    const status = await api(`/api/payments/manual?plan=${plan}`, { cookie });
    assert.equal(status.data.payment.emailNotification, "sent");
  }
  assert.equal(transports.length, 4);
  assert.equal(transports[0].service, "gmail");
  assert.equal(transports[0].auth.pass, "fake-app-password");
  const list = await api("/api/admin/manual-payments", { cookie: admin });
  assert.ok(list.data.payments.every((payment) => payment.emailNotification === "sent"));
});

test("non-Nigerian, invalid and unauthenticated submissions do not trigger emails", async () => {
  assert.equal((await api("/api/payments/manual", { body: transfer() })).status, 401);
  for (const country of ["ghana", "kenya", "uganda", "international"]) {
    const { cookie } = await member(country);
    const result = await api("/api/payments/manual", {
      cookie, body: transfer("vip", country === "ghana" ? "momo" : "usdt"),
    });
    assert.equal(result.status, 201);
    assert.equal(result.data.emailNotification, undefined);
  }
  const { cookie } = await member("nigeria");
  assert.equal((await api("/api/payments/manual", {
    cookie, body: { ...transfer(), receipt: "invalid" },
  })).status, 400);
  assert.equal(messages.length, 0);
  assert.equal(transports.length, 0);
});

test("SMTP failure preserves the receipt and reports persistent failure to member and admin", async () => {
  deliveryError = new Error("SMTP unavailable");
  const { cookie } = await member("nigeria");
  const result = await api("/api/payments/manual", { cookie, body: transfer() });
  assert.equal(result.status, 201);
  assert.equal(result.data.emailNotification, "failed");
  const payment = await one("SELECT * FROM manual_payments WHERE id = ?", [result.data.id]);
  assert.equal(payment.status, "pending");
  assert.equal(payment.receipt_data, receipt);
  assert.equal(payment.email_notification_status, "failed");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /email notification failed: SMTP unavailable/);
  assert.equal((await api("/api/payments/manual?plan=vip", { cookie })).data.payment.emailNotification, "failed");
  const list = await api("/api/admin/manual-payments", { cookie: admin });
  assert.equal(list.data.payments.find((item) => item.id === result.data.id).emailNotification, "failed");
  const confirmed = await api(`/api/admin/manual-payments/${result.data.id}/confirm`, { cookie: admin, body: {} });
  assert.equal(confirmed.status, 200);
  assert.equal((await api("/api/me", { cookie })).data.user.plan, "vip");
});

test("missing Gmail credentials and rejected recipients are explicit failures, not successes", async () => {
  const password = config.gmail.appPassword;
  try {
    config.gmail.appPassword = "";
    const { cookie } = await member("nigeria");
    const result = await api("/api/payments/manual", { cookie, body: transfer() });
    assert.equal(result.data.emailNotification, "failed");
    assert.match(errors[0], /GMAIL_USER and GMAIL_APP_PASSWORD/);
    assert.equal(transports.length, 0);
  } finally {
    config.gmail.appPassword = password;
  }
  accepted = [];
  const { cookie } = await member("nigeria");
  const result = await api("/api/payments/manual", { cookie, body: transfer() });
  assert.equal(result.data.emailNotification, "failed");
  assert.match(errors.at(-1), /did not accept/);
});

test("legacy Nigerian bank receipts without a saved country also notify", async () => {
  const { cookie, user } = await member("nigeria");
  await execute("UPDATE users SET country = '' WHERE id = ?", [user.id]);
  const result = await api("/api/payments/manual", { cookie, body: transfer() });
  assert.equal(result.status, 201);
  assert.equal(result.data.emailNotification, "sent");
  assert.equal(messages.length, 1);
});
