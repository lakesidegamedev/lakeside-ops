"use strict";
// Ticket ownership fences task tools and already queued public replies. A
// takeover never grants consent or rewrites a started external effect.
function ticketsOf(data, job) {
  const seen = new Set();
  const tickets = new Set();
  while (job && !seen.has(job.id)) {
    seen.add(job.id);
    const ticket = Number(job.ticket) || Number(/-(\d+)$/.exec(job.source?.channelName || "")?.[1]);
    if (Number.isSafeInteger(ticket) && ticket > 0) tickets.add(ticket);
    const parent = job.codingParent || job.museParent;
    if (!parent) break;
    job = data.jobs[parent];
  }
  return [...tickets];
}
const ticketOf = (data, job) => ticketsOf(data, job)[0] || null;
function held(data, job) {
  for (const ticket of ticketsOf(data, job)) {
    const owner = data.supportOwner?.tickets?.[ticket] || data.supportOwner?.owner || "keir";
    if (owner !== "keir") return { ticket, owner, takeoverId: data.supportOwner?.takeovers?.[ticket]?.id || null };
  }
  return null;
}
function assertCanAct(data, job) {
  require("./ticketpause").assertCanAct(data, job);
  const hold = held(data, job);
  if (hold) throw Object.assign(new Error(`Ticket ${hold.ticket} is owned by ${hold.owner}; Keir must stand down until an explicit handback.`), { code: "TICKET_TAKEOVER_HELD" });
}
function suppressOutbox(ledger, key, entry, at) {
  if (entry.suppressedByTakeover || entry.deliveredAt) return true;
  if (!entry.destination?.startsWith("channel:")) return false;
  const job = ledger.data.jobs[entry.destination.slice(8)];
  if (!job || job.replyChannel === "app" && job.source?.channelId === "app") return false;
  const pause = require("./ticketpause").pauseFor(ledger.data, job);
  const hold = held(ledger.data, job) || (pause && { ticket: pause.ticket, owner: "owner pause" });
  if (!hold) return false;
  entry.deliveredAt = at;
  entry.skipped = "ticket takeover: stale automatic reply suppressed";
  entry.suppressedByTakeover = { ...hold, at };
  ledger.audit("outbox_suppressed_takeover", { key, job: job.id, ...hold, deliveredChunks: entry.deliveredChunks || 0 });
  ledger.save();
  return true;
}
function record(ledger, ticket, owner, by, options, at) {
  const s = ledger.data.supportOwner;
  const receipt = { id: String(options.id || ledger.id()).slice(0, 100), ticket, owner, by: by || null, at,
    implementationOwner: String(options.implementationOwner || owner).slice(0, 150),
    correction: String(options.correction || "").slice(0, 3000),
    remainingWork: (Array.isArray(options.remainingWork) ? options.remainingWork : []).map(String).map(s => s.slice(0, 500)).slice(0, 12) };
  (s.takeovers ||= {})[ticket] = receipt;
  for (const job of Object.values(ledger.data.jobs)) {
    if (!ticketsOf(ledger.data, job).includes(ticket)) continue;
    (job.history ||= []).push({ kind: "support_takeover", at: new Date(at).toISOString(), receiptId: receipt.id,
      summary: `Implementation owner: ${receipt.implementationOwner}. ${receipt.correction}`.slice(0, 3300) });
  }
  ledger.audit("ticket_takeover_recorded", receipt);
  // Suppress now as well as at delivery, so an immediate handback cannot
  // resurrect advice that was pending when the ticket changed hands.
  if (owner !== "keir") for (const [key, entry] of Object.entries(ledger.data.outbox)) {
    const destinationJob = entry.destination?.startsWith("channel:") && ledger.data.jobs[entry.destination.slice(8)];
    if (!entry.deliveredAt && ticketsOf(ledger.data, destinationJob).includes(ticket)) suppressOutbox(ledger, key, entry, at);
  }
  return receipt;
}
module.exports = { ticketOf, held, assertCanAct, suppressOutbox, record };
