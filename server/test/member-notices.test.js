import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../../member-notices.js", import.meta.url), "utf8");

function noticePage() {
  const nodes = [];
  const events = new Map();
  const dispatched = [];
  const errors = [];
  const requests = [];
  let warnings = [];
  let code = 200;
  let acknowledgementFails = false;
  let interval;
  const document = {
    hidden: false,
    body: { append() {} },
    addEventListener: (name, callback) => events.set(name, callback),
    createElement: (tag) => {
      const node = {
        tag, open: false, textContent: "", hidden: false, disabled: false, children: [], handlers: new Map(),
        setAttribute() {},
        append(...children) { this.children.push(...children); },
        addEventListener(name, callback) { this.handlers.set(name, callback); },
        showModal() { this.open = true; },
        close() { this.open = false; },
      };
      nodes.push(node);
      return node;
    },
  };
  const context = vm.createContext({
    document, Event: class { constructor(type) { this.type = type; } },
    location: { protocol: "http:", href: "", replace(value) { this.href = value; } },
    console: { error: (...args) => errors.push(args) },
    window: {
      addEventListener: (name, callback) => events.set(name, callback),
      dispatchEvent: (event) => dispatched.push(event.type),
      setInterval: (callback, delay) => { assert.equal(delay, 10000); interval = callback; },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const action = options?.method === "POST";
      const status = action && acknowledgementFails ? 500 : code;
      if (action && status === 200) {
        warnings = warnings.slice(1);
      }
      const body = status === 403 ? { code: "ACCOUNT_BLOCKED", error: "Account blocked" }
        : status >= 400 ? { error: "Test failure" } : { warnings, ok: true };
      return { status, ok: status === 200, json: async () => body };
    },
  });
  vm.runInContext(source, context);
  const flush = async () => { for (let i = 0; i < 10; i += 1) { await Promise.resolve(); } };
  return {
    nodes, document, context, errors, requests, dispatched, events, flush,
    dialog: nodes[0], heading: nodes[1], message: nodes[2], status: nodes[3], button: nodes[4],
    setWarnings: (value) => { warnings = value; },
    setCode: (value) => { code = value; },
    failAck: () => { acknowledgementFails = true; },
    tick: async () => { await interval(); await flush(); },
    click: async () => { await nodes[4].handlers.get("click")(); await flush(); },
  };
}

test("warnings are shown as plain text, persist on Escape and advance only after acknowledgement", async () => {
  const page = noticePage();
  await page.flush();
  page.setWarnings([{ id: 1, message: "<script>alert(1)</script>" }, { id: 2, message: "Second warning" }]);
  await page.tick();
  assert.equal(page.dialog.open, true);
  assert.equal(page.message.textContent, "<script>alert(1)</script>");
  let prevented = false;
  page.dialog.handlers.get("cancel")({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(page.requests.filter((request) => request.options.method === "POST").length, 0);
  await page.click();
  assert.equal(page.requests.some((request) => request.url === "/api/me/warnings/1/acknowledge"), true);
  assert.equal(page.message.textContent, "Second warning");
  await page.click();
  assert.equal(page.dialog.open, false);
  assert.ok(page.requests.filter((request) => request.options.method !== "POST").every((request) => request.options.cache === "no-store"));
});

test("failed acknowledgement remains visible and shows the server error without discarding the warning", async () => {
  const page = noticePage();
  await page.flush();
  page.setWarnings([{ id: 9, message: "Please follow the rules." }]);
  await page.tick();
  page.failAck();
  await page.click();
  assert.equal(page.dialog.open, true);
  assert.equal(page.message.textContent, "Please follow the rules.");
  assert.equal(page.status.textContent, "Test failure");
  assert.equal(page.button.disabled, false);
  assert.equal(page.errors.length, 1);
});

test("blocked account redirects to the blocked-only page without a sign-in or logout escape", async () => {
  const page = noticePage();
  await page.flush();
  page.setCode(403);
  await page.tick();
  assert.equal(page.dialog.open, false);
  assert.equal(page.context.location.href, "blocked.html");
  assert.ok(page.dispatched.includes("member-blocked"));
  page.setCode(200);
  await page.click();
  assert.equal(page.requests.some((request) => request.url === "/api/auth/logout"), false);
  assert.equal(page.context.location.href, "blocked.html");
});

test("signed-out users do not see warnings; polling errors are explicit but do not block the page", async () => {
  const page = noticePage();
  await page.flush();
  page.setCode(401);
  await page.tick();
  assert.equal(page.dialog.open, false);
  page.setCode(500);
  await page.tick();
  assert.equal(page.dialog.open, false);
  assert.equal(page.nodes[5].hidden, false);
  assert.match(page.nodes[5].textContent, /Retrying automatically/);
  page.setCode(401);
  await page.tick();
  assert.equal(page.nodes[5].hidden, true);
  const count = page.requests.length;
  page.document.hidden = true;
  await page.tick();
  assert.equal(page.requests.length, count);
});
