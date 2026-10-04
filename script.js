// One button in the top-right corner: "Sign in" when signed out, "Sign out" when signed in.
const signInButton = document.querySelector("#sign-in");
const footerSignIn = document.querySelector("#footer-sign-in");
const userLabel = document.querySelector("#user-label");
const menuToggle = document.querySelector("#menu-toggle");
const siteMenu = document.querySelector("#site-menu");
const menuLinks = document.querySelectorAll("#site-menu a");
const dayButtons = document.querySelectorAll(".day-button[data-day]");
const customDayButton = document.querySelector("#day-custom");

// Signed-in account from the server: { email, plan, planExpiresAt } or null.
let currentUser = null;

function setMenuOpen(open) {
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  siteMenu.hidden = !open;
}

// Signed-in members see the paid tables first: VIP, then VVIP, then Free.
// Visitors see Free first. The dividers between tables move with them.
const tableSections = { free: document.querySelector("#free"), vip: document.querySelector("#vip"), vvip: document.querySelector("#vvip") };
// Tables are placed after the day switcher, which always stays on top.
const leadDivider = document.querySelector(".day-switcher");
const tableDividers = [tableSections.vip.previousElementSibling, tableSections.vvip.previousElementSibling];

function arrangeTables(signedIn) {
  const order = signedIn ? ["vip", "vvip", "free"] : ["free", "vip", "vvip"];
  let previous = leadDivider;
  order.forEach((id, index) => {
    previous.after(tableSections[id]);
    previous = tableSections[id];
    if (index < tableDividers.length) {
      previous.after(tableDividers[index]);
      previous = tableDividers[index];
    }
  });
}

function showUser(user) {
  const changed = (currentUser?.id ?? null) !== (user?.id ?? null) || currentUser?.plan !== user?.plan;
  currentUser = user;
  arrangeTables(Boolean(user));
  if (changed) {
    renderPredictions();
  }
  signInButton.textContent = user ? "Sign out" : "Sign in";
  signInButton.classList.toggle("is-signed-in", Boolean(user));
  footerSignIn.textContent = user ? "Sign out" : "Sign in";
  userLabel.hidden = !user;
  if (!user) {
    return;
  }
  // Older accounts have no name, so they still show the email.
  const who = user.name || user.email;
  document.querySelector("#user-avatar").textContent = initials(who);
  document.querySelector("#user-name").textContent = who;
  const planBadge = document.querySelector("#user-plan");
  planBadge.textContent = user.plan.toUpperCase();
  planBadge.className = `user-plan plan-${user.plan}`;
  userLabel.dataset.plan = user.plan;
  userLabel.title = user.plan === "free" ? who : `${who} · ${user.plan.toUpperCase()} member`;
  showWelcome(user);
}

// "Kwame Mensah" -> "KM"; an email falls back to its first letter.
function initials(text) {
  const words = text.split("@")[0].split(/[\s._-]+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?";
}

// The account page leaves a note after signing in ("back") or creating an account ("new").
// It is shown once, then cleared.
function showWelcome(user) {
  let kind = null;
  try {
    kind = sessionStorage.getItem("welcome");
    sessionStorage.removeItem("welcome");
  } catch {
    return;
  }
  if (kind !== "back" && kind !== "new") {
    return;
  }
  const firstName = (user.name || "").split(" ")[0];
  const toast = document.querySelector("#welcome-toast");
  toast.replaceChildren(
    element("strong", "", kind === "new" ? `Welcome to O G Sports Hub${firstName ? `, ${firstName}` : ""}!` : `Welcome back${firstName ? `, ${firstName}` : ""}!`),
    element("span", "", kind === "new" ? "Your account is ready. Enjoy today's predictions." : "Good to see you again. Today's picks are waiting."),
  );
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("is-shown"));
  setTimeout(() => {
    toast.classList.remove("is-shown");
    setTimeout(() => (toast.hidden = true), 400);
  }, 4500);
}

