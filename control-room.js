const ADMIN_SESSION_KEY = "predictions-admin";
const TESSERACT_SRC = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

const dayButtons = document.querySelectorAll(".day-button");
const dateText = document.querySelector("#control-date");
const tierSections = document.querySelector("#tier-sections");

const form = document.querySelector("#match-form");
const formTitle = document.querySelector("#form-title");
const formMessage = document.querySelector("#form-message");
const submitButton = document.querySelector("#f-submit");
const cancelButton = document.querySelector("#f-cancel");
const matchFields = document.querySelector("#match-fields");
const manualFields = document.querySelector("#manual-fields");
const tierHint = document.querySelector("#tier-hint");
const fields = {
  tier: document.querySelector("#f-tier"),
  home: document.querySelector("#f-home"),
  away: document.querySelector("#f-away"),
  tip: document.querySelector("#f-tip"),
  odds: document.querySelector("#f-odds"),
  image: document.querySelector("#f-image"),
};
const imageLabel = document.querySelector("#image-label");
const imagePreview = document.querySelector("#image-preview");
const imagePreviewImg = document.querySelector("#image-preview-img");
const imageRemove = document.querySelector("#image-remove");
const slipStatus = document.querySelector("#slip-status");
const slipResults = document.querySelector("#slip-results");
const slipTitle = document.querySelector("#slip-title");
const slipBody = document.querySelector("#slip-body");
const slipClear = document.querySelector("#slip-clear");

// Pictures are shrunk before saving because browser storage only holds a few MB.
const MAX_IMAGE_SIDE = 1000;
let pendingImage = "";
let slipMatches = [];
let scanning = false;
let tesseractReady = null;



let data = loadData() || { matches: [], members: [], payments: [], settings: { whatsapp: "", currency: "GH₵" } };
// Predictions for the selected day, loaded from the server (shared with the front page).
let serverMatches = [];
let selectedOffset = 0;
let editingId = null;

function showMessage(messageEl, text, isError = false) {
  messageEl.textContent = text;
  messageEl.classList.toggle("error", isError);
}

function persist(messageEl, successText) {
  if (saveData(data)) {
    showMessage(messageEl, successText);
    return true;
  }
  showMessage(messageEl, "Couldn't save. Storage is full or blocked. Try removing some pictures.", true);
  return false;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function formatOdds(value) {
  return Number(value) > 0 ? Number(value).toFixed(2) : "";
}

// Control Room tables: the public ones plus recovery bonus tips.
const ADMIN_TIERS = [...TIERS, { id: "recovery", label: "Recovery (bonus)" }];

function tierLabel(tierId) {
  return ADMIN_TIERS.find((tier) => tier.id === tierId)?.label || tierId;
}

/* ---------- Form state ---------- */

function updateFormLock() {
  const chosen = Boolean(fields.tier.value);
  matchFields.disabled = !chosen;
  tierHint.hidden = chosen;
}

function updateSubmitLabel() {
  if (editingId) {
    submitButton.textContent = "Save changes";
  } else if (slipMatches.length) {
    const count = slipMatches.length;
    submitButton.textContent = `Add ${count} match${count === 1 ? "" : "es"}`;
  } else {
    submitButton.textContent = "Add match";
  }
  submitButton.disabled = scanning;
}

function setPendingImage(src) {
  pendingImage = src;
  imagePreview.hidden = !src;
  if (src) {
    imagePreviewImg.src = src;
  } else {
    imagePreviewImg.removeAttribute("src");
  }
}

function resetForm({ keepTier = false } = {}) {
  const tier = fields.tier.value;
  editingId = null;
  form.reset();
  if (keepTier) {
    fields.tier.value = tier;
  }
  setPendingImage("");
  setSlipMatches([]);
  slipStatus.textContent = "";
  formTitle.textContent = "Add match";
  imageLabel.textContent = "SportyBet slip screenshot (reads the matches for you)";
  cancelButton.hidden = true;
  updateFormLock();
  updateSubmitLabel();
}

function startEdit(match) {
  resetForm();
  editingId = match.id;
  fields.tier.value = match.tier;
  fields.home.value = match.home;
  fields.away.value = match.away;
  fields.tip.value = match.tip;
  fields.odds.value = match.odds || "";
  setPendingImage(match.image || "");
  formTitle.textContent = "Edit match";
  imageLabel.textContent = "Picture (optional)";
  cancelButton.hidden = false;
  showMessage(formMessage, "");
  updateFormLock();
  updateSubmitLabel();
  showPanel("matches");
  form.scrollIntoView({ behavior: "smooth", block: "center" });
  fields.home.focus({ preventScroll: true });
}

/* ---------- Slip reading ---------- */

function loadTesseract() {
  if (!tesseractReady) {
    tesseractReady = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = TESSERACT_SRC;
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => {
        tesseractReady = null;
        script.remove();
        reject(new Error("Text reader failed to load"));
      };
      document.head.append(script);
    });
  }
  return tesseractReady;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable image"));
    };
    img.src = url;
  });
}

