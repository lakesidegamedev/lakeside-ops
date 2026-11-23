"use strict";
// Owner rule, 2026-11-23: "Keir is supposed to make life easier, be trustworthy, and only bother me if it really really
// needs a dev call." His phone showed an internal error pushed every 30 minutes, two morning briefs, a "needs a person
// (wake cap)" DM while a developer agent was already on the ticket, and DMs full of GitHub embeds and jargon.
//
// The rule, enforced here for every owner DM and app push:
//   - Interrupt the owner ONLY for a decision that genuinely needs him (a product, money or irreversible call), asked in
//     plain words as a multiple-choice question (decisions.js "ask:" prompts with buttons).
//   - Keir's direct reply to something the owner asked still reaches him.
//   - Everything else (status, briefs, completions, stalls, hand-offs, watch alerts) goes to the one daily digest or
//     nowhere. A stall is resolved by dispatching a worker, never by paging the owner.
//   - An internal error is never pushed or DMed as such.
// Pure functions.

// Owner DM keys that may interrupt: multiple-choice decisions, the one daily digest, Keir's direct reply to a task the
// owner gave it, the answer to a command the owner sent by DM (discord:<message id>), and the notice that the owner's own
// message was not taken as his answer.
const DM_ALLOWED = /^(?:ask|trust-report|finish|owner-unmatched|discord):/;
const allowedDm = (key) => DM_ALLOWED.test(String(key || ""));

// Internal wording that must never reach the owner's lock screen or DMs as the message itself.
const INTERNAL = /\b(?:origin receipts?|authenticated origin|capability blocker|OWNER_MUSE\w*|wake cap|stack trace|ECONN\w+|ETIMEDOUT|TypeError|ReferenceError|SyntaxError|exit code \d+|HTTP \d{3}|MCP error|tool_refused|ledger|activation|effect[- ]error|preflight|stepguard|deadline-blocked)\b|\bError:\s/i;
const internal = (text) => INTERNAL.test(String(text || ""));

// Jargon to plain words for owner-facing text; raw links are dropped (Discord turns them into embeds).
const PLAIN = [
  [/\bwake cap(?:ped)?\b/gi, "its retry limit"],
  [/\bneeds a person\b/gi, "is waiting"],
  [/\bhandoff\b/gi, "hand-off"],
  [/\bauthenticated origin receipts?\b/gi, "sign-in record"],
];
function plain(text) {
  let s = String(text || "");
  s = s.replace(/<?https?:\/\/[^\s>)]+>?/g, "").replace(/\(\s*\)/g, "");
  for (const [re, to] of PLAIN) s = s.replace(re, to);
  return s.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// What the lock screen says for a reply that would otherwise carry an internal error.
const BLOCKED_LINE = "Keir could not finish this one. Open the app for details.";
function pushBody(text) { return internal(text) ? BLOCKED_LINE : plain(text); }

module.exports = { allowedDm, internal, plain, pushBody, BLOCKED_LINE, DM_ALLOWED };
