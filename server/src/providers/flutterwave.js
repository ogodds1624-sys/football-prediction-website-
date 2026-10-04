import { config } from "../config.js";
import { safeEqual } from "../auth.js";
import { ProviderError } from "../errors.js";

// Docs: https://developer.flutterwave.com/docs/flutterwave-standard-1
const BASE_URL = "https://api.flutterwave.com/v3";

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.flutterwave.secretKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new ProviderError(`Flutterwave could not be reached: ${error.message}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.status !== "success") {
    throw new ProviderError(`Flutterwave ${path} failed (${response.status}): ${body?.message || "no message"}`);
  }
  return body.data;
}

function toState(status) {
  if (status === "successful") {
    return "success";
  }
  if (status === "failed" || status === "cancelled") {
    return "failed";
  }
  return "pending";
}

export const flutterwave = {
  name: "flutterwave",

  isEnabled() {
    return Boolean(config.flutterwave.secretKey);
  },

  // Flutterwave takes amounts in major units (50.00), we store minor units (5000).
  async initialize({ email, amount, currency, reference, callbackUrl, metadata }) {
    const data = await request("/payments", {
      method: "POST",
      body: JSON.stringify({
        tx_ref: reference,
        amount: (amount / 100).toFixed(2),
        currency,
        redirect_url: callbackUrl,
        customer: { email },
        customizations: { title: "Football Predictions" },
        meta: metadata,
      }),
    });
    return data.link;
  },

  // Looks the transaction up by our own reference, so a forged transaction_id
  // in the redirect URL cannot point us at someone else's payment.
  async verify(reference) {
    const data = await request(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
    return {
      state: toState(data.status),
      reference: data.tx_ref,
      amount: Math.round(Number(data.amount) * 100),
      currency: String(data.currency).toUpperCase(),
      transactionId: String(data.id),
    };
  },

  // Flutterwave sends back the "Secret hash" you set in the dashboard.
  isValidWebhook(rawBody, headers) {
    const hash = headers["verif-hash"];
    if (!hash || !config.flutterwave.webhookHash) {
      return false;
    }
    return safeEqual(hash, config.flutterwave.webhookHash);
  },

  referenceFromWebhook(event) {
    return event?.event === "charge.completed" ? event.data?.tx_ref || null : null;
  },
};
