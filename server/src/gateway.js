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
  { id: "momo", label: "Ghana MoMo", country: "ghana", fields: ["network", "number", "name"] },
  { id: "ghBank", label: "Ghana bank", country: "ghana", fields: ["bank", "number", "name"] },
  { id: "ngBank", label: "Nigeria bank transfer", country: "nigeria", fields: ["bank", "number", "name"] },
  {
    id: "usdt",
    label: "USDT (TRC20)",
    countries: ["kenya", "uganda", "international"],
    fields: ["network", "number", "name"],
  },
];

// Used when the Control Room rate boxes are left blank.
export const NGN_PER_GHS = 120;
export const NGN_PER_USDT = 1329;

export function methodCountries(method) {
  if (Array.isArray(method?.countries) && method.countries.length) {
    return method.countries;
  }
  return method?.country ? [method.country] : [];
}

export function methodServes(method, country) {
  return methodCountries(method).includes(country);
}

// USDT = GHS price × naira per GHS ÷ naira per USDT.
// Blank rates use 1 GHS = 120 NGN and 1 USDT = 1,329 NGN.
export function usdtFromGhs(ghsMajor, rates = {}) {
  const ngnPerGhs = rates.ngn ?? NGN_PER_GHS;
  const ngnPerUsdt = rates.usdtNgn ?? NGN_PER_USDT;
  const minor = Math.round((Number(ghsMajor) * 100 * ngnPerGhs) / ngnPerUsdt);
  return {
    currency: "USDT",
    amount: minor / 100,
    ngnPerGhs,
    ngnPerUsdt,
  };
}

export const COUNTRIES = ["ghana", "nigeria", "kenya", "uganda", "international"];

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
  return { ...Object.fromEntries(RATE_CURRENCIES.map((currency) => [currency.id, null])), usdtNgn: null };
}

function rateOrNull(raw, label) {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1e7) {
    throw new HttpError(400, `Enter a valid rate for ${label}, or leave it empty.`);
  }
  return Math.round(value * 10000) / 10000;
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
    rates[currency.id] = rateOrNull(input[currency.id], currency.country);
  }
  rates.usdtNgn = rateOrNull(input.usdtNgn, "USDT");
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
    (method) => ({
      id: method.id,
      label: method.label,
      country: method.country || null,
      countries: methodCountries(method),
      accounts: checkout.methods[method.id].accounts,
    }),
  );
  const usdt = usdtFromGhs(1, rates);
  return {
    businessName: checkout.businessName,
    whatsapp: checkout.whatsapp,
    email: checkout.email,
    methods,
    rates: RATE_CURRENCIES.filter((currency) => rates[currency.id]).map((currency) => ({ ...currency, rate: rates[currency.id] })),
    usdt: { ngnPerGhs: usdt.ngnPerGhs, ngnPerUsdt: usdt.ngnPerUsdt },
  };
}