const tierBodies = {
  free: document.querySelector("#free-body"),
  vip: document.querySelector("#vip-body"),
  vvip: document.querySelector("#vvip-body"),
};
// Only the VIP/VVIP buttons; other buttons share the .plan-button look.
const planButtons = document.querySelectorAll(".plan-button[data-tier]");
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
  const odds = match.odds ? ` · Odds: ${match.odds}` : "";
  // The server only sends tips the viewer may see: free tips need an account,
  // VIP/VVIP tips need a plan that covers them.
  const lockedText = tier === "free" ? "Tip hidden · register free to see it" : "Tip locked · buy the plan to unlock";
  meta.textContent = match.locked ? `${lockedText}${odds}` : `Tip: ${match.tip}${odds}`;
  info.append(meta);

  if (match.image) {
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

function messageRow(text) {
  const row = emptyRow();
  row.firstChild.textContent = text;
  return row;
}

// Each request gets a number so a slow answer for an old day can't overwrite a newer one.
let predictionsRequest = 0;

async function renderPredictions() {
  const request = ++predictionsRequest;
  const date = dateKey(selectedOffset);
  let matches;
  try {
    const response = await fetch(`/api/matches?date=${date}`);
    if (!response.ok) {
      throw new Error("predictions unavailable");
    }
    matches = (await response.json()).matches;
  } catch {
    if (request === predictionsRequest) {
      for (const tier of TIERS) {
        tierBodies[tier.id].replaceChildren(messageRow("Couldn't load predictions. Refresh the page to try again."));
      }
    }
    return;
  }
  if (request !== predictionsRequest) {
    return;
  }

  for (const tier of TIERS) {
    const tierMatches = matches.filter((match) => match.tier === tier.id);
    const rows = tierMatches.length ? tierMatches.map((match) => matchRow(match, tier.id)) : [emptyRow()];
    tierBodies[tier.id].replaceChildren(...rows);
  }

  for (const button of planButtons) {
    const total = totalOdds(matches.filter((match) => match.tier === button.dataset.tier));
    button.textContent = total ? `BUY PLAN (total odds ${total.toFixed(2)})` : "BUY PLAN (total odds)";
  }
}

// Shows the predictions for a day, as an offset from today (0 = today).
function selectDay(offset) {
  selectedOffset = offset;
  for (const button of dayButtons) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.day) === offset));
  }
  // Dates other than yesterday/today/tomorrow get their own highlighted button.
  const isCustom = ![-1, 0, 1].includes(offset);
  customDayButton.hidden = !isCustom;
  if (isCustom) {
    customDayButton.textContent = shortDayLabel(offset);
  }
  hideBooking();
  renderPredictions();
}