function drawScaled(img, scale) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function shrinkImage(file) {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.width, img.height));
  return drawScaled(img, scale).toDataURL("image/jpeg", 0.8);
}

// Grey, enlarged, dark-on-light text reads far better than a raw dark-mode screenshot.
async function prepareForReading(file) {
  const img = await loadImage(file);
  const scale = Math.min(2, Math.max(1, 1600 / img.width));
  const canvas = drawScaled(img, scale);
  const context = canvas.getContext("2d");
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const values = pixels.data;

  let total = 0;
  for (let i = 0; i < values.length; i += 4) {
    total += 0.299 * values[i] + 0.587 * values[i + 1] + 0.114 * values[i + 2];
  }
  const invert = total / (values.length / 4) < 128;

  for (let i = 0; i < values.length; i += 4) {
    let grey = 0.299 * values[i] + 0.587 * values[i + 1] + 0.114 * values[i + 2];
    if (invert) {
      grey = 255 - grey;
    }
    values[i] = values[i + 1] = values[i + 2] = grey;
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

async function readSlipText(file) {
  slipStatus.textContent = "Loading the text reader…";
  const Tesseract = await loadTesseract();
  const canvas = await prepareForReading(file);
  const worker = await Tesseract.createWorker("eng", 1, {
    logger: (progress) => {
      if (progress.status === "recognizing text") {
        slipStatus.textContent = `Reading the slip… ${Math.round(progress.progress * 100)}%`;
      }
    },
  });
  try {
    const result = await worker.recognize(canvas);
    return result.data.text;
  } finally {
    await worker.terminate();
  }
}

function slipInput(match, key, label, extra = {}) {
  const input = document.createElement("input");
  input.value = match[key];
  input.maxLength = 60;
  input.autocomplete = "off";
  input.setAttribute("aria-label", label);
  Object.assign(input, extra);
  input.addEventListener("input", () => {
    match[key] = input.value;
  });
  const td = document.createElement("td");
  td.append(input);
  return td;
}

function renderSlipRows() {
  slipBody.replaceChildren(
    ...slipMatches.map((match, index) => {
      const row = document.createElement("tr");
      const number = index + 1;
      row.append(
        slipInput(match, "home", `Home team, match ${number}`),
        slipInput(match, "away", `Away team, match ${number}`),
        slipInput(match, "tip", `Tip, match ${number}`, { placeholder: "Type tip, e.g. Draw", className: "tip-input" }),
        slipInput(match, "odds", `Odds, match ${number}`, { type: "number", step: "0.01", min: "1" }),
      );
      const removeCell = document.createElement("td");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "row-action danger";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove match ${number}`);
      remove.addEventListener("click", () => {
        setSlipMatches(slipMatches.filter((other) => other !== match));
      });
      removeCell.append(remove);
      row.append(removeCell);
      return row;
    }),
  );
  labelCells(slipBody.closest("table"));
}

function setSlipMatches(matches) {
  slipMatches = matches;
  slipResults.hidden = !matches.length;
  manualFields.hidden = matches.length > 0;
  slipTitle.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"} found`;
  renderSlipRows();
  updateSubmitLabel();
}

async function scanSlip(file) {
  scanning = true;
  updateSubmitLabel();
  setSlipMatches([]);
  setPendingImage("");
  try {
    const text = await readSlipText(file);
    const found = parseSlip(text);
    if (found.length) {
      setSlipMatches(found.map((match) => ({ ...match, tip: "", odds: formatOdds(match.odds) })));
      slipStatus.textContent = `Found ${found.length} match${found.length === 1 ? "" : "es"}. Type the tip for each one, then press Add.`;
      slipBody.querySelector(".tip-input")?.focus();
    } else {
      setPendingImage(await shrinkImage(file));
      slipStatus.textContent = "No matches could be read from this picture. Type the match in above and the picture will be attached to it.";
    }
  } catch {
    slipStatus.textContent = "Couldn't read this picture. Check your internet connection, or type the match in above.";
    fields.image.value = "";
  } finally {
    scanning = false;
    updateSubmitLabel();
  }
}

/* ---------- Tables ---------- */

function actionButton(text, onClick, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `row-action ${extraClass}`.trim();
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

// Copies each column heading onto its cells, so phones can show rows as labelled cards.
function labelCells(table) {
  const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
  for (const row of table.querySelectorAll("tbody tr")) {
    [...row.children].forEach((cell, index) => {
      cell.dataset.label = headers[index] || "";
    });
  }
  return table;
}

function textCell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function resultSelect(match) {
  const select = document.createElement("select");
  select.className = "result-select";
  select.setAttribute("aria-label", `Result for ${match.home} vs ${match.away}`);
  for (const [value, label] of [["pending", "Pending"], ["won", "Won"], ["lost", "Lost"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = match.result || "pending";
  select.addEventListener("change", async () => {
    try {
      await postJson("/api/admin/matches/result", { id: match.id, result: select.value });
      showMessage(formMessage, `Result saved for ${match.home} vs ${match.away}.`);
      render();
    } catch (error) {
      select.value = match.result || "pending";
      showMessage(formMessage, error.message, true);
    }
  });
  return select;
}

async function deleteMatch(match) {
  if (!window.confirm(`Delete ${match.home} vs ${match.away}?`)) {
    return;
  }
  try {
    await postJson("/api/admin/matches/delete", { id: match.id });
    if (editingId === match.id) {
      resetForm();
    }
    showMessage(formMessage, "Match deleted. It's gone from the front page too.");
    render();
  } catch (error) {
    showMessage(formMessage, error.message, true);
  }
}

function matchRow(match) {
  const row = document.createElement("tr");
  row.append(textCell(`${match.home} vs ${match.away}`), textCell(match.tip), textCell(match.odds || "–"));

  const pictureCell = document.createElement("td");
  if (match.image) {
    const thumb = document.createElement("img");
    thumb.className = "admin-thumb";
    thumb.src = match.image;
    thumb.alt = `Picture for ${match.home} vs ${match.away}`;
    pictureCell.append(thumb);
  } else {
    pictureCell.textContent = "–";
  }
  row.append(pictureCell);

  const resultCell = document.createElement("td");
  resultCell.append(resultSelect(match));
  row.append(resultCell);

  const actions = document.createElement("td");
  actions.className = "row-actions";
  actions.append(
    actionButton("Edit", () => startEdit(match)),
    actionButton("Delete", () => deleteMatch(match), "danger"),
  );
  row.append(actions);
  return row;
}

function tierSection(tier, matches) {
  const section = document.createElement("section");
  section.className = "control-section";

  const heading = document.createElement("div");
  heading.className = "tier-heading";
  const title = document.createElement("h2");
  title.textContent = `${tier.label} predictions`;
  heading.append(title);

  if (tier.id !== "free") {
    heading.append(totalOddsEditor(tier, matches));
  }
  if (dayCodes[tier.id]) {
    const codeText = document.createElement("p");
    codeText.className = "tier-total";
    codeText.textContent = `Booking code ${dayCodes[tier.id]}`;
    heading.append(codeText);
  }
  section.append(heading);

  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "No matches for this day.";
    section.append(empty);
    return section;
  }

  const table = document.createElement("table");
  table.className = tier.id === "free" ? "admin-table" : `admin-table ${tier.id}-table`;

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Match", "Tip", "Odds", "Picture", "Result", "Actions"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headRow.append(th);
  }
  head.append(headRow);

  const body = document.createElement("tbody");
  body.append(...matches.map(matchRow));
  table.append(head, body);
  labelCells(table);

  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.append(table);
  section.append(wrap);
  return section;
}

function renderStats() {
  for (const tier of TIERS) {
    document.querySelector(`#stat-${tier.id}`).textContent = serverMatches.filter((match) => match.tier === tier.id).length;
  }
}

let matchesRequest = 0;
let dayCodes = {};
let dayTotals = {};

function totalOddsEditor(tier, matches) {
  const form = document.createElement("form");
  form.className = "total-odds-form";
  form.noValidate = true;
  const label = document.createElement("label");
  label.append("Total odds");
  const input = document.createElement("input");
  input.type = "number";
  input.step = "0.01";
  input.min = "1";
  input.inputMode = "decimal";
  input.autocomplete = "off";
  input.setAttribute("aria-label", `${tier.label} total odds`);
  const calculated = totalOdds(matches);
  input.value = dayTotals[tier.id] || "";
  input.placeholder = calculated ? calculated.toFixed(2) : "e.g. 12.40";
  label.append(input);
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "row-action";
  button.textContent = "Save";
  form.append(label, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      const saved = await postJson("/api/admin/odds-total", {
        date: dateKey(selectedOffset),
        tier: tier.id,
        total: input.value,
      });
      dayTotals[tier.id] = saved.total;
      input.value = saved.total || "";
      showMessage(
        formMessage,
        saved.total
          ? `${tier.label} total odds saved.`
          : `${tier.label} total odds cleared. Buy Plan will multiply the match odds.`,
      );
    } catch (error) {
      showMessage(formMessage, error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  return form;
}

async function render() {
  const request = ++matchesRequest;
  const date = dateKey(selectedOffset);
  dateText.textContent = dateLabel(selectedOffset);
  loadBookingCode();
  try {
    const [body, codesBody] = await Promise.all([
      adminFetch(`/api/admin/matches?date=${date}`),
      adminFetch(`/api/admin/booking-code?date=${date}`),
    ]);
    // Ignore the answer if the day was switched while it was loading.
    if (request !== matchesRequest) {
      return;
    }
    serverMatches = body.matches;
    dayCodes = codesBody.codes || {};
    dayTotals = body.oddsTotals || {};
  } catch (error) {
    showMessage(formMessage, error.message, true);
    return;
  }
  tierSections.replaceChildren(
    ...ADMIN_TIERS.map((tier) => tierSection(tier, serverMatches.filter((match) => match.tier === tier.id))),
  );
  renderStats();
}

/* ---------- SportyBet booking code, saved with the match ---------- */

const bookingInput = document.querySelector("#b-code");
const BOOKING_CODE_PATTERN = /^[A-Za-z0-9]{4,20}$/;

async function loadBookingCode() {
  const tier = fields.tier.value;
  const date = dateKey(selectedOffset);
  if (!tier) {
    bookingInput.value = "";
    return;
  }
  try {
    const response = await fetch(`/api/admin/booking-code?date=${date}&tier=${tier}`);
    if (response.status === 401) {
      showMessage(formMessage, "Your admin sign-in has expired. Sign out and sign in again.", true);
      return;
    }
    const body = await response.json();
    if (date === dateKey(selectedOffset) && tier === fields.tier.value) {
      bookingInput.value = body.code || "";
    }
  } catch {
    showMessage(formMessage, "Couldn't load the booking code. Check your connection.", true);
  }
}

// A typed code is stored for this table and day. A blank field leaves the saved code alone.
async function saveBookingCode(tier) {
  const code = bookingInput.value.trim();
  if (!code) {
    return "";
  }
  if (!BOOKING_CODE_PATTERN.test(code)) {
    throw new Error("Booking codes are 4 to 20 letters and numbers.");
  }
  const response = await fetch("/api/admin/booking-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: dateKey(selectedOffset), tier, code }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    throw new Error("Your admin sign-in has expired. Sign out and sign in again.");
  }
  if (!response.ok) {
    throw new Error(body.error || "Couldn't save the booking code.");
  }
  return body.code || "";
}

/* ---------- Saving ---------- */

async function addSlipMatches(tier) {
  const incomplete = slipMatches.findIndex((match) => !match.home.trim() || !match.away.trim() || !match.tip.trim());
  if (incomplete !== -1) {
    showMessage(formMessage, `Row ${incomplete + 1} is missing a team or the tip. Fill it in or remove the row.`, true);
    slipBody.rows[incomplete].querySelector("input:placeholder-shown")?.focus();
    return false;
  }

  const matches = slipMatches.map((match) => ({
    tier,
    home: match.home.trim(),
    away: match.away.trim(),
    tip: match.tip.trim(),
    odds: formatOdds(match.odds),
  }));
  try {
    const code = await saveBookingCode(tier);
    await postJson("/api/admin/matches", { date: dateKey(selectedOffset), matches });
    const count = matches.length;
    const withCode = code ? ` with booking code ${code}` : "";
    showMessage(formMessage, `Added ${count} match${count === 1 ? "" : "es"} to ${tierLabel(tier)}${withCode}. They're now on the front page.`);
  } catch (error) {
    showMessage(formMessage, error.message, true);
    return false;
  }
  return true;
}

async function saveSingleMatch(tier) {
  const values = {
    tier,
    home: fields.home.value.trim(),
    away: fields.away.value.trim(),
    tip: fields.tip.value.trim(),
    odds: formatOdds(fields.odds.value),
    image: pendingImage,
  };
  if (!values.home || !values.away || !values.tip) {
    showMessage(formMessage, "Fill in both teams and the tip, or upload a SportyBet slip.", true);
    return false;
  }

  try {
    const code = await saveBookingCode(tier);
    const withCode = code ? ` with booking code ${code}` : "";
    if (editingId) {
      await postJson("/api/admin/matches/update", { id: editingId, ...values });
      showMessage(formMessage, `Updated ${values.home} vs ${values.away}${withCode}.`);
    } else {
      await postJson("/api/admin/matches", { date: dateKey(selectedOffset), ...values });
      showMessage(formMessage, `Added ${values.home} vs ${values.away} to ${tierLabel(tier)}${withCode}. It's now on the front page.`);
    }
  } catch (error) {
    showMessage(formMessage, error.message, true);
    return false;
  }
  return true;
}

/* ---------- Members ---------- */

const memberMessage = document.querySelector("#member-message");
const memberList = document.querySelector("#member-list");
const memberQuery = document.querySelector("#member-query");
let loadedMembers = [];
let membersLoaded = false;

function memberSearchText(member) {
  const payments = (member.payments || []).map((payment) => `${payment.plan} ${payment.currency} ${payment.amount}`);
  return [member.name, member.email, member.plan, ...payments].join(" ").toLowerCase();
}

function membersMatching(query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return loadedMembers;
  }
  return loadedMembers.filter((member) => {
    const text = memberSearchText(member);
    return words.every((word) => text.includes(word));
  });
}

function showMembers() {
  const query = memberQuery.value;
  const shown = membersMatching(query);
  const empty = query.trim() ? "No members match that search." : "No accounts yet.";
  memberList.replaceChildren(
    simpleTable(["Name", "Email", "Plan", "Amount paid", "Joined", "Last visit"], shown.map(memberRow), empty, "members-table"),
  );
}

function simpleTable(headers, rows, emptyText, className = "admin-table") {
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = emptyText;
    return empty;
  }
  const table = document.createElement("table");
  table.className = className;
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of headers) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  body.append(...rows);
  table.append(head, body);
  labelCells(table);
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.append(table);
  return wrap;
}

// "Oct 4, 2026"; today and yesterday read as words.
function visitLabel(iso) {
  if (!iso) {
    return "–";
  }
  const when = new Date(iso);
  const day = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
  if (day === dateKey(0)) {
    return "Today";
  }
  if (day === dateKey(-1)) {
    return "Yesterday";
  }
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function planCell(plan) {
  const cell = document.createElement("td");
  const pill = document.createElement("span");
  pill.className = `plan-pill plan-${plan}`;
  pill.textContent = tierLabel(plan);
  cell.append(pill);
  return cell;
}

function amountCell(member) {
  const cell = document.createElement("td");
  const payments = member.payments || [];
  if (!payments.length) {
    cell.textContent = "–";
    return cell;
  }
  for (const payment of payments) {
    const line = document.createElement("span");
    line.className = "paid-amount";
    line.textContent = `${String(payment.plan).toUpperCase()} ${payment.currency} ${Number(payment.amount).toFixed(2)}`;
    cell.append(line);
  }
  return cell;
}

function memberRow(member) {
  const row = document.createElement("tr");
  row.append(
    textCell(member.name || "–"),
    textCell(member.email),
    planCell(member.plan),
    amountCell(member),
    textCell(visitLabel(member.joinedAt)),
    // Accounts that haven't been back since signing up count their sign-up as the visit.
    textCell(visitLabel(member.lastSeenAt || member.joinedAt)),
  );
  return row;
}

// Registered accounts, members on a plan today, and the list of accounts (server).
async function loadMembers() {
  try {
    const { totals, members } = await adminFetch("/api/admin/members");
    document.querySelector("#ov-members").textContent = totals.users;
    document.querySelector("#ov-members-detail").textContent = totals.users
      ? `Active today: VIP ${totals.vip} · VVIP ${totals.vvip}`
      : "No accounts yet";
    loadedMembers = members;
    membersLoaded = true;
    showMembers();
  } catch (error) {
    showMessage(memberMessage, error.message, true);
  }
}

document.querySelector("#member-search").addEventListener("submit", (event) => {
  event.preventDefault();
});

memberQuery.addEventListener("input", () => {
  if (membersLoaded) {
    showMembers();
  }
});

/* ---------- Payment gateway (stored on the server) ---------- */

const GATEWAY_METHODS = {
  momo: ["network", "number", "name"],
  ghBank: ["bank", "number", "name"],
  ngBank: ["bank", "number", "name"],
  usdt: ["network", "number", "name"],
};
const ratesForm = document.querySelector("#rates-form");
const ratesMessage = document.querySelector("#rates-message");
const checkoutForm = document.querySelector("#checkout-form");
const checkoutMessage = document.querySelector("#checkout-message");
const rateInputs = document.querySelectorAll("[data-rate]");
let savedRates = {};

async function adminFetch(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    throw new Error("Your admin sign-in has expired. Sign out and sign in again.");
  }
  if (!response.ok) {
    throw new Error(body.error || "Something went wrong. Please try again.");
  }
  return body;
}

function postJson(url, payload) {
  return adminFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

function accountRow(methodId, account = {}) {
  const container = document.querySelector(`[data-method-rows="${methodId}"]`);
  const placeholders = container.dataset.placeholders.split("|");
  const row = document.createElement("div");
  row.className = "account-row";
  GATEWAY_METHODS[methodId].forEach((field, index) => {
    const input = document.createElement("input");
    input.dataset.field = field;
    input.maxLength = 60;
    input.autocomplete = "off";
    input.placeholder = placeholders[index];
    input.setAttribute("aria-label", placeholders[index]);
    input.value = account[field] || "";
    row.append(input);
  });
  // The first row always stays; extra rows can be removed.
  if (container.children.length) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "round-button remove-row";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove this account");
    remove.addEventListener("click", () => row.remove());
    row.append(remove);
  }
  container.append(row);
  return row;
}

function fillGateway({ checkout, rates }) {
  document.querySelector("#c-business").value = checkout.businessName;
  document.querySelector("#c-whatsapp").value = checkout.whatsapp;
  document.querySelector("#c-email").value = checkout.email;
  for (const methodId of Object.keys(GATEWAY_METHODS)) {
    const method = checkout.methods[methodId];
    document.querySelector(`[data-method-toggle="${methodId}"]`).checked = method.enabled;
    document.querySelector(`[data-method-rows="${methodId}"]`).replaceChildren();
    const accounts = method.accounts.length ? method.accounts : [{}];
    accounts.forEach((account) => accountRow(methodId, account));
  }
  savedRates = rates;
  for (const input of rateInputs) {
    input.value = rates[input.dataset.rate] ?? "";
  }
}

function readCheckout() {
  const methods = {};
  for (const methodId of Object.keys(GATEWAY_METHODS)) {
    const rows = document.querySelectorAll(`[data-method-rows="${methodId}"] .account-row`);
    methods[methodId] = {
      enabled: document.querySelector(`[data-method-toggle="${methodId}"]`).checked,
      accounts: [...rows].map((row) =>
        Object.fromEntries([...row.querySelectorAll("input")].map((input) => [input.dataset.field, input.value])),
      ),
    };
  }
  return {
    businessName: document.querySelector("#c-business").value,
    whatsapp: document.querySelector("#c-whatsapp").value,
    email: document.querySelector("#c-email").value,
    methods,
  };
}

async function loadGateway() {
  try {
    fillGateway(await adminFetch("/api/admin/gateway"));
    showMessage(checkoutMessage, "");
    showMessage(ratesMessage, "");
  } catch (error) {
    showMessage(checkoutMessage, error.message, true);
  }
}

for (const button of document.querySelectorAll("[data-method-add]")) {
  button.addEventListener("click", () => {
    const methodId = button.dataset.methodAdd;
    const container = document.querySelector(`[data-method-rows="${methodId}"]`);
    if (container.children.length >= 5) {
      showMessage(checkoutMessage, "You can add up to 5 accounts per method.", true);
      return;
    }
    accountRow(methodId).querySelector("input").focus();
  });
}

for (const button of document.querySelectorAll("[data-reset]")) {
  button.addEventListener("click", () => {
    const id = button.dataset.reset;
    document.querySelector(`#rate-${id}`).value = savedRates[id] ?? "";
  });
}

ratesForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries([...rateInputs].map((input) => [input.dataset.rate, input.value]));
  try {
    const { rates } = await postJson("/api/admin/gateway/rates", payload);
    savedRates = rates;
    showMessage(ratesMessage, "Exchange rates saved.");
  } catch (error) {
    showMessage(ratesMessage, error.message, true);
  }
});

checkoutForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { checkout } = await postJson("/api/admin/gateway/checkout", readCheckout());
    fillGateway({ checkout, rates: savedRates });
    showMessage(checkoutMessage, "Checkout settings saved. Visitors see switched-on methods when they press BUY PLAN.");
  } catch (error) {
    showMessage(checkoutMessage, error.message, true);
  }
});

document.querySelector("#gateway-refresh").addEventListener("click", loadGateway);

/* ---------- Testimonials (stored on the server) ---------- */

const testimonialForm = document.querySelector("#testimonial-form");
const testimonialStatus = document.querySelector("#testimonial-message-status");
const testimonialList = document.querySelector("#testimonial-list");

async function testimonialAction(url, id, doneText) {
  try {
    await postJson(url, { id });
    showMessage(testimonialStatus, doneText);
    loadTestimonials();
  } catch (error) {
    showMessage(testimonialStatus, error.message, true);
  }
}

function testimonialRow(item) {
  const row = document.createElement("tr");
  const actions = document.createElement("td");
  actions.className = "row-actions";
  if (item.status === "pending") {
    actions.append(
      actionButton("Accept", () => testimonialAction("/api/admin/testimonials/approve", item.id, `Accepted. ${item.name}'s review is now on the website.`), "accept"),
      actionButton("Reject", () => {
        if (window.confirm(`Reject and delete the review from ${item.name}?`)) {
          testimonialAction("/api/admin/testimonials/delete", item.id, "Review rejected.");
        }
      }, "danger"),
    );
  } else {
    actions.append(
      actionButton("Delete", () => {
        if (window.confirm(`Remove ${item.name}'s review from the website?`)) {
          testimonialAction("/api/admin/testimonials/delete", item.id, "Review removed from the website.");
        }
      }, "danger"),
    );
  }
  row.append(
    textCell(item.name),
    textCell(item.location || "–"),
    textCell("★".repeat(item.rating) + "☆".repeat(5 - item.rating)),
    textCell(item.message),
    actions,
  );
  return row;
}

async function loadTestimonials() {
  try {
    const { testimonials } = await adminFetch("/api/admin/testimonials");
    const pending = testimonials.filter((item) => item.status === "pending");
    const approved = testimonials.filter((item) => item.status !== "pending");
    const headers = ["Name", "Location", "Rating", "Message", ""];
    document.querySelector("#pending-list").replaceChildren(
      simpleTable(headers, pending.map(testimonialRow), "No reviews waiting. New ones from members appear here."),
    );
    testimonialList.replaceChildren(simpleTable(headers, approved.map(testimonialRow), "No reviews on the website yet."));
    const badge = document.querySelector("#pending-count");
    badge.hidden = !pending.length;
    badge.textContent = `${pending.length} waiting`;
  } catch (error) {
    showMessage(testimonialStatus, error.message, true);
  }
}

testimonialForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await postJson("/api/admin/testimonials", {
      name: document.querySelector("#t-name").value,
      location: document.querySelector("#t-location").value,
      rating: Number(document.querySelector("#t-rating").value),
      message: document.querySelector("#t-message").value,
    });
    testimonialForm.reset();
    showMessage(testimonialStatus, "Testimonial added. It now rotates under the VVIP table.");
    loadTestimonials();
  } catch (error) {
    showMessage(testimonialStatus, error.message, true);
  }
});

