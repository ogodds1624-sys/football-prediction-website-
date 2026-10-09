// Shared by the front page and the control room.
const DATA_KEY = "predictions-data";

const TIERS = [
  { id: "free", label: "Free" },
  { id: "vip", label: "VIP" },
  { id: "boom", label: "Wake up to boom games" },
  { id: "vvip", label: "VVIP" },
];

function dateKey(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dateLabel(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// Returns null when the admin has never saved anything.
function loadData() {
  try {
    const raw = localStorage.getItem(DATA_KEY);
    if (!raw) {
      return null;
    }
    const data = JSON.parse(raw);
    return {
      matches: Array.isArray(data.matches) ? data.matches : [],
      members: Array.isArray(data.members) ? data.members : [],
      payments: Array.isArray(data.payments) ? data.payments : [],
      settings: { whatsapp: "", currency: "GH₵", ...data.settings },
    };
  } catch {
    return null;
  }
}

function saveData(data) {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

function matchesFor(data, date, tier) {
  return data.matches.filter((match) => match.date === date && match.tier === tier);
}

function totalOdds(matches) {
  const odds = matches.map((match) => Number(match.odds)).filter((value) => value > 0);
  if (!odds.length) {
    return null;
  }
  return odds.reduce((product, value) => product * value, 1);
}

function whatsappLink(number, message) {
  const digits = String(number || "").replace(/\D/g, "");
  if (!digits) {
    return null;
  }
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
