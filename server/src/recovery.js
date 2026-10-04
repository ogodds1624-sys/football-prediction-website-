import { execute, one, transaction } from "./db.js";
import { HttpError } from "./errors.js";
import { getPlan } from "./plans.js";

// Recovery tickets: a member who bought a VIP/VVIP ticket that LOST gets the
// admin's bonus ("recovery") tips. A recovery is valid for the 2 days after
// the lost ticket; after that they need to buy again. Winning tickets and
// tickets still waiting for results don't qualify.

const DAY_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_DAYS = 2;

// Dates are plain "YYYY-MM-DD" strings, compared in UTC (Ghana time).
export function todayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

// Records a purchase so recovery can check it later. Works inside or outside a transaction.
export async function recordPurchase(runner, userId, planId, date, source) {
  await runner.execute("INSERT INTO purchases (user_id, plan, date, source) VALUES (?, ?, ?, ?)", [
    userId,
    planId,
    date,
    source,
  ]);
}

// How a ticket (one table on one day) ended: "lost" if any tip lost,
// "won" if every tip is decided and none lost, otherwise "pending".
async function ticketOutcome(date, tier) {
  const row = await one(
    `SELECT COUNT(*) AS total, SUM(result = 'lost') AS lost, SUM(result = 'pending') AS pending
     FROM matches WHERE date = ? AND tier = ?`,
    [date, tier],
  );
  const total = Number(row?.total || 0);
  if (Number(row?.lost || 0) > 0) {
    return "lost";
  }
  if (!total || Number(row?.pending || 0) > 0) {
    return "pending";
  }
  return "won";
}

/**
 * Checks whether a member may use a recovery ticket on `date` (their today).
 * Returns { status, ... } where status is one of:
 *   "eligible" – a ticket lost within the last 2 days; tips are included
 *   "won"      – their recent ticket won, so no recovery
 *   "pending"  – results for their recent ticket aren't in yet
 *   "expired"  – their lost ticket is older than 2 days
 *   "none"     – no VIP/VVIP purchase on record
 */
export async function checkRecovery(userId, date) {
  const { rows: purchases } = await execute(
    "SELECT plan, date FROM purchases WHERE user_id = ? AND date < ? ORDER BY date DESC, id DESC LIMIT 10",
    [userId, date],
  );
  if (!purchases.length) {
    const today = await one("SELECT id FROM purchases WHERE user_id = ? AND date = ?", [userId, date]);
    return today
      ? { status: "pending", message: "Your ticket from today is still being played. Recovery opens the next day if it loses." }
      : { status: "none", message: "We couldn't find a VIP or VVIP purchase on this account." };
  }

  let sawWin = false;
  let sawPending = false;
  for (const purchase of purchases) {
    const age = daysBetween(purchase.date, date);
    if (age > RECOVERY_DAYS) {
      break;
    }
    const outcome = await ticketOutcome(purchase.date, purchase.plan);
    if (outcome === "lost") {
      const { rows: tips } = await execute(
        "SELECT home, away, tip, odds, result FROM matches WHERE date = ? AND tier = 'recovery' ORDER BY id",
        [date],
      );
      return {
        status: "eligible",
        plan: purchase.plan,
        lostDate: purchase.date,
        validUntil: shiftDate(purchase.date, RECOVERY_DAYS),
        tips,
        message: tips.length
          ? "Your recovery ticket is ready. Here are today's bonus tips."
          : "You qualify for a recovery ticket. Today's bonus tips will be posted soon. Check back shortly.",
      };
    }
    sawWin ||= outcome === "won";
    sawPending ||= outcome === "pending";
  }

  if (sawPending) {
    return { status: "pending", message: "Results for your recent ticket aren't in yet. Check again once the matches have finished." };
  }
  if (sawWin) {
    return { status: "won", message: "Good news: your recent ticket won, so no recovery is needed. Recovery tickets are only for lost tickets." };
  }
  return {
    status: "expired",
    message: `Recovery tickets are valid for ${RECOVERY_DAYS} days after a lost ticket. Buy a new VIP or VVIP plan to continue.`,
  };
}

// Admin: mark a member as paid (e.g. MoMo) for a plan on a day, and unlock their tips.
export async function activatePlan(email, planId, date) {
  const plan = getPlan(planId);
  if (!plan) {
    throw new HttpError(400, "Choose VIP or VVIP.");
  }
  const user = await one("SELECT id, email, plan, plan_expires_at FROM users WHERE email = ?", [String(email || "").trim()]);
  if (!user) {
    throw new HttpError(404, "No account uses that email. Ask the member to create an account first.");
  }
  await transaction(async (tx) => {
    await recordPurchase(tx, user.id, plan.id, date, "manual");
    // Purchases for today unlock the member's tips until the end of today (UTC).
    if (date === todayKey()) {
      const endOfDay = `${shiftDate(date, 1)}T00:00:00.000Z`;
      const keepHigher = user.plan_expires_at > new Date().toISOString() && getPlan(user.plan)?.rank > plan.rank;
      await tx.execute("UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?", [
        keepHigher ? user.plan : plan.id,
        keepHigher && user.plan_expires_at > endOfDay ? user.plan_expires_at : endOfDay,
        user.id,
      ]);
    }
  });
  return { email: user.email, plan: plan.id, date };
}

// Everyone with an account, most recent visitor first. Plan is "free" once a paid plan has run out.
export async function listMembers() {
  const now = new Date().toISOString();
  const { rows } = await execute(
    `SELECT id, name, email, plan, plan_expires_at, created_at, last_seen_at
     FROM users ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC LIMIT 500`,
  );
  return rows.map((user) => ({
    id: user.id,
    name: user.name || "",
    email: user.email,
    plan: user.plan !== "free" && user.plan_expires_at > now ? user.plan : "free",
    joinedAt: user.created_at,
    lastSeenAt: user.last_seen_at || null,
  }));
}

export async function memberTotals() {
  const now = new Date().toISOString();
  const row = await one(
    `SELECT COUNT(*) AS users,
            SUM(plan = 'vip' AND plan_expires_at > ?) AS vip,
            SUM(plan = 'vvip' AND plan_expires_at > ?) AS vvip
     FROM users`,
    [now, now],
  );
  return { users: Number(row?.users || 0), vip: Number(row?.vip || 0), vvip: Number(row?.vvip || 0) };
}