/* ---------- One-time move of browser-only matches to the server ---------- */

const migrateBanner = document.querySelector("#migrate-banner");
const migrateText = document.querySelector("#migrate-text");
const migrateButton = document.querySelector("#migrate-button");

function showMigrateBanner() {
  const count = data.matches.length;
  migrateBanner.hidden = !count;
  migrateText.textContent = `You have ${count} match${count === 1 ? "" : "es"} saved only in this browser from before. Visitors can't see them until they're published.`;
}

migrateButton.addEventListener("click", async () => {
  migrateButton.disabled = true;
  const byDate = new Map();
  for (const match of data.matches) {
    if (!byDate.has(match.date)) {
      byDate.set(match.date, []);
    }
    byDate.get(match.date).push({
      tier: match.tier,
      home: match.home,
      away: match.away,
      tip: match.tip,
      odds: match.odds,
      image: match.image || "",
    });
  }
  try {
    for (const [date, matches] of byDate) {
      for (let start = 0; start < matches.length; start += 50) {
        await postJson("/api/admin/matches", { date, matches: matches.slice(start, start + 50) });
      }
    }
    data.matches = [];
    persist(formMessage, "All saved matches are now published on the website.");
    showMigrateBanner();
    render();
  } catch (error) {
    migrateText.textContent = `Couldn't publish: ${error.message}`;
  } finally {
    migrateButton.disabled = false;
  }
});

