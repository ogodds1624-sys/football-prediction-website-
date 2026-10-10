import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load server/.env into process.env. Real environment variables (e.g. set by
// your host) win, because loadEnvFile never overwrites existing values.
try {
  process.loadEnvFile(path.join(serverDir, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}

const onVercel = Boolean(process.env.VERCEL);
const isProduction = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";

// Setup problems are collected instead of thrown, so a missing setting never
// takes the website down. The API reports them (see app.js) and the local
// server refuses to start (see server.js).
const problems = [];

function required(name) {
  const value = process.env[name];
  if (!value) {
    const fix = onVercel
      ? "Add it in Vercel > Project > Settings > Environment Variables, then redeploy."
      : "Copy server/.env.example to server/.env and fill it in.";
    problems.push(`Missing environment variable ${name}. ${fix}`);
  }
  return value || "";
}

// Optional. Without it, payment return links use the address the request
// arrived on (on Vercel: your .vercel.app address or custom domain).
function appUrl() {
  if (process.env.APP_URL) {
    return process.env.APP_URL;
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return "";
}

// Vercel has no lasting disk, so it must use Turso. Locally a SQLite file is used.
function databaseUrl() {
  if (process.env.TURSO_DATABASE_URL) {
    return process.env.TURSO_DATABASE_URL;
  }
  if (onVercel) {
    return required("TURSO_DATABASE_URL");
  }
  return process.env.DATABASE_FILE || path.join(serverDir, "data", "app.db");
}

export const config = {
  isProduction,
  problems,
  port: Number(process.env.PORT || 3000),
  appUrl: appUrl().replace(/\/+$/, ""),
  sessionSecret: required("SESSION_SECRET"),
  currency: (process.env.CURRENCY || "GHS").toUpperCase(),
  databaseUrl: databaseUrl(),
  databaseToken: process.env.TURSO_AUTH_TOKEN || undefined,
  // The existing front-end lives one folder up from server/.
  siteDir: path.resolve(serverDir, ".."),
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY || "",
  },
  flutterwave: {
    secretKey: process.env.FLW_SECRET_KEY || "",
    webhookHash: process.env.FLW_WEBHOOK_HASH || "",
  },
  // Passcode for the Control Room. Admin sign-in is off until it is set.
  adminPasscode: process.env.ADMIN_PASSCODE || "",
  gmail: {
    user: process.env.GMAIL_USER || "",
    appPassword: process.env.GMAIL_APP_PASSWORD || "",
  },
};

if (config.sessionSecret && config.sessionSecret.length < 32) {
  problems.push("SESSION_SECRET must be at least 32 characters long.");
}

if (isProduction) {
  if (config.appUrl && !config.appUrl.startsWith("https://")) {
    problems.push("APP_URL must use https:// in production.");
  }
  if (config.paystack.secretKey.startsWith("sk_test_") || config.flutterwave.secretKey.includes("_TEST")) {
    console.warn("Warning: running in production with a TEST payment key.");
  }
}

for (const problem of problems) {
  console.error(`Setup problem: ${problem}`);
}
