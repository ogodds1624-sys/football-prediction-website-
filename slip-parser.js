// Reads teams, selections and odds from booking slip OCR text.
// OCR is imperfect, so the control room always shows the result for review.

const SLIP_JUNK = /booking code|total odds|stake|potential|bonus|bet ?slip|place bet|cash ?out|max win|sportybet|share|accept odds|ticket|load code|real ?sport|^((single|multiple|system|multi)\s*)+$|^\d+\s*(games?|selections?|events?)$/i;
const SLIP_ODDS = /(?:@\s*)?\b(\d{1,3}\.\d{2})(?!\d)/g;
const SLIP_TIME = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b(?:mon|tue|wed|thu|fri|sat|sun|today|tomorrow)\b/gi;
// Market and pick names that can look like "Team - Team" on a slip.
const SLIP_MARKET = /handicap|over\s*\/\s*under|double chance|1x2|both teams|correct score|half|total|draw no bet|^(home|away|draw|over|under|yes|no|gg|ng)$/i;
const SLIP_VS = /^(.+?)\s+(?:vs\.?|v\.?)\s+(.+)$/i;
const SLIP_DASH = /^(.+?)\s+[-–—]\s+(.+)$/;

function slipTip(line) {
  const text = line
    .replace(/^[^\p{L}\d]+/u, "")
    .replace(/^[xX]\s+(?=(?:over|under|home|away|draw|yes|no)\b)/i, "")
    .trim();
  const goals = text.match(/^(over|under)\s+(\d+(?:[.,]\d{1,2})?)\b/i);
  if (goals) {
    const direction = goals[1].toLowerCase();
    return `${direction === "over" ? "Over" : "Under"} ${Number(goals[2].replace(",", "."))}`;
  }
  const selection = text.match(/^(home\s+or\s+draw|draw\s+or\s+away|home\s+or\s+away|home|away|draw|yes|no)\b(.*)$/i);
  if (!selection) {
    return "";
  }
  // A selection can share a line with its odds or market, but not a team name.
  const suffix = selection[2]
    .replace(SLIP_ODDS, "")
    .replace(/1x2|double chance|both teams to score|draw no bet/gi, "")
    .replace(/[^\p{L}\d]/gu, "");
  if (suffix) {
    return "";
  }
  return selection[1].toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()).replace(/\s+/g, " ");
}

function cleanSlipText(text) {
  return text
    .replace(SLIP_ODDS, " ")
    .replace(SLIP_TIME, " ")
    .replace(/\bID[:\s]*\d+/gi, " ")
    .replace(/[|»«©®•*_=~]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\d(]+|[^\p{L}\d.)+]+$/gu, "")
    .trim();
}

function isTeamName(text) {
  return /\p{L}{2,}/u.test(text) && text.length <= 50;
}

function lastOdds(text) {
  const withoutGoalLine = text.replace(/\b(?:over|under)\s+\d+(?:[.,]\d{1,2})?\b/gi, "");
  const found = [...withoutGoalLine.matchAll(SLIP_ODDS)].map((match) => match[1]);
  const valid = found.filter((value) => Number(value) >= 1.01);
  return valid.length ? valid[valid.length - 1] : "";
}

function matchTeams(line, pattern) {
  const found = line.match(pattern);
  if (!found) {
    return null;
  }
  const home = cleanSlipText(found[1]);
  const away = cleanSlipText(found[2]);
  if (SLIP_MARKET.test(line) || SLIP_MARKET.test(home) || SLIP_MARKET.test(away)) {
    return null;
  }
  return isTeamName(home) && isTeamName(away) ? { home, away } : null;
}

function parseSlip(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !SLIP_JUNK.test(line));

  // "Arsenal - Chelsea" style is only trusted when no line uses "vs",
  // because market names like "Over/Under - 2.5" also contain dashes.
  const pattern = lines.some((line) => SLIP_VS.test(line)) ? SLIP_VS : SLIP_DASH;

  const matchIndexes = [];
  const teams = [];
  lines.forEach((line, index) => {
    const found = matchTeams(line, pattern);
    if (found) {
      matchIndexes.push(index);
      teams.push({ ...found, odds: lastOdds(line) });
    }
  });
  if (!matchIndexes.length) {
    return [];
  }

  // SportyBet usually prints the pick and odds above the teams; other slips put them below.
  const firstDetailIndex = lines.findIndex(
    (line, index) => !matchIndexes.includes(index) && (slipTip(line) || lastOdds(line)),
  );
  const detailsAbove = firstDetailIndex !== -1 && firstDetailIndex < matchIndexes[0];

  const results = [];
  const seen = new Set();
  matchIndexes.forEach((lineIndex, i) => {
    const start = detailsAbove ? (i === 0 ? 0 : matchIndexes[i - 1] + 1) : lineIndex + 1;
    const end = detailsAbove ? lineIndex : (matchIndexes[i + 1] ?? lines.length);
    const details = lines.slice(start, end);

    const key = `${teams[i].home}|${teams[i].away}`.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    const detailOdds = details.map(lastOdds).filter(Boolean);
    results.push({
      home: teams[i].home,
      away: teams[i].away,
      tip: details.map(slipTip).find(Boolean) || "",
      odds: teams[i].odds || detailOdds[detailOdds.length - 1] || "",
    });
  });
  return results;
}

if (typeof module !== "undefined") {
  module.exports = { parseSlip };
}
