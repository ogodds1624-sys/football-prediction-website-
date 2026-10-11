import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../../rollover-campaign.js", import.meta.url), "utf8");

function campaign({ user = { plan: "free" }, warnings = [], slots = {}, otherDialog = false } = {}) {
  const nodes = new Map();
  const events = new Map();
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
    currentUser: user,
    document: { hidden: false, querySelector: (id) => id === "dialog[open]" ? otherDialog : node(id),
      addEventListener: (name, callback) => events.set(name, callback) },
    location: { protocol: "http:", href: "" },
    loadCurrentUser: async () => true,
    coversTier: () => context.currentUser?.plan === "weekly" || context.currentUser?.fullAccess,
    loadOptions: async () => ({ slots }),
    fetch: async () => ({ ok: true, json: async () => ({ warnings }) }),
    console: { error() {} }, popToast() {},
    window: { addEventListener: (name, callback) => events.set(name, callback),
      setInterval: (callback) => { tick = callback; } },
  });
  vm.runInContext(source, context);
  return { context, node, events, tick: () => tick(),
    flush: async () => { for (let i = 0; i < 12; i += 1) { await Promise.resolve(); } },
    clearWarnings: () => { warnings = []; } };
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
