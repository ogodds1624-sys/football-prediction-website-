import { execute, one } from "./db.js";
import { HttpError } from "./errors.js";

// Predictions managed in the Control Room and shown on the front page.
// Free tips need a (free) account. VIP/VVIP tips are only sent to members
// whose plan covers that table, so a locked tip never reaches the browser.

// "recovery" holds bonus tips for recovery tickets; it is never in the public tables.
export const TIERS = ["free", "vip", "vvip", "recovery"];
const RESULTS = ["pending", "won", "lost"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Pictures are shrunk in the browser first; this keeps a runaway upload out.
const MAX_IMAGE_CHARS = 1_500_000;

export function dateFrom(value) {
  const date = String(value || "");
  if (!DATE_PATTERN.test(date)) {
    throw new HttpError(400, "Invalid date.");
  }
  return date;
}

function text(value, max = 60) {
  return String(value ?? "").trim().slice(0, max);
}

// Validates one match from the Control Room.
export function matchFrom(body) {
  const tier = String(body?.tier || "");
  if (!TIERS.includes(tier)) {
    throw new HttpError(400, "Choose a table: Free, VIP, VVIP or Recovery.");
  }
  const match = {
    tier,
    home: text(body.home),
    away: text(body.away),
    tip: text(body.tip),
    odds: Number(body.odds) > 0 ? Number(body.odds).toFixed(2) : "",
    image: String(body.image || ""),
  };
  if (!match.home || !match.away || !match.tip) {
    throw new HttpError(400, "Fill in both teams and the tip.");
  }
  if (match.image && (!match.image.startsWith("data:image/") || match.image.length > MAX_IMAGE_CHARS)) {
    throw new HttpError(400, "That picture is too large. Try a smaller one.");
  }
  return match;
}

// Which tables a viewer may see tips for. Visitors who aren't signed in
// (plan null) see teams and odds only; a free account unlocks free tips.
// VIP and VVIP each unlock only their own table. A VVIP plan does not reveal VIP tips.
export function unlockedTiers(plan) {
  if (!plan) {
    return new Set();
  }
  if (plan === "vvip") {
    return new Set(["free", "vvip"]);
  }
  if (plan === "vip") {
    return new Set(["free", "vip"]);
  }
  return new Set(["free"]);
}

export async function matchesForDate(date) {
  const { rows } = await execute(
    "SELECT id, date, tier, home, away, tip, odds, image, result FROM matches WHERE date = ? ORDER BY id",
    [date],
  );
  return rows;
}

export function publicMatch(match, unlocked) {
  const open = unlocked.has(match.tier);
  return {
    tier: match.tier,
    home: match.home,
    away: match.away,
    odds: match.odds,
    result: match.result,
    tip: open ? match.tip : null,
    locked: !open,
    // Pictures (often betting slips) would reveal locked tips.
    image: open ? match.image || "" : "",
  };
}

export async function createMatches(date, matches) {
  const created = [];
  for (const match of matches) {
    created.push(
      await one(
        `INSERT INTO matches (date, tier, home, away, tip, odds, image) VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id, date, tier, home, away, tip, odds, image, result`,
        [date, match.tier, match.home, match.away, match.tip, match.odds, match.image],
      ),
    );
  }
  return created;
}

export async function updateMatch(id, match) {
  const updated = await one(
    `UPDATE matches SET tier = ?, home = ?, away = ?, tip = ?, odds = ?, image = ? WHERE id = ?
     RETURNING id, date, tier, home, away, tip, odds, image, result`,
    [match.tier, match.home, match.away, match.tip, match.odds, match.image, id],
  );
  if (!updated) {
    throw new HttpError(404, "That match no longer exists.");
  }
  return updated;
}

export async function setResult(id, result) {
  if (!RESULTS.includes(result)) {
    throw new HttpError(400, "Result must be pending, won or lost.");
  }
  await execute("UPDATE matches SET result = ? WHERE id = ?", [result, id]);
}

export async function deleteMatch(id) {
  await execute("DELETE FROM matches WHERE id = ?", [id]);
}

// Per-day totals for a month ("YYYY-MM"), used by the front page calendar.
export async function monthSummary(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) {
    throw new HttpError(400, "Invalid month.");
  }
  const { rows } = await execute(
    `SELECT date,
            COUNT(*) AS total,
            SUM(result = 'won') AS won,
            SUM(result = 'lost') AS lost
     FROM matches
     WHERE date LIKE ? AND tier != 'recovery'
     GROUP BY date
     ORDER BY date`,
    [`${month}-%`],
  );
  return rows.map((row) => ({
    date: row.date,
    total: Number(row.total),
    won: Number(row.won || 0),
    lost: Number(row.lost || 0),
  }));
}
