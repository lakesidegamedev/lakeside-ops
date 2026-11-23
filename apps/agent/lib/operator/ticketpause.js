"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { JOB_TERMINAL } = require("./machines");
// The close exception lives only in this async scope: never on a job or the ledger, so a save, a reload or a parallel
// request cannot carry it. It names the exact job and the exact permission receipt it was granted under.
const closeScope = new AsyncLocalStorage();
// An owner pause is authority, not a model's promise to check back later.
const CLOSED = new Set(JOB_TERMINAL);
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
// Keir 11.1: an owner can silence updates while permitting closure. A later status
// post still went out. Settling a ticket and silencing updates are different asks. This recognises only a whole short
// message that tells Keir to stop updating, optionally with permission to close. It is called only for an owner or staff
// message addressed to Keir, so a player explaining or quoting such words never reaches it.
const LEAD = "(?:(?:ok(?:ay)?|thanks?|thank you|hi|hey)[,.!\\s]+)*(?:please\\s+)?";
const STOP = "(?:no need to (?:keep )?(?:updat\\w*|post\\w*|send\\w*|status)(?: updates?)?|no more (?:status )?updates?|(?:you can |please |do not |don'?t )?(?:stop|quit) (?:updating|posting updates|sending updates|the updates)|(?:do not|don'?t) (?:keep )?(?:updat\\w*|post\\w* updates?|send\\w* updates?))";
const WHERE = "(?:\\s+(?:here|in here|in this ticket|on this ticket|on this|anymore|any more|any longer|for now|now|please|thanks|thank you))*";
const CLOSE = "(?:you (?:can|may|could) (?:go ahead and )?(?:close|resolve)(?: (?:it|this|this ticket|the ticket|this one))?|feel free to (?:close|resolve)(?: (?:it|this|this ticket|the ticket))?|(?:go ahead and |please )?(?:close|resolve) (?:it|this|this ticket|the ticket)(?: (?:if|when) (?:you (?:want|like)|appropriate))?)";
const STOP_RE = new RegExp(`^${LEAD}${STOP}${WHERE}(?:[\\s,.;:!-]+(?:and |so )?(${CLOSE})${WHERE})?[.!\\s]*$`, "i");
function parseStopUpdates(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 160 || /\?/.test(t)) return null;
  const m = STOP_RE.exec(t);
  return m ? { closePermission: Boolean(m[1]) } : null;
}
// Idempotent. A repeat message, or a replayed one, changes nothing. A later message that adds close permission to an
// existing stop records only the permission.
function applyStopUpdates(ledger, channelId, ticket, parsed, source, at) {
  const data = ledger.data, existing = data.channels?.[channelId]?.keirPaused;
  if (existing && existing.messageId === source.messageId) return false;
  if (!existing) setPause(ledger, channelId, ticket, true, source, at);
  const pause = data.channels[channelId].keirPaused;
  if (!pause.stopUpdates) pause.stopUpdates = { by: source.authorId, messageId: source.messageId, at };
  if (parsed.closePermission && !pause.closePermission) {
    pause.closePermission = { by: source.authorId, messageId: source.messageId, at };
    ledger.audit("ticket_close_permission", { ticket, channelId, actor: source.authorId, message: source.messageId });
  }
  ledger.save();
  return !existing;
}
// Runs fn (the closer's authority read and support_resolve only) with the exception for this job and the pause's
// current close-permission receipt. No permission on the pause means no scope, so the pause holds as usual.
function runAsCloser(data, job, fn) {
  const permission = pauseFor(data, job)?.closePermission;
  if (!permission) return fn();
  return closeScope.run({ jobId: job.id, receipt: permission.messageId }, fn);
}
function assertCanAct(data, job) {
  const pause = pauseFor(data, job);
  // Only the deterministic closer, and only under explicit close permission, may resolve a silenced ticket.
  const scope = closeScope.getStore();
  if (pause && pause.closePermission && scope && scope.jobId === job.id && scope.receipt === pause.closePermission.messageId) return;
  if (pause) throw Object.assign(new Error(`Ticket ${pause.ticket} is paused by the owner. Stop until an explicit resume.`), { code: "TICKET_OWNER_PAUSED" });
}

// Owner rule 2026-11-23 (always a worker, never "staff are reviewing"): lift the pauses Keir's own older staff hand-off left
// on tickets (wake cap, a player challenge, repeated corrections). A pause a person set is never touched. Cleared directly:
// setPause would tell the task the owner resumed it, which is not what happened. Returns the tickets lifted.
function liftKeirEscalationPauses(data, now) {
  const esc = data.ticketEscalations || {}, pauses = data.ticketPauses || {}, lifted = [];
  for (const [n, e] of Object.entries(esc)) {
    if (!["wake_cap", "player_challenge", "repeated_corrections"].includes(e?.why)) continue;
    if (pauses[n] && pauses[n].by !== "keir-escalation") continue;
    delete pauses[n];
    for (const c of Object.values(data.channels || {})) if (Number(c.keirPaused?.ticket) === Number(n) && c.keirPaused.by === "keir-escalation") delete c.keirPaused;
    for (const j of Object.values(data.jobs || {})) if (Number(j.ticketPaused?.ticket) === Number(n) && j.ticketPaused.by === "keir-escalation") {
      delete j.ticketPaused;
      if (j.state === "paused" && !j.channelClosed && !j.resolved) {
        j.state = "waiting"; j.wakeAt = now + 60000;
        (j.inbox ||= []).push({ role: "system", authorId: "keir-escalation-lift", at: new Date(now).toISOString(), content: "Your earlier \"staff are reviewing\" hand-off on this ticket is withdrawn: Keir owns it again (owner rule 2026-11-23). Read the ticket from the start. If someone else posted to the player in the last two hours, stay quiet; otherwise do the next owed step or set your closing condition." });
      }
    }
    delete esc[n]; lifted.push(Number(n));
  }
  return lifted;
}

module.exports = { liftKeirEscalationPauses, runAsCloser, pauseFor, setPause, assertCanAct, parseStopUpdates, applyStopUpdates };
