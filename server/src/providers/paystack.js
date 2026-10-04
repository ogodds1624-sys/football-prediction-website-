import crypto from "node:crypto";
import { config } from "../config.js";
import { safeEqual } from "../auth.js";
import { ProviderError } from "../errors.js";

// Docs: https://paystack.com/docs/api/transaction/
const BASE_URL = "https://api.paystack.co";

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.paystack.secretKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new ProviderError(`Paystack could not be reached: ${error.message}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.status) {
    throw new ProviderError(`Paystack ${path} failed (${response.status}): ${body?.message || "no message"}`);
  }
  return body.data;
}

function toState(status) {
  if (status === "success") {
    return "success";
  }
  if (["failed", "abandoned", "reversed"].includes(status)) {
    return "failed";
  }
  return "pending";
}

export const paystack = {
  name: "paystack",

  isEnabled() {
    return Boolean(config.paystack.secretKey);
  },

  // Returns the hosted checkout URL to send the user to.
  async initialize({ email, amount, currency, reference, callbackUrl, metadata }) {
    const data = await request("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({ email, amount, currency, reference, callback_url: callbackUrl, metadata }),
    });
    return data.authorization_url;
  },

  // Asks Paystack directly what happened. This is the only thing we trust.
  async verify(reference) {
    const data = await request(`/transaction/verify/${encodeURIComponent(reference)}`);
    return {
      state: toState(data.status),
      reference: data.reference,
      amount: Number(data.amount),
      currency: String(data.currency).toUpperCase(),
      transactionId: String(data.id),
    };
  },

  // Paystack signs each webhook body with HMAC-SHA512 using your secret key.
  isValidWebhook(rawBody, headers) {
    const signature = headers["x-paystack-signature"];
    if (!signature || !config.paystack.secretKey) {
      return false;
    }
    const expected = crypto.createHmac("sha512", config.paystack.secretKey).update(rawBody).digest("hex");
    return safeEqual(expected, signature);
  },

  // Returns our payment reference if this webhook event is a completed charge.
  referenceFromWebhook(event) {
    return event?.event === "charge.success" ? event.data?.reference || null : null;
  },
};
