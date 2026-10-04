const signInButton = document.querySelector("#sign-in");
const userLabel = document.querySelector("#user-label");
const menuToggle = document.querySelector("#menu-toggle");
const siteMenu = document.querySelector("#site-menu");
const menuLinks = document.querySelectorAll("#site-menu a");
const dayButtons = document.querySelectorAll(".day-button");

// Signed-in account from the server: { email, plan, planExpiresAt } or null.
let currentUser = null;

function setMenuOpen(open) {
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  siteMenu.hidden = !open;
}

function showUser(user) {
  currentUser = user;
  if (!user) {
    userLabel.hidden = true;
    userLabel.textContent = "";
    signInButton.textContent = "Sign in";
    return;
  }

  userLabel.hidden = false;
  userLabel.textContent = user.plan === "free" ? user.email : `${user.email} · ${user.plan.toUpperCase()}`;
  signInButton.textContent = "Sign out";
}

const tierBodies = {
  free: document.querySelector("#free-body"),
  vip: document.querySelector("#vip-body"),
  vvip: document.querySelector("#vvip-body"),
};
const planButtons = document.querySelectorAll(".plan-button");
const footerWhatsapp = document.querySelector("#footer-whatsapp");

let selectedOffset = 0;

function matchRow(match, tier) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");

  const layout = document.createElement("div");
  layout.className = "match-cell";
  const info = document.createElement("div");

  const teams = document.createElement("span");
  teams.className = "match-teams";
  teams.textContent = `${match.home} vs ${match.away}`;
  info.append(teams);

  const meta = document.createElement("span");
  meta.className = "match-meta";
  if (tier === "free") {
    meta.textContent = match.odds ? `Tip: ${match.tip} · Odds: ${match.odds}` : `Tip: ${match.tip}`;
  } else {
    meta.textContent = "Tip locked · buy the plan to unlock";
  }
  info.append(meta);

  // Paid-tier pictures stay hidden since they may reveal the locked tip.
  if (tier === "free" && match.image) {
    const picture = document.createElement("img");
    picture.className = "match-picture";
    picture.src = match.image;
    picture.alt = `Picture for ${match.home} vs ${match.away}`;
    picture.title = "Tap to enlarge";
    picture.addEventListener("click", () => picture.classList.toggle("expanded"));
    info.append(picture);
  }

  layout.append(info);

  if (match.result === "won" || match.result === "lost") {
    const badge = document.createElement("span");
    badge.className = `result-badge ${match.result}`;
    badge.textContent = match.result === "won" ? "Won" : "Lost";
    layout.append(badge);
  }

  cell.append(layout);

  row.append(cell);
  return row;
}

function emptyRow() {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.className = "empty-row";
  cell.textContent = "No predictions for this day yet.";
  row.append(cell);
  return row;
}

function renderPredictions() {
  const data = loadData();
  const whatsapp = data ? data.settings.whatsapp : "";

  const footerLink = whatsappLink(whatsapp, "Hello, I have a question about your predictions.");
  if (footerLink) {
    footerWhatsapp.href = footerLink;
  }

  // Keep the placeholder rows until the admin has saved something.
  if (!data) {
    return;
  }

  const date = dateKey(selectedOffset);
  for (const tier of TIERS) {
    const matches = matchesFor(data, date, tier.id);
    const rows = matches.length ? matches.map((match) => matchRow(match, tier.id)) : [emptyRow()];
    tierBodies[tier.id].replaceChildren(...rows);
  }

  for (const button of planButtons) {
    const total = totalOdds(matchesFor(data, date, button.dataset.tier));
    button.textContent = total ? `BUY PLAN (total odds ${total.toFixed(2)})` : "BUY PLAN (total odds)";
  }
}

for (const button of dayButtons) {
  button.addEventListener("click", () => {
    for (const other of dayButtons) {
      other.setAttribute("aria-pressed", String(other === button));
    }
    selectedOffset = Number(button.dataset.day);
    hideBooking();
    renderPredictions();
  });
}

/* ---------- SportyBet booking code (free predictions) ---------- */

const bookingButton = document.querySelector("#booking-button");
const bookingPanel = document.querySelector("#booking-panel");
const bookingText = document.querySelector("#booking-text");
const bookingCodeRow = document.querySelector("#booking-code-row");
const bookingCode = document.querySelector("#booking-code");
const bookingCopy = document.querySelector("#booking-copy");
const bookingActions = document.querySelector("#booking-actions");

const DAY_NAMES = { "-1": "yesterday", 0: "today", 1: "tomorrow" };

function showBooking({ text, code = null, askToJoin = false }) {
  bookingPanel.hidden = false;
  bookingButton.setAttribute("aria-expanded", "true");
  bookingText.textContent = text;
  bookingCodeRow.hidden = !code;
  bookingCode.textContent = code || "";
  bookingCopy.textContent = "Copy";
  bookingActions.hidden = !askToJoin;
}

function hideBooking() {
  bookingPanel.hidden = true;
  bookingButton.setAttribute("aria-expanded", "false");
}

