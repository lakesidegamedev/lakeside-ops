"use strict";
// Keir 9, feature B: one checked answer, reused when several players report the same fault.
//
// Code only, no model. When a ticket task starts it is compared with tickets from the last 72 hours. A match needs
// at least two independent signals (similar wording, the support search returning that ticket, the same screen or
// file name, the same place, the same turn number) and the reasons are recorded. The earlier ticket's answer is
// offered as context only if it was posted with a code-written "From:" line (so it rests on reads), was never
// corrected by Keir and was not disputed by its player afterwards. The new task must still read this player's own
// figures (the existing number check is untouched), and a post that contradicts the earlier checked answer on the
// same fault is refused once with both texts, so the task aligns or says why this player's case differs.
const { isCorrection } = require("./playercopy");

const WINDOW_MS = 72 * 3600000;
const KEEP_MS = 5 * 86400000;
const MAX_ANSWERS = 120;
const MIN_SIGNALS = 2;
const SIMILAR = 0.3;
const SIMILAR_WORDS = 3;

const STOP = new Set("the and for you that this with have not but are was were can why what when how from they them then there their into out all any get got its our your its just also now has had did does don't dont still about after before again which would could should been being very more some than too only over under".split(" "));
const FROM_LINE = /(?:^|\n)\s*From:\s*([^\n]{3,160})\s*$/;
const DISPUTE = /\b(?:still (?:not|wrong|broken|the same|happening|showing|there|missing|no)|that(?:'|’)?s (?:not|wrong|incorrect)|not (?:right|correct|true|fixed|working)|isn(?:'|’)?t (?:right|correct|true|fixed|working)|doesn(?:'|’)?t (?:match|work|add up|help|fix)|you(?:'|’)?re wrong|incorrect|wrong|disagree|no it|same (?:issue|problem|error)|again)\b/i;