/* ---------- App navigation (one section at a time, no page scroll) ---------- */

const navLinks = document.querySelectorAll(".app-nav-link");
const panels = ["today", "matches", "reviews", "members", "gateway"];
const dayBar = document.querySelector("#today");
const controlStage = document.querySelector(".control-stage");

function setActiveNav(id) {
  for (const link of navLinks) {
    const active = link.hash === `#${id}`;
    link.classList.toggle("is-active", active);
    if (active) {
      link.setAttribute("aria-current", "location");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

function showPanel(id) {
  const panel = panels.includes(id) ? id : "today";
  for (const el of document.querySelectorAll(".control-panel")) {
    el.hidden = el.dataset.panel !== panel;
  }
  dayBar.hidden = panel !== "today" && panel !== "matches";
  setActiveNav(panel);
  controlStage.scrollTop = 0;
  if (location.hash !== `#${panel}`) {
    history.replaceState(null, "", `#${panel}`);
  }
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[href^='#']");
  if (!link) {
    return;
  }
  const id = link.getAttribute("href").slice(1);
  if (!panels.includes(id)) {
    return;
  }
  event.preventDefault();
  showPanel(id);
});

showPanel(location.hash.slice(1));

/* ---------- Events ---------- */

for (const button of dayButtons) {
  button.addEventListener("click", () => {
    for (const other of dayButtons) {
      other.setAttribute("aria-pressed", String(other === button));
    }
    selectedOffset = Number(button.dataset.day);
    resetForm({ keepTier: true });
    showMessage(formMessage, "");
    render();
  });
}

fields.tier.addEventListener("change", () => {
  updateFormLock();
  showMessage(formMessage, "");
  loadBookingCode();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const tier = fields.tier.value;
  if (!tier) {
    showMessage(formMessage, "Choose a table first.", true);
    fields.tier.focus();
    return;
  }
  if (scanning) {
    return;
  }

  submitButton.disabled = true;
  const saved = await (!editingId && slipMatches.length ? addSlipMatches(tier) : saveSingleMatch(tier));
  submitButton.disabled = false;
  if (!saved) {
    return;
  }
  // Stay on the same table so more matches can be added straight away.
  resetForm({ keepTier: true });
  render();
});

fields.image.addEventListener("change", async () => {
  const file = fields.image.files[0];
  if (!file) {
    return;
  }
  if (!file.type.startsWith("image/")) {
    showMessage(formMessage, "That file isn't a picture.", true);
    fields.image.value = "";
    return;
  }
  showMessage(formMessage, "");

  if (editingId) {
    try {
      setPendingImage(await shrinkImage(file));
    } catch {
      showMessage(formMessage, "Couldn't read that picture. Try another one.", true);
      fields.image.value = "";
    }
    return;
  }
  scanSlip(file);
});

imageRemove.addEventListener("click", () => {
  fields.image.value = "";
  setPendingImage("");
  slipStatus.textContent = "";
});

slipClear.addEventListener("click", () => {
  fields.image.value = "";
  setSlipMatches([]);
  slipStatus.textContent = "";
});

cancelButton.addEventListener("click", () => {
  resetForm({ keepTier: true });
  showMessage(formMessage, "");
});


document.querySelector("#control-sign-out").addEventListener("click", async () => {
  try {
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
  } catch {
    // Nothing stored to clear.
  }
  try {
    await fetch("/api/admin/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } finally {
    location.replace("admin.html");
  }
});

const planPricesForm = document.querySelector("#plan-prices-form");
const planPricesMessage = document.querySelector("#plan-prices-message");

async function loadPlanPrices() {
  const { currency, plans } = await adminFetch("/api/admin/plans");
  document.querySelector("#price-currency").textContent = currency;
  document.querySelector("#price-vip").value = plans.vip;
  document.querySelector("#price-vvip").value = plans.vvip;
}

planPricesForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  planPricesMessage.textContent = "";
  try {
    const { plans } = await postJson("/api/admin/plans", {
      vip: document.querySelector("#price-vip").value,
      vvip: document.querySelector("#price-vvip").value,
    });
    document.querySelector("#price-vip").value = plans.vip;
    document.querySelector("#price-vvip").value = plans.vvip;
    showMessage(planPricesMessage, "Prices saved. Buy Plan now shows these amounts.");
  } catch (error) {
    showMessage(planPricesMessage, error.message, true);
  }
});

resetForm();
render();
loadMembers();
loadGateway();
loadPlanPrices().catch((error) => showMessage(planPricesMessage, error.message, true));

const planSlotsForm = document.querySelector("#plan-slots-form");
const planSlotsMessage = document.querySelector("#plan-slots-message");

function slotSummary(view) {
  const line = (tier, name) => {
    if (view.caps[tier] == null) {
      return `${name} is not shown yet`;
    }
    const left = view.available[tier];
    const places = left === 1 ? "1 place" : `${left} places`;
    return `${name} members see ${places} left`;
  };
  return `${line("vip", "VIP")}. ${line("vvip", "VVIP")}.`;
}

async function loadPlanSlots() {
  const view = await adminFetch("/api/admin/slots");
  document.querySelector("#slot-vip").value = view.caps.vip ?? "";
  document.querySelector("#slot-vvip").value = view.caps.vvip ?? "";
  planSlotsMessage.textContent = slotSummary(view);
}

planSlotsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  planSlotsMessage.textContent = "";
  try {
    const view = await postJson("/api/admin/slots", {
      vip: document.querySelector("#slot-vip").value,
      vvip: document.querySelector("#slot-vvip").value,
    });
    document.querySelector("#slot-vip").value = view.caps.vip;
    document.querySelector("#slot-vvip").value = view.caps.vvip;
    showMessage(planSlotsMessage, `Slots saved. ${slotSummary(view)}`);
  } catch (error) {
    showMessage(planSlotsMessage, error.message, true);
  }
});

