// Default prices in CURRENCY. Country-specific overrides are saved separately;
// name, length and rank stay here. Amounts use the smallest currency unit.
// A buyer never sends a price. Payments read the saved amount on the server.
import { config } from "./config.js";
import { execute, one } from "./db.js";
import { HttpError } from "./errors.js";
import { getGateway, NGN_PER_GHS, usdtFromGhs } from "./gateway.js";

export const PLANS = {
  // Daily packages: each purchase covers one day and is renewed by buying again.
  vip: { id: "vip", name: "VIP", amount: 5000, days: 1, rank: 1 },
  vvip: { id: "vvip", name: "VVIP", amount: 10000, days: 1, rank: 2 },
  // Same daily shape as VIP. Rank stays below VIP so buying boom does not replace an active VIP plan.
  boom: { id: "boom", name: "Wake up to boom games", amount: 5000, days: 1, rank: 0 },
  weekly: { id: "weekly", name: "WEEKLY ROLLOVER", amount: 10000, days: 7, rank: 3 },
};

const PRICE_KEY = "planPrices";
const SLOT_KEY = "planSlots";
const COUNTRY_PRICE_CURRENCIES = {
  nigeria: "NGN",
  kenya: "USDT",
  uganda: "USDT",
  international: "USDT",
};

export function getPlan(planId) {
  return Object.hasOwn(PLANS, planId) ? PLANS[planId] : null;
}

function minorUnits(value, label) {
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new HttpError(400, `Enter a ${label} price with up to 2 decimal places.`);
  }
  const amount = Math.round(Number(text) * 100);
  if (amount < 1 || amount > 100_000_000) {
    throw new HttpError(400, `Enter a ${label} price greater than zero.`);
  }
  return amount;
}

async function savedAmounts() {
  const row = await one("SELECT value FROM settings WHERE key = ?", [PRICE_KEY]);
  let stored = {};
  if (row) {
    try {
      stored = JSON.parse(row.value);
    } catch {
      stored = {};
    }
  }
  const amounts = {};
  for (const plan of Object.values(PLANS)) {
    const saved = Number(stored[plan.id]);
    amounts[plan.id] = Number.isInteger(saved) && saved > 0 ? saved : plan.amount;
  }
  return amounts;
}

async function savedCountryAmounts() {
  const row = await one("SELECT value FROM settings WHERE key = ?", [PRICE_KEY]);
  if (!row) {
    return {};
  }
  try {
    const stored = JSON.parse(row.value);
    const countries = {};
    for (const country of Object.keys(COUNTRY_PRICE_CURRENCIES)) {
      const amounts = stored?.countries?.[country];
      if (!amounts || typeof amounts !== "object") {
        continue;
      }
      countries[country] = {};
      for (const plan of Object.values(PLANS)) {
        const amount = Number(amounts[plan.id]);
        countries[country][plan.id] = Number.isInteger(amount) && amount > 0 ? amount : null;
      }
    }
    return countries;
  } catch {
    return {};
  }
}

// Base plan details with the Control Room price, in the smallest currency unit.
export async function getPricedPlan(planId) {
  const plan = getPlan(planId);
  if (!plan) {
    return null;
  }
  const amounts = await savedAmounts();
  return { ...plan, amount: amounts[plan.id] };
}

export async function getCountryPlanPrice(planId, country) {
  const plan = getPlan(planId);
  if (!plan) {
    return null;
  }
  const amounts = await savedAmounts();
  if (!Object.hasOwn(COUNTRY_PRICE_CURRENCIES, country)) {
    return { amount: amounts[plan.id], currency: config.currency };
  }

  const overrides = await savedCountryAmounts();
  const override = overrides[country]?.[plan.id];
  if (override) {
    return { amount: override, currency: COUNTRY_PRICE_CURRENCIES[country] };
  }

  const { rates } = await getGateway();
  if (country === "nigeria") {
    const ngnPerGhs = rates.ngn ?? NGN_PER_GHS;
    return { amount: Math.round(amounts[plan.id] * ngnPerGhs), currency: "NGN" };
  }
  const quote = usdtFromGhs(amounts[plan.id] / 100, rates);
  return { amount: Math.round(quote.amount * 100), currency: quote.currency };
}

