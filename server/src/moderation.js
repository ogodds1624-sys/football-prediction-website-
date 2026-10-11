import { execute, one } from "./db.js";
import { HttpError } from "./errors.js";

export function userIdFrom(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(400, "Choose a valid member.");
  }
  return id;
}

export async function managedUsers(query = "") {
  const search = String(query).trim().toLowerCase();
  if (search.length > 200) {
    throw new HttpError(400, "Search must be 200 characters or fewer.");
  }
  const { rows } = await execute(
    `SELECT users.id, users.name, users.email, users.blocked_at,
      warning.id AS warning_id, warning.message AS warning_message,
      warning.created_at AS warning_created_at, warning.acknowledged_at
     FROM users
     LEFT JOIN user_warnings AS warning ON warning.id = (
       SELECT id FROM user_warnings WHERE user_id = users.id ORDER BY id DESC LIMIT 1
     )
     WHERE ? = '' OR instr(lower(users.email || ' ' || users.name), ?) > 0
     ORDER BY users.id DESC LIMIT 50`,
    [search, search],
  );
  return rows.map((user) => ({
    id: Number(user.id), name: user.name, email: user.email, blockedAt: user.blocked_at,
    latestWarning: user.warning_id ? {
      id: Number(user.warning_id), message: user.warning_message,
      createdAt: user.warning_created_at, acknowledgedAt: user.acknowledged_at,
    } : null,
  }));
}

export async function setUserBlocked(id, blocked) {
  if (typeof blocked !== "boolean") {
    throw new HttpError(400, "Choose block or unblock.");
  }
  const user = await one("SELECT id FROM users WHERE id = ?", [id]);
  if (!user) {
    throw new HttpError(404, "Member not found.");
  }
  if (blocked) {
    await execute(
      `UPDATE users SET blocked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       session_version = session_version + 1 WHERE id = ? AND blocked_at IS NULL`, [id],
    );
  } else {
    await execute("UPDATE users SET blocked_at = NULL WHERE id = ?", [id]);
  }
}

export async function sendUserWarning(id, value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1000) {
    throw new HttpError(400, "Enter a warning of 1 to 1,000 characters.");
  }
  if (!await one("SELECT id FROM users WHERE id = ?", [id])) {
    throw new HttpError(404, "Member not found.");
  }
  const row = await one(
    "INSERT INTO user_warnings (user_id, message) VALUES (?, ?) RETURNING id, message, created_at",
    [id, value.trim()],
  );
  return { id: Number(row.id), message: row.message, createdAt: row.created_at };
}

export async function pendingWarnings(userId) {
  const { rows } = await execute(
    "SELECT id, message, created_at FROM user_warnings WHERE user_id = ? AND acknowledged_at IS NULL ORDER BY id",
    [userId],
  );
  return rows.map((warning) => ({ id: Number(warning.id), message: warning.message, createdAt: warning.created_at }));
}

export async function acknowledgeWarning(userId, warningId) {
  const row = await one(
    `UPDATE user_warnings SET acknowledged_at = COALESCE(acknowledged_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     WHERE id = ? AND user_id = ? RETURNING id`,
    [warningId, userId],
  );
  if (!row) {
    throw new HttpError(404, "Warning not found.");
  }
}
