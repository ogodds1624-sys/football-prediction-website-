export const DAILY_ACCESS_COLUMNS = {
  vip: "vip_access_until",
  vvip: "vvip_access_until",
  boom: "boom_access_until",
};

export function endOfUtcDay(now = Date.now()) {
  const end = new Date(now);
  end.setUTCHours(24, 0, 0, 0);
  return end.toISOString();
}

export function activeAccess(user, now = new Date().toISOString()) {
  if (!user) {
    return [];
  }
  const plans = new Map();
  if (user.plan !== "free" && user.plan_expires_at > now) {
    const plan = user.plan === "vip" && user.slot_plan === "boom" ? "boom" : user.plan;
    plans.set(plan, user.plan_expires_at);
  }
  for (const [plan, column] of Object.entries(DAILY_ACCESS_COLUMNS)) {
    if (user[column] > now && (!plans.has(plan) || user[column] > plans.get(plan))) {
      plans.set(plan, user[column]);
    }
  }
  return [...plans].map(([plan, expiresAt]) => ({ plan, expiresAt }));
}

export async function grantDailyAccess(tx, user, plan, now = Date.now(), expiresAt = null) {
  const column = DAILY_ACCESS_COLUMNS[plan.id];
  if (!column) {
    throw new Error(`Cannot grant additional access for ${plan.id}.`);
  }
  const until = expiresAt || endOfUtcDay(now);
  await tx.execute(`UPDATE users SET ${column} = ? WHERE id = ?`, [until, user.id]);
}

// Restore only still-valid daily approvals made after a recorded Weekly purchase.
export async function restoreWeeklyDailyAccess(tx, now = new Date().toISOString()) {
  for (const [plan, column] of Object.entries(DAILY_ACCESS_COLUMNS)) {
    await tx.execute(`
      WITH approved AS (
        SELECT user_id, plan, updated_at AS approved_at FROM manual_payments WHERE status = 'confirmed'
        UNION ALL
        SELECT user_id, plan, paid_at AS approved_at FROM payments WHERE status = 'success'
      ), eligible AS (
        SELECT daily.user_id, strftime('%Y-%m-%dT00:00:00.000Z', MAX(daily.approved_at), 'start of day', '+1 day') AS expires_at
        FROM approved AS daily
        WHERE daily.plan = ? AND daily.approved_at > (
          SELECT MAX(weekly.approved_at) FROM approved AS weekly
          WHERE weekly.user_id = daily.user_id AND weekly.plan = 'weekly'
        )
        GROUP BY daily.user_id
      )
      UPDATE users SET ${column} = (SELECT expires_at FROM eligible WHERE eligible.user_id = users.id)
      WHERE plan = 'weekly' AND plan_expires_at > ? AND ${column} IS NULL
        AND EXISTS (SELECT 1 FROM eligible WHERE eligible.user_id = users.id AND eligible.expires_at > ?)`,
    [plan, now, now]);
  }
}