function shortDayLabel(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

for (const button of dayButtons) {
  button.addEventListener("click", () => selectDay(Number(button.dataset.day)));
}

/* ---------- Recovery ticket (menu) ---------- */

const recoveryDialog = document.querySelector("#recovery-dialog");
const recoveryForm = document.querySelector("#recovery-form");
const recoveryEmail = document.querySelector("#recovery-email");
const recoveryResult = document.querySelector("#recovery-result");
const recoveryMessage = document.querySelector("#recovery-message");
const recoveryTips = document.querySelector("#recovery-tips");
const recoverySubmit = document.querySelector("#recovery-submit");

function openRecovery() {
  setMenuOpen(false);
  recoveryEmail.value = currentUser?.email || recoveryEmail.value;
  recoveryResult.hidden = true;
  recoveryDialog.showModal();
}

function showRecovery(status, message, tips = []) {
  recoveryResult.hidden = false;
  recoveryResult.dataset.status = status;
  recoveryMessage.textContent = message;
  recoveryTips.replaceChildren(
    ...tips.map((tip) => {
      const item = document.createElement("li");
      const teams = document.createElement("span");
      teams.className = "recovery-teams";
      teams.textContent = `${tip.home} vs ${tip.away}`;
      const detail = document.createElement("span");
      detail.className = "recovery-detail";
      detail.textContent = tip.odds ? `Tip: ${tip.tip} · Odds: ${tip.odds}` : `Tip: ${tip.tip}`;
      item.append(teams, detail);
      return item;
    }),
  );
}

// The email is confirmed by signing in with it; the server checks the purchase rules.
async function checkRecoveryTicket() {
  const email = recoveryEmail.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showRecovery("error", "Enter the email you registered with.");
    return;
  }
  if (!currentUser) {
    const next = encodeURIComponent("index.html?recovery=1");
    location.href = `account.html?mode=login&email=${encodeURIComponent(email)}&next=${next}`;
    return;
  }
  recoverySubmit.disabled = true;
  try {
    const response = await fetch("/api/recovery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, date: dateKey(0) }),
    });
    if (response.status === 401) {
      showUser(null);
      await checkRecoveryTicket();
      return;
    }
    const body = await response.json();
    if (!response.ok) {
      showRecovery("error", body.error || "Couldn't check your ticket. Please try again.");
      return;
    }
    const until = body.validUntil
      ? ` Valid until ${new Date(`${body.validUntil}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}.`
      : "";
    showRecovery(body.status, body.message + (body.status === "eligible" ? until : ""), body.tips || []);
  } catch {
    showRecovery("error", "Couldn't reach the server. Check your connection and try again.");
  } finally {
    recoverySubmit.disabled = false;
  }
}

recoveryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  checkRecoveryTicket();
});
document.querySelector("#menu-recovery").addEventListener("click", openRecovery);
document.querySelector("#recovery-close").addEventListener("click", () => recoveryDialog.close());
recoveryDialog.addEventListener("click", (event) => {
  if (event.target === recoveryDialog) {
    recoveryDialog.close();
  }
});

/* ---------- Results calendar (menu) ---------- */

const calendarDialog = document.querySelector("#calendar-dialog");
const calendarGrid = document.querySelector("#calendar-grid");
const calendarTitle = document.querySelector("#calendar-title");
// The month on screen, as its first day.
let calendarMonth = new Date();

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function offsetOf(date) {
  return Math.round((date - startOfToday()) / 86400000);
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

async function monthResults(date) {
  try {
    const response = await fetch(`/api/matches/month?month=${monthKey(date)}`);
    const { days } = await response.json();
    return new Map(days.map((day) => [day.date, day]));
  } catch {
    return new Map();
  }
}

async function renderCalendar() {
  const first = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
  calendarTitle.textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const results = await monthResults(first);

  // Weeks start on Monday; pad the first row with the previous month's days.
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) {
    cells.push(Object.assign(document.createElement("span"), { className: "calendar-cell is-blank" }));
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(first.getFullYear(), first.getMonth(), day);
    const offset = offsetOf(date);
    const key = dateKey(offset);
    const summary = results.get(key);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "calendar-cell";
    button.disabled = offset > 1;
    button.classList.toggle("is-today", offset === 0);
    button.classList.toggle("is-selected", offset === selectedOffset);

    const number = document.createElement("span");
    number.className = "calendar-day";
    number.textContent = day;
    button.append(number);

    let label = date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    if (summary) {
      const decided = summary.won + summary.lost;
      const tone = !decided ? "pending" : summary.won >= summary.lost ? "won" : "lost";
      const dot = document.createElement("i");
      dot.className = `dot ${tone}`;
      button.append(dot);
      if (decided) {
        const score = document.createElement("span");
        score.className = "calendar-score";
        score.textContent = `${summary.won}✓ ${summary.lost}✗`;
        button.append(score);
      }
      label += `: ${summary.total} predictions, ${summary.won} won, ${summary.lost} lost`;
    }
    button.setAttribute("aria-label", label);
    button.addEventListener("click", () => {
      selectDay(offset);
      calendarDialog.close();
      document.querySelector("#free").scrollIntoView({ behavior: "smooth" });
    });
    cells.push(button);
  }
  calendarGrid.replaceChildren(...cells);

  // Tomorrow is the latest day with predictions, so stop at its month.
  const tomorrow = startOfToday();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const monthIndex = (date) => date.getFullYear() * 12 + date.getMonth();
  document.querySelector("#calendar-next").disabled = monthIndex(first) >= monthIndex(tomorrow);
}

function openCalendar() {
  const shown = new Date();
  shown.setDate(shown.getDate() + selectedOffset);
  calendarMonth = new Date(shown.getFullYear(), shown.getMonth(), 1);
  setMenuOpen(false);
  calendarDialog.showModal();
  renderCalendar();
}

function moveMonth(step) {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + step, 1);
  renderCalendar();
}

document.querySelector("#calendar-prev").addEventListener("click", () => moveMonth(-1));
document.querySelector("#calendar-next").addEventListener("click", () => moveMonth(1));
document.querySelector("#calendar-today").addEventListener("click", () => {
  selectDay(0);
  calendarDialog.close();
  document.querySelector("#free").scrollIntoView({ behavior: "smooth" });
});
document.querySelector("#calendar-close").addEventListener("click", () => calendarDialog.close());
// Tapping the dark area outside the calendar closes it.
calendarDialog.addEventListener("click", (event) => {
  if (event.target === calendarDialog) {
    calendarDialog.close();
  }
});

document.querySelector("#menu-calendar").addEventListener("click", openCalendar);
customDayButton.addEventListener("click", openCalendar);

/* ---------- SportyBet booking code (free predictions) ---------- */

const bookingButton = document.querySelector("#booking-button");
const bookingPanel = document.querySelector("#booking-panel");
const bookingText = document.querySelector("#booking-text");
const bookingCodeRow = document.querySelector("#booking-code-row");
const bookingCode = document.querySelector("#booking-code");
const bookingCopy = document.querySelector("#booking-copy");

const DAY_NAMES = { "-1": "yesterday", 0: "today", 1: "tomorrow" };

function showBooking({ text, code = null }) {
  bookingPanel.hidden = false;
  bookingButton.setAttribute("aria-expanded", "true");
  bookingText.textContent = text;
  bookingCodeRow.hidden = !code;
  bookingCode.textContent = code || "";
  bookingCopy.textContent = "Copy";
}

function hideBooking() {
  bookingPanel.hidden = true;
  bookingButton.setAttribute("aria-expanded", "false");
}

// Visitors go straight to registration, then come back here with the code opened.
function sendToRegister() {
  location.href = `account.html?mode=register&next=${encodeURIComponent("index.html?booking=1")}`;
}

// The code is only sent by the server to signed-in users.
async function revealBookingCode() {
  const dayName = DAY_NAMES[selectedOffset] ?? shortDayLabel(selectedOffset);
  if (!currentUser) {
    sendToRegister();
    return;
  }

  bookingButton.disabled = true;
  try {
    const response = await fetch(`/api/booking-code?date=${dateKey(selectedOffset)}`);
    if (response.status === 401) {
      showUser(null);
      sendToRegister();
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

/* ---------- Testimonials carousel (real reviews added in the Control Room) ---------- */

const testimonialsBox = document.querySelector("#testimonials");
const testimonialCard = document.querySelector("#testimonial");
const testimonialDots = document.querySelector("#testimonial-dots");
const TESTIMONIAL_MS = 5000;
let testimonials = [];
let testimonialIndex = 0;
let testimonialTimer = null;

function showTestimonial(index) {
  testimonialIndex = (index + testimonials.length) % testimonials.length;
  const item = testimonials[testimonialIndex];
  testimonialCard.classList.remove("is-entering");
  // Restart the slide-in animation for the new review.
  void testimonialCard.offsetWidth;
  testimonialCard.classList.add("is-entering");

  const stars = document.querySelector("#testimonial-stars");
  stars.textContent = "★".repeat(item.rating) + "☆".repeat(5 - item.rating);
  stars.setAttribute("aria-label", `${item.rating} out of 5 stars`);
  document.querySelector("#testimonial-message").textContent = `“${item.message}”`;
  document.querySelector("#testimonial-name").textContent = item.name;
  document.querySelector("#testimonial-location").textContent = item.location;

  [...testimonialDots.children].forEach((dot, dotIndex) => {
    dot.setAttribute("aria-pressed", String(dotIndex === testimonialIndex));
  });
}

function startTestimonialTimer() {
  stopTestimonialTimer();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (testimonials.length > 1 && !reduceMotion) {
    testimonialTimer = setInterval(() => showTestimonial(testimonialIndex + 1), TESTIMONIAL_MS);
  }
}

function stopTestimonialTimer() {
  clearInterval(testimonialTimer);
  testimonialTimer = null;
}

async function loadTestimonials() {
  try {
    const response = await fetch("/api/testimonials");
    testimonials = (await response.json()).testimonials || [];
  } catch {
    testimonials = [];
  }
  // The slider stays hidden until there is an approved review.
  const hasReviews = testimonials.length > 0;
  document.querySelector("#testimonial-carousel").hidden = !hasReviews;
  document.querySelector("#testimonials-empty").hidden = hasReviews;
  if (!hasReviews) {
    return;
  }
  testimonialDots.replaceChildren(
    ...testimonials.map((item, index) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "testimonial-dot";
      dot.setAttribute("aria-label", `Review ${index + 1} of ${testimonials.length}`);
      dot.addEventListener("click", () => {
        showTestimonial(index);
        startTestimonialTimer();
      });
      return dot;
    }),
  );
  testimonialDots.hidden = testimonials.length < 2;
  showTestimonial(0);
  startTestimonialTimer();
}

// Pause while someone is reading or using the controls.
testimonialsBox.addEventListener("mouseenter", stopTestimonialTimer);
testimonialsBox.addEventListener("mouseleave", startTestimonialTimer);
testimonialsBox.addEventListener("focusin", stopTestimonialTimer);
testimonialsBox.addEventListener("focusout", startTestimonialTimer);

loadTestimonials();

/* ---------- Leave a review (members only, shown after admin approval) ---------- */

const reviewOpen = document.querySelector("#review-open");
const reviewForm = document.querySelector("#review-form");
const reviewStatus = document.querySelector("#review-status");
const reviewThanks = document.querySelector("#review-thanks");

function openReviewForm() {
  if (!currentUser) {
    location.href = `account.html?mode=register&next=${encodeURIComponent("index.html?review=1")}`;
    return;
  }
  reviewForm.hidden = false;
  reviewThanks.hidden = true;
  reviewOpen.setAttribute("aria-expanded", "true");
  const reviewName = document.querySelector("#review-name");
  reviewName.value ||= (currentUser.name || "").slice(0, 40);
  reviewName.focus();
}

reviewOpen.addEventListener("click", () => {
  if (!reviewForm.hidden) {
    reviewForm.hidden = true;
    reviewOpen.setAttribute("aria-expanded", "false");
    return;
  }
  openReviewForm();
});

reviewForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  reviewStatus.textContent = "";
  const submit = reviewForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const response = await fetch("/api/testimonials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.querySelector("#review-name").value,
        location: document.querySelector("#review-location").value,
        rating: Number(reviewForm.querySelector('input[name="rating"]:checked').value),
        message: document.querySelector("#review-message").value,
      }),
    });
    if (response.status === 401) {
      showUser(null);
      openReviewForm();
      return;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      reviewStatus.textContent = body.error || "Couldn't send your review. Please try again.";
      return;
    }
    reviewForm.reset();
    reviewForm.hidden = true;
    reviewOpen.setAttribute("aria-expanded", "false");
    reviewThanks.textContent = "Thank you! Your review has been sent and will appear here once it's approved.";
    reviewThanks.hidden = false;
  } catch {
    reviewStatus.textContent = "Couldn't reach the server. Check your connection and try again.";
  } finally {
    submit.disabled = false;
  }
});

/* ---------- Buying a plan ---------- */

const payDialog = document.querySelector("#pay-dialog");
const payTitle = document.querySelector("#pay-title");
const payPrice = document.querySelector("#pay-price");
const payOptions = document.querySelector("#pay-options");
const payError = document.querySelector("#pay-error");
const payNote = document.querySelector("#pay-note");
const payManual = document.querySelector("#pay-manual");

const PROVIDER_NAMES = { paystack: "Pay with Paystack", flutterwave: "Pay with Flutterwave" };

// Plan prices, online providers and the admin's checkout details, from the server.
async function loadOptions() {
  const response = await fetch("/api/payments/options");
  if (!response.ok) {
    throw new Error("options unavailable");
  }
  return response.json();
}

function element(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (textContent !== undefined) {
    node.textContent = textContent;
  }
  return node;
}

function contactLinks(checkout, message) {
  const nodes = [];
  const link = whatsappLink(checkout.whatsapp, message);
  if (link) {
    const button = element("a", "plan-button pay-whatsapp", "SEND PROOF ON WHATSAPP");
    button.href = link;
    button.target = "_blank";
    button.rel = "noopener";
    nodes.push(button);
  }
  if (checkout.email) {
    const line = element("p", "pay-small", "Questions? Email ");
    const mail = element("a", "", checkout.email);
    mail.href = `mailto:${checkout.email}`;
    line.append(mail);
    nodes.push(line);
  }
  return nodes;
}

// Manual payment details: accounts, price in other currencies, and how to send proof.
function manualPayment(planInfo, options, hasOnline) {
  const { checkout, currency } = options;
  const amountText = `${currency} ${planInfo.amount.toFixed(2)}`;
  const nodes = [];

  if (!checkout.methods.length) {
    if (!hasOnline) {
      nodes.push(element("p", "pay-small", "Payments are opening soon. Contact us to get your plan today."));
      const link = whatsappLink(checkout.whatsapp, `Hello, I want to buy the ${planInfo.name} plan.`);
      if (link) {
        const button = element("a", "plan-button pay-whatsapp", "CONTACT US ON WHATSAPP");
        button.href = link;
        button.target = "_blank";
        button.rel = "noopener";
        nodes.push(button);
      }
      nodes.push(...contactLinks({ ...checkout, whatsapp: "" }, ""));
    }
    return nodes;
  }

  nodes.push(element("p", "pay-heading", hasOnline ? "Or pay manually" : `Send ${amountText} to any of these:`));
  for (const method of checkout.methods) {
    const block = element("div", "pay-method");
    block.append(element("p", "pay-method-title", method.label));
    for (const account of method.accounts) {
      const provider = account.network || account.bank || "";
      const card = element("div", "pay-account");
      card.append(element("span", "pay-account-number", [provider, account.number].filter(Boolean).join(" · ")));
      if (account.name) {
        card.append(element("span", "pay-account-name", account.name));
      }
      block.append(card);
    }
    nodes.push(block);
  }

  if (checkout.rates.length) {
    const list = element("p", "pay-small pay-convert");
    list.textContent = "Paying from abroad: " + checkout.rates
      .map((rate) => `${rate.symbol} ${(planInfo.amount * rate.rate).toLocaleString(undefined, { maximumFractionDigits: 2 })} (${rate.country})`)
      .join(" · ");
    nodes.push(list);
  }

  nodes.push(element("p", "pay-small", `Use your account email (${currentUser.email}) as the payment reference. Your plan is activated once we confirm your payment.`));
  const message = `Hello${checkout.businessName ? ` ${checkout.businessName}` : ""}, I've paid ${amountText} for the ${planInfo.name} plan. My account email: ${currentUser.email}. Here is my proof of payment:`;
  nodes.push(...contactLinks(checkout, message));
  return nodes;
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
  if (!currentUser) {
    location.href = "account.html?mode=register";
    return;
  }

  let options;
  try {
    options = await loadOptions();
  } catch {
    window.alert("Couldn't load the payment options. Check your connection and try again.");
    return;
  }
  const planInfo = options.plans.find((item) => item.id === plan);
  if (!planInfo) {
    return;
  }
  const hasOnline = options.providers.length > 0;

  payTitle.textContent = `Buy ${planInfo.name} plan`;
  payPrice.textContent = `${options.currency} ${planInfo.amount.toFixed(2)} · valid for ${planInfo.days === 1 ? "today (renews daily)" : `${planInfo.days} days`}`;
  payError.textContent = "";
  payNote.hidden = !hasOnline;
  payManual.replaceChildren(...manualPayment(planInfo, options, hasOnline));
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

