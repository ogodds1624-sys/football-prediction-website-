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

function memberPage() {
  let user = { id: 1, name: "Test", plan: "free", country: "ghana" };
  let available = true;
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
    popToast: (...args) => notices.push(args),
    console: { error: (...args) => errors.push(args) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (paused) {
        await new Promise((resolve) => { resolveFetch = resolve; });
      }
      return { ok: available, json: async () => ({ user }) };
    },
  });
  vm.runInContext(coversSource + refreshSource + clickSource, context);
  return {
    context, requests, events, clicks, errors, notices,
    setUser: (value) => { user = value; },
    fail: () => { available = false; },
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

test("Buy Plan rechecks approval before checkout and shows the owned booking code instead", async () => {
  const page = memberPage();
  await page.context.loadCurrentUser();
  page.setUser({ id: 1, plan: "boom", country: "ghana" });
  await page.clicks.get("boom")();
  assert.equal(page.context.location.href, "");
  assert.equal(page.context.currentUser.plan, "boom");
  assert.equal(page.codesShown(), 1);
});

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
