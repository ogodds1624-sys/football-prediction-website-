import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// One small async interface over two backends:
//   - Turso (libsql://...) in production on Vercel, via the pure-JS web client
//   - Node's built-in SQLite file locally and in tests
// The rest of the server only uses execute(), one() and transaction().

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name            TEXT NOT NULL DEFAULT '',
    password_hash   TEXT NOT NULL,
    plan            TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'vip', 'vvip')),
    plan_expires_at TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  // amount is stored in the smallest currency unit (pesewas / kobo / cents).
  `CREATE TABLE IF NOT EXISTS payments (
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
  )`,
  "CREATE INDEX IF NOT EXISTS payments_user_id ON payments(user_id)",
  // Admin settings stored as JSON, e.g. "checkout" and "rates" (see gateway.js).
  `CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  // Predictions shown on the front page, one row per match per day.
  `CREATE TABLE IF NOT EXISTS matches (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL,
    tier       TEXT NOT NULL CHECK (tier IN ('free', 'vip', 'vvip', 'recovery')),
    home       TEXT NOT NULL,
    away       TEXT NOT NULL,
    tip        TEXT NOT NULL,
    odds       TEXT NOT NULL DEFAULT '',
    image      TEXT NOT NULL DEFAULT '',
    result     TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'won', 'lost')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  "CREATE INDEX IF NOT EXISTS matches_date ON matches(date)",
  // Every VIP/VVIP purchase by day: online payments and admin activations.
  // Used to check recovery ticket eligibility.
  `CREATE TABLE IF NOT EXISTS purchases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    plan       TEXT NOT NULL CHECK (plan IN ('vip', 'vvip')),
    date       TEXT NOT NULL,
    source     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  "CREATE INDEX IF NOT EXISTS purchases_user_date ON purchases(user_id, date)",
  // Real member reviews, added by the admin, shown under the VVIP table.
  `CREATE TABLE IF NOT EXISTS testimonials (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    location   TEXT NOT NULL DEFAULT '',
    rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  // SportyBet booking code for the free predictions, one per day (YYYY-MM-DD).
  `CREATE TABLE IF NOT EXISTS booking_codes (
    date       TEXT PRIMARY KEY,
    code       TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
];

function createTursoBackend() {
  let clientPromise;
  const client = () => {
    clientPromise ??= import("@libsql/client/web").then(({ createClient }) =>
      createClient({ url: config.databaseUrl, authToken: config.databaseToken }),
    );
    return clientPromise;
  };

  const wrap = (runner) => ({
    async execute(sql, args = []) {
      const result = await runner.execute({ sql, args });
      return { rows: result.rows, rowsAffected: result.rowsAffected };
    },
  });

  return {
    async init() {
      await (await client()).batch(SCHEMA, "write");
    },
    execute: async (sql, args) => wrap(await client()).execute(sql, args),
    async transaction(fn) {
      const tx = await (await client()).transaction("write");
      try {
        const result = await fn(wrap(tx));
        await tx.commit();
        return result;
      } catch (error) {
        await tx.rollback();
        throw error;
      } finally {
        tx.close();
      }
    },
  };
}

function createLocalBackend() {
  let database;
  // Transactions on the single local connection run one at a time.
  let queue = Promise.resolve();

  const open = async () => {
    if (!database) {
      const { DatabaseSync } = await import("node:sqlite");
      if (config.databaseUrl !== ":memory:") {
        fs.mkdirSync(path.dirname(config.databaseUrl), { recursive: true });
      }
      database = new DatabaseSync(config.databaseUrl);
      database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    }
    return database;
  };

  const runner = {
    async execute(sql, args = []) {
      const statement = (await open()).prepare(sql);
      if (/^\s*(select|with)\b|\breturning\b/i.test(sql)) {
        return { rows: statement.all(...args), rowsAffected: 0 };
      }
      return { rows: [], rowsAffected: Number(statement.run(...args).changes) };
    },
  };

  return {
    async init() {
      const db = await open();
      for (const statement of SCHEMA) {
        db.exec(statement);
      }
    },
    execute: (sql, args) => runner.execute(sql, args),
    transaction(fn) {
      const run = queue.then(async () => {
        const db = await open();
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn(runner);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

const backend = config.databaseUrl.startsWith("libsql://") || config.databaseUrl.startsWith("https://")
  ? createTursoBackend()
  : createLocalBackend();

let ready;

// Creates the tables once per server start (or per serverless cold start).
// Columns added after a table already existed in production. Each runs once;
// "duplicate column" means it was already applied.
const MIGRATIONS = [
  // Existing reviews were added by the admin, so they count as approved.
  "ALTER TABLE testimonials ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'",
  "ALTER TABLE testimonials ADD COLUMN user_id INTEGER",
  // Accounts made before sign-up asked for a name keep an empty one.
  "ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT ''",
];

// SQLite can't change a CHECK rule in place, so tables made before the
// "recovery" tier existed are rebuilt once, keeping every row.
async function allowRecoveryTier() {
  const { rows } = await backend.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'matches'", []);
  if (!rows.length || rows[0].sql.includes("'recovery'")) {
    return;
  }
  await backend.transaction(async (tx) => {
    await tx.execute(
      `CREATE TABLE matches_rebuild (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        date       TEXT NOT NULL,
        tier       TEXT NOT NULL CHECK (tier IN ('free', 'vip', 'vvip', 'recovery')),
        home       TEXT NOT NULL,
        away       TEXT NOT NULL,
        tip        TEXT NOT NULL,
        odds       TEXT NOT NULL DEFAULT '',
        image      TEXT NOT NULL DEFAULT '',
        result     TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'won', 'lost')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
      [],
    );
    await tx.execute(
      `INSERT INTO matches_rebuild (id, date, tier, home, away, tip, odds, image, result, created_at)
       SELECT id, date, tier, home, away, tip, odds, image, result, created_at FROM matches`,
      [],
    );
    await tx.execute("DROP TABLE matches", []);
    await tx.execute("ALTER TABLE matches_rebuild RENAME TO matches", []);
    await tx.execute("CREATE INDEX IF NOT EXISTS matches_date ON matches(date)", []);
  });
}

async function migrate() {
  for (const statement of MIGRATIONS) {
    try {
      await backend.execute(statement, []);
    } catch (error) {
      if (!/duplicate column/i.test(error.message)) {
        throw error;
      }
    }
  }
  await allowRecoveryTier();
}

export function dbReady() {
  ready ??= backend
    .init()
    .then(migrate)
    .catch((error) => {
      ready = null;
      throw error;
    });
  return ready;
}

export async function execute(sql, args = []) {
  await dbReady();
  return backend.execute(sql, args);
}

export async function one(sql, args = []) {
  const result = await execute(sql, args);
  return result.rows[0] ?? null;
}

// Runs fn(tx) as one write transaction; tx.execute(sql, args) runs inside it.
// Two requests confirming the same payment cannot both apply it.
export async function transaction(fn) {
  await dbReady();
  return backend.transaction(fn);
}
