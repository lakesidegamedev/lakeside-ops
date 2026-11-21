"use strict";
// Ticket 1860 (2026-11-21): in the ticket's own channel the owner wrote "@Keith close this ticket please and wrap up".
// Keir wrapped up, then refused to close: an earlier agent handoff had set ownerClosureHold (the owner's authority,
// delegated), the tool guard refused support_resolve, ticket_command asked the owner to confirm because the request
// "did not name 1860", and after the owner said yes it refused again because "only the owner can lift it, by naming the
// ticket". The ticket stayed open three hours until a person closed it.
//
// The owner telling Keir to close a ticket IS the owner lifting the closure hold for that ticket. In the ticket's own
// channel, "close this ticket", "close this", "close it" or a bare "close" names that ticket: the channel identifies it.
// Only the owner (config.ownerId) can lift the hold; staff, players and a "close this" in another ticket's channel cannot.
const ticketNumberOf = (name) => Number(/^ticket-.*-(\d+)$/.exec(name || "")?.[1] || 0);

// "don't close", "no need to close it yet", "keep it open": a refusal near the verb, or an explicit keep-open anywhere.
const NEGATED = /\b(?:don'?t|do not|dont|not|never|no need to|shouldn'?t|should not|wait to|hold off on)\s+(?:\w+\s+){0,2}?(?:close|resolve)\b|\b(?:keep|leave) (?:it |this |the ticket )?open\b|\bnot yet\b|\bhold off\b/i;
const CLOSE = /\b(?:close|resolve)\b/i;
// "close the PR", "resolve the issue": a close of something that is not the ticket.
const OTHER_OBJECT = /\b(?:close|resolve)\s+(?:out\s+)?(?:the|that|this|my|your|our)?\s*(?:pr|prs|pull request|issue|issues|card|cards|incident|loop|gap|decision|question)\b/i;

// True when text asks Keir to close ticket n from inside ticket n's channel: a close verb, not negated, not aimed at
// something else, and naming no other ticket number. A number naming n itself is fine.
function asksToCloseThisTicket(text, n) {
  const t = String(text || "").replace(/<@!?\d+>/g, " ");
  if (!n || !CLOSE.test(t) || NEGATED.test(t) || OTHER_OBJECT.test(t)) return false;
  for (const m of t.matchAll(/(?:^|[^\w.])#?(\d{3,6})(?![\w.])/g)) if (Number(m[1]) !== Number(n)) return false;
  return true;
}

// The ticket an owner request in Discord lifts the hold on, or 0. Authority comes from the recorded author of the
// gateway message (source.authorId, the real Discord author) and the channel it was posted in, never from the text.
function ownerChannelClose(config, job, texts = null) {
  if (!job || !config?.ownerId) return 0;
  if (!["command", "conversation"].includes(job.kind) || job.role !== "owner" || job.actorId !== config.ownerId) return 0;
  const src = job.source || {};
  if (src.authorId !== config.ownerId || !src.channelId || src.channelId === "app" || src.channelId !== job.channelId) return 0;
  const n = ticketNumberOf(src.channelName);
  if (!n || (job.ticket && Number(job.ticket) !== n)) return 0;
  const said = texts || [src.content, ...[...(job.requestInbox || []), ...(job.inbox || [])].filter((s) => s?.authorId === config.ownerId && s.channelId === src.channelId).map((s) => s.content)];
  return said.some((t) => asksToCloseThisTicket(t, n)) ? n : 0;
}

// Clears the owner's closure hold on every task for ticket n, with an audit line per task. Returns the cleared task ids.
function liftOwnerHold(ledger, n, detail = {}) {
  const d = ledger.data, cleared = [];
  for (const j of Object.values(d.jobs || {})) {
    if (!j.ownerClosureHold) continue;
    if (Number(j.ticket || ticketNumberOf(j.source?.channelName)) !== Number(n)) continue;
    const hold = j.ownerClosureHold;
    delete j.ownerClosureHold;
    cleared.push(j.id);
    ledger.audit("owner_closure_hold_lifted", { job: j.id, ticket: Number(n), handoff: hold?.handoffId || null, ...detail });
  }
  if (cleared.length) ledger.save();
  return cleared;
}

module.exports = { asksToCloseThisTicket, ownerChannelClose, liftOwnerHold, ticketNumberOf };
