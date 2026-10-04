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
    throw new Error(`Missing environment variable ${name}. Copy server/.env.example to server/.env and fill it in.`);
  }
  return value;
}

const isProduction = process.env.NODE_ENV === "production";

export const config = {
  isProduction,
  port: Number(process.env.PORT || 3000),
  appUrl: required("APP_URL").replace(/\/+$/, ""),
  sessionSecret: required("SESSION_SECRET"),
  currency: (process.env.CURRENCY || "GHS").toUpperCase(),
  databaseFile: process.env.DATABASE_FILE || path.join(serverDir, "data", "app.db"),
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
    console.warn("Warning: NODE_ENV is production but a TEST payment key is configured.");
  }
}
