import crypto from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";
import { execute, one, transaction } from "./db.js";
import { activeAccess, restorePaidWeeklyAccess } from "./access.js";

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const SESSION_COOKIE = "session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_COOKIE = "member_device";
const DEVICE_MS = 365 * 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function rememberDevice(req, res, userId) {
  let token = readCookie(req, DEVICE_COOKIE);
  if (/^[a-f0-9]{64}$/.test(token || "")) {
    const known = await one("SELECT user_id FROM user_devices WHERE token_hash = ? AND user_id = ?", [
      crypto.createHash("sha256").update(token).digest("hex"), userId,
    ]);
    if (known) {
      return;
    }
  }
  if (!/^[a-f0-9]{64}$/.test(token || "")) {
    token = crypto.randomBytes(32).toString("hex");
  }
  res.cookie(DEVICE_COOKIE, token, {
    httpOnly: true, secure: config.isProduction, sameSite: "lax",
    maxAge: DEVICE_MS, path: "/",
  });
  await execute("INSERT OR IGNORE INTO user_devices (token_hash, user_id) VALUES (?, ?)", [
    crypto.createHash("sha256").update(token).digest("hex"), userId,
  ]);
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !expected) {
    return false;
  }
  const key = await scrypt(password, Buffer.from(salt, "base64"), KEY_LENGTH);
  return safeEqual(key.toString("base64"), expected);
}

export function findUserById(userId) {
  return one("SELECT id, email, name, plan, slot_plan, plan_expires_at, vip_access_until, vvip_access_until, boom_access_until, country, last_seen_at, blocked_at, session_version FROM users WHERE id = ?", [userId]);
}

// This account always sees VIP and VVIP. No other account is treated this way.
export const FULL_ACCESS_EMAIL = "peels.hounds_6j@icloud.com";

export function hasFullAccess(user) {
  return String(user?.email || "").trim().toLowerCase() === FULL_ACCESS_EMAIL;
}

export function publicUser(user) {
  const plans = activeAccess(user);
  const plan = plans[0]?.plan || "free";
  return {
    id: user.id,
    email: user.email,
    name: user.name || "",
    plan,
    planExpiresAt: plans[0]?.expiresAt || null,
    plans,
    country: user.country || "",
    fullAccess: hasFullAccess(user),
  };
}

/* ---------- Signed session cookie: "<userId>.<expiresMs>.<hmac>" ---------- */

function sign(value) {
  return crypto.createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
}

export function startSession(res, userId, version = 0) {
  const expires = Date.now() + SESSION_MS;
  const value = `${userId}.${expires}.${version}`;
  res.cookie(SESSION_COOKIE, `${value}.${sign(value)}`, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    maxAge: SESSION_MS,
    path: "/",
  });
}

export function endSession(res) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

function memberSession(req) {
  const cookie = readCookie(req, SESSION_COOKIE);
  const parts = (cookie || "").split(".");
  const [userId, expires] = parts;
  const legacy = parts.length === 3;
  const version = legacy ? 0 : Number(parts[2]);
  const signature = legacy ? parts[2] : parts[3];
  if (!userId || !expires || !signature) {
    return null;
  }
  const value = legacy ? `${userId}.${expires}` : `${userId}.${expires}.${parts[2]}`;
  if ((!legacy && parts.length !== 4) || !Number.isSafeInteger(version) || version < 0 ||
      !safeEqual(signature, sign(value)) || Number(expires) < Date.now()) {
    return null;
  }
  return { userId: Number(userId), version };
}

// Last visits are written at most this often per member, so browsing stays cheap.
const SEEN_EVERY_MS = 10 * 60 * 1000;

export async function markSeen(user) {
  const now = new Date();
  if (user.last_seen_at && now - new Date(user.last_seen_at) < SEEN_EVERY_MS) {
    return;
  }
  user.last_seen_at = now.toISOString();
  await execute("UPDATE users SET last_seen_at = ? WHERE id = ?", [user.last_seen_at, user.id]);
}

