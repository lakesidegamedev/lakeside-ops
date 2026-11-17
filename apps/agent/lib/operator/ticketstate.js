"use strict";
// Keir 10.1.13 (owner, 2026-11-17): Keir DM'd about tickets that were already resolved (1838, 1842, 1836) and
// told a player "still working on it" a minute after the ticket closed. One definition of "this ticket is over",
// shared by every alert, every player post and every job wake:
//   - the support record says resolved, closed or merged (the reconcile writes it to d.ticketOutcomes);
//   - the ticket's channel was deleted or closed outside Keir (owner rule: that means resolved);
//   - Keir's own resolution was submitted.
const SUPPORT_CLOSED = new Set(["resolved", "closed", "merged"]);
const TERMINAL = new Set(["done", "cancelled", "dismissed"]);

function outcomeClosed(d, n) {
  for (const o of Object.values(d.ticketOutcomes || {})) if (Number(o.ticket) === Number(n) && !o.superseded && (SUPPORT_CLOSED.has(String(o.status)) || o.mergedInto)) return true;
  return false;
}

// Why the ticket is over, from the ledger alone, or null. Only the coordinator (the job the ticket number points
// at) and the asking job count, so a reopened ticket's fresh job is not blocked by the old closure.
function endedReason(d, n, job = null) {
  if (!n) return null;
  const coordinator = d.jobs?.[d.seen?.[`ticket:${n}`]];
  for (const j of [job, coordinator]) {
    if (!j || Number(j.ticket) !== Number(n)) continue;
    if (j.channelClosed) return "channel closed";
    if (j.resolved) return "resolved";
    if (j.resolutionSubmitted) return "resolved";
    if (j.mergedInto) return "merged";
  }
  if (outcomeClosed(d, n)) return "support record closed";
  return null;
}

// Stop every Keir job on a ended ticket: no more wakes, nothing queued to say. `except` is the job that is
// finishing its own turn right now. A channel deleted outside Keir also marks the job channelClosed, as the
// scan does, so a later reopen can still be adopted.
function closeTicketJobs(ledger, n, why, { except = null, channelGone = false, skipRunning = false } = {}) {
  const d = ledger.data;
  let closed = 0;
  for (const j of Object.values(d.jobs || {})) {
    if (Number(j.ticket) !== Number(n) || j === except || j.id === except?.id) continue;
    if (skipRunning && j.state === "running") continue;
    if (channelGone) j.channelClosed = true;
    if (TERMINAL.has(j.state)) continue;
    j.state = "done"; j.wakeAt = 0; j.inbox = [];
    j.summary = `Ticket ${n} ended (${why}); stopped work.`;
    closed++;
  }
  if (closed) ledger.audit("ticket_jobs_closed", { ticket: n, why, jobs: closed });
  return closed;
}

module.exports = { SUPPORT_CLOSED, endedReason, closeTicketJobs, outcomeClosed };
