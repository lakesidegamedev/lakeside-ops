"use strict";
// A ticket task adopted from a handoff after its channel was already gone has no
// channel id. The sweep's Discord check (GET /channels/<id> returning 404) can
// then never close it, so it woke every fifteen minutes for 29 hours (ticket
// 1730, 2026-11-01: 128 activations, 15M tokens, every read refused). The support
// record is the authority instead: a closed, resolved or merged ticket ends it.
const CLOSED = new Set(["closed", "resolved", "merged"]);

async function closeIfTicketClosed(job, readTicket) {
  if (!job?.ticket || job.channelId || ["done", "cancelled"].includes(job.state)) return false;
  let ticket;
  // "unreadable" lets the sweep back off instead of retrying every pass.
  try { ticket = await readTicket(job.ticket); } catch { return "unreadable"; }
  if (!CLOSED.has(String(ticket?.status || ""))) return false;
  job.channelClosed = true;
  if (job.state === "dismissed") return true;
  job.state = "done";
  job.summary = "Ticket is closed and has no channel; stopped work.";
  return true;
}

// The live ticket task already bound to a channel, if any (the sweep must not adopt it twice).
function liveTaskForChannel(jobs, channelId) {
  if (!channelId) return null;
  return Object.values(jobs || {}).find((j) => j.channelId === channelId && j.kind === "ticket" && !["done", "cancelled", "dismissed"].includes(j.state)) || null;
}

module.exports = { closeIfTicketClosed, liveTaskForChannel };
