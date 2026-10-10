const title = document.querySelector("#result-title");
const text = document.querySelector("#result-text");
const button = document.querySelector("#result-button");

const reference = new URLSearchParams(location.search).get("reference");
const MAX_CHECKS = 10;
const CHECK_EVERY_MS = 3000;

function show(heading, message) {
  title.textContent = heading;
  text.textContent = message;
  button.hidden = false;
}

function planName(plan) {
  return plan === "weekly" ? "WEEKLY ROLLOVER" : plan === "boom" ? "Wake up to boom games" : plan === "vvip" ? "VVIP" : "VIP";
}

// The server confirms with Paystack/Flutterwave itself; this page only asks
// the server what it found. Pending payments are re-checked a few times.
async function check(attempt = 1) {
  if (!reference) {
    show("No payment found", "We couldn't find a payment to check.");
    return;
  }
  try {
    const response = await fetch(`/api/payments/${encodeURIComponent(reference)}`);
    if (response.status === 401) {
      location.href = `account.html?next=${encodeURIComponent(`payment-result.html?reference=${reference}`)}`;
      return;
    }
    const body = await response.json();
    if (!response.ok) {
      show("Payment not found", body.error || "We couldn't find this payment.");
      return;
    }

    const { payment, user } = body;
    if (payment.status === "success") {
      const until = user.planExpiresAt ? new Date(user.planExpiresAt).toLocaleDateString() : "";
      show("Payment successful", `Your ${planName(user.plan)} plan is active${until ? ` until ${until}` : ""}. Enjoy the predictions!`);
      return;
    }
    if (payment.status === "failed") {
      show("Payment not completed", "Your payment did not go through and you have not been charged for this plan. You can try again.");
      return;
    }
    if (attempt < MAX_CHECKS) {
      setTimeout(() => check(attempt + 1), CHECK_EVERY_MS);
      return;
    }
    show("Payment still processing", "Your payment is taking longer than usual. Your plan will activate automatically once it's confirmed.");
  } catch {
    show("Couldn't check your payment", "Check your connection and refresh this page.");
  }
}

check();