async function restoreWeeklyExpiry(user) {
  const restored = await transaction((tx) => restorePaidWeeklyAccess(tx, user.id));
  if (restored) {
    Object.assign(user, await findUserById(user.id));
  }
  if (user.plan !== "weekly") {
    return;
  }
  const approval = await one(
    `SELECT MAX(approved_at) AS approved_at FROM (
       SELECT updated_at AS approved_at FROM manual_payments
       WHERE user_id = ? AND plan = 'weekly' AND status = 'confirmed'
       UNION ALL
       SELECT paid_at AS approved_at FROM payments
       WHERE user_id = ? AND plan = 'weekly' AND status = 'success'
       UNION ALL
       SELECT created_at AS approved_at FROM purchases
       WHERE user_id = ? AND plan = 'weekly' AND date = substr(created_at, 1, 10)
     )`,
    [user.id, user.id, user.id],
  );
  const approvedAt = Date.parse(approval?.approved_at || "");
  if (!Number.isFinite(approvedAt)) {
    return;
  }
  const minimumExpiry = new Date(approvedAt + WEEK_MS).toISOString();
  if (Date.parse(user.plan_expires_at || "") >= Date.parse(minimumExpiry)) {
    return;
  }

  const updated = await execute(
    `UPDATE users SET plan_expires_at = ?
     WHERE id = ? AND plan = 'weekly' AND COALESCE(plan_expires_at, '') = COALESCE(?, '')`,
    [minimumExpiry, user.id, user.plan_expires_at],
  );
  if (updated.rowsAffected) {
    user.plan_expires_at = minimumExpiry;
    return;
  }
  const latest = await findUserById(user.id);
  if (latest) {
    user.plan_expires_at = latest.plan_expires_at;
  }
}

// Attaches req.user (or null) to every request, and notes the member's visit.
export async function loadUser(req, res, next) {
  const session = memberSession(req);
  const user = session ? await findUserById(session.userId) : null;
  if (user) {
    await rememberDevice(req, res, user.id);
  }
  const token = readCookie(req, DEVICE_COOKIE);
  const blockedDevice = /^[a-f0-9]{64}$/.test(token || "")
    ? await one(`SELECT users.id FROM user_devices JOIN users ON users.id = user_devices.user_id
       WHERE token_hash = ? AND users.blocked_at IS NOT NULL LIMIT 1`,
      [crypto.createHash("sha256").update(token).digest("hex")])
    : null;
  req.blockedUser = Boolean(user?.blocked_at || blockedDevice);
  req.user = user && !req.blockedUser && user.session_version === session.version ? user : null;
  if (req.user) {
    await restoreWeeklyExpiry(req.user);
    await markSeen(req.user);
  }
  next();
}

/* ---------- Admin session: separate cookie, signed for the "admin" role ---------- */

const ADMIN_COOKIE = "admin_session";
const ADMIN_MS = 12 * 60 * 60 * 1000;

function signAdmin(expires) {
  return sign(`admin:${expires}`);
}

export function startAdminSession(res) {
  const expires = Date.now() + ADMIN_MS;
  res.cookie(ADMIN_COOKIE, `${expires}.${signAdmin(expires)}`, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    maxAge: ADMIN_MS,
    path: "/",
  });
}

export function endAdminSession(res) {
  res.clearCookie(ADMIN_COOKIE, { path: "/" });
}

export function requireAdmin(req, res, next) {
  const [expires, signature] = (readCookie(req, ADMIN_COOKIE) || "").split(".");
  const valid = expires && signature && safeEqual(signature, signAdmin(expires)) && Number(expires) > Date.now();
  if (!valid) {
    res.status(401).json({ error: "Admin sign-in required." });
    return;
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Please sign in first." });
    return;
  }
  next();
}
