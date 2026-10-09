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

function showPlanTables(plan) {
  const hideVip = plan === "vvip";
  tableSections.vip.hidden = hideVip;
  for (const link of document.querySelectorAll('a[href="#vip"]')) {
    const target = link.closest(".footer-list li") || link;
    target.hidden = hideVip;
  }
}

function showUser(user) {
  const changed = (currentUser?.id ?? null) !== (user?.id ?? null) || currentUser?.plan !== user?.plan;
  currentUser = user;
  arrangeTables(Boolean(user));
  showPlanTables(user?.plan);
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
  popToast(
    kind === "new" ? `Welcome to O G Sports Hub${firstName ? `, ${firstName}` : ""}!` : `Welcome back${firstName ? `, ${firstName}` : ""}!`,
    kind === "new" ? "Your account is ready. Enjoy today's predictions." : "Good to see you again. Today's picks are waiting.",
    4500,
  );
}

// Visitors who aren't signed in are invited to create an account, once per visit.
function showVisitorInvite() {
  try {
    if (sessionStorage.getItem("invited")) {
      return;
    }
    sessionStorage.setItem("invited", "1");
  } catch {
    return;
  }
  popToast("Welcome to O G Sports Hub!", "Create an account to get access to our predictions.", 3000);
}

// Slides a card down under the header, then away after `ms`.
let toastTimer;
function popToast(title, text, ms) {
  const toast = document.querySelector("#welcome-toast");
  toast.replaceChildren(element("strong", "", title), element("span", "", text));
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("is-shown"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("is-shown");
    toastTimer = setTimeout(() => (toast.hidden = true), 400);
  }, ms);
}

const tierBodies = {
  free: document.querySelector("#free-body"),
  vip: document.querySelector("#vip-body"),
  vvip: document.querySelector("#vvip-body"),
};
// Only the VIP/VVIP buttons; other buttons share the .plan-button look.
const planButtons = document.querySelectorAll(".plan-button[data-tier]");

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
  // and VIP and VVIP tips need that exact plan. A VVIP plan does not reveal VIP tips.
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
  showOwnedBookingCodes();
  markFullPlans();
}

let codeRequest = 0;
const DAY_NAMES = { "-1": "yesterday", 0: "today", 1: "tomorrow" };

function coversTier(tier) {
  return currentUser?.plan === tier;
}

