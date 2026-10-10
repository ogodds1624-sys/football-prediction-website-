import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

test("weekly migration preserves populated legacy tables, indexes, references and ID sequences", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-migration-"));
  const file = path.join(directory, "legacy.db");
  const env = {
    ...process.env,
    TURSO_DATABASE_URL: "",
    VERCEL: "",
    DATABASE_FILE: file,
    SESSION_SECRET: "weekly-migration-test-secret-at-least-32-chars",
  };
  const migrate = () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { dbReady } from ${JSON.stringify(new URL("../src/db.js", import.meta.url).href)}; await dbReady();`],
    { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  let db;
  try {
    migrate();
    db = new DatabaseSync(file);
    db.exec(`
      INSERT INTO users (id,email,password_hash,plan,slot_plan,plan_expires_at,name,country)
        VALUES (7,'legacy@example.com','hash','vip','boom','2028-01-01','Legacy','ghana');
      INSERT INTO payments (id,user_id,provider,reference,plan,amount,currency)
        VALUES (11,7,'paystack','legacy-ref','boom',5000,'GHS');
      INSERT INTO manual_payments (id,user_id,plan,amount,currency,method_id,network,account_number,receipt_data)
        VALUES (12,7,'boom',5000,'GHS','momo','network','number','receipt');
      INSERT INTO purchases (id,user_id,plan,date,source) VALUES (13,7,'vip','2026-01-01','manual');
      INSERT INTO matches (id,date,tier,home,away,tip) VALUES (14,'2026-01-01','boom','Home','Away','Over 1.5');
      INSERT INTO odds_totals (date,tier,total) VALUES ('2026-01-01','boom','2.50');
      INSERT INTO booking_codes (date,tier,code) VALUES ('2026-01-01','boom','LEGACY');
      UPDATE sqlite_sequence SET seq = 100 WHERE name = 'users';
    `);
    const names = ["users", "payments", "manual_payments", "purchases", "matches", "odds_totals", "booking_codes"];
    const snapshots = new Map(names.map((name) => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
    const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all();
    // Make a populated pre-weekly schema, retaining all unrelated columns.
    db.exec("PRAGMA foreign_keys = OFF; BEGIN");
    for (const name of names) {
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).sql;
      const legacy = schema.replace(/,\s*'weekly'/g, "").replace(
        new RegExp(`^CREATE TABLE\\s+["]?${name}["]?`, "i"), `CREATE TABLE ${name}_legacy`,
      );
      db.exec(`${legacy}; INSERT INTO ${name}_legacy SELECT * FROM ${name}; DROP TABLE ${name}; ALTER TABLE ${name}_legacy RENAME TO ${name};`);
    }
    for (const index of indexes) {
      db.exec(index.sql.replace("INDEX ", "INDEX IF NOT EXISTS "));
    }
    db.exec("UPDATE sqlite_sequence SET seq = 100 WHERE name = 'users'; COMMIT");
    db.close();
    db = null;
    migrate();
    migrate();
    db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of names) {
      assert.deepEqual(db.prepare(`SELECT * FROM ${name}`).all(), snapshots.get(name));
      assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name).sql, /'weekly'/);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all(), indexes);
    db.exec("INSERT INTO users (email,password_hash,plan) VALUES ('weekly@example.com','hash','weekly')");
    assert.equal(db.prepare("SELECT id FROM users WHERE email = 'weekly@example.com'").get().id, 101);
  } finally {
    db?.close();
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
    fs.rmdirSync(directory);
  }
});
