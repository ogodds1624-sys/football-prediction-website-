import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../../script.js", import.meta.url), "utf8");
const refreshSource = source.slice(source.indexOf("let currentUserRequest = null;"),
  source.indexOf("loadCurrentUser().then("));
const clickSource = source.slice(
  source.indexOf('for (const button of document.querySelectorAll(".plan-button[data-tier]"))'),
  source.indexOf('document.querySelector("#pay-close").addEventListener'),
);
const coversSource = source.slice(source.indexOf("function coversTier("), source.indexOf("function planForButton("));

test("section WON badges require every game won and clear on day changes or loading errors", async () => {
  const tiers = ["free", "vip", "boom", "vvip", "weekly"];
  const statuses = Object.fromEntries(tiers.map((tier) => [tier, { hidden: true }]));
  let matches = tiers.flatMap((tier) => [
    { tier, result: "won", locked: true },
    { tier, result: "won", locked: true },
  ]);
  let fail = false;
  let release;
  let pause = false;
  const context = vm.createContext({
    document: { querySelector: (selector) => statuses[selector.slice(1, -4)] },
    TIERS: tiers.map((id) => ({ id })),
    selectedOffset: 0,
    dateKey: (offset) => String(offset),
    tierBodies: Object.fromEntries(tiers.map((tier) => [tier, { replaceChildren() {} }])),
    planButtons: [],
    matchRow: (match) => match,
    emptyRow: () => null,
    messageRow: (text) => text,
    showPlanSlots() {}, showOwnedBookingCodes() {}, markFullPlans() {},
    fetch: async () => {
      if (pause) {
        await new Promise((resolve) => { release = resolve; });
      }
      return { ok: !fail, json: async () => ({ matches }) };
    },
  });
  vm.runInContext(source.slice(source.indexOf("let predictionsRequest = 0;"),
    source.indexOf("let codeRequest = 0;")), context);
  await context.renderPredictions();
  assert.ok(tiers.every((tier) => statuses[tier].hidden === false));
  matches = [
    { tier: "free", result: "won" }, { tier: "free", result: "pending" },
    { tier: "vip", result: "won" }, { tier: "vip", result: "lost" },
    { tier: "boom", result: "pending" },
    { tier: "weekly", result: "won" },
  ];
  context.selectedOffset = -1;
  pause = true;
  const loading = context.renderPredictions();
  assert.ok(tiers.every((tier) => statuses[tier].hidden));
  pause = false;
  release();
  await loading;
  assert.ok(["free", "vip", "boom", "vvip"].every((tier) => statuses[tier].hidden));
  assert.equal(statuses.weekly.hidden, false);
  fail = true;
  await context.renderPredictions();
  assert.ok(tiers.every((tier) => statuses[tier].hidden));
});

function memberPage() {
  let user = { id: 1, name: "Test", plan: "free", country: "ghana" };
  let available = true;
  let blocked = false;
  let interval;
  let resolveFetch;
  let paused = false;
  const requests = [];
  const events = new Map();
  const clicks = new Map();
  const errors = [];
  const notices = [];
  let codesShown = 0;
  const buttons = ["vip", "vvip", "boom", "weekly"].map((tier) => ({
    dataset: { tier }, disabled: false,
    addEventListener: (_, callback) => clicks.set(tier, callback),
  }));
  const context = vm.createContext({
    currentUser: null,
    document: {
      hidden: false,
      addEventListener: (event, callback) => events.set(event, callback),
      querySelectorAll: () => buttons,
    },
    window: {
      addEventListener: (event, callback) => events.set(event, callback),
      setInterval: (callback, delay) => { assert.equal(delay, 10000); interval = callback; },
    },
    location: { protocol: "http:", pathname: "/index.html", search: "", href: "", replace() {} },
    planSlots: {},
    planForButton: (button) => button.dataset.tier,
    slotForButton: (button) => button.dataset.tier,
    showUser: (value) => { context.currentUser = value; },
    showOwnedBookingCodes: () => { codesShown += 1; },
    showVisitorInvite() {},
    showSectionWon() {},
    popToast: (...args) => notices.push(args),
    TIERS: ["free", "vip", "vvip", "boom", "weekly"].map((id) => ({ id })),
    tierBodies: Object.fromEntries(["free", "vip", "vvip", "boom", "weekly"].map((id) => [id, { replaceChildren() {} }])),
    messageRow: (message) => message,
    console: { error: (...args) => errors.push(args) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (paused) {
        await new Promise((resolve) => { resolveFetch = resolve; });
      }
      return { ok: available && !blocked, status: blocked ? 403 : available ? 200 : 500,
        json: async () => blocked ? { code: "ACCOUNT_BLOCKED", error: "Your account is blocked." } : { user } };
    },
  });
  vm.runInContext(coversSource + refreshSource + clickSource, context);
  return {
    context, requests, events, clicks, errors, notices,
    setUser: (value) => { user = value; },
    fail: () => { available = false; },
    block: () => { blocked = true; },
    tick: () => interval(),
    pause: () => { paused = true; },
    resume: () => { paused = false; resolveFetch(); },
    codesShown: () => codesShown,
  };
}

