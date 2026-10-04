import crypto from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";
import { one } from "./db.js";

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const SESSION_COOKIE = "session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

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
  return one("SELECT id, email, name, plan, plan_expires_at FROM users WHERE id = ?", [userId]);
}

export function publicUser(user) {
  const active = user.plan !== "free" && user.plan_expires_at && user.plan_expires_at > new Date().toISOString();
  return {
    id: user.id,
    email: user.email,
    name: user.name || "",
    plan: active ? user.plan : "free",
    planExpiresAt: active ? user.plan_expires_at : null,
  };
}

/* ---------- Signed session cookie: "<userId>.<expiresMs>.<hmac>" ---------- */

function sign(value) {
  return crypto.createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
}

export function startSession(res, userId) {
  const expires = Date.now() + SESSION_MS;
  const value = `${userId}.${expires}`;
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

function sessionUserId(req) {
  const cookie = readCookie(req, SESSION_COOKIE);
  const [userId, expires, signature] = (cookie || "").split(".");
  if (!userId || !expires || !signature) {
    return null;
  }
  if (!safeEqual(signature, sign(`${userId}.${expires}`)) || Number(expires) < Date.now()) {
    return null;
  }
  return Number(userId);
}

// Attaches req.user (or null) to every request.
export async function loadUser(req, res, next) {
  const userId = sessionUserId(req);
  req.user = userId ? await findUserById(userId) : null;
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
