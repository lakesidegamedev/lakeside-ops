"use strict";

const stamp = value => typeof value === "number" ? value : Date.parse(value || "");
const keyFor = job => `${job.ticket}:${job.channelId || job.source?.channelId || job.id}`;

// Only canonical support receipts establish a resolution. A vanished channel,
// done task, merge, or final-answer proposal does not establish success.
function observeTicket(data, job, ticket, now = Date.now()) {
  if (ticket?.number !== job.ticket) return false;
  const channel = ticket.conversation?.channelId;
  const outcomes = data.ticketOutcomes ||= {};
  const key = keyFor(job);
  const prior = outcomes[key];
  if (channel && channel !== (job.channelId || job.source?.channelId)) {
    if (prior) { prior.superseded = true; prior.reopened = true; prior.observedAt = now; }
    return false;
  }
  const receipt = ticket.resolution;
  const resolvedAt = stamp(receipt?.resolvedAt || ticket.resolvedAt || ticket.closedAt);
  const resolved = ["resolved", "closed"].includes(ticket.status) && !ticket.mergedInto
    && Boolean(receipt?.receiptId) && Number.isFinite(resolvedAt);
  const attempts = Object.values(data.jobs || {}).filter(j => j.ticket === job.ticket
    && (j.channelId || j.source?.channelId) === (job.channelId || job.source?.channelId));
  const submitted = attempts.find(j => j.resolutionSubmitted && (j.resolutionReceiptId === receipt?.receiptId
    || j.resolutionSubmittedAt <= resolvedAt + 60000));
  const attribution = ticket.resolutionAttribution;
  const credit = attribution ? (attribution.agent === "keir" ? "keir" : "assisted") : submitted ? "keir" : "assisted";
  outcomes[key] = {
    ticket: job.ticket, channelId: channel || job.channelId || null,
    status: ticket.status, observedAt: now,
    superseded: false,
    createdAt: Number.isFinite(stamp(ticket.createdAt)) ? stamp(ticket.createdAt) : prior?.createdAt ?? null,
    resolvedAt: resolved ? resolvedAt : null,
    receiptId: resolved ? receipt.receiptId : null,
    mergedInto: ticket.mergedInto || null,
    credit: resolved ? credit : null,
    resolverJob: resolved ? (attribution ? attribution.jobId || null : submitted?.id || null) : null,
    closedBy: ticket.closedBy || ticket.resolvedBy || receipt?.closedBy || null,
    attributionEvidence: resolved ? attribution?.evidence || (submitted ? "keir-resolution-submission" : "keir-work-on-ticket") : null,
    reopened: Boolean(prior?.reopened || prior?.resolvedAt && !resolved && !ticket.mergedInto || job.reopenedFromJob),
  };
  return true;
}

// Bounded read-only reconciliation also finds resolutions closed by somebody
// else. Old terminal jobs participate so historical successes can be backfilled.
async function reconcileTickets({ ledger, readTicket, now = Date.now(), limit = 3 }) {
  const latest = new Map();
  for (const job of Object.values(ledger.data.jobs || {})) {
    if (job.kind !== "ticket" || !job.ticket) continue;
    const old = latest.get(job.ticket);
    if (!old || (job.at || 0) > (old.at || 0)) latest.set(job.ticket, job);
  }
  const due = [...latest.values()].filter(j => !j.performanceCheckedAt || now - j.performanceCheckedAt >= 15 * 60000)
    .sort((a, b) => (a.performanceCheckedAt || 0) - (b.performanceCheckedAt || 0) || (b.at || 0) - (a.at || 0)).slice(0, limit);
  for (const job of due) {
    job.performanceCheckedAt = now;
    try { observeTicket(ledger.data, job, await readTicket(job.ticket), now); }
    catch { /* Preserve prior evidence on a sensor failure. Retry next interval. */ }
  }
  if (due.length) ledger.save();
  return due.length;
}

module.exports = { observeTicket, reconcileTickets, keyFor, stamp };
