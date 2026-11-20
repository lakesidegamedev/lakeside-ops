"use strict";
// Keir 10.3 continuity wiring: the one place the activation (agent.js) and the delivery path (broker.js) touch the
// durable ticket case file (ticketcase.js) and the shift log (shiftlog.js). Keeps the hook-ins in those files to a
// line each. Fails open: any error means the activation runs without the extra context.

const ticketcase = require("./ticketcase");
let shiftLog = null;
const setShiftLog = (instance) => { shiftLog = instance; };
const wanted = (job) => Boolean(job && job.kind === "ticket" && job.ticket && job.role !== "player" && !job.codingParent);

// Parts for the top of a ticket activation: the case file first, the shift log second.
async function prepare({ ledger, job, config = {}, now = Date.now() }) {
  const parts = {};
  if (!wanted(job)) return parts;
  try {
    ticketcase.syncActivation(ledger.data, job, { now, ownerId: config.ownerId, botId: config.botId });
    ticketcase.prune(ledger.data, now);
    const text = ticketcase.render(ledger.data, job.ticket);
    if (text) parts.ticketCaseFile = text;
  } catch { /* no case file */ }
  try { const text = await shiftLog?.get(); if (text) parts.shiftLog = text; } catch { /* no shift log */ }
  return parts;
}

// Move the continuity keys to the front of the context (JSON key order is prompt order). In place, so every holder of
// `context` sees it. The current question precedes the case history.
function promote(context) {
  const first = ["currentTurn", "ticketCaseFile", "shiftLog"].filter((k) => context[k] !== undefined);
  if (!first.length) return context;
  const entries = Object.entries(context);
  for (const [k] of entries) delete context[k];
  for (const k of first) context[k] = entries.find(([key]) => key === k)[1];
  for (const [k, v] of entries) if (!first.includes(k)) context[k] = v;
  return context;
}

module.exports = { prepare, promote, setShiftLog, wanted };