loadPlanSlots().catch((error) => showMessage(planSlotsMessage, error.message, true));
loadTestimonials();
showMigrateBanner();

function manualPaymentRow(payment) {
  const row = document.createElement("tr");
  const actions = document.createElement("td");
  actions.className = "row-actions";
  const receipt = document.createElement("a");
  receipt.className = "row-action";
  receipt.href = `/api/admin/manual-payments/${payment.id}/receipt`;
  receipt.target = "_blank";
  receipt.rel = "noopener";
  receipt.textContent = "Receipt";
  actions.append(receipt);
  if (payment.status === "pending") {
    actions.append(
      actionButton("Approve", () => decidePayment(payment, "approve")),
      actionButton("Reject", () => decidePayment(payment, "reject"), "danger"),
    );
  } else {
    const status = document.createElement("span");
    status.className = "payment-status";
    status.dataset.status = payment.status;
    status.textContent = payment.status === "confirmed" ? "Approved" : "Rejected";
    actions.append(status);
  }
  row.append(
    textCell(payment.name || "—"),
    textCell(payment.email),
    textCell(String(payment.plan).toUpperCase()),
    textCell(`${payment.currency} ${Number(payment.amount).toFixed(2)}`),
    actions,
  );
  return row;
}

function emptyManualRow(text) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 5;
  cell.textContent = text;
  row.append(cell);
  return row;
}

