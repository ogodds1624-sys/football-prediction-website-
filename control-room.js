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

const settingsForm = document.querySelector("#settings-form");
const settingsMessage = document.querySelector("#settings-message");

const currencyInput = document.querySelector("#s-currency");

let data = loadData() || { matches: [], members: [], payments: [], settings: { whatsapp: "", currency: "GH₵" } };
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

function tierLabel(tierId) {
  return TIERS.find((tier) => tier.id === tierId).label;
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
  select.addEventListener("change", () => {
    match.result = select.value;
    persist(formMessage, `Result saved for ${match.home} vs ${match.away}.`);
    renderStats();
  });
  return select;
}

function deleteMatch(match) {
  if (!window.confirm(`Delete ${match.home} vs ${match.away}?`)) {
    return;
  }
  data.matches = data.matches.filter((other) => other.id !== match.id);
  if (editingId === match.id) {
    resetForm();
  }
  persist(formMessage, "Match deleted.");
  render();
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

  const total = totalOdds(matches);
  if (tier.id !== "free" && total) {
    const totalText = document.createElement("p");
    totalText.className = "tier-total";
    totalText.textContent = `Total odds ${total.toFixed(2)}`;
    heading.append(totalText);
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

  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.append(table);
  section.append(wrap);
  return section;
}

function renderStats() {
  const date = dateKey(selectedOffset);
  for (const tier of TIERS) {
    document.querySelector(`#stat-${tier.id}`).textContent = matchesFor(data, date, tier.id).length;
  }
  const won = data.matches.filter((match) => match.result === "won").length;
  const lost = data.matches.filter((match) => match.result === "lost").length;
  document.querySelector("#stat-rate").textContent = won + lost ? `${Math.round((won / (won + lost)) * 100)}%` : "–";
}

function render() {
  const date = dateKey(selectedOffset);
  dateText.textContent = dateLabel(selectedOffset);
  tierSections.replaceChildren(...TIERS.map((tier) => tierSection(tier, matchesFor(data, date, tier.id))));
  renderStats();
  loadBookingCode();
}

/* ---------- SportyBet booking code (stored on the server) ---------- */

const bookingForm = document.querySelector("#booking-form");
const bookingInput = document.querySelector("#b-code");
const bookingMessage = document.querySelector("#booking-message");

function adminSessionEnded() {
  showMessage(bookingMessage, "Your admin sign-in has expired. Sign out and sign in again to manage booking codes.", true);
}

async function loadBookingCode() {
  const date = dateKey(selectedOffset);
  bookingInput.value = "";
  showMessage(bookingMessage, "");
  try {
    const response = await fetch(`/api/admin/booking-code?date=${date}`);
    if (response.status === 401) {
      adminSessionEnded();
      return;
    }
    const body = await response.json();
    // Ignore the answer if the admin switched day while it was loading.
    if (date === dateKey(selectedOffset)) {
      bookingInput.value = body.code || "";
    }
  } catch {
    showMessage(bookingMessage, "Couldn't load the booking code. Check your connection.", true);
  }
}

async function saveBookingCode(code) {
  const date = dateKey(selectedOffset);
  try {
    const response = await fetch("/api/admin/booking-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, code }),
    });
    if (response.status === 401) {
      adminSessionEnded();
      return;
    }
    const body = await response.json();
    if (!response.ok) {
      showMessage(bookingMessage, body.error || "Couldn't save the code.", true);
      return;
    }
    bookingInput.value = body.code || "";
    showMessage(bookingMessage, body.code ? `Saved ${body.code} for ${dateLabel(selectedOffset)}.` : "Booking code removed.");
  } catch {
    showMessage(bookingMessage, "Couldn't reach the server. Try again.", true);
  }
}

bookingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = bookingInput.value.trim();
  if (!code) {
    showMessage(bookingMessage, "Type the booking code first.", true);
    return;
  }
  saveBookingCode(code);
});

