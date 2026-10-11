import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../../rollover-campaign.js", import.meta.url), "utf8");

function campaign({ user = { plan: "free" }, warnings = [], slots = {}, otherDialog = false,
  time = "2026-10-11T06:00:00.000Z" } = {}) {
  const nodes = new Map();
  const events = new Map();
  const errors = [];
  const notices = [];
  let now = Date.parse(time);
  let accountAvailable = true;
  let warningsAvailable = true;
  let optionsAvailable = true;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  let tick;
  const node = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, { open: false, textContent: "", disabled: false, handlers: new Map(),
        addEventListener(name, callback) { this.handlers.set(name, callback); },
        showModal() { this.open = true; }, close() { this.open = false; } });
    }
    return nodes.get(id);
  };
  const context = vm.createContext({
    Date: Clock,
    currentUser: user,
    document: { hidden: false, querySelector: (id) => id === "dialog[open]"
      ? otherDialog || [...nodes.values()].find((value) => value.open) : node(id),
      addEventListener: (name, callback) => events.set(name, callback) },
    location: { protocol: "http:", href: "" },
    loadCurrentUser: async () => accountAvailable,
    coversTier: (tier) => context.currentUser?.fullAccess ||
      context.currentUser?.plan === tier ||
      (tier === "boom" && context.currentUser?.plan === "vip"),
    loadOptions: async () => {
      if (!optionsAvailable) { throw new Error("Checkout unavailable"); }
      return { slots };
    },
    fetch: async () => ({ ok: warningsAvailable, json: async () => ({ warnings }) }),
    console: { error: (...args) => errors.push(args) }, popToast: (...args) => notices.push(args),
    window: { addEventListener: (name, callback) => events.set(name, callback),
      setInterval: (callback) => { tick = callback; } },
  });
  vm.runInContext(source, context);
  return { context, node, events, errors, notices, tick: () => tick(),
    flush: async () => { for (let i = 0; i < 12; i += 1) { await Promise.resolve(); } },
    clearWarnings: () => { warnings = []; },
    setTime: (value) => { now = Date.parse(value); },
    failAccount: () => { accountAvailable = false; },
    failWarnings: () => { warningsAvailable = false; },
    failOptions: () => { optionsAvailable = false; } };
}

test("registered non-Weekly users are invited once per visit and Later dismisses", async () => {
  const page = campaign();
  await page.flush();
  assert.equal(page.node("#rollover-campaign").open, true);
  page.node("#rollover-later").handlers.get("click")();
  await page.tick();
  assert.equal(page.node("#rollover-campaign").open, false);
  const nextVisit = campaign();
  await nextVisit.flush();
  assert.equal(nextVisit.node("#rollover-campaign").open, true);
});

test("daily GMT windows switch exactly at 06:00 and 20:00 and include after-midnight night games", async () => {
  for (const [time, prefix] of [
    ["2026-10-11T05:59:59.999Z", "boom"],
    ["2026-10-11T06:00:00.000Z", "rollover"],
    ["2026-10-11T19:59:59.999Z", "rollover"],
    ["2026-10-11T20:00:00.000Z", "boom"],
    ["2026-10-12T00:00:00.000Z", "boom"],
    ["2026-10-12T06:00:00.000Z", "rollover"],
    ["2026-10-11T23:00:00+03:00", "boom"],
  ]) {
    const page = campaign({ time });
    await page.flush();
    assert.equal(page.node(`#${prefix}-campaign`).open, true, time);
    assert.equal(page.node(`#${prefix === "boom" ? "rollover" : "boom"}-campaign`).open, false, time);
  }
});

test("open page switches campaigns and repeats on new days but not across midnight in the same night window", async () => {
  const page = campaign({ time: "2026-10-11T19:59:00Z" });
  await page.flush();
  assert.equal(page.node("#rollover-campaign").open, true);
  page.setTime("2026-10-11T20:00:00Z");
  await page.tick();
  assert.equal(page.node("#rollover-campaign").open, false);
  assert.equal(page.node("#boom-campaign").open, true);
  page.node("#boom-later").handlers.get("click")();
  page.setTime("2026-10-12T00:00:00Z");
  await page.tick();
  assert.equal(page.node("#boom-campaign").open, false);
  page.setTime("2026-10-12T06:00:00Z");
  await page.tick();
  assert.equal(page.node("#rollover-campaign").open, true);
  page.setTime("2026-10-12T20:00:00Z");
  await page.tick();
  assert.equal(page.node("#boom-campaign").open, true);
});

