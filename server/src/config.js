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

function required(name) {
  const value = process.env[name];
  if (!value) {
    const fix = process.env.VERCEL
      ? "Add it in Vercel > Project > Settings > Environment Variables, then redeploy."
      : "Copy server/.env.example to server/.env and fill it in.";
    throw new Error(`Missing environment variable ${name}. ${fix}`);
  }
  return value;
}

const onVercel = Boolean(process.env.VERCEL);
const isProduction = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";

// On Vercel the site address is known automatically; elsewhere APP_URL is required.
function appUrl() {
  if (process.env.APP_URL) {
    return process.env.APP_URL;
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return required("APP_URL");
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
};

if (config.sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must be at least 32 characters long.");
}

if (isProduction) {
  if (!config.appUrl.startsWith("https://")) {
    throw new Error("APP_URL must use https:// in production.");
  }
  if (config.paystack.secretKey.startsWith("sk_test_") || config.flutterwave.secretKey.includes("_TEST")) {
    console.warn("Warning: running in production with a TEST payment key.");
  }
}
