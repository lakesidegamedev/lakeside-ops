"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { requested } = require("../lib/operator/suggestionintake");

test("everyday wording asks for a suggestion; praise and refusals do not (ticket 1756)", () => {
  for (const t of ["Send the suggestion", "keir make that a suggestion please", "file a suggestion for this"]) assert.equal(requested(t), true, t);
  for (const t of ["great suggestion", "do not send the suggestion", "don't file a suggestion"]) assert.equal(requested(t), false, t);
});

test("a public report Keir published may be linked to a player; other ops links may not (ticket 1757)", () => {
  const { playerLeak } = require("../lib/operator/playercopy");
  const text = "The full audit is here: https://ops.lakesidegames.net/reports/exxon-mobil-tax-audit-turn-627";
  assert.equal(playerLeak(text, { publicReports: ["exxon-mobil-tax-audit-turn-627"] }), null);
  assert.equal(playerLeak(text).kind, "internal URL");
  assert.equal(playerLeak("see https://ops.lakesidegames.net/kanban", { publicReports: ["exxon-mobil-tax-audit-turn-627"] }).kind, "internal URL");
});
