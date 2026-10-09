// Default prices. The Control Room can replace the amounts; name, length and
// rank stay here. Amounts are in the smallest currency unit:
// 5000 = GH₵ 50.00 (or ₦50.00 / $50.00 depending on CURRENCY).
// A buyer never sends a price. Payments read the saved amount on the server.
import { execute, one } from "./db.js";
import { HttpError } from "./errors.js";

export const PLANS = {
  // Daily packages: each purchase covers one day and is renewed by buying again.
  vip: { id: "vip", name: "VIP", amount: 5000, days: 1, rank: 1 },
  vvip: { id: "vvip", name: "VVIP", amount: 10000, days: 1, rank: 2 },
  // Same daily shape as VIP. Rank stays below VIP so buying boom does not replace an active VIP plan.
  boom: { id: "boom", name: "Wake up to boom games", amount: 5000, days: 1, rank: 0 },
};

const PRICE_KEY = "planPrices";
const SLOT_KEY = "planSlots";

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

// Plan details with the Control Room price, in the smallest currency unit.
export async function getPricedPlan(planId) {
  const plan = getPlan(planId);
  if (!plan) {
    return null;
  }
  const amounts = await savedAmounts();
  return { ...plan, amount: amounts[plan.id] };
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
  const prices = {
    vip: minorUnits(input?.vip ?? current.vip, "VIP"),
    vvip: minorUnits(input?.vvip ?? current.vvip, "VVIP"),
    boom: minorUnits(input?.boom ?? current.boom, "Wake up to boom games"),
  };
  await execute(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [PRICE_KEY, JSON.stringify(prices)],
  );
  return { vip: prices.vip / 100, vvip: prices.vvip / 100, boom: prices.boom / 100 };
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
  return { vip: slot("vip"), vvip: slot("vvip"), boom: slot("boom") };
}

export async function savePlanSlots(input) {
  const current = await readPlanSlots();
  const slots = {
    vip: wholeSlots(input?.vip, "VIP"),
    vvip: wholeSlots(input?.vvip, "VVIP"),
    boom: input?.boom == null || String(input.boom).trim() === "" ? current.boom : wholeSlots(input.boom, "Wake up to boom games"),
  };
  await execute(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [SLOT_KEY, JSON.stringify(slots)],
  );
  return slots;
}
