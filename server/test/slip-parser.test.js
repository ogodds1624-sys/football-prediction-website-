import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const context = vm.createContext({ module: { exports: {} } });
vm.runInContext(readFileSync(new URL("../../slip-parser.js", import.meta.url), "utf8"), context);
const parseSlip = (text) => JSON.parse(JSON.stringify(context.module.exports.parseSlip(text)));

test("reads decorated SportyBet picks above teams without copying icons or markets", () => {
  assert.deepEqual(parseSlip(`
SportyBet
✓ Over 1.5 1.25
Over/Under
Arsenal vs Chelsea
× Home 1.80
1X2
Liverpool vs Everton
x Away @ 2.10
1X2
Brighton vs Fulham
Total odds 4.73
`), [
    { home: "Arsenal", away: "Chelsea", tip: "Over 1.5", odds: "1.25" },
    { home: "Liverpool", away: "Everton", tip: "Home", odds: "1.80" },
    { home: "Brighton", away: "Fulham", tip: "Away", odds: "2.10" },
  ]);
});

test("reads selections below dashed team names and keeps goal thresholds out of odds", () => {
  assert.deepEqual(parseSlip(`
Arsenal - Chelsea
Under 2.50
Over/Under
1.35
Liverpool - Everton
Draw 1X2 @ 3.20
`), [
    { home: "Arsenal", away: "Chelsea", tip: "Under 2.5", odds: "1.35" },
    { home: "Liverpool", away: "Everton", tip: "Draw", odds: "3.20" },
  ]);
});

test("unknown selections remain blank for admin review", () => {
  assert.deepEqual(parseSlip("Arsenal vs Chelsea\nCorrect score\n2:1\n5.00"), [
    { home: "Arsenal", away: "Chelsea", tip: "", odds: "5.00" },
  ]);
});

test("a selection without odds above teams belongs to that match", () => {
  assert.deepEqual(parseSlip("Over 1.50\nArsenal vs Chelsea\nAway\nLiverpool vs Everton"), [
    { home: "Arsenal", away: "Chelsea", tip: "Over 1.5", odds: "" },
    { home: "Liverpool", away: "Everton", tip: "Away", odds: "" },
  ]);
});
