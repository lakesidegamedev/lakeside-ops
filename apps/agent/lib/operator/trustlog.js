"use strict";
// Keir 8.4: the small ledger the stuck-ticket sweeper and the daily trust report read.
// Everything lives on d.trust and is bounded. Player text is kept short and only for seven days.
const DAY = 86400000;
const KEEP_MS = 7 * DAY;

const trust = (d) => {
  const t = (d.trust ||= {});
  t.replies ||= []; t.claims ||= []; t.playerMessages ||= []; t.progress ||= {}; t.sweeps ||= {}; t.ownerPings ||= {}; t.reports ||= {}; t.restarts ||= [];
  return t;
};
const fresh = (list, at) => list.filter((x) => at - x.at < KEEP_MS);

// A post that restates "still checking" is not progress (ticket 1766 posted the same non-answer seven times).
const STILL_CHECKING = /\b(?:still (?:checking|looking|investigating|working|digging|on it|reviewing|waiting)|(?:i am|i'm|we are|we're) (?:still )?(?:checking|looking into|investigating|working on)|no (?:new )?update (?:yet|for now)|i haven't found (?:it|the cause|anything) yet|will (?:update|get back to) you|(?:checking|looking into) (?:this|it) (?:now|further))\b/i;
const CLAIM = /\b(?:is|are|now|been)\s+(?:fixed|live|working|resolved|gone|sorted|corrected)\b|\bshould be (?:fixed|gone|working)\b|\blive on the main server\b|\bfix is (?:live|in)\b/i;
const NEGATIVE_REPLY = /\b(?:still (?:not|broken|wrong|the same|happening|there|showing|missing|no)|not (?:fixed|working|resolved|changed)|isn['’]t (?:fixed|working)|same (?:issue|problem|thing|error)|again|doesn['’]t work|didn['’]t work|nothing changed|no change|worse)\b/i;

function isSubstantiveText(text, previousTexts = []) {
  const t = String(text || "").trim();
  if (t.length < 25 || STILL_CHECKING.test(t) && t.length < 220) return false;
  const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
  const a = words(t);
  for (const prev of previousTexts) {
    const b = words(prev);
    if (!a.size || !b.size) continue;
    let both = 0; for (const w of a) if (b.has(w)) both++;
    if (both / (a.size + b.size - both) >= 0.6) return false;
  }
  return true;
}

function recordReply(d, { ticket, jobId, text, at, card = false }) {
  const t = trust(d);
  if (card) return;
  const prior = t.replies.filter((r) => r.ticket === ticket).slice(-3).map((r) => r.text);
  const substantive = isSubstantiveText(text, prior);
  t.replies = fresh([...t.replies, { ticket, jobId, at, text: String(text).slice(0, 500), substantive, claim: CLAIM.test(String(text)) }], at).slice(-600);
  if (substantive) (t.progress[ticket] ||= {}).lastSubstantiveAt = at;
  (t.progress[ticket] ||= {}).lastReplyAt = at;
}
function recordPlayerMessages(d, ticket, messages, at = Date.now()) {
  const t = trust(d);
  for (const m of messages || []) {
    const when = Date.parse(m.at) || at, text = String(m.content || "").slice(0, 400);
    if (!text || t.playerMessages.some((x) => x.ticket === ticket && x.at === when)) continue;
    t.playerMessages.push({ ticket, at: when, text });
  }
  t.playerMessages = fresh(t.playerMessages, at).slice(-600);
}
// Non-reply progress (a PR, a handoff, a release, a heal) calls this so it resets the stale clock.
function markProgress(d, ticket, at, kind) {
  const p = (trust(d).progress[ticket] ||= {});
  p.lastSubstantiveAt = Math.max(p.lastSubstantiveAt || 0, at); p.lastKind = kind;
}
// "Fixed/live" said, then the player (or a later Keir post) said otherwise.
function contradictedClaims(d, since, at) {
  const t = trust(d), out = [];
  for (const c of t.replies.filter((r) => r.claim && r.at >= since)) {
    const player = t.playerMessages.find((m) => m.ticket === c.ticket && m.at > c.at && NEGATIVE_REPLY.test(m.text));
    const later = t.replies.find((r) => r.ticket === c.ticket && r.at > c.at && /\b(?:correction|i was wrong|that was wrong|not (?:yet )?(?:fixed|live)|isn['’]t (?:fixed|live) yet)\b/i.test(r.text));
    if (player || later) out.push({ ticket: c.ticket, claimAt: c.at, claim: c.text.slice(0, 160), contradictedBy: player ? "player" : "later update", evidence: (player?.text || later.text).slice(0, 160) });
  }
  return out;
}
module.exports = { trust, recordReply, recordPlayerMessages, markProgress, contradictedClaims, isSubstantiveText, STILL_CHECKING, NEGATIVE_REPLY, KEEP_MS };
