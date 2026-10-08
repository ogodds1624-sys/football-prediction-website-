const planId = new URLSearchParams(location.search).get("plan");
const loading = document.querySelector("#pay-loading");
const empty = document.querySelector("#pay-empty");
const sheet = document.querySelector("#pay-sheet");
const form = document.querySelector("#pay-form");
const fileInput = document.querySelector("#pay-file");
const errorText = document.querySelector("#pay-error");
const submitButton = document.querySelector("#pay-submit");
const picker = document.querySelector("#pay-picker");
const copyButton = document.querySelector("#pay-copy-btn");
const copyLabel = document.querySelector("#pay-copy-label");

const RECEIPT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const MAX_RECEIPT_BYTES = 4_000_000;

const confirmDialog = document.querySelector("#pay-confirm");
const confirmTitle = document.querySelector("#pay-confirm-title");
const confirmCopy = document.querySelector("#pay-confirm-copy");
const confirmLoader = document.querySelector("#pay-loader");
const confirmClose = document.querySelector("#pay-confirm-close");
const WAITING_TEXT = "This keeps going until we accept or reject your payment.";

let accounts = [];
let selected = 0;
let amountText = "";
let sending = false;
let sent = false;
let watchTimer = 0;

function showProblem(message) {
  loading.hidden = true;
  sheet.hidden = true;
  empty.hidden = false;
  empty.textContent = message;
}

