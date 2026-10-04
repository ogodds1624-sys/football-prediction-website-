import crypto from "node:crypto";
import { config } from "./config.js";
import { execute, one, transaction } from "./db.js";
import { HttpError } from "./errors.js";
import { getPlan } from "./plans.js";
import { getProvider } from "./providers/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const SQL = {
  insertPayment: `
    INSERT INTO payments (user_id, provider, reference, plan, amount, currency)
    VALUES (?, ?, ?, ?, ?, ?)`,
  findPayment: "SELECT * FROM payments WHERE reference = ?",
  markFailed: `
    UPDATE payments SET status = 'failed', updated_at = ${NOW}
    WHERE reference = ? AND status = 'pending'`,
  markSuccess: `
    UPDATE payments
    SET status = 'success', provider_transaction_id = ?, paid_at = ${NOW}, updated_at = ${NOW}
    WHERE reference = ? AND status = 'pending'`,
  findUser: "SELECT id, plan, plan_expires_at FROM users WHERE id = ?",
  updateUserPlan: "UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?",
};

export function findPayment(reference) {
  return one(SQL.findPayment, [reference]);
}

export function publicPayment(payment) {
  return {
    reference: payment.reference,
    provider: payment.provider,
    plan: payment.plan,
    amount: payment.amount / 100,
    currency: payment.currency,
    status: payment.status,
    paidAt: payment.paid_at,
  };
}

// Creates a pending payment and returns the provider's checkout URL.
// The price comes from PLANS on the server, never from the request.
export async function startPayment(user, providerName, planId) {
  const plan = getPlan(planId);
  if (!plan) {
    throw new HttpError(400, "Unknown plan.");
  }
  const provider = getProvider(providerName);
  if (!provider) {
    throw new HttpError(400, "That payment method is not available.");
  }

  const reference = `${plan.id}_${crypto.randomUUID()}`;
  await execute(SQL.insertPayment, [user.id, provider.name, reference, plan.id, plan.amount, config.currency]);

  try {
    const checkoutUrl = await provider.initialize({
      email: user.email,
      amount: plan.amount,
      currency: config.currency,
      reference,
      callbackUrl: `${config.appUrl}/api/payments/callback/${provider.name}`,
      metadata: { user_id: user.id, plan: plan.id },
    });
    return { reference, checkoutUrl };
  } catch (error) {
    await execute(SQL.markFailed, [reference]);
    throw error;
  }
}

// Extends from the current expiry if the plan is still running, so renewing
// early never loses days. A higher plan replaces a lower one.
async function upgradeUser(tx, userId, plan) {
  const user = (await tx.execute(SQL.findUser, [userId])).rows[0];
  const now = Date.now();
  const currentExpiry = user.plan_expires_at ? Date.parse(user.plan_expires_at) : 0;
  const stillActive = user.plan !== "free" && currentExpiry > now;

  const start = stillActive ? currentExpiry : now;
  const expiresAt = new Date(start + plan.days * DAY_MS).toISOString();
  const keepCurrent = stillActive && getPlan(user.plan)?.rank > plan.rank;
  await tx.execute(SQL.updateUserPlan, [keepCurrent ? user.plan : plan.id, expiresAt, userId]);
}

// Confirms a payment with the provider's own servers and, if it really
// succeeded for the right amount, marks it paid and upgrades the user.
// Safe to call many times (callback, webhook and status checks all use it).
export async function confirmPayment(reference) {
  const payment = await findPayment(reference);
  if (!payment || payment.status !== "pending") {
    return payment;
  }

  const provider = getProvider(payment.provider);
  if (!provider) {
    throw new Error(`Provider ${payment.provider} is not configured`);
  }
  const result = await provider.verify(reference);

  if (result.state === "pending") {
    return payment;
  }

  const genuine =
    result.state === "success" &&
    result.reference === payment.reference &&
    result.amount === Number(payment.amount) &&
    result.currency === payment.currency;

  if (!genuine) {
    if (result.state === "success") {
      console.warn(
        `Payment ${reference} rejected: expected ${payment.amount} ${payment.currency}, ` +
          `provider reported ${result.amount} ${result.currency} for ${result.reference}`,
      );
    }
    await execute(SQL.markFailed, [reference]);
    return findPayment(reference);
  }

  await transaction(async (tx) => {
    // Only the first confirmation changes anything; repeats are no-ops.
    const { rowsAffected } = await tx.execute(SQL.markSuccess, [result.transactionId, reference]);
    if (rowsAffected) {
      await upgradeUser(tx, payment.user_id, getPlan(payment.plan));
    }
  });
  return findPayment(reference);
}
