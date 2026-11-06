"use strict";
// Keir 8.5.1: ticket 1785 sat six hours behind a self-owned blocking question card with nothing working it.
// Pure helpers shared by the sweeper and the coding-worker module: when is a ticket's cause "unverified and
// nobody is on it", and which worker run (if any) is currently covering the ticket.

// Run states in which a worker is no longer doing anything. "reported" is an investigation that finished
// with findings and no PR (the result goes back to the ticket task).
const ENDED = new Set(["done", "escalated", "needs_owner", "cancelled", "reported"]);
const MAX_INVESTIGATIONS_PER_TICKET = 2;

const UNVERIFIED = /\b(?:cause (?:is )?(?:still )?(?:un(?:verified|known|confirmed)|not (?:yet )?(?:verified|found|confirmed|established))|(?:still )?unverified|root cause (?:is )?(?:un(?:known|verified)|not (?:yet )?(?:found|verified)))\b/i;
const NEXT_STEP = /\bnext\b\s*[:\-]|\bnext step\b|\bto do\b|\bwill (?:check|read|trace|pull|compare)\b/i;

// An open question Keir filed on his own board that blocks the ticket (raise_to_developers kind question,
// selfOwned). Nobody else will ever answer it.
function openOwnQuestion(jobs) {
  for (const j of jobs) {
    for (const r of j.raisedToDevelopers || []) {
      if (r.selfOwned && r.blocking && !r.releasedAt && (r.kind || "question") === "question") return { ...r, jobId: j.id };
    }
  }
  return null;
}

// The cause is unverified when the ticket holds an open own question card, or its waiting task's own summary
// says the cause is unverified and names a next investigation step.
function causeUnverified(jobs) {
  const card = openOwnQuestion(jobs);
  if (card) return { source: "card", card };
  const j = jobs.find((x) => x.kind === "ticket" && x.state === "waiting" && UNVERIFIED.test(String(x.summary || "")) && NEXT_STEP.test(String(x.summary || "")));
  return j ? { source: "summary", summary: String(j.summary).slice(0, 300) } : null;
}

const runsOf = (d, ticket) => Object.values(d.codingWorkers?.runs || {}).filter((r) => String(r.ticket) === String(ticket));
const activeRun = (d, ticket) => runsOf(d, ticket).find((r) => !ENDED.has(r.state)) || null;
const lastEndedAt = (d, ticket) => Math.max(0, ...runsOf(d, ticket).filter((r) => ENDED.has(r.state)).map((r) => r.endedAt || 0));
const investigationsFor = (d, ticket) => runsOf(d, ticket).filter((r) => r.kind === "investigate").length;

module.exports = { ENDED, MAX_INVESTIGATIONS_PER_TICKET, openOwnQuestion, causeUnverified, activeRun, lastEndedAt, investigationsFor, UNVERIFIED };