document.querySelector("#b-clear").addEventListener("click", () => {
  if (window.confirm(`Remove the booking code for ${dateLabel(selectedOffset)}?`)) {
    saveBookingCode("");
  }
});

/* ---------- Saving ---------- */

function addSlipMatches(tier) {
  const incomplete = slipMatches.findIndex((match) => !match.home.trim() || !match.away.trim() || !match.tip.trim());
  if (incomplete !== -1) {
    showMessage(formMessage, `Row ${incomplete + 1} is missing a team or the tip. Fill it in or remove the row.`, true);
    slipBody.rows[incomplete].querySelector("input:placeholder-shown")?.focus();
    return false;
  }

  const date = dateKey(selectedOffset);
  const added = slipMatches.map((match) => ({
    id: newId(),
    date,
    tier,
    result: "pending",
    home: match.home.trim(),
    away: match.away.trim(),
    tip: match.tip.trim(),
    odds: formatOdds(match.odds),
    image: "",
  }));
  data.matches.push(...added);
  const count = added.length;
  if (!persist(formMessage, `Added ${count} match${count === 1 ? "" : "es"} to ${tierLabel(tier)}. They're now on the front page.`)) {
    data.matches.splice(-count, count);
    return false;
  }
  return true;
}

function saveSingleMatch(tier) {
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

  const editedMatch = editingId && data.matches.find((match) => match.id === editingId);
  if (editedMatch) {
    const previous = { ...editedMatch };
    Object.assign(editedMatch, values);
    if (!persist(formMessage, `Updated ${values.home} vs ${values.away}.`)) {
      Object.assign(editedMatch, previous);
      return false;
    }
    return true;
  }

  data.matches.push({ id: newId(), date: dateKey(selectedOffset), result: "pending", ...values });
  if (!persist(formMessage, `Added ${values.home} vs ${values.away} to ${tierLabel(tier)}. It's now on the front page.`)) {
    data.matches.pop();
    return false;
  }
  return true;
}

/* ---------- Members and payments ---------- */

const memberForm = document.querySelector("#member-form");
const memberMessage = document.querySelector("#member-message");
const memberList = document.querySelector("#member-list");
const memberNames = document.querySelector("#member-names");
const paymentForm = document.querySelector("#payment-form");
const paymentMessage = document.querySelector("#payment-message");
const paymentList = document.querySelector("#payment-list");

function money(amount) {
  return `${data.settings.currency} ${Number(amount).toFixed(2)}`;
}

function isActive(member) {
  return !member.expires || member.expires >= dateKey(0);
}

function simpleTable(headers, rows, emptyText) {
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = emptyText;
    return empty;
  }
  const table = document.createElement("table");
  table.className = "admin-table";
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
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.append(table);
  return wrap;
}

function removeRecord(listName, record, label, messageEl) {
  if (!window.confirm(`Remove ${label}?`)) {
    return;
  }
  data[listName] = data[listName].filter((other) => other.id !== record.id);
  persist(messageEl, `Removed ${label}.`);
  renderPeople();
}

function memberRow(member) {
  const row = document.createElement("tr");
  const status = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `status-badge ${isActive(member) ? "active" : "expired"}`;
  badge.textContent = isActive(member) ? "Active" : "Expired";
  status.append(badge);

  const actions = document.createElement("td");
  actions.append(actionButton("Remove", () => removeRecord("members", member, member.name, memberMessage), "danger"));

  row.append(
    textCell(member.name),
    textCell(member.phone || "–"),
    textCell(tierLabel(member.plan)),
    textCell(member.expires || "–"),
    status,
    actions,
  );
  return row;
}

function paymentRow(payment) {
  const row = document.createElement("tr");
  const actions = document.createElement("td");
  actions.append(actionButton("Remove", () => removeRecord("payments", payment, `the payment from ${payment.name}`, paymentMessage), "danger"));
  row.append(
    textCell(payment.date),
    textCell(payment.name),
    textCell(tierLabel(payment.plan)),
    textCell(payment.method),
    textCell(money(payment.amount)),
    actions,
  );
  return row;
}

