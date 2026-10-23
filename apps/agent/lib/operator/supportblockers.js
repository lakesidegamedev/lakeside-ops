"use strict";
const { ownerText } = require("./privacy");
// Failures in the support desk belong to the operator, not to the player.
function internalFailure(text) {
  const s = String(text || "");
  return /\bsuggestion intake\b[\s\S]{0,100}\b(?:block|reject|fail|repair|fault)/i.test(s)
    || (/\b(?:suggestion|proposal|reopened ticket|filing|source (?:post|message|channel))\b/i.test(s) && /\b(?:original (?:post|message)|reopened ticket|source (?:post|message|channel))\b[\s\S]{0,130}\b(?:cannot|can't|could not|unavailable|deleted|unlinked|fails?)/i.test(s))
    || /\b(?:cannot|can't|unable to|fails? to)\s+(?:be\s+)?file\b[\s\S]{0,100}\b(?:suggestion|proposal|original|reopened|source)/i.test(s)
    || /\b(?:suggestion|proposal)\b[\s\S]{0,100}\b(?:remains? unfiled|still unfiled|filing (?:fails?|failed|blocked))/i.test(s);
}
function report(ledger, ticket, detail, now = Date.now()) {
  const rows = (ledger.data.internalSupportFailures ||= {}), old = rows[ticket];
  if (old && !old.clearedAt) return old;
  const entry = { at: now, detail: ownerText(detail).slice(0, 1800) };
  rows[ticket] = entry;
  // The existing error channel goes to the owner's private ops alerts, not DMs.
  ledger.notify(`error:internal-support:${ticket}:${now}`, "owner", `Ticket ${ticket}: internal support failure. Repair privately; do not ask the player to work around it. ${entry.detail}`);
  ledger.save(); return entry;
}
function guard(ledger, ticket, text, now) {
  if (!internalFailure(text)) return;
  report(ledger, ticket, text, now);
  throw new Error("Not posted: this is an internal support failure, flagged privately to the owner once. Fix the cause; do not repeat it or its workarounds to the player. Post only a new finding, an answer they need, or a verified outcome.");
}
function clear(ledger, ticket, now = Date.now()) {
  const row = ledger.data.internalSupportFailures?.[ticket];
  if (row && !row.clearedAt) { row.clearedAt = now; ledger.save(); }
}
function unchangedWait(text) {
  return /\b(?:still not live|still waiting|not (?:on the live game|live) yet|production has not picked|live game has not picked|live game hasn.t picked)\b/i.test(String(text || ""));
}
module.exports = { internalFailure, report, guard, clear, unchangedWait };
