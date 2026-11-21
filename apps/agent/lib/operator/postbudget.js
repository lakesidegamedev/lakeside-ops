"use strict";
// Keir 11.2 (audit 2026-11-21, P1-3): a ticket post budget.
//
// Ticket 1845 got 58 Keir posts against 11 human messages, eight of them "This is now live on the main server", and
// per-turn reports that repeated the same answer with new numbers. Three rules, all pure functions over the ticket's
// post record; the broker's post guard applies them:
//   1. Live: one "now live" announcement per ticket per shipped change (main release receipt), whichever voice makes
//      it: the status card notice and the model's own post never both announce the same release.
//   2. Turn updates: a turn report with no new player message since the last one goes out only when the answer
//      changed (sold out to flooded, loss to profit, broken to fixed), not merely the numbers.
//   3. Hourly cap: at most KEIR_TICKET_POSTS_PER_HOUR (default 4) Keir posts in an hour with no new player message.
//      Past the cap, one merged message may still go out if it carries a correction or an answer the player is owed;
//      anything else is refused with an instruction to merge it, never dropped silently.
const HOUR = 3600000;
const DEFAULT_PER_HOUR = 4;

const isCard = (p) => (p.kind ? p.kind === "status_card" : String(p.text || "").startsWith("[status card]"));
const LIVE = /\blive on the main server\b|\b(?:is|are) (?:now )?live\b|\blive (?:from|since) this turn\b|\bnow (?:in|on) the (?:live )?(?:game|main server)\b|\bon the main server\b/i;
const FUTURE = /\b(?:will be|once it(?:'s| is)|when it(?:'s| is)|not yet|is not on|isn't on|goes live|reaches)\b/i;
function liveClaim(text) { const t = String(text || ""); return LIVE.test(t) && !FUTURE.test(t); }

// Keir posts after the player's last message, within the last hour. Posts answering the owner or a developer (staff) are
// not the player's budget (review M6).
function recentRun(posts, humanAt, now) { return (posts || []).filter((p) => !isCard(p) && !p.staff && p.at > (humanAt || 0) && now - p.at < HOUR); }

// { allow, overflow, count }. essential: a correction, or an answer the player is owed. overflowUsedAt: when the one merged
// overflow message for this player message went out (null if not yet).
function hourly({ posts, humanAt, now, cap = DEFAULT_PER_HOUR, essential = false, overflowUsedAt = null }) {
  const count = recentRun(posts, humanAt, now).length;
  if (count < cap) return { allow: true, overflow: false, count };
  // Third pass: an essential post (a correction, an answer the player is owed or asked for, a promised follow-up) always
  // goes out; the cap holds back only unprompted posts.
  if (essential) return { allow: true, overflow: true, count };
  const used = overflowUsedAt && overflowUsedAt > (humanAt || 0) && now - overflowUsedAt < HOUR;
  return { allow: false, overflow: false, count, used: Boolean(used) };
}
function hourlyRefusal(r, cap) {
  return r.used
    ? `Not posted: Keir has posted ${r.count} times in this ticket in the last hour with no new message from the player, and the one merged message past that limit already went out. Hold this until the player writes or the hour passes; if it corrects something, it goes first in your next message.`
    : `Not posted: Keir has posted ${r.count} times in this ticket in the last hour with no new message from the player (limit ${cap}). Merge what is still needed into one message. A correction or an answer the player is owed goes out as that one message; anything else waits for the player or the next hour.`;
}

// Turn reports. The "answer" is the set of outcome words a report carries, not its figures.
const TURN = /\bturn\s+\d+\b|\b(?:this|last|latest) turn\b/i;
const ANSWERS = [
  ["sold", /\bsold (?:out|every|all)\b|\bevery (?:basket|unit)\b[^.]{0,40}\bsold\b|\ball of it sold\b/i],
  ["unsold", /\bno sales\b|\bunsold\b|\bflooded\b|\bnot selling\b|\bsold nothing\b/i],
  ["profit", /\bprofit(?:able)?\b|\bmade money\b|\bin profit\b|\bgained\b/i],
  ["loss", /\bloss(?:es)?\b|\blost\b|\bnot making money\b|\bnegative\b/i],
  ["up", /\brose\b|\bup (?:to|from)\b|\bincreas\w*\b|\bhigher\b|\bclimb\w*\b/i],
  ["down", /\bfell\b|\bdown (?:to|from)\b|\bdecreas\w*\b|\blower\b|\bdropped\b/i],
  ["same", /\bunchanged\b|\bstill\b|\bno change\b|\bheld\b|\bagain\b|\bsteady\b/i],
  ["fixed", /\bfixed\b|\bworking\b|\bresolved\b|\bhas turned\b/i],
  ["broken", /\bnot fixed\b|\bnot working\b|\bstill broken\b|\bnot bringing\b/i],
];
const CORE = new Set(["sold", "unsold", "profit", "loss", "fixed", "broken"]);
function isTurnUpdate(text) { return TURN.test(String(text || "")); }
function answerOf(text) { const t = String(text || ""); return ANSWERS.filter(([, re]) => re.test(t)).map(([k]) => k).sort().join(","); }
// The earlier turn report this one repeats, or null. Only reports since the player's last message count.
function repeatsTurnAnswer({ posts, humanAt, message }) {
  if (!isTurnUpdate(message)) return null;
  const prior = (posts || []).filter((p) => !isCard(p) && p.at > (humanAt || 0) && isTurnUpdate(p.text)).at(-1);
  if (!prior) return null;
  // Direction and "still/again" words move with the numbers; the answer is what sold, whether money was made, whether it is fixed.
  const core = (x) => answerOf(x).split(",").filter((k) => CORE.has(k));
  const a = core(message), b = new Set(core(prior.text));
  return a.length && a.every((k) => b.has(k)) ? prior : null;
}

// Keir 11.2 second pass: turn commentary is opt-in. "A turn ran" is never by itself a reason to post. A turn report goes
// out only when it answers the player (they wrote since Keir last posted), corrects something, keeps a recorded promise
// that is due, or is the specific turn result the job's closing condition calls for; a called-for report that repeats the
// previous report's answer is still refused (the item 8 rule, now part of this one rule).
const REPORT = /\bturns?\s+\d+\s*(?::|has (?:now )?run|ran\b|has been processed|brought|figures|held|answers|results?\b|was\b|is in\b)|\b(?:on|after|by|since) turn \d+\b|\b(?:this|last|latest|that) turn(?:'s)?\b|\bthe (?:next )?turn has (?:now )?run\b|\b\w+ turns? (?:running|in a row)\b/i;
function isTurnReport(text) { return REPORT.test(String(text || "")); }
// { posts, humanAt, message, correction, promiseDue, calledFor } -> null (may post) or { why, refusal, prior }.
// lastKeirAt: Keir's last post from a durable record (the post window above is emptied after an hour of quiet).
// Why a post may go out under the turn rule: null (not a turn report), "correction", "answer", "promise" or "closing";
// "refused" when it may not.
function turnPostVia({ posts, humanAt, message, correction = false, promiseDue = false, calledFor = false, lastKeirAt = 0 }) {
  if (!isTurnReport(message) || /\?\s*$/.test(String(message).trim())) return null;
  if (correction) return "correction";
  const lastAt = Math.max((posts || []).filter((p) => !isCard(p)).at(-1)?.at || 0, lastKeirAt || 0);
  // The first answer on a ticket, or one after the player wrote, answers them; only an unprompted follow-up is commentary.
  if (!lastAt || (humanAt || 0) > lastAt) return "answer";
  if (promiseDue) return "promise";
  if (calledFor && !repeatsTurnAnswer({ posts, humanAt, message })) return "closing";
  return "refused";
}
function turnPostRule(args) {
  if (turnPostVia(args) !== "refused") return null;
  const { posts, humanAt, message, calledFor } = args;
  if (calledFor) {
    const prior = repeatsTurnAnswer({ posts, humanAt, message });
    return { why: "same turn answer", prior, refusal: `Not posted: this turn report gives the same answer as the last one ("${String(prior.text).slice(0, 140)}") and the player has not written since. Post a turn report only when the answer changes; keep checking privately.` };
  }
  return { why: "turn not called for", refusal: "Not posted: a turn having run is not a reason to post. A turn report goes out only when the player asked, a promise you made is due, or your closing condition (closesWhen and waitingOn) calls for this turn's result. Keep checking privately, or set waitOn {kind: \"turn\", ref: N} for the one turn whose result the player needs." };
}

// The ticket's main release receipt: one key per shipped change set, and when it arrived.
function mainReceipt(jobs) {
  const rows = (jobs || []).flatMap((j) => Object.entries(j.releaseEvidence || {}).filter(([, r]) => r && r.main).map(([k, r]) => ({ k, at: Number(r.at) || 0 })));
  if (!rows.length) return null;
  return { key: rows.map((r) => r.k).sort().join("|"), at: Math.max(...rows.map((r) => r.at)) };
}
// A live announcement (notice or post) already made for this receipt, after the player last spoke.
function liveAlreadySaid({ posts, receipt, humanAt }) {
  if (!receipt) return null;
  return (posts || []).find((p) => !isCard(p) && p.at >= receipt.at && p.at > (humanAt || 0) && liveClaim(p.text)) || null;
}

module.exports = { isTurnReport, turnPostRule, turnPostVia, hourly, hourlyRefusal, recentRun, isTurnUpdate, answerOf, repeatsTurnAnswer, mainReceipt, liveAlreadySaid, liveClaim, DEFAULT_PER_HOUR, HOUR };
