import crypto from "node:crypto";
import { config } from "./config.js";
import { execute, one, transaction } from "./db.js";
import { HttpError } from "./errors.js";
import { publicCheckout } from "./gateway.js";
import { getPlan, getPricedPlan } from "./plans.js";
import { getProvider } from "./providers/index.js";
import { recordPurchase, todayKey } from "./recovery.js";

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
// siteUrl is where the provider sends the user back to.
export async function startPayment(user, providerName, planId, siteUrl) {
  const plan = await getPricedPlan(planId);
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
      callbackUrl: `${siteUrl}/api/payments/callback/${provider.name}`,
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
async function upgradeUser(tx, userId, plan, source) {
  const user = (await tx.execute(SQL.findUser, [userId])).rows[0];
  const now = Date.now();
  const currentExpiry = user.plan_expires_at ? Date.parse(user.plan_expires_at) : 0;
  const stillActive = user.plan !== "free" && currentExpiry > now;

  const start = stillActive ? currentExpiry : now;
  const expiresAt = new Date(start + plan.days * DAY_MS).toISOString();
  const keepCurrent = stillActive && getPlan(user.plan)?.rank > plan.rank;
  await tx.execute(SQL.updateUserPlan, [keepCurrent ? user.plan : plan.id, expiresAt, userId]);
  await recordPurchase(tx, userId, plan.id, todayKey(), source);
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
      await upgradeUser(tx, payment.user_id, getPlan(payment.plan), payment.provider);
    }
  });
  return findPayment(reference);
}

const RECEIPT_PATTERN = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/;
const MAX_RECEIPT_BYTES = 4_000_000;

// Stores a receipt for a transfer to one of the admin's switched-on accounts.
// The price and account come from the server, never from the amount in the file.
export async function submitManualPayment(user, input) {
  const plan = await getPricedPlan(input?.plan);
  if (!plan) {
    throw new HttpError(400, "Unknown plan.");
  }
  const checkout = await publicCheckout();
  const method = checkout.methods.find((item) => item.id === input?.methodId);
  const account = method?.accounts[Number(input?.accountIndex)];
  if (!account?.number) {
    throw new HttpError(400, "Choose a payment account.");
  }

  const match = String(input?.receipt || "").match(RECEIPT_PATTERN);
  if (!match) {
    throw new HttpError(400, "Upload a JPEG, PNG, WebP or PDF receipt.");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_RECEIPT_BYTES) {
    throw new HttpError(400, "The receipt must be under 4 MB.");
  }
  const receipt = `data:${match[1]};base64,${bytes.toString("base64")}`;
  const network = account.network || account.bank || method.label;

  try {
    const { rows } = await execute(
      `INSERT INTO manual_payments
        (user_id, plan, amount, currency, method_id, network, account_number, account_name, receipt_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      [user.id, plan.id, plan.amount, config.currency, method.id, network, account.number, account.name || "", receipt],
    );
    return { id: Number(rows[0].id) };
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error.message)) {
      throw new HttpError(409, "You already sent a receipt for this plan. We'll confirm it soon.");
    }
    throw error;
  }
}

export function listManualPayments() {
  return execute(
    `SELECT manual_payments.id, users.email, manual_payments.plan, manual_payments.amount,
            manual_payments.currency, manual_payments.network, manual_payments.status, manual_payments.created_at
     FROM manual_payments
     JOIN users ON users.id = manual_payments.user_id
     WHERE manual_payments.status = 'pending'
     ORDER BY manual_payments.id DESC`,
  );
}

export async function manualReceipt(id) {
  const row = await one("SELECT receipt_data FROM manual_payments WHERE id = ?", [id]);
  const match = row ? String(row.receipt_data).match(RECEIPT_PATTERN) : null;
  if (!match) {
    return null;
  }
  return { type: match[1], bytes: Buffer.from(match[2], "base64") };
}

async function pendingManualPayment(id) {
  const payment = await one("SELECT id, user_id, plan, status FROM manual_payments WHERE id = ?", [id]);
  if (!payment || payment.status !== "pending") {
    throw new HttpError(404, "That payment is no longer waiting.");
  }
  return payment;
}

// Approves a manual transfer and activates the member's plan.
export async function confirmManualPayment(id) {
  const payment = await pendingManualPayment(id);
  const plan = getPlan(payment.plan);
  await transaction(async (tx) => {
    const { rowsAffected } = await tx.execute(
      `UPDATE manual_payments SET status = 'confirmed', updated_at = ${NOW} WHERE id = ? AND status = 'pending'`,
      [payment.id],
    );
    if (rowsAffected) {
      await upgradeUser(tx, payment.user_id, plan, "manual");
    }
  });
}

// Turns down a transfer. The member's plan stays as it is, and they can send a new receipt.
export async function rejectManualPayment(id) {
  const payment = await pendingManualPayment(id);
  const { rowsAffected } = await execute(
    `UPDATE manual_payments SET status = 'rejected', updated_at = ${NOW} WHERE id = ? AND status = 'pending'`,
    [payment.id],
  );
  if (!rowsAffected) {
    throw new HttpError(404, "That payment is no longer waiting.");
  }
}