function money(currency, amount) {
  const shown = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${currency} ${shown}`;
}

function paymentAccounts(checkout) {
  const list = [];
  for (const method of checkout.methods || []) {
    method.accounts.forEach((account, accountIndex) => {
      if (!account.number) {
        return;
      }
      list.push({
        methodId: method.id,
        accountIndex,
        network: account.network || account.bank || method.label,
        number: account.number,
        name: account.name || method.label,
      });
    });
  }
  return list;
}

function showAccount(index) {
  selected = index;
  const account = accounts[index];
  document.querySelector("#pay-network").textContent = account.network;
  document.querySelector("#pay-number").textContent = account.number;
  document.querySelector("#pay-name").textContent = account.name;
  for (const button of picker.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.index) === index));
  }
}

function renderPicker() {
  picker.hidden = accounts.length < 2;
  picker.replaceChildren(
    ...accounts.map((account, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fee-pick";
      button.dataset.index = String(index);
      button.textContent = account.network;
      button.setAttribute("aria-pressed", String(index === 0));
      button.addEventListener("click", () => showAccount(index));
      return button;
    }),
  );
}

function readReceipt(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error("Upload a screenshot or PDF of the transfer."));
      return;
    }
    const type = file.type === "image/jpg" ? "image/jpeg" : file.type;
    if (!RECEIPT_TYPES.has(type)) {
      reject(new Error("Upload a JPEG, PNG, WebP or PDF receipt."));
      return;
    }
    if (file.size > MAX_RECEIPT_BYTES) {
      reject(new Error("That receipt is too large. Use a file under 4 MB."));
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const data = String(reader.result);
      resolve(`data:${type};base64,${data.slice(data.indexOf(",") + 1)}`);
    });
    reader.addEventListener("error", () => reject(new Error("Couldn't read that file. Please try again.")));
    reader.readAsDataURL(file);
  });
}

function startWatch() {
  if (watchTimer) {
    return;
  }
  watchTimer = window.setInterval(checkDecision, 4000);
}

function stopWatch() {
  window.clearInterval(watchTimer);
  watchTimer = 0;
}

function showWaiting() {
  sent = true;
  sending = false;
  form.hidden = true;
  submitButton.disabled = true;
  const done = document.querySelector("#pay-done");
  done.textContent = WAITING_TEXT;
  done.hidden = false;
  confirmTitle.textContent = "Waiting for confirmation";
  confirmCopy.textContent = WAITING_TEXT;
  confirmLoader.hidden = false;
  confirmClose.hidden = true;
  if (!confirmDialog.open) {
    confirmDialog.showModal();
  }
  startWatch();
}

function showFormAgain(message) {
  stopWatch();
  sent = false;
  sending = false;
  form.hidden = false;
  submitButton.disabled = false;
  fileInput.value = "";
  document.querySelector("#pay-file-label").textContent = "Upload payment receipt";
  document.querySelector("#pay-file-hint").textContent = "Image or PDF · required to confirm transfer";
  document.querySelector("#pay-done").hidden = true;
  errorText.textContent = message;
  if (confirmDialog.open) {
    confirmDialog.close();
  }
}

async function checkDecision() {
  try {
    const response = await fetch(`/api/payments/manual?plan=${encodeURIComponent(planId)}`);
    if (!response.ok) {
      return;
    }
    const { payment } = await response.json();
    if (!payment || payment.status === "pending") {
      return;
    }
    stopWatch();
    if (payment.status === "rejected") {
      showFormAgain("That payment was rejected. You can send another receipt.");
      return;
    }
    location.replace("index.html");
  } catch {
    // Keep the loading animation until the next check.
  }
}

function fillSheet(plan, currency) {
  amountText = money(currency, plan.amount);
  document.querySelector("#pay-heading").textContent = `${plan.name} plan fee`;
  document.querySelector("#pay-plan").textContent = plan.name;
  document.querySelector("#pay-copy").textContent = `One-time payment for ${plan.days} days. Your plan activates once we confirm the transfer.`;
  document.querySelector("#pay-amount").textContent = amountText;
  document.querySelector("#pay-amount-row").textContent = amountText;
  document.querySelector("#pay-step-amount").textContent = amountText;
  document.title = `Pay for ${plan.name}`;
  renderPicker();
  showAccount(0);
  loading.hidden = true;
  sheet.hidden = false;
}

async function loadPage() {
  if (planId !== "vip" && planId !== "vvip") {
    showProblem("Choose VIP or VVIP from the predictions page.");
    return;
  }

  let me;
  let options;
  let paymentStatus = "";
  try {
    const [meResponse, optionsResponse, statusResponse] = await Promise.all([
      fetch("/api/me"),
      fetch("/api/payments/options"),
      fetch(`/api/payments/manual?plan=${planId}`),
    ]);
    me = await meResponse.json();
    if (!optionsResponse.ok) {
      throw new Error("options unavailable");
    }
    options = await optionsResponse.json();
    if (statusResponse.ok) {
      const status = await statusResponse.json();
      paymentStatus = status.payment?.status || "";
    }
  } catch {
    showProblem("Couldn't load the payment details. Check your connection and try again.");
    return;
  }

  if (!me.user) {
    const next = `pay.html?plan=${planId}`;
    location.replace(`account.html?mode=register&next=${encodeURIComponent(next)}`);
    return;
  }

  const plan = options.plans.find((item) => item.id === planId);
  accounts = paymentAccounts(options.checkout);
  if (!plan || !accounts.length) {
    showProblem("Payments are opening soon. Please check back shortly.");
    return;
  }
  if (paymentStatus === "confirmed") {
    location.replace("index.html");
    return;
  }
  fillSheet(plan, options.currency);
  if (paymentStatus === "pending") {
    showWaiting();
  }
}

copyButton.addEventListener("click", async () => {
  const number = document.querySelector("#pay-number").textContent;
  try {
    await navigator.clipboard.writeText(number);
  } catch {
    errorText.textContent = "Couldn't copy the number. Select it and copy it yourself.";
    return;
  }
  copyLabel.textContent = "Copied";
  window.setTimeout(() => {
    copyLabel.textContent = "Copy";
  }, 1500);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  document.querySelector("#pay-file-label").textContent = file ? file.name : "Upload payment receipt";
  document.querySelector("#pay-file-hint").textContent = file
    ? "Ready to send with your payment"
    : "Image or PDF · required to confirm transfer";
  errorText.textContent = "";
});

confirmDialog.addEventListener("cancel", (event) => {
  if (!confirmLoader.hidden) {
    event.preventDefault();
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (sending || sent) {
    return;
  }
  errorText.textContent = "";
  const account = accounts[selected];
  sending = true;
  submitButton.disabled = true;
  try {
    const receipt = await readReceipt(fileInput.files[0]);
    const response = await fetch("/api/payments/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan: planId,
        methodId: account.methodId,
        accountIndex: account.accountIndex,
        receipt,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 409) {
      throw new Error(body.error || "Couldn't send your receipt. Please try again.");
    }
    showWaiting();
  } catch (error) {
    errorText.textContent = error.message;
    sending = false;
    if (!sent) {
      submitButton.disabled = false;
    }
  }
});

loadPage();