const wordsOf = (t) => new Set((String(t || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter((w) => !STOP.has(w)));
const reportOf = (j) => [j?.source, ...(j?.requestInbox || [])].filter(Boolean).slice(0, 3).map((s) => String(s.content || "")).join("\n").slice(0, 1500);
const jobAt = (j) => Date.parse(j?.at) || Number(j?.at) || 0;

// Screen and file names: URL paths and file names in the report.
function screensOf(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(/(?:https?:\/\/[^\s/]+)?(\/[a-z][a-z0-9_-]{2,}(?:\/[a-z0-9_-]{1,40}){0,3})(?=[\s?#.,;:)]|$)/gi)) out.add(m[1].toLowerCase());
  for (const m of String(text || "").matchAll(/\b([\w-]{2,40}\.(?:png|jpe?g|gif|webp|json|csv|txt|log))\b/gi)) out.add(m[1].toLowerCase());
  return out;
}
const turnsOf = (text) => new Set([...String(text || "").matchAll(/\bturn\s*#?\s*(\d{1,6})\b/gi)].map((m) => m[1]));
const placesOf = (text) => new Set([...String(text || "").matchAll(/\b(?:sector|country|region|state|province)\s+(?:of\s+|called\s+|named\s+)?([A-Z][A-Za-z-]{2,})/g)].map((m) => m[1].toLowerCase()));

const shared = (a, b) => [...a].filter((x) => b.has(x));

/** The reasons two reports are the same problem, one entry per independent kind of signal. */
function signals(newText, oldText, { searched = false } = {}) {
  const out = [];
  const a = wordsOf(newText), b = wordsOf(oldText);
  const both = shared(a, b);
  const jaccard = a.size && b.size ? both.length / (a.size + b.size - both.length) : 0;
  if (both.length >= SIMILAR_WORDS && jaccard >= SIMILAR) out.push({ kind: "wording", detail: `${Math.round(jaccard * 100)}% of the key words match` });
  if (searched) out.push({ kind: "search", detail: "the support search for this report returned it" });
  const screens = shared(screensOf(newText), screensOf(oldText));
  if (screens.length) out.push({ kind: "screen", detail: `same screen or file ${screens[0]}` });
  const places = shared(placesOf(newText), placesOf(oldText));
  if (places.length) out.push({ kind: "place", detail: `same place ${places[0]}` });
  const turns = shared(turnsOf(newText), turnsOf(oldText));
  if (turns.length) out.push({ kind: "turn", detail: `same turn ${turns[0]}` });
  return out;
}

const store = (d) => (d.checkedAnswers ||= {});

/** Called for every public post that is not a status card. Keeps answers that carry a code-written source line. */
function noteAnswer(d, ticket, message, { at = Date.now(), jobId } = {}) {
  const text = String(message || "").trim();
  if (!text) return;
  const all = store(d), key = String(ticket);
  // A later correction by Keir retracts everything earlier on the ticket.
  if (isCorrection(text)) { for (const a of all[key] || []) a.corrected = at; return; }
  const m = FROM_LINE.exec(text);
  if (!m) return;
  const body = text.slice(0, m.index).trim();
  if (body.length < 12) return;
  all[key] = [...(all[key] || []), { at, jobId, text: body.slice(0, 600), source: m[1].replace(/\.\s*$/, "").slice(0, 120) }].slice(-3);
  const keys = Object.keys(all);
  if (keys.length > MAX_ANSWERS) for (const k of keys.sort((x, y) => (all[x].at(-1)?.at || 0) - (all[y].at(-1)?.at || 0)).slice(0, keys.length - MAX_ANSWERS)) delete all[k];
  for (const k of Object.keys(all)) if (at - (all[k].at(-1)?.at || 0) > KEEP_MS) delete all[k];
}

/** Whether the player wrote something after the answer that reads as disagreement. */
function disputed(d, ticket, answer) {
  return (d.trust?.playerMessages || []).some((m) => m.ticket === ticket && m.at > answer.at && DISPUTE.test(String(m.text || "")));
}

/** The usable checked answer on a ticket: posted, sourced, not corrected, not disputed. */
function usable(d, ticket, now) {
  const list = (d.checkedAnswers?.[String(ticket)] || []).filter((a) => now - a.at < WINDOW_MS && !a.corrected);
  for (let i = list.length - 1; i >= 0; i--) if (!disputed(d, ticket, list[i])) return list[i];
  return null;
}

/**
 * Best earlier ticket with a checked answer that matches this job on at least two independent signals.
 * `hits` is the set of ticket numbers a support search returned for this report (may be empty).
 */
function findMatch(d, job, { now = Date.now(), hits = [] } = {}) {
  const text = reportOf(job);
  if (!job?.ticket || text.length < 12) return null;
  const hitSet = new Set((hits || []).map(Number));
  let best = null;
  for (const n of Object.keys(d.checkedAnswers || {})) {
    const ticket = Number(n);
    if (ticket === job.ticket) continue;
    const other = d.jobs?.[d.seen?.[`ticket:${ticket}`]];
    if (!other || other.internalProbe || ["moderation", "investigation"].includes(d.channels?.[other.channelId]?.category)) continue;
    const answer = usable(d, ticket, now);
    if (!answer) continue;
    const why = signals(text, reportOf(other), { searched: hitSet.has(ticket) });
    if (why.length < MIN_SIGNALS) continue;
    if (!best || why.length > best.why.length || why.length === best.why.length && answer.at > best.answer.at) best = { ticket, answer, why };
  }
  return best;
}

const clip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);

/** The context block for the new task. The answer is evidence to adapt, never text to paste. */
function contextFor(match) {
  return {
    ticket: match.ticket,
    matchedOn: match.why.map((w) => `${w.kind}: ${w.detail}`),
    summary: `Ticket ${match.ticket} had the same problem; the answer given there, checked against ${match.answer.source}, was: ${clip(match.answer.text, 420)}`,
    instruction: "Reuse the finding, not the wording. Read this player's own figures and page first (their numbers, their turn); the earlier player's figures are not evidence for this ticket. If this player's case differs, say how. Never mention the other ticket or player to this player.",
  };
}

// The direction an answer takes on a fault: it is working as designed, or it is a fault.
const BY_DESIGN = /\bas (?:designed|intended)\b|\bby design\b|\bworking (?:correctly|as expected)\b|\bnot (?:a|an) (?:bug|error|fault|mistake)\b|\bexpected (?:behaviou?r|result)\b|\bworks that way\b/i;
const FAULT = /\b(?:is|was|are|were) (?:a |an )?(?:bug|bugged|broken|incorrect|wrong|an error|a fault|a mistake|a display error)\b|\b(?:found|confirmed) (?:a |an |the )?(?:bug|fault|error|mistake)\b|\breading the wrong\b|\bshould not (?:show|read|say)\b/i;
function verdict(text) {
  const t = String(text || "");
  if (BY_DESIGN.test(t)) return "by-design";
  return FAULT.test(t) ? "fault" : null;
}

/** Refusal text when the draft takes the opposite direction to the earlier checked answer, else null. */
function contradiction(draft, match) {
  const a = verdict(match.answer.text), b = verdict(draft);
  if (!a || !b || a === b) return null;
  return `Not posted: this contradicts the checked answer already given on the same problem (checked against ${match.answer.source}). Earlier answer: "${clip(match.answer.text, 300)}" Your draft: "${clip(draft, 300)}" Either align with the earlier answer, or say plainly what is different about this player's case and post again; that post will go out.`;
}

/** Matching phrase for broker.js PACING_REFUSAL: a consistency refusal owes the player nothing new. */
const REFUSAL_TEXT = /contradicts the checked answer/;

module.exports = { findMatch, noteAnswer, contextFor, contradiction, verdict, signals, usable, disputed, REFUSAL_TEXT, WINDOW_MS };