export async function publicCountryPlanPrices() {
  const basePrices = await publicPlanPrices();
  const overrides = await savedCountryAmounts();
  const { rates } = await getGateway();
  const prices = {};
  for (const country of ["ghana", ...Object.keys(COUNTRY_PRICE_CURRENCIES)]) {
    prices[country] = {};
    for (const plan of Object.values(PLANS)) {
      const base = Math.round(basePrices[plan.id] * 100);
      const override = overrides[country]?.[plan.id];
      let price = { amount: base, currency: config.currency };
      if (country !== "ghana") {
        if (override) {
          price = { amount: override, currency: COUNTRY_PRICE_CURRENCIES[country] };
        } else if (country === "nigeria") {
          price = { amount: Math.round(base * (rates.ngn ?? NGN_PER_GHS)), currency: "NGN" };
        } else {
          const quote = usdtFromGhs(base / 100, rates);
          price = { amount: Math.round(quote.amount * 100), currency: quote.currency };
        }
      }
      prices[country][plan.id] = { currency: price.currency, amount: price.amount / 100 };
    }
  }
  return prices;
}

export async function publicPlanPriceOverrides() {
  const amounts = await savedCountryAmounts();
  return Object.fromEntries(
    Object.entries(amounts).map(([country, countryPrices]) => [
      country,
      Object.fromEntries(Object.entries(countryPrices).map(([plan, amount]) => [plan, amount == null ? null : amount / 100])),
    ]),
  );
}

// What the website and the Control Room show: prices in normal currency units.
export async function publicPlanPrices() {
  const amounts = await savedAmounts();
  const plans = {};
  for (const plan of Object.values(PLANS)) {
    plans[plan.id] = amounts[plan.id] / 100;
  }
  return plans;
}

export async function savePlanPrices(input) {
  const current = await publicPlanPrices();
  const currentCountries = await savedCountryAmounts();
  const prices = {
    vip: minorUnits(input?.vip ?? current.vip, "VIP"),
    vvip: minorUnits(input?.vvip ?? current.vvip, "VVIP"),
    boom: minorUnits(input?.boom ?? current.boom, "Wake up to boom games"),
    weekly: minorUnits(input?.weekly ?? current.weekly, "WEEKLY ROLLOVER"),
  };
  const countries = {};
  for (const country of Object.keys(COUNTRY_PRICE_CURRENCIES)) {
    countries[country] = {};
    for (const plan of Object.values(PLANS)) {
      const supplied = input?.countries?.[country];
      const hasPrice = supplied && Object.hasOwn(supplied, plan.id);
      const raw = hasPrice ? supplied[plan.id] : currentCountries[country]?.[plan.id];
      countries[country][plan.id] =
        raw == null || String(raw).trim() === "" ? null : minorUnits(raw, `${country} ${plan.name}`);
    }
  }
  await execute(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [PRICE_KEY, JSON.stringify({ ...prices, countries })],
  );
  return {
    plans: { vip: prices.vip / 100, vvip: prices.vvip / 100, boom: prices.boom / 100, weekly: prices.weekly / 100 },
    countries: Object.fromEntries(
      Object.entries(countries).map(([country, countryPrices]) => [
        country,
        Object.fromEntries(Object.entries(countryPrices).map(([plan, amount]) => [plan, amount == null ? null : amount / 100])),
      ]),
    ),
  };
}

function wholeSlots(value, label) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw new HttpError(400, `Enter a whole number of ${label} slots.`);
  }
  const count = Number(text);
  if (count > 100_000) {
    throw new HttpError(400, `${label} slots are too high.`);
  }
  return count;
}

// Null means the Control Room has not set a cap, so the public page hides the line.
export async function readPlanSlots() {
  const row = await one("SELECT value FROM settings WHERE key = ?", [SLOT_KEY]);
  let stored = {};
  if (row) {
    try {
      stored = JSON.parse(row.value);
    } catch {
      stored = {};
    }
  }
  const slot = (tier) => {
    if (stored[tier] == null || stored[tier] === "") {
      return null;
    }
    const count = Number(stored[tier]);
    return Number.isInteger(count) && count >= 0 ? count : null;
  };
  return { vip: slot("vip"), vvip: slot("vvip"), boom: slot("boom"), weekly: slot("weekly") };
}

export async function savePlanSlots(input) {
  const current = await readPlanSlots();
  const slots = {
    vip: wholeSlots(input?.vip, "VIP"),
    vvip: wholeSlots(input?.vvip, "VVIP"),
    boom: input?.boom == null || String(input.boom).trim() === "" ? current.boom : wholeSlots(input.boom, "Wake up to boom games"),
    weekly: input?.weekly == null || String(input.weekly).trim() === "" ? current.weekly : wholeSlots(input.weekly, "WEEKLY ROLLOVER"),
  };
  await execute(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [SLOT_KEY, JSON.stringify(slots)],
  );
  return slots;
}
