"use strict";
// An owner pause is authority, not a model's promise to check back later.
const CLOSED = new Set(["done", "cancelled", "dismissed"]);
function pauseFor(data, job) {
  const seen = new Set();
  while (job && !seen.has(job.id)) {
    seen.add(job.id);
    if (job.ticketPauseControl && job.kind === "notice" && job.role === "owner") return null;
    const direct = data.channels?.[job.channelId]?.keirPaused;
    if (direct) return direct;
    const ticket = Number(job.ticket);
    if (ticket && data.ticketPauses?.[ticket]) return data.ticketPauses[ticket];
    job = data.jobs?.[job.codingParent || job.museParent];
  }
  return null;
}
function setPause(ledger, channelId, ticket, paused, source, at) {
  const data = ledger.data, channel = (data.channels[channelId] ||= {});
  if (paused) channel.keirPaused = { ticket, by: source.authorId, messageId: source.messageId, at };
  else delete channel.keirPaused;
  const pauses = (data.ticketPauses ||= {});
  if (paused) pauses[ticket] = channel.keirPaused; else delete pauses[ticket];
  for (const job of Object.values(data.jobs)) {
    if (paused ? !pauseFor(data, job) : !job.ticketPaused || job.ticketPaused.ticket !== ticket) continue;
    if (paused) {
      job.ticketPaused = channel.keirPaused;
      if (!CLOSED.has(job.state)) { job.state = "paused"; delete job.wakeAt; }
    } else {
      delete job.ticketPaused;
      if (job.state === "paused") {
        job.state = Object.values(job.effects || {}).some(effect => effect.state === "started") ? "blocked"
          : job.kind === "command" && !job.codingParent ? "dismissed" : "queued";
        if (job.kind === "ticket") (job.inbox ||= []).push({ ...source, role: "owner", at: source.at || new Date(at).toISOString(),
          content: "The owner explicitly resumed this ticket. Continue from the verified checkpoint, read current state, and restore its open status if it is still parked." });
      }
    }
  }
  ledger.audit(paused ? "ticket_paused" : "ticket_resumed", { ticket, channelId, actor: source.authorId, message: source.messageId });
  ledger.save();
}
function assertCanAct(data, job) {
  const pause = pauseFor(data, job);
  if (pause) throw Object.assign(new Error(`Ticket ${pause.ticket} is paused by the owner. Stop until an explicit resume.`), { code: "TICKET_OWNER_PAUSED" });
}
module.exports = { pauseFor, setPause, assertCanAct };