test("an open Free member page refreshes to Boom after approval and bypasses cached account data", async () => {
  const page = memberPage();
  await page.context.loadCurrentUser();
  assert.equal(page.context.currentUser.plan, "free");
  page.setUser({ id: 1, plan: "boom", country: "ghana" });
  page.tick();
  await page.context.loadCurrentUser();
  assert.equal(page.context.currentUser.plan, "boom");
  assert.equal(page.context.coversTier("boom"), true);
  assert.equal(page.context.coversTier("vip"), true);
  assert.ok(page.requests.every((request) => request.options.cache === "no-store"));
});

test("returning to the tab or restoring a page refreshes membership", async () => {
  const page = memberPage();
  await page.context.loadCurrentUser();
  page.setUser({ id: 1, plan: "boom", country: "ghana" });
  page.events.get("visibilitychange")();
  await page.context.loadCurrentUser();
  assert.equal(page.context.currentUser.plan, "boom");
  page.setUser({ id: 1, plan: "free", country: "ghana" });
  page.events.get("pageshow")({ persisted: true });
  await page.context.loadCurrentUser();
  assert.equal(page.context.currentUser.plan, "free");
});

test("Buy Plan allows repurchase when a new game remains locked", async () => {
  const page = memberPage();
  await page.context.loadCurrentUser();
  page.setUser({ id: 1, plan: "boom", country: "ghana" });
  const boomButton = page.context.document.querySelectorAll()[2];
  boomButton.dataset.needsRepurchase = "true";
  await page.clicks.get("boom")();
  assert.equal(page.context.location.href, "pay.html?plan=boom");
  assert.equal(page.context.currentUser.plan, "boom");
  assert.equal(page.codesShown(), 0);
});

for (const plan of ["vip", "vvip", "boom"]) {
  test(`Weekly member with approved ${plan} access sees the owned button instead of buying again`, async () => {
    const page = memberPage();
    page.setUser({ id: 1, plan: "weekly", country: "ghana", plans: [
      { plan: "weekly", expiresAt: "2099-01-01T00:00:00.000Z" },
      { plan, expiresAt: "2099-01-01T00:00:00.000Z" },
    ] });
    await page.context.loadCurrentUser();
    await page.clicks.get(plan)();
    assert.equal(page.context.location.href, "");
    assert.equal(page.codesShown(), 1);
    assert.equal(page.context.coversTier("weekly"), true);
    assert.equal(page.context.coversTier(plan), true);
  });
}

test("failed account refresh preserves paid access and never opens another checkout", async () => {
  const page = memberPage();
  page.setUser({ id: 1, plan: "boom", country: "ghana" });
  await page.context.loadCurrentUser();
  page.fail();
  await page.clicks.get("boom")();
  assert.equal(page.context.currentUser.plan, "boom");
  assert.equal(page.context.location.href, "");
  assert.equal(page.errors.length, 1);
  assert.equal(page.notices.length, 1);
});

test("an explicitly blocked account loses displayed membership and cannot start another checkout", async () => {
  const page = memberPage();
  page.setUser({ id: 1, plan: "weekly", country: "ghana" });
  await page.context.loadCurrentUser();
  page.block();
  await page.clicks.get("weekly")();
  assert.equal(page.context.currentUser, null);
  assert.equal(page.context.location.href, "");
  assert.equal(page.notices[0][0], "Account blocked");
  assert.equal(page.errors.length, 0);
});

test("an unpaid user still opens checkout and concurrent refreshes share one request", async () => {
  const page = memberPage();
  page.pause();
  const first = page.context.loadCurrentUser();
  const second = page.context.loadCurrentUser();
  assert.equal(page.requests.length, 1);
  page.resume();
  await Promise.all([first, second]);
  await page.clicks.get("boom")();
  assert.equal(page.context.location.href, "pay.html?plan=boom");
});

test("unchanged paid membership reloads predictions instead of retaining an old locked response", () => {
  const showSource = source.slice(source.indexOf("function showUser("), source.indexOf('// "Kwame Mensah"'));
  const nodes = new Map();
  const node = (key) => {
    if (!nodes.has(key)) {
      nodes.set(key, { classList: { toggle() {} }, dataset: {} });
    }
    return nodes.get(key);
  };
  let predictions = 0;
  let bookingCodes = 0;
  const user = { id: 1, name: "Buyer", email: "buyer@example.com", plan: "boom", country: "ghana" };
  const context = vm.createContext({
    currentUser: user,
    document: { querySelector: node },
    signInButton: node("sign-in"), footerSignIn: node("footer"), userLabel: node("label"),
    arrangeTables() {}, showPlanTables() {}, showWelcome() {}, initials: () => "B",
    renderPredictions: () => { predictions += 1; },
    showOwnedBookingCodes: () => { bookingCodes += 1; },
  });
  vm.runInContext(showSource, context);
  for (const plan of ["vip", "vvip", "boom", "weekly"]) {
    context.currentUser = { ...user, plan };
    const before = predictions;
    context.showUser({ ...user, plan });
    context.showUser({ ...user, plan });
    assert.equal(predictions, before + 2, `${plan} refreshes unchanged paid predictions`);
    assert.equal(bookingCodes, predictions);
  }
  context.currentUser = { ...user, plan: "free" };
  context.showUser({ ...user, plan: "free" });
  assert.equal(predictions, 8);
});