async function loadManualPayments() {
  const body = document.querySelector("#payment-table-body");
  const message = document.querySelector("#manual-payment-message");
  if (!body) {
    return;
  }
  try {
    const { payments } = await adminFetch("/api/admin/manual-payments");
    const waiting = payments.filter((payment) => payment.status !== "confirmed");
    body.replaceChildren(...(waiting.length ? waiting.map(manualPaymentRow) : [emptyManualRow("No payments waiting.")]));
    labelCells(body.closest("table"));
    for (const cell of body.querySelectorAll("td[colspan]")) {
      cell.dataset.label = "";
    }
  } catch (error) {
    body.replaceChildren(emptyManualRow("Couldn't load payments."));
    showMessage(message, error.message, true);
  }
}

async function decidePayment(payment, decision) {
  const message = document.querySelector("#manual-payment-message");
  const approving = decision === "approve";
  const plan = String(payment.plan).toUpperCase();
  const question = approving
    ? `Approve the ${plan} payment from ${payment.email}? Their plan will become active.`
    : `Reject the ${plan} payment from ${payment.email}? Their plan will not change.`;
  if (!window.confirm(question)) {
    return;
  }
  try {
    await postJson(`/api/admin/manual-payments/${payment.id}/${approving ? "confirm" : "reject"}`, {});
    showMessage(
      message,
      approving
        ? `Approved ${payment.email}. Their ${plan} plan is now active.`
        : `Rejected the payment from ${payment.email}.`,
    );
    await loadManualPayments();
    if (approving) {
      await loadMembers();
    }
  } catch (error) {
    showMessage(message, error.message, true);
  }
}

loadManualPayments();