// A paid member sees the day's SportyBet code where Buy Plan used to be.
async function showOwnedBookingCodes() {
  const request = ++codeRequest;
  const owned = [...planButtons].filter((button) => coversTier(button.dataset.tier));
  for (const button of planButtons) {
    const slot = document.querySelector(`#${button.dataset.tier}-code`);
    const ownedTier = coversTier(button.dataset.tier);
    button.hidden = ownedTier;
    if (!ownedTier && slot) {
      slot.hidden = true;
    }
  }
  if (!owned.length) {
    return;
  }

  let code = "";
  let failed = false;
  try {
    const response = await fetch(`/api/booking-code?date=${dateKey(selectedOffset)}&tier=${owned[0].dataset.tier}`);
    if (!response.ok) {
      throw new Error("code");
    }
    code = (await response.json()).code || "";
  } catch {
    failed = true;
  }
  if (request !== codeRequest) {
    return;
  }
  const dayName = DAY_NAMES[selectedOffset] ?? shortDayLabel(selectedOffset);
  for (const button of owned) {
    const slot = document.querySelector(`#${button.dataset.tier}-code`);
    const text = slot.querySelector(".booking-text");
    const row = slot.querySelector(".booking-code-row");
    slot.hidden = false;
    if (failed) {
      text.textContent = "Couldn't load the booking code. Refresh the page to try again.";
      row.hidden = true;
    } else if (code) {
      text.textContent = `SportyBet booking code for ${dayName}:`;
      slot.querySelector(".booking-code").textContent = code;
      row.hidden = false;
    } else {
      text.textContent = `The booking code for ${dayName} isn't ready yet. Check back soon.`;
      row.hidden = true;
    }
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

document.addEventListener("click", async (event) => {
  const button = event.target.closest(".plan-code .booking-copy");
  if (!button) {
    return;
  }
  const code = button.parentElement.querySelector(".booking-code").textContent;
  try {
    await navigator.clipboard.writeText(code);
    button.textContent = "Copied!";
  } catch {
    button.textContent = "Select and copy";
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

for (const button of document.querySelectorAll(".plan-button[data-tier]")) {
  button.addEventListener("click", () => {
    const plan = button.dataset.tier;
    if (button.disabled || planSlots[plan] === 0) {
      return;
    }
    const next = `pay.html?plan=${plan}`;
    if (!currentUser) {
      location.href = `account.html?mode=register&next=${encodeURIComponent(next)}`;
      return;
    }
    location.href = next;
  });
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
    renderPredictions();
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
    if (!body.user) {
      showVisitorInvite();
    }
  } catch {
    showUser(null);
  }
}

loadCurrentUser().then(() => {
  const params = new URLSearchParams(location.search);
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

// Payment proof still uses the Control Room WhatsApp number. The support chat and the footer icon use 233597559382.
let supportInfo = { plans: [], currency: "GHS", whatsapp: "", email: "" };

loadOptions()
  .then((options) => {
    supportInfo = {
      plans: options.plans || [],
      currency: options.currency || "GHS",
      whatsapp: options.checkout?.whatsapp || "",
      email: options.checkout?.email || "",
    };
    showPlanSlots(options.slots);
  })
  .catch(() => {});

let planSlots = {};

function markFullPlans() {
  for (const button of planButtons) {
    const full = planSlots[button.dataset.tier] === 0 && !coversTier(button.dataset.tier);
    button.disabled = full;
    if (full) {
      button.textContent = "SLOTS FULL";
    }
  }
}

function showPlanSlots(slots) {
  planSlots = slots || {};
  for (const tier of ["vip", "vvip"]) {
    const line = document.querySelector(`#${tier}-slots`);
    if (!line) {
      continue;
    }
    const left = planSlots[tier];
    if (left == null || left === "") {
      line.hidden = true;
      line.textContent = "";
      continue;
    }
    const count = Math.max(0, Number(left));
    line.hidden = false;
    line.textContent = count === 1 ? "1 slot available" : `${count} slots available`;
  }
  markFullPlans();
}

document.querySelector("#year").textContent = new Date().getFullYear();

footerSignIn.addEventListener("click", () => {
  if (currentUser) {
    signOut();
  } else {
    location.href = "account.html";
  }
});

/* ---------- Front-page chat ---------- */

const helpPanel = document.querySelector("#help-panel");
const helpOpen = document.querySelector("#help-open");
const helpLog = document.querySelector("#help-log");
const helpInput = document.querySelector("#help-input");
let helpBusy = false;
let helpGreeted = false;

function moneyAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    return "";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function planPriceText() {
  if (!supportInfo.plans.length) {
    return "The price for each plan is shown on its Buy Plan button.";
  }
  return supportInfo.plans
    .map((plan) => {
      const days = Number(plan.days) === 1 ? "1 day" : `${plan.days} days`;
      return `${plan.name} is ${supportInfo.currency} ${moneyAmount(plan.amount)} for ${days}`;
    })
    .join(". ") + ".";
}

const SUPPORT_WHATSAPP = "233597559382";

function contactAnswer() {
  const link = whatsappLink(SUPPORT_WHATSAPP, "Hello, I have a question about my predictions account.");
  return {
    text: "Our WhatsApp contact is 233597559382. You will see the other handles in the footer at the bottom of the page, under Follow us: TikTok, Instagram, and X.",
    link: link ? { href: link, label: "Open WhatsApp" } : null,
    showFooter: true,
  };
}

function supportReply(raw) {
  const text = raw.toLowerCase();
  const asks = (pattern) => pattern.test(text);
  if (asks(/\b(whats\s*a+p+p?|whatapp|instagram|insta|tik\s*tok|twitter|socials?|handles?)\b/) || asks(/\bfollow us\b/) || asks(/\b(human|agent|someone|person|call)\b/)) {
    return contactAnswer();
  }
  if (asks(/\b(book|booking|sporty)\b/)) {
    return { text: "The SportyBet booking code shows only for the plan you have, in place of Buy Plan, for the day you are viewing. VIP members see the VIP code. VVIP members see the VVIP code. If the code is not ready, that space says so. The free table does not have a booking-code button." };
  }
  if (asks(/\brecovery\b/)) {
    return { text: "Open Recovery ticket in the menu. It is for a VIP or VVIP ticket that lost, and it stays available for 2 days after that loss. A winning ticket does not qualify. Sign in with the account that bought the plan." };
  }
  if (asks(/\b(pay|payment|receipt|momo|confirm|rejected|approved|spinner)\b/)) {
    return { text: "Sign in, open VIP or VVIP, and press Buy Plan. Pay with the details shown, upload your receipt, and tap I've sent the money once. A spinner stays on the page until we accept or reject the receipt, including after a refresh. If we reject it, you can send another receipt. When we accept it, you come back here and Buy Plan for that plan becomes the booking code." };
  }
  if (asks(/\b(price|prices|cost|how much|fee)\b/)) {
    return { text: `${planPriceText()} A plan lasts for that day only. The buyer does not type a price.` };
  }
  if (asks(/\b(differ|versus|vs|which plan|only see|unlock)\b/) || (asks(/\bvip\b/) && asks(/\bvvip\b/))) {
    return { text: "VIP and VVIP are separate tables. A VIP plan unlocks free tips and VIP tips only. A VVIP plan unlocks free tips and VVIP tips only, not the VIP table. Each booking code belongs to its own table." };
  }
  if (asks(/\b(buy|purchase|subscribe|upgrade)\b/) || asks(/\bplan\b/)) {
    return { text: `Create an account and sign in, then press Buy Plan under VIP or VVIP. ${planPriceText()} After the receipt is accepted, that plan's Buy Plan button becomes the booking code.` };
  }
  if (asks(/\b(sign in|signin|sign up|signup|register|account|password|log in|login)\b/)) {
    return { text: "Use Sign in at the top of the page to open your account or create one. Your name appears in the header after you sign in." };
  }
  if (asks(/\b(predict|tip|free|odds|fixture|today|tomorrow)/)) {
    return { text: "Free predictions are open to everyone. Use Yesterday, Today, or Tomorrow to change the day. VIP and VVIP stay locked until that plan is active for today. A VIP member does not see VVIP tips, and a VVIP member does not see VIP tips." };
  }
  if (asks(/\b(gambl|responsib|addict|18)\b/)) {
    return { text: "Betting is for adults, and winnings are never guaranteed. Only stake money you can afford to lose. If betting is hurting your money or your life, stop and seek professional help." };
  }
  if (asks(/^\s*(hi|hello|hey|good morning|good afternoon|good evening)\b/) && text.trim().split(/\s+/).length <= 4) {
    return { text: "Hello. Ask me about predictions, VIP and VVIP plans, payments, booking codes, or recovery tickets." };
  }
  return { text: "Ask me about predictions, buying VIP or VVIP, payment confirmation, booking codes, or recovery tickets. You can also message us on WhatsApp." };
}

let footerGlowTimer;

function showFooterHandles() {
  const block = document.querySelector(".social-links");
  setHelpOpen(false);
  if (!block) {
    return;
  }
  block.scrollIntoView({ behavior: "smooth", block: "center" });
  block.classList.remove("is-highlighted");
  void block.offsetWidth;
  block.classList.add("is-highlighted");
  clearTimeout(footerGlowTimer);
  footerGlowTimer = setTimeout(() => block.classList.remove("is-highlighted"), 2500);
}

function addHelpBubble(role, text, link, showFooter) {
  const item = document.createElement("div");
  item.className = `help-bubble help-${role}`;
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  item.append(paragraph);
  if (link) {
    const anchor = document.createElement("a");
    anchor.href = link.href;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.textContent = link.label;
    item.append(anchor);
  }
  if (showFooter) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "help-footer-jump";
    button.textContent = "Show footer handles";
    button.addEventListener("click", showFooterHandles);
    item.append(button);
  }
  helpLog.append(item);
  helpLog.scrollTop = helpLog.scrollHeight;
}

function greetHelp() {
  if (helpGreeted) {
    return;
  }
  helpGreeted = true;
  addHelpBubble("bot", "Hello. Ask me about predictions, VIP and VVIP plans, payments, booking codes, or recovery tickets.");
}

function setHelpOpen(open) {
  helpPanel.hidden = !open;
  helpOpen.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("chat-open", open);
  if (open) {
    setMenuOpen(false);
    greetHelp();
    if (document.activeElement) {
      document.activeElement.blur();
    }
  }
}

function sendHelp(raw) {
  const text = String(raw || "").trim().slice(0, 400);
  if (!text || helpBusy) {
    return;
  }
  helpBusy = true;
  setHelpOpen(true);
  addHelpBubble("user", text);
  helpDraft = "";
  paintHelpDraft();
  const pending = document.createElement("p");
  pending.className = "help-typing";
  pending.setAttribute("aria-label", "Replying");
  pending.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
  helpLog.append(pending);
  helpLog.scrollTop = helpLog.scrollHeight;
  window.setTimeout(() => {
    pending.remove();
    const answer = supportReply(text);
    addHelpBubble("bot", answer.text, answer.link, answer.showFooter);
    helpBusy = false;
  }, 400);
}

helpOpen.addEventListener("click", () => setHelpOpen(helpPanel.hidden));
document.querySelector("#help-back").addEventListener("click", () => setHelpOpen(false));
document.querySelector("#menu-help").addEventListener("click", () => setHelpOpen(true));
document.querySelector("#help-send").addEventListener("click", () => sendHelp(helpDraft));

const helpKeys = document.querySelector("#help-keys");
let helpDraft = "";
let helpShift = false;
let helpNumbers = false;
const HELP_LETTERS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const HELP_NUMBERS = ["1234567890", "-/:;()$&@", ".,?!'"];

function paintHelpDraft() {
  helpInput.textContent = helpDraft;
  helpInput.classList.toggle("is-empty", helpDraft.length === 0);
}

function helpKey(label, name, wide) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `help-key${wide ? " help-key-space" : ""}`;
  button.dataset.key = name;
  button.textContent = label;
  if (name === "shift" && helpShift) {
    button.classList.add("is-on");
  }
  if (name === "numbers" && helpNumbers) {
    button.classList.add("is-on");
  }
  return button;
}

function renderHelpKeys() {
  helpKeys.replaceChildren();
  const rows = helpNumbers ? HELP_NUMBERS : HELP_LETTERS;
  rows.forEach((row, index) => {
    const line = document.createElement("div");
    line.className = "help-key-row";
    if (index === 2 && !helpNumbers) {
      line.classList.add("help-key-row-edge");
      line.append(helpKey("Shift", "shift", true));
    }
    for (const char of row) {
      const shown = !helpNumbers && helpShift ? char.toUpperCase() : char;
      line.append(helpKey(shown, `char:${shown}`));
    }
    if (index === 2) {
      line.append(helpKey("⌫", "backspace", true));
    }
    helpKeys.append(line);
  });
  const bottom = document.createElement("div");
  bottom.className = "help-key-row help-key-row-bottom";
  bottom.append(helpKey(helpNumbers ? "ABC" : "123", "numbers", true));
  bottom.append(helpKey("space", "space", true));
  bottom.append(helpKey("Send", "send", true));
  helpKeys.append(bottom);
}

function typeHelp(char) {
  if (helpDraft.length >= 400) {
    return;
  }
  helpDraft += char;
  if (helpShift && !helpNumbers) {
    helpShift = false;
    renderHelpKeys();
  }
  paintHelpDraft();
}

helpKeys.addEventListener("pointerdown", (event) => {
  const key = event.target.closest("[data-key]");
  if (!key) {
    return;
  }
  event.preventDefault();
  const name = key.dataset.key;
  if (name.startsWith("char:")) {
    typeHelp(name.slice(5));
  } else if (name === "space") {
    typeHelp(" ");
  } else if (name === "backspace") {
    helpDraft = helpDraft.slice(0, -1);
    paintHelpDraft();
  } else if (name === "shift") {
    if (helpNumbers) {
      return;
    }
    helpShift = !helpShift;
    renderHelpKeys();
  } else if (name === "numbers") {
    helpNumbers = !helpNumbers;
    helpShift = false;
    renderHelpKeys();
  } else if (name === "send") {
    sendHelp(helpDraft);
  }
});

document.addEventListener("keydown", (event) => {
  if (helpPanel.hidden) {
    return;
  }
  if (event.key === "Escape") {
    setHelpOpen(false);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  if (event.key === "Backspace") {
    helpDraft = helpDraft.slice(0, -1);
    paintHelpDraft();
    event.preventDefault();
  } else if (event.key === "Enter") {
    sendHelp(helpDraft);
    event.preventDefault();
  } else if (event.key.length === 1) {
    typeHelp(event.key);
    event.preventDefault();
  }
});

renderHelpKeys();

document.addEventListener("click", (event) => {
  const ask = event.target.closest("[data-help-ask]");
  if (!ask) {
    return;
  }
  sendHelp(ask.dataset.helpAsk);
});
