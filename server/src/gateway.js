import { execute, one } from "./db.js";
import { HttpError } from "./errors.js";

// Manual checkout settings managed in the Control Room: who to pay, how, and
// exchange rates for showing plan prices in other currencies.
// Everything starts empty and switched off.

export const RATE_CURRENCIES = [
  { id: "ngn", country: "Nigeria", symbol: "₦" },
  { id: "kes", country: "Kenya", symbol: "KSh" },
  { id: "tzs", country: "Tanzania", symbol: "TSh" },
  { id: "zmw", country: "Zambia", symbol: "ZK" },
  { id: "zar", country: "South Africa", symbol: "R" },
];

export const METHODS = [
  { id: "momo", label: "Ghana MoMo", fields: ["network", "number", "name"] },
  { id: "ghBank", label: "Ghana bank", fields: ["bank", "number", "name"] },
  { id: "ngBank", label: "Nigeria bank transfer", fields: ["bank", "number", "name"] },
];

const MAX_ACCOUNTS = 5;
const MAX_TEXT = 60;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emptyCheckout() {
  return {
    businessName: "",
    whatsapp: "",
    email: "",
    methods: Object.fromEntries(METHODS.map((method) => [method.id, { enabled: false, accounts: [] }])),
  };
}

function emptyRates() {
  return Object.fromEntries(RATE_CURRENCIES.map((currency) => [currency.id, null]));
}

function text(value, max = MAX_TEXT) {
  return String(value ?? "").trim().slice(0, max);
}

// Turns whatever the browser sent into a clean, bounded settings object.
export function cleanCheckout(input = {}) {
  const email = text(input.email, 120);
  if (email && !EMAIL_PATTERN.test(email)) {
    throw new HttpError(400, "Enter a valid support email, or leave it empty.");
  }
  const whatsapp = String(input.whatsapp ?? "").replace(/\D/g, "").slice(0, 15);

  const methods = {};
  for (const method of METHODS) {
    const source = input.methods?.[method.id] || {};
    const accounts = (Array.isArray(source.accounts) ? source.accounts : [])
      .map((account) => Object.fromEntries(method.fields.map((field) => [field, text(account?.[field])])))
      .filter((account) => method.fields.some((field) => account[field]))
      .slice(0, MAX_ACCOUNTS);
    methods[method.id] = { enabled: source.enabled === true, accounts };
  }

  return { businessName: text(input.businessName), whatsapp, email, methods };
}

export function cleanRates(input = {}) {
  const rates = {};
  for (const currency of RATE_CURRENCIES) {
    const raw = input[currency.id];
    if (raw === null || raw === undefined || raw === "") {
      rates[currency.id] = null;
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 1e7) {
      throw new HttpError(400, `Enter a valid rate for ${currency.country}, or leave it empty.`);
    }
    rates[currency.id] = Math.round(value * 10000) / 10000;
  }
  return rates;
}

async function readSetting(key, fallback) {
  const row = await one("SELECT value FROM settings WHERE key = ?", [key]);
  if (!row) {
    return fallback;
  }
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

async function writeSetting(key, value) {
  await execute(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [key, JSON.stringify(value)],
  );
}

export async function getGateway() {
  return {
    checkout: cleanCheckout(await readSetting("checkout", emptyCheckout())),
    rates: cleanRates(await readSetting("rates", emptyRates())),
  };
}

export async function saveCheckout(input) {
  const checkout = cleanCheckout(input);
  await writeSetting("checkout", checkout);
  return checkout;
}

export async function saveRates(input) {
  const rates = cleanRates(input);
  await writeSetting("rates", rates);
  return rates;
}

// What visitors may see: only switched-on methods that have accounts, and only set rates.
export async function publicCheckout() {
  const { checkout, rates } = await getGateway();
  const methods = METHODS.filter((method) => checkout.methods[method.id].enabled && checkout.methods[method.id].accounts.length).map(
    (method) => ({ id: method.id, label: method.label, accounts: checkout.methods[method.id].accounts }),
  );
  return {
    businessName: checkout.businessName,
    whatsapp: checkout.whatsapp,
    email: checkout.email,
    methods,
    rates: RATE_CURRENCIES.filter((currency) => rates[currency.id]).map((currency) => ({ ...currency, rate: rates[currency.id] })),
  };
}
