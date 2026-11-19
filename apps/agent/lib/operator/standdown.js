"use strict";
const { JOB_TERMINAL } = require("./machines");
// Keir 10.1.14 stand-down fixes (live ledger review, 2026-11-17). Pure functions, no ledger writes except applyOwnerChannelAnswer.
//   A  noNewRefusal: no substantive post when nothing new arrived from the player and nothing changed since the last one.
//   B  limitationLine: "passed it to the developers" only with a developer-visible receipt for the open question.
//   C  holdingClaimRefusal, capabilityClaim: holding lines say what is checked, never a cause or a capability Keir lacks.
//   D  quoteFactors, priceVerdictRefusal: a build price verdict names the largest non-base factor in the quote breakdown.
//   E  promisesFollowUp, outstandingPromise: the closer never closes over a staff or bot promise that was not kept.
//   F  applyOwnerChannelAnswer, claimsOwnerWait: an owner decision given in the ticket channel is the answer.

const crypto = require("crypto");

// ---------- A: nothing new, nothing changed ----------
// What counts as "state changed": a handoff filed or released, a linked issue opened or closed, a decision opened or answered.
function stateFingerprint(d, ticketNo) {
  const jobs = Object.values(d.jobs || {}).filter((j) => Number(j.ticket) === Number(ticketNo));
  const parts = [];
  for (const j of jobs) {
    for (const r of j.raisedToDevelopers || []) parts.push(`h${r.id ?? ""}:${r.releasedAt ? 1 : 0}:${r.issue != null ? d.keirIssues?.[r.issue]?.state || "?" : ""}`);
  }
  for (const j of jobs) {
    if ((j.pullRequests || []).length) parts.push(`p${j.id}:${j.pullRequests.length}`);
    if (j.releaseEvidence) parts.push(`r${j.id}:${Object.keys(j.releaseEvidence).length}`);
  }
  for (const a of Object.values(d.actions || {})) if (jobs.some((j) => j.id === a.jobId)) parts.push(`a${a.id}:${a.state}`);
  for (const j of Object.values(d.jobs || {})) if (j.codingParent && jobs.some((p) => p.id === j.codingParent)) parts.push(`c${j.id}:${j.state}`);
  for (const x of Object.values(d.decisions || {})) if (jobs.some((j) => j.id === x.jobId)) parts.push(`d${x.id}:${x.state}`);
  parts.sort();
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

const CORRECTION = /^(?:correction|to correct my (?:last|previous|earlier) message)\b/i;
const INTRO = /^hi,? i(?:'|’)?m keir\b/i;

const tokens = (t) => new Set(String(t || "").toLowerCase().match(/[a-z0-9]{4,}/g) || []);
function similarity(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0; for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}
// last: d.lastSubstantive[ticket] = { at, fp }. Returns a refusal string or null.
function noNewRefusal({ newRead = false, last, humanAt = 0, fp, message, answeringStaff = false, now = Date.now() }) {
  if (!last || !last.fp || answeringStaff) return null;
  const text = String(message || "").trim();
  if (!text || CORRECTION.test(text) || INTRO.test(text)) return null;
  if (humanAt > last.at) return null; // the player wrote since
  if (last.question) return null; // the last post asked the player something; a finding after it is new
  if (last.fp !== fp) return null; // something changed since
  // Only a restatement is noise: a different finding or a different answer is new information even without a new player message.
  if (last.text) { const sim = similarity(last.text, text); if (sim < (newRead ? 0.8 : 0.35)) return null; }
  else if (newRead) return null;
  return `Not posted: the player has not written since your last post here (${Math.max(1, Math.round((now - last.at) / 60000))} min ago) and nothing on the ticket has changed since. A second message with no new information is noise. Keep working privately; post when the player writes or when a handoff, fix, issue or decision actually changes.`;
}

// ---------- B: the limitation line ----------
const PASSED_ON = "I haven't got a confirmed answer for you yet. I've passed it to the developers and will reply here when I do.";
const NOT_PASSED_ON = "I haven't got a confirmed answer for you yet. I'm still working on it and will reply here when I do.";
// receipt: the raise_to_developers result for the CURRENT open question, with the item that was filed. A self-owned card
// (Keir's own board) is not the developers having it.
function limitationLine(receipt) {
  const ok = receipt && receipt.raised === true && receipt.id != null && !receipt.selfOwned;
  return ok ? PASSED_ON : NOT_PASSED_ON;
}
// Did this activation file the receipt for the open question? cutoff: the player's latest message time.
function currentQuestionReceipt(jobs, humanAt, { since = 0 } = {}) {
  let best = null;
  for (const j of jobs || []) for (const r of j.raisedToDevelopers || []) {
    if (r.selfOwned || r.releasedAt || r.id == null) continue;
    if ((r.at || 0) < Math.max(humanAt || 0, since)) continue;
    if (!best || (r.at || 0) > (best.at || 0)) best = r;
  }
  return best ? { raised: true, id: best.id, selfOwned: false } : null;
}

// ---------- C: holding lines and capability claims ----------
const HOLDING = /\b(?:i(?:'|’)?m|i am|we(?:'|’)?re|we are|still|currently)\s+(?:still\s+)?(?:checking|looking|investigating|digging|working|reading|tracing|verifying)\b|\bchecking (?:whether|if|why|what)\b|\blooking into\b|\bi(?:'|’)?ll (?:check|look)\b/i;
// A cause or state asserted as fact inside a line that only promises a check.
const GUESS = /\b(?:because|probably|likely|presumably|might be|may be|could be|seems? (?:to be|like|that)|suspect|due to|caused by|the (?:cause|reason|problem|issue) is|has nothing|has no\b|have no\b|have nothing|is missing|is empty|isn'?t (?:set|configured|reaching)|not (?:set up|configured|reaching)|so i(?:'|’)?m checking (?:whether|if)|so i am checking (?:whether|if))\b/i;
const sentenceCount = (t) => String(t || "").split(/(?<=[.!?])\s+/).filter(Boolean).length;

function isHoldingLine(message) {
  const t = String(message || "").trim();
  return t.length > 0 && sentenceCount(t) <= 3 && HOLDING.test(t);
}
function holdingClaimRefusal(message) {
  if (!isHoldingLine(message)) return null;
  const m = GUESS.exec(message);
  if (!m) return null;
  return `Not posted: this holding line states a cause or a state of the player's account as fact ("${m[0]}") that nothing has verified. A holding line says only what is being checked ("I am checking X"), never why it is wrong or what the account has or lacks. Rewrite it as what you are checking, or finish the investigation and post the finding with its read.`;
}

// Keir reads game records and code. It does not open the game on a phone or in a browser, and it is not the player's device.
const CAP_OBJECT = "phone|phones|mobile|device|devices|browser|browsers|iphone|android|ios|tablet|screen|site|website|web page|webpage|page|pages|app|client|desktop|laptop";
const CAPABILITY = new RegExp(
  `\\b(?:loads?|loaded|works?|worked|opens?|opened|renders?|rendered|looks?|looked|displays?|displayed|runs?|ran|shows?|showed)\\b[^.!?]{0,40}\\bfor me\\b` +
  `|\\bfor me\\b[^.!?]{0,30}\\b(?:loads?|works?|opens?|renders?|looks? (?:fine|right|normal|ok|okay)|displays?|runs?)\\b` +
  `|\\bi(?:'|’)?ve (?:tested|tried|loaded|opened|visited|browsed|checked|viewed|seen)\\b[^.!?]{0,60}\\b(?:${CAP_OBJECT})\\b` +
  `|\\bi (?:tested|tried|loaded|opened|visited|browsed|viewed|saw|ran)\\b[^.!?]{0,60}\\b(?:${CAP_OBJECT})\\b` +
  `|\\bon (?:a|my|an|the) (?:phone|mobile|iphone|android|tablet|device)\\b[^.!?]{0,40}\\b(?:loads?|works?|looks?|renders?|opens?)\\b`, "i");
function capabilityClaim(message) {
  const m = CAPABILITY.exec(String(message || ""));
  if (!m) return null;
  return `Not posted: "${m[0].slice(0, 80)}" claims Keir tested or loaded something as a user would. Keir reads game records and code; it cannot open the site, a phone or a browser. Say what the records and code show, and ask the player for the device, browser and what they see.`;
}

// ---------- D: build quote breakdown ----------
const FACTORS = [
  { key: "dominanceMultiplier", label: "dominance surcharge", words: /\bdominan|\bmarket share\b|\bsurcharge\b|\btoll\b/i },
  { key: "commodityDominanceMultiplier", label: "commodity dominance toll", words: /\bcommodity\b[^.!?]{0,30}\b(?:toll|dominan|share)|\bdominan|\btoll\b/i },
  { key: "rateMultiplier", label: "interest rate (prime rate) multiplier", words: /\b(?:interest|prime|rates?|financing)\b/i },
  { key: "hostPriceMultiplier", label: "host country price level", words: /\b(?:host|cost of living|price level|local prices?|country)\b/i },
  { key: "foundingMultiplier", label: "founding discount", words: /\bfounding|first (?:facility|plant|build)\b/i },
  { key: "expansionMultiplier", label: "expansion discount", words: /\bexpansion|expanding\b/i },
  { key: "acumenMultiplier", label: "CEO acumen discount", words: /\bacumen\b/i },
  { key: "techMultiplier", label: "tech discount", words: /\btech/i },
];
const NEUTRAL = 0.05; // within 5% of 1.0 is not a factor worth naming

// Reads the quote breakdown from any read text. Accepts JSON fields ("dominanceMultiplier": 1.5) or "dominanceMultiplier 1.5".
function quoteFactors(texts) {
  const found = {};
  for (const t of texts || []) {
    const s = String(t || "").replace(/\\"/g, '"');
    for (const f of FACTORS) {
      const m = new RegExp(`["']?${f.key}["']?\\s*[:=]?\\s*"?(-?\\d+(?:\\.\\d+)?)`, "i").exec(s);
      if (m && !(f.key in found)) found[f.key] = Number(m[1]);
    }
  }
  const list = FACTORS.filter((f) => f.key in found && Number.isFinite(found[f.key]) && found[f.key] > 0).map((f) => ({ ...f, value: found[f.key], size: Math.abs(Math.log(found[f.key])) }));
  // commodityDominanceMultiplier is the commodity part of dominanceMultiplier (the larger of the two is charged): do not name both.
  const dom = list.find((f) => f.key === "dominanceMultiplier"), com = list.find((f) => f.key === "commodityDominanceMultiplier");
  const pruned = dom && com ? list.filter((f) => f !== (com.value > dom.value ? dom : com)) : list;
  const significant = pruned.filter((f) => Math.abs(f.value - 1) > NEUTRAL).sort((a, b) => b.size - a.size);
  return { all: pruned, largest: significant[0] || null, present: pruned.length > 0 };
}

const PRICE_VERDICT = /\b(?:no|not a|isn'?t a|nothing (?:wrong|odd|off) (?:with|in))\b[^.!?]{0,30}\b(?:pricing|price|cost|charge)\b[^.!?]{0,20}\b(?:fault|bug|error|problem|issue|wrong)\b|\bpric(?:e|ing|es) (?:is|are|looks?|seems?) (?:correct|right|fine|as (?:intended|designed|expected)|working)\b|\b(?:working as (?:intended|designed)|as designed)\b[^.!?]{0,60}\b(?:price|cost|pricing)\b|\b(?:price|cost|pricing)\b[^.!?]{0,60}\b(?:working as (?:intended|designed)|as designed)\b|\b(?:each|per unit|a unit)\b[^.!?]{0,40}\$\s?\d/i;
const BUILD_PRICE = /\b(?:build|plant|capacity|facility|facilities|construct\w*|units?)\b/i;

// null when fine. texts: this ticket's reads. Applies only to a verdict or explanation of a build price.
function priceVerdictRefusal(message, texts) {
  const msg = String(message || "");
  if (!PRICE_VERDICT.test(msg) || !BUILD_PRICE.test(msg)) return null;
  const q = quoteFactors(texts);
  if (!q.present) return "Not posted: this gives a verdict on a build price, but no read on this ticket shows the quote breakdown. Read the build quote (it lists the dominance, commodity toll, rate, host country, founding and expansion factors) and base the verdict on it.";
  if (!q.largest) return null;
  const named = q.largest.words.test(msg);
  if (named) return null;
  return `Not posted: a build price verdict must name the largest factor above the base price. The quote read on this ticket has ${q.largest.label} at ${q.largest.value}x. Say that this factor is in the price and how much of it it makes up, then give the verdict.`;
}

// ---------- E: promises that were never kept ----------
const PROMISE = /\b(?:still being (?:looked|checked|investigated|worked)|being looked into|(?:i|we)(?:'|’)?(?:ll| will| am going to) (?:update|let you know|come back|follow up|get back|report back|reply|check|look)|will (?:update|follow up|get back|reply|let you know)|(?:i am|i'm|we are|we're) (?:still )?(?:looking into|investigating|checking|working on)|will reply here|more (?:to (?:come|follow)|soon))\b/i;
function promisesFollowUp(text) { return PROMISE.test(String(text || "")); }
// rows: channel messages; isAnswer(row) says staff or bot. The latest answer-side post decides: a promise stands until a later
// answer-side post that does not itself promise something.
function outstandingPromise(rows, isAnswer) {
  const answers = (rows || []).filter(isAnswer).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const last = answers.at(-1);
  return Boolean(last && promisesFollowUp(last.content));
}

// ---------- F: the owner answered in the channel ----------
const OWNER_WAIT = /\b(?:needs?|awaiting|waiting (?:on|for)|pending|with|up to|for) (?:the )?owner(?:'s)?(?: decision| call| answer| approval| yes)?\b|\bowner(?:'s)? (?:decision|call|approval|answer)\b[^.!?]{0,40}\b(?:needed|pending|awaited|required|outstanding)\b|\bneeds the owner\b|\bthe owner has to decide\b/i;
function claimsOwnerWait(message) { return OWNER_WAIT.test(String(message || "")); }

// Marks every free-text pending decision on this ticket answered by the owner's channel message. Decisions that gate an
// action (actionId, binds, review) still need the button: a sentence in a channel is direction, not execution approval.
function applyOwnerChannelAnswer(d, { ticket, ownerId, authorId, text, messageId = null, at = Date.now() }) {
  if (!ticket || !ownerId || authorId !== ownerId) return [];
  const content = String(text || "").trim();
  if (!content || content.startsWith("/")) return [];
  const jobs = Object.values(d.jobs || {}).filter((j) => Number(j.ticket) === Number(ticket));
  const answered = [];
  for (const x of Object.values(d.decisions || {})) {
    if (x.state !== "pending" || !jobs.some((j) => j.id === x.jobId)) continue;
    if (x.actionId || x.binds) continue;
    if ((x.at || 0) > at) continue;
    x.state = "answered"; x.answeredAt = at; x.answeredBy = ownerId; x.answerText = content.slice(0, 600); x.answeredVia = "ticket_channel"; x.answerMessage = messageId;
    answered.push(x.id);
  }
  (d.ownerChannelAnswers ||= {})[ticket] = { at, text: content.slice(0, 600), message: messageId, decisions: answered };
  for (const j of jobs) {
    if (!answered.length) break;
    if (Object.values(d.decisions || {}).some((y) => y.state === "pending" && y.jobId === j.id)) continue;
    if (!answered.some((id) => d.decisions[id].jobId === j.id)) continue;
    delete j.ownerDecisionPending;
    (j.inbox ||= []).push({ authorId: ownerId, role: "owner", at: new Date(at).toISOString(), decision: answered[0],
      content: `The owner answered the open decision in the ticket channel: ${content.slice(0, 600)}. Treat it as the decision (direction, not execution approval). Do not tell the player it is still waiting on the owner.` });
    if (!JOB_TERMINAL.includes(j.state)) { j.state = "queued"; j.wakeAt = 0; }
  }
  return answered;
}
// The owner has spoken on this ticket after the newest decision was raised, so "waiting on the owner" is false.
function ownerAnsweredSince(d, ticket) {
  const a = d.ownerChannelAnswers?.[ticket];
  if (!a) return false;
  const jobs = Object.values(d.jobs || {}).filter((j) => Number(j.ticket) === Number(ticket));
  const newer = Object.values(d.decisions || {}).some((x) => jobs.some((j) => j.id === x.jobId) && (x.at || 0) > a.at);
  return !newer;
}

module.exports = { stateFingerprint, noNewRefusal, limitationLine, currentQuestionReceipt, PASSED_ON, NOT_PASSED_ON, isHoldingLine, holdingClaimRefusal, capabilityClaim,
  quoteFactors, priceVerdictRefusal, promisesFollowUp, outstandingPromise, claimsOwnerWait, applyOwnerChannelAnswer, ownerAnsweredSince };