// The code is only sent by the server to signed-in users.
async function revealBookingCode() {
  const dayName = DAY_NAMES[selectedOffset];
  if (!currentUser) {
    showBooking({ text: `Create a free account or sign in to get ${dayName}'s SportyBet booking code.`, askToJoin: true });
    return;
  }

  bookingButton.disabled = true;
  try {
    const response = await fetch(`/api/booking-code?date=${dateKey(selectedOffset)}`);
    if (response.status === 401) {
      showUser(null);
      showBooking({ text: "Your session has ended. Sign in again to get the booking code.", askToJoin: true });
      return;
    }
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error);
    }
    if (body.code) {
      showBooking({ text: `SportyBet booking code for ${dayName}'s free predictions:`, code: body.code });
    } else {
      showBooking({ text: `The booking code for ${dayName} isn't ready yet. Check back soon.` });
    }
  } catch {
    showBooking({ text: "Couldn't load the booking code. Check your connection and try again." });
  } finally {
    bookingButton.disabled = false;
  }
}

bookingButton.addEventListener("click", () => {
  if (!bookingPanel.hidden) {
    hideBooking();
    return;
  }
  revealBookingCode();
});

bookingCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(bookingCode.textContent);
    bookingCopy.textContent = "Copied!";
  } catch {
    bookingCopy.textContent = "Select and copy";
  }
});

/* ---------- Buying a plan ---------- */

const payDialog = document.querySelector("#pay-dialog");
const payTitle = document.querySelector("#pay-title");
const payPrice = document.querySelector("#pay-price");
const payOptions = document.querySelector("#pay-options");
const payError = document.querySelector("#pay-error");

const PROVIDER_NAMES = { paystack: "Pay with Paystack", flutterwave: "Pay with Flutterwave" };

function whatsappFallback(plan) {
  const data = loadData();
  const link = whatsappLink(data && data.settings.whatsapp, `Hello, I want to buy the ${plan.toUpperCase()} plan.`);
  if (link) {
    window.open(link, "_blank", "noopener");
  } else {
    window.alert("Online payment isn't available right now. Please contact us on WhatsApp.");
  }
}

async function startCheckout(provider, plan, button) {
  payError.textContent = "";
  button.disabled = true;
  button.textContent = "Opening checkout…";
  try {
    const response = await fetch("/api/payments/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, plan }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || "Couldn't start the payment.");
    }
    location.href = body.checkoutUrl;
  } catch (error) {
    payError.textContent = error.message;
    button.disabled = false;
    button.textContent = PROVIDER_NAMES[provider];
  }
}

async function openPayment(plan) {
  if (location.protocol === "file:") {
    whatsappFallback(plan);
    return;
  }
  if (!currentUser) {
    location.href = "account.html?mode=register";
    return;
  }

  let options;
  try {
    const response = await fetch("/api/payments/options");
    options = await response.json();
  } catch {
    whatsappFallback(plan);
    return;
  }
  const planInfo = options.plans.find((item) => item.id === plan);
  if (!planInfo || !options.providers.length) {
    whatsappFallback(plan);
    return;
  }

  payTitle.textContent = `Buy ${planInfo.name} plan`;
  payPrice.textContent = `${options.currency} ${planInfo.amount.toFixed(2)} for ${planInfo.days} days`;
  payError.textContent = "";
  payOptions.replaceChildren(
    ...options.providers.map((provider) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `plan-button ${plan}-plan`;
      button.textContent = PROVIDER_NAMES[provider] || provider;
      button.addEventListener("click", () => startCheckout(provider, plan, button));
      return button;
    }),
  );
  payDialog.showModal();
}

for (const button of planButtons) {
  button.addEventListener("click", () => openPayment(button.dataset.tier));
}

document.querySelector("#pay-close").addEventListener("click", () => payDialog.close());

window.addEventListener("storage", (event) => {
  if (event.key === DATA_KEY) {
    renderPredictions();
  }
});

renderPredictions();

menuToggle.addEventListener("click", () => {
  setMenuOpen(menuToggle.getAttribute("aria-expanded") !== "true");
});

for (const link of menuLinks) {
  link.addEventListener("click", () => setMenuOpen(false));
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuToggle.getAttribute("aria-expanded") === "true") {
    setMenuOpen(false);
    menuToggle.focus();
  }
});

document.addEventListener("click", (event) => {
  if (siteMenu.hidden) {
    return;
  }
  if (siteMenu.contains(event.target) || menuToggle.contains(event.target)) {
    return;
  }
  setMenuOpen(false);
});

signInButton.addEventListener("click", async () => {
  if (!currentUser) {
    location.href = "account.html";
    return;
  }
  try {
    await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } finally {
    showUser(null);
  }
});

async function loadCurrentUser() {
  if (location.protocol === "file:") {
    return;
  }
  try {
    const response = await fetch("/api/me");
    const body = await response.json();
    showUser(body.user);
  } catch {
    showUser(null);
  }
}

loadCurrentUser();

document.querySelector("#year").textContent = new Date().getFullYear();

document.querySelector("#footer-sign-in").addEventListener("click", () => signInButton.click());