function renderOverview() {
  const active = data.members.filter(isActive);
  const vip = active.filter((member) => member.plan === "vip").length;
  const vvip = active.filter((member) => member.plan === "vvip").length;
  document.querySelector("#ov-members").textContent = data.members.length;
  document.querySelector("#ov-members-detail").textContent = data.members.length
    ? `${active.length} active · VIP ${vip} · VVIP ${vvip}`
    : "No members yet";

  const total = data.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const monthPrefix = dateKey(0).slice(0, 7);
  const thisMonth = data.payments
    .filter((payment) => payment.date.startsWith(monthPrefix))
    .reduce((sum, payment) => sum + Number(payment.amount), 0);
  document.querySelector("#ov-revenue").textContent = money(total);
  document.querySelector("#ov-revenue-detail").textContent = data.payments.length
    ? `${data.payments.length} payment${data.payments.length === 1 ? "" : "s"} · ${money(thisMonth)} this month`
    : "No payments recorded";
}

function renderPeople() {
  const members = [...data.members].sort((a, b) => a.name.localeCompare(b.name));
  memberList.replaceChildren(
    simpleTable(["Name", "Phone", "Plan", "Plan ends", "Status", ""], members.map(memberRow), "No members added yet."),
  );

  const payments = [...data.payments].sort((a, b) => b.date.localeCompare(a.date));
  paymentList.replaceChildren(
    simpleTable(["Date", "Member", "Plan", "Method", "Amount", ""], payments.map(paymentRow), "No payments recorded yet."),
  );

  memberNames.replaceChildren(
    ...members.map((member) => {
      const option = document.createElement("option");
      option.value = member.name;
      return option;
    }),
  );
  renderOverview();
}

memberForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const member = {
    id: newId(),
    name: document.querySelector("#m-name").value.trim(),
    phone: document.querySelector("#m-phone").value.trim(),
    plan: document.querySelector("#m-plan").value,
    expires: document.querySelector("#m-expires").value,
    joined: dateKey(0),
  };
  if (!member.name) {
    showMessage(memberMessage, "Enter the member's name.", true);
    return;
  }
  data.members.push(member);
  if (!persist(memberMessage, `Added ${member.name}.`)) {
    data.members.pop();
    return;
  }
  memberForm.reset();
  renderPeople();
});

paymentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const payment = {
    id: newId(),
    name: document.querySelector("#p-name").value.trim(),
    plan: document.querySelector("#p-plan").value,
    amount: Number(document.querySelector("#p-amount").value),
    method: document.querySelector("#p-method").value,
    date: dateKey(0),
  };
  if (!payment.name || !(payment.amount > 0)) {
    showMessage(paymentMessage, "Enter the member's name and an amount.", true);
    return;
  }
  data.payments.push(payment);
  if (!persist(paymentMessage, `Recorded ${money(payment.amount)} from ${payment.name}.`)) {
    data.payments.pop();
    return;
  }
  paymentForm.reset();
  renderPeople();
});

/* ---------- Payment gateway (stored on the server) ---------- */

const GATEWAY_METHODS = {
  momo: ["network", "number", "name"],
  ghBank: ["bank", "number", "name"],
  ngBank: ["bank", "number", "name"],
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
});

form.addEventListener("submit", (event) => {
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

  const saved = !editingId && slipMatches.length ? addSlipMatches(tier) : saveSingleMatch(tier);
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

settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  data.settings.currency = currencyInput.value.trim() || "GH₵";
  currencyInput.value = data.settings.currency;
  persist(settingsMessage, "Settings saved.");
  renderPeople();
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

currencyInput.value = data.settings.currency;
resetForm();
render();
renderPeople();
loadGateway();
loadTestimonials();
