import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../../pay.js", import.meta.url), "utf8");

function checkout({ plan = "vip", status = "confirmed", userPlan = "free", slots = null, signedIn = true } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        hidden: false, textContent: "", disabled: false, open: false,
        dataset: {}, addEventListener() {}, setAttribute() {},
        replaceChildren() {}, querySelectorAll() { return []; },
        showModal() { this.open = true; }, close() { this.open = false; },
      });
    }
    return elements.get(id);
  };
  let currentStatus = status;
  const redirects = [];
  const context = vm.createContext({
    URLSearchParams,
    location: { search: `?plan=${plan}`, replace: (path) => redirects.push(path) },
    document: { querySelector: element, createElement: () => element(Symbol()) },
    window: { setInterval: () => 1, clearInterval() {} },
    fetch: async (url) => ({
      ok: true,
      json: async () => url === "/api/me"
        ? { user: signedIn ? { plan: userPlan, country: "ghana" } : null }
        : url === "/api/payments/options"
          ? { currency: "GHS", slots: { [plan]: slots }, plans: [
            { id: plan, name: plan.toUpperCase(), days: plan === "weekly" ? 7 : 1, amount: 100 },
          ], checkout: { methods: [
            { id: "momo", label: "MoMo", country: "ghana", accounts: [{ network: "MTN", number: "0241111111", name: "Test" }] },
          ] } }
          : { payment: currentStatus ? { status: currentStatus } : null },
    }),
  });
  vm.runInContext(source.replace(/\bloadPage\(\);\s*$/, ""), context);
  return { context, elements, redirects, setStatus: (value) => { currentStatus = value; } };
}

test("old approved receipts do not send expired members home when buying any plan", async () => {
  for (const plan of ["vip", "vvip", "boom", "weekly"]) {
    const page = checkout({ plan });
    await page.context.loadPage();
    assert.deepEqual(page.redirects, []);
    assert.equal(page.elements.get("#pay-sheet").hidden, false);
    assert.equal(page.elements.get("#pay-heading").textContent, `${plan.toUpperCase()} plan fee`);
    assert.equal(page.elements.get("#pay-confirm").open, false);
  }
});

test("active members can renew despite their previous approved receipt", async () => {
  const page = checkout({ plan: "weekly", userPlan: "weekly" });
  await page.context.loadPage();
  assert.deepEqual(page.redirects, []);
  assert.equal(page.elements.get("#pay-sheet").hidden, false);
});

test("pending receipts still wait and a new approval returns members home", async () => {
  const page = checkout({ status: "pending" });
  await page.context.loadPage();
  assert.deepEqual(page.redirects, []);
  assert.equal(page.elements.get("#pay-confirm").open, true);
  assert.equal(page.elements.get("#pay-form").hidden, true);
  page.setStatus("confirmed");
  await page.context.checkDecision();
  assert.deepEqual(page.redirects, ["index.html"]);
});

test("rejected or absent receipts allow another purchase", async () => {
  for (const status of ["rejected", ""]) {
    const page = checkout({ status });
    await page.context.loadPage();
    assert.deepEqual(page.redirects, []);
    assert.equal(page.elements.get("#pay-sheet").hidden, false);
    assert.equal(page.elements.get("#pay-confirm").open, false);
  }
});

test("old approvals do not bypass full slots or sign-in requirements", async () => {
  const full = checkout({ slots: 0 });
  await full.context.loadPage();
  assert.deepEqual(full.redirects, []);
  assert.equal(full.elements.get("#pay-sheet").hidden, true);
  assert.match(full.elements.get("#pay-empty").textContent, /slots are full/);
  const visitor = checkout({ signedIn: false });
  await visitor.context.loadPage();
  assert.deepEqual(visitor.redirects, ["account.html?mode=register&next=pay.html%3Fplan%3Dvip"]);
});
