import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../../script.js", import.meta.url), "utf8");

test("footer social icons remain visible without navigation or interactive controls", () => {
  const socials = html.slice(html.indexOf('<div class="social-links">'), html.indexOf('<p class="copyright">'));
  assert.equal((socials.match(/<span class="social-link /g) || []).length, 4);
  assert.doesNotMatch(socials, /<a\b|<button\b|\bhref=|\bonclick=|\btabindex=/);
  for (const label of ["WhatsApp", "TikTok", "Instagram", "X"]) {
    assert.ok(socials.includes(`role="img" aria-label="${label}"`));
  }
});

test("support replies and footer support prompts remain active", () => {
  const context = vm.createContext({
    supportInfo: { plans: [], currency: "GHS" },
    currentUser: null,
    whatsappLink: (number) => `https://wa.me/${number}`,
  });
  vm.runInContext(source.slice(source.indexOf("function moneyAmount("), source.indexOf("let footerGlowTimer;")), context);
  for (const question of ["How do the predictions work?", "How do I confirm a payment?", "What is Weekly rollover?"]) {
    assert.ok(context.supportReply(question).text.length > 0);
  }
  assert.equal(context.supportReply("WhatsApp support").link.href, "https://wa.me/233597559382");
  assert.ok(html.includes('data-help-ask="How do I confirm a payment?"'));
  assert.ok(source.includes("sendHelp(ask.dataset.helpAsk)"));
  assert.ok(source.includes('document.querySelector("#help-send").addEventListener'));
});