test("night invitation excludes Boom and VIP access but permits Weekly and VVIP members", async () => {
  for (const [user, eligible] of [
    [null, false], [{ plan: "boom" }, false], [{ plan: "vip" }, false],
    [{ plan: "weekly" }, true], [{ plan: "vvip" }, true], [{ plan: "free" }, true],
    [{ plan: "free", fullAccess: true }, false],
  ]) {
    const page = campaign({ time: "2026-10-11T20:00:00Z", user });
    await page.flush();
    assert.equal(page.node("#boom-campaign").open, eligible);
  }
});

test("night Join now opens Boom checkout and Later or blocking dismisses; full slots stop checkout", async () => {
  const page = campaign({ time: "2026-10-11T20:00:00Z" });
  await page.flush();
  await page.node("#boom-join").handlers.get("click")();
  assert.equal(page.context.location.href, "pay.html?plan=boom");
  page.events.get("member-blocked")();
  assert.equal(page.node("#boom-campaign").open, false);
  const full = campaign({ time: "2026-10-11T20:00:00Z", slots: { boom: 0 } });
  await full.flush();
  await full.node("#boom-join").handlers.get("click")();
  assert.equal(full.context.location.href, "");
  assert.match(full.node("#boom-campaign-error").textContent, /slots are full/);
  assert.equal(full.node("#boom-join").disabled, false);
});

test("warning and checkout failures are visible and failed account checks never open checkout", async () => {
  const page = campaign({ warnings: [{ id: 1 }] });
  await page.flush();
  page.failWarnings();
  page.clearWarnings();
  await page.tick();
  assert.equal(page.node("#rollover-campaign").open, false);
  assert.equal(page.errors.length, 1);
  assert.equal(page.notices.length, 1);
  const checkout = campaign({ time: "2026-10-11T20:00:00Z" });
  await checkout.flush();
  checkout.failOptions();
  await checkout.node("#boom-join").handlers.get("click")();
  assert.equal(checkout.context.location.href, "");
  assert.equal(checkout.node("#boom-campaign-error").textContent, "Checkout unavailable");
  checkout.failAccount();
  await checkout.node("#boom-join").handlers.get("click")();
  assert.match(checkout.node("#boom-campaign-error").textContent, /Couldn't check/);
});

test("visitors, Weekly subscribers, full-access users and pending warnings are not prompted", async () => {
  for (const options of [{ user: null }, { user: { plan: "weekly" } },
    { user: { plan: "free", fullAccess: true } }, { warnings: [{ id: 1 }] }, { otherDialog: true }]) {
    const page = campaign(options);
    await page.flush();
    assert.equal(page.node("#rollover-campaign").open, false);
  }
  const page = campaign({ warnings: [{ id: 1 }] });
  await page.flush();
  page.clearWarnings();
  await page.tick();
  assert.equal(page.node("#rollover-campaign").open, true);
});

test("Join now opens Weekly checkout, but full slots and newly active subscriptions prevent it", async () => {
  const page = campaign();
  await page.flush();
  await page.node("#rollover-join").handlers.get("click")();
  assert.equal(page.context.location.href, "pay.html?plan=weekly");
  const full = campaign({ slots: { weekly: 0 } });
  await full.flush();
  await full.node("#rollover-join").handlers.get("click")();
  assert.equal(full.context.location.href, "");
  assert.match(full.node("#rollover-campaign-error").textContent, /slots are full/);
  page.context.location.href = "";
  page.context.currentUser = { plan: "weekly" };
  await page.node("#rollover-join").handlers.get("click")();
  assert.equal(page.context.location.href, "");
  assert.equal(page.node("#rollover-campaign").open, false);
});