renderPredictions();

menuToggle.addEventListener("click", () => {
  setMenuOpen(menuToggle.getAttribute("aria-expanded") !== "true");
});

for (const link of menuLinks) {
  link.addEventListener("click", () => setMenuOpen(false));
}

// "Our Mission" jumps straight to the footer and lights it up for a second.
const missionBlock = document.querySelector("#mission");
let missionGlowTimer;
document.querySelector('#site-menu a[href="#mission"]').addEventListener("click", (event) => {
  event.preventDefault();
  history.replaceState(null, "", "#mission");
  missionBlock.scrollIntoView({ behavior: "instant", block: "center" });
  missionBlock.classList.remove("is-highlighted");
  // Reflow so tapping again replays the glow.
  void missionBlock.offsetWidth;
  missionBlock.classList.add("is-highlighted");
  clearTimeout(missionGlowTimer);
  missionGlowTimer = setTimeout(() => missionBlock.classList.remove("is-highlighted"), 1000);
});

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

async function signOut() {
  try {
    await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } finally {
    showUser(null);
    hideBooking();
  }
}

signInButton.addEventListener("click", () => {
  if (currentUser) {
    signOut();
  } else {
    location.href = "account.html";
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

loadCurrentUser().then(() => {
  // Back from registering via the booking code button: open the code for them.
  const params = new URLSearchParams(location.search);
  if (params.get("booking") === "1") {
    history.replaceState(null, "", location.pathname);
    if (currentUser) {
      bookingButton.scrollIntoView({ behavior: "smooth", block: "center" });
      revealBookingCode();
    }
  }
  if (params.get("recovery") === "1") {
    history.replaceState(null, "", location.pathname);
    if (currentUser) {
      openRecovery();
      checkRecoveryTicket();
    }
  }
  // Back from registering via "Leave a review": open the form for them.
  if (params.get("review") === "1") {
    history.replaceState(null, "", location.pathname);
    if (currentUser) {
      reviewOpen.scrollIntoView({ behavior: "smooth", block: "center" });
      openReviewForm();
    }
  }
});

// Footer WhatsApp card uses the support number saved in the Control Room.
loadOptions()
  .then(({ checkout }) => {
    const link = whatsappLink(checkout.whatsapp, "Hello, I have a question about your predictions.");
    if (link) {
      footerWhatsapp.href = link;
    }
  })
  .catch(() => {});

document.querySelector("#year").textContent = new Date().getFullYear();

footerSignIn.addEventListener("click", () => {
  if (currentUser) {
    signOut();
  } else {
    location.href = "account.html";
  }
});
