"use strict";
// Keir 10.2 (ticket 1837): an escalation to a person carries what was checked, the evidence, and the specific blocker.
// Pure functions. The broker passes in what the ticket read and posted.

const clip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);

function toolOf(input) {
  try { const v = typeof input === "string" ? JSON.parse(input) : input; return [v?.server, v?.tool].filter(Boolean).join(".") || null; } catch { return null; }
}

// The first step an investigator would take, from what has not been read yet.
function blockerOf({ codeRead, codeLookups, summary }) {
  const said = clip(summary, 240);
  if (!codeRead && !codeLookups) return `No game code was read for this ticket, so the cause is not established. Keir's own stated blocker: ${said || "none given"}.`;
  return `The code was read but the cause is not confirmed. Keir's own stated blocker: ${said || "none given"}.`;
}

function build({ ticket, summary, playerAsked, reads = [], codeLookups = 0, codeRead = false, posts = [] }) {
  const tools = [...new Set(reads.map((r) => toolOf(r.input)).filter(Boolean))].slice(0, 8);
  const evidence = reads.filter((r) => r.result).slice(-2).map((r) => `- ${toolOf(r.input) || "read"}: ${clip(r.result, 220)}`);
  const told = posts.slice(-2).map((t) => `- "${clip(t, 200)}"`);
  return [
    `Ticket ${ticket}: Keir's task ended without an answer the player can use.`,
    `Player asked: ${clip(playerAsked, 280) || "see the ticket"}`,
    `Checked: ${tools.length ? tools.join(", ") : "no data reads"}; code lookups: ${codeLookups}; code read: ${codeRead ? "yes" : "no"}.`,
    evidence.length ? `Evidence:\n${evidence.join("\n")}` : "Evidence: none recorded.",
    told.length ? `Player was told:\n${told.join("\n")}` : "Player was told: nothing beyond the intro.",
    `Blocker: ${blockerOf({ codeRead, codeLookups, summary })}`,
  ].join("\n");
}

// A finish that names work still to do ("next activation", "next investigator to read ...") has not finished that work.
const NAMED_WORK = /\b(?:next (?:activation|investigator|run|task|step)|to (?:read|check|trace|confirm|verify|look at)\b|blocked on (?:reading|checking|tracing)|still (?:to )?(?:read|check|trace|investigate)|needs? (?:a )?(?:breakdown|confirm\w*|verif\w*)|not yet (?:read|checked|traced|verified|confirmed)|unconfirmed|unverified)\b/i;
const namesUnfinishedWork = (summary) => NAMED_WORK.test(String(summary || ""));

module.exports = { build, blockerOf, namesUnfinishedWork, NAMED_WORK };
