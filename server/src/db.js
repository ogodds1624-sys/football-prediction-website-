import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

if (config.databaseFile !== ":memory:") {
  fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });
}

export const db = new DatabaseSync(config.databaseFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    plan            TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'vip', 'vvip')),
    plan_expires_at TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- amount is stored in the smallest currency unit (pesewas / kobo / cents).
  CREATE TABLE IF NOT EXISTS payments (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 INTEGER NOT NULL REFERENCES users(id),
    provider                TEXT NOT NULL CHECK (provider IN ('paystack', 'flutterwave')),
    reference               TEXT NOT NULL UNIQUE,
    plan                    TEXT NOT NULL CHECK (plan IN ('vip', 'vvip')),
    amount                  INTEGER NOT NULL CHECK (amount > 0),
    currency                TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
    provider_transaction_id TEXT,
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    paid_at                 TEXT
  );

  CREATE INDEX IF NOT EXISTS payments_user_id ON payments(user_id);
`);

// Runs fn inside a write transaction. BEGIN IMMEDIATE takes the write lock up
// front, so two requests confirming the same payment cannot both apply it.
export function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
