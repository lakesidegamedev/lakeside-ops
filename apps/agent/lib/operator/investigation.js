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

// 2026-11-23: what a worker picks up when a ticket stopped moving: every card Keir filed on it that is still open,
// plus the task's own last summary. Always returns something, so a stalled ticket is never left with no one on it.
const EXTRA_STALL_RUNS = 1;
function stallCause(jobs) {
  const cards = jobs.flatMap((j) => (j.raisedToDevelopers || []).filter((r) => r && r.id && !r.releasedAt).map((r) => r));
  const blocking = cards.find((r) => r.blocking) || cards.at(-1) || null;
  const root = jobs.filter((j) => j.kind === "ticket").sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  const list = cards.slice(-6).map((r) => `- card ${r.id}${r.blocking ? " (blocking)" : ""}: ${String(r.title || "").slice(0, 160)}`).join("\n");
  const summary = [
    "Keir's ticket task stopped making progress and handed the ticket to you. Read the ticket from the start (support_get), then take it the rest of the way: verify the cause with numbers if it is not verified, and if it is a bug or display defect, build the fix per the rules above.",
    list && `Cards Keir filed on this ticket that are still open (read each with ops-knowledge kanban_get for what was already checked):\n${list}`,
  ].filter(Boolean).join("\n\n");
  return { source: "stall", card: blocking ? { id: blocking.id, title: blocking.title } : null, summary, root: root?.id || null };
}

const runsOf = (d, ticket) => Object.values(d.codingWorkers?.runs || {}).filter((r) => String(r.ticket) === String(ticket));
const activeRun = (d, ticket) => runsOf(d, ticket).find((r) => !ENDED.has(r.state)) || null;
const lastEndedAt = (d, ticket) => Math.max(0, ...runsOf(d, ticket).filter((r) => ENDED.has(r.state)).map((r) => r.endedAt || 0));
const investigationsFor = (d, ticket) => runsOf(d, ticket).filter((r) => r.kind === "investigate").length;

module.exports = { ENDED, MAX_INVESTIGATIONS_PER_TICKET, EXTRA_STALL_RUNS, stallCause, openOwnQuestion, causeUnverified, activeRun, lastEndedAt, investigationsFor, UNVERIFIED };
