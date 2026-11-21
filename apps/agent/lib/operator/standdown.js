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
    // Keir 11.4: a card Keir's own coding worker took is Keir's work, not the developers'.
    if (r.selfOwned || r.releasedAt || r.id == null || r.workerRun) continue;
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

// Keir 11.2 (audit 2026-11-21): any owner sentence in a ticket used to answer every open question on it. All three cases
// in two weeks were wrong ("can you link it here for review?" answered "Ship PR 6865 now?"; "yeah automobiles was removed"
// answered "Raise the demand cap?"; "Keir is wrong" answered a pricing question). A channel message now answers a question
// only when it is a Discord reply to that question's message, or it clearly names one option: its number, its full label,
// or yes or no when the question is a single yes or no. Anything else stays context and the question stays open.
// Decisions that gate an action (actionId, binds) still need the button: a sentence in a channel is direction, not approval.
const YES = /^(?:yes|yeah|yep|yup|y|ok(?:ay)?|sure|approved?|go ahead|do it|ship it|go for it|sounds good|agreed)$/i;
const NO = /^(?:no|nope|nah|n|declined?|rejected?|don'?t|do not|hold off|not now|leave it)$/i;
const norm = (t) => String(t || "").toLowerCase().replace(/[*_`~>]/g, " ").replace(/[^a-z0-9%$.' ]+/g, " ").replace(/\s+/g, " ").trim();
// Keir 11.2 third pass (review M1): a yes next to a question or a deferral is not an answer ("ok, let me look at the
// numbers first"; "yes? why is it so large").
const DEFER = /\?|\b(?:let me|let's see|first|later|hold on|hang on|wait|why|but|not sure|maybe|hmm|think|check|look)\b/i;
// yes, no, or null. Only a standalone clause counts: "Do the refund, yes." is yes; "yeah automobiles was removed" is not.
// Fourth pass (review N4): a yes word and a no word anywhere in the same message ("No, absolutely yes") answer nothing.
const YES_WORD = /\b(?:yes|yeah|yep|yup|ok(?:ay)?|sure|approved?|go ahead|do it|ship it|go for it)\b/i;
const NO_WORD = /\b(?:no|nope|nah|declined?|rejected?|don'?t|do not|hold off|not now)\b/i;
function yesNo(text) {
  const t = String(text || "");
  const clauses = t.split(/[,.;!?\n]+/).map((c) => c.trim().replace(/\s+/g, " ")).filter(Boolean);
  const yes = clauses.some((c) => YES.test(c)), no = clauses.some((c) => NO.test(c));
  if (yes === no) return null;
  if (YES_WORD.test(t) && NO_WORD.test(t)) return null;
  const rest = clauses.filter((c) => !YES.test(c) && !NO.test(c)).join(" ");
  if (DEFER.test(rest) || /\?/.test(t)) return null;
  return yes ? "yes" : "no";
}
// The message with lead-ins and politeness trimmed: "go with Refund the player please" -> "refund the player".
const LEAD = /^(?:(?:ok(?:ay)?|yes|yeah|sure)\s+)?(?:let'?s\s+)?(?:go with|pick|choose|take|do|i choose|i pick|option)\s+/;
const TAIL = /\s+(?:please|thanks|thank you|for now)$/;
const bare = (text) => norm(text).replace(/[.!']/g, "").replace(LEAD, "").replace(TAIL, "").trim();
// Review 3 F4: a number names an option only as the whole message ("1", "option 2", "go with 2 please"), or, inside a
// reply to the question, as "option N" in a sentence that does not negate, defer or ask ("not option 2", "don't do
// option 1", "option 1 looks wrong, why 500?" choose nothing).
function optionNumber(text, { reply = false } = {}) {
  const t = String(text || "").trim();
  const whole = /^(?:option|choice|#)?\s*([1-6])(?:\s+(?:please|thanks|thank you))?\s*[.!)]?$/i.exec(t) || /^(?:go with|pick|choose|take)\s+(?:option\s*|choice\s*)?#?([1-6])(?:\s+(?:please|thanks|thank you))?\s*[.!]?$/i.exec(t);
  if (whole) return whole[1];
  const inside = reply && /\b(?:option|choice)\s*#?\s*([1-6])\b/i.exec(t);
  if (!inside || /\?/.test(t)) return null;
  const rest = norm(t.replace(inside[0], " "));
  return NEGATES.test(rest) || DEFER.test(rest) ? null : inside[1];
}
// Fourth pass (review N4): a label inside a negated, deferring or conditional sentence is not a choice ("we should not
// refund the player until I check", "dont refund the player yet", "refund the player later maybe").
// Review 3 F4: naming an option to reject it ("anything but", "other than", "X is wrong") is not choosing it.
const NEGATES = /\b(?:not|don'?t|dont|never|no|nope|won'?t|wont|shouldn'?t|can'?t|until|unless|instead|yet|later|maybe|perhaps|if|whether|but|except|other than|rather than|wrong|bad|against)\b|^\s*(?:should|shall|do|does|did|can|could|would|will|is|are|what|why|how|when|who)\b/i;
// The option this message clearly names, or null. A single-choice question (no options) takes a yes or no.
// Outside a Discord reply to the question only the whole message names an option; inside a reply a label may sit in a
// longer sentence, but never one that negates, defers or asks.
function namedOption(x, text, { alone, reply = false }) {
  const options = x.options || [];
  if (!options.length) { const yn = yesNo(text); return yn ? { free: yn } : null; }
  const n = alone ? optionNumber(text, { reply }) : null;
  if (n && options.some((o) => o.id === n)) return options.find((o) => o.id === n);
  // A label counts when it is the whole message (after "go with", "please" and the like), or when it is at least two
  // words long and the message is not a question. "wait, why is the refund so large?" does not pick "Wait".
  const msg = ` ${norm(text)} `, whole = bare(text);
  const byLabel = options.filter((o) => {
    const l = norm(o.label);
    if (l.length < 3) return false;
    if (whole === l.replace(/[.!']/g, "")) return true;
    return reply && l.split(" ").length >= 2 && !/\?/.test(String(text)) && !NEGATES.test(norm(text).replace(l, " ")) && !DEFER.test(norm(text).replace(l, " ")) && msg.includes(` ${l} `);
  });
  if (byLabel.length === 1) return byLabel[0];
  if (alone && options.length === 2) {
    const yn = yesNo(text), yes = options.find((o) => /^yes\b/i.test(o.label)), no = options.find((o) => /^no\b/i.test(o.label));
    if (yn && yes && no) return yn === "yes" ? yes : no;
  }
  return null;
}
// replyTo: the message the owner replied to ({ id, authorId, content }), or null. botId: Keir's Discord id.
function repliesTo(x, replyTo, botId) {
  if (!replyTo?.id) return false;
  const ids = [...Object.values(x.sent || {}).map((s) => s.messageId), ...(x.channelMessages || [])].filter(Boolean).map(String);
  if (ids.includes(String(replyTo.id))) return true;
  if (!botId || replyTo.authorId !== botId) return false;
  const body = norm(replyTo.content), q = norm(x.question).slice(0, 80);
  return q.length >= 20 && body.includes(q.slice(0, 60));
}
// Keir 11.2 third pass (review M2): a message the owner meant as an answer but that did not count must not vanish. When
// a question is open and the message looks meant for it (a yes or no word, an option word, or words from the question),
// the owner is told once per question, in his DMs where the question's buttons are, what is still open and how to answer.
// A message addressed to someone else (it mentions another person) or unrelated to the question gets nothing.
const ANSWERISH = /\b(?:yes|yeah|yep|yup|no|nope|nah|ok(?:ay)?|sure|approved?|go ahead|do it|ship it|go for it|declined?|reject(?:ed)?|option|choice)\b|^\s*#?[1-6]\s*[.!)]?\s*$/i;
const WORDS_STOP = new Set(["this", "that", "with", "from", "have", "should", "would", "could", "there", "their", "about", "which", "what", "when", "will", "your", "they", "them", "then", "than", "into", "just", "ticket", "keir", "player"]);
const keyWords = (t) => new Set(norm(t).split(" ").filter((w) => w.length >= 4 && !WORDS_STOP.has(w) && !/^\d+$/.test(w)));
function meantFor(x, text, botId) {
  const mentions = [...String(text || "").matchAll(/<@!?(\d+)>/g)].map((m) => m[1]).filter((id) => id !== String(botId || ""));
  if (mentions.length || /^\s*@\w/.test(String(text || ""))) return false;
  if (ANSWERISH.test(String(text || ""))) return true;
  const mine = keyWords(text), theirs = keyWords(`${x.question} ${(x.options || []).map((o) => o.label).join(" ")}`);
  for (const w of mine) if (theirs.has(w)) return true;
  return false;
}
function howToAnswer(x) {
  const opts = (x.options || []).map((o, i) => `${i + 1} "${o.label}"`);
  return opts.length ? `tap a button on the question, reply to it, or name the option on its own (${opts.join(" or ")})` : "tap a button on the question, reply to it, or say yes or no on its own";
}
function applyOwnerChannelAnswer(d, { ticket, ownerId, authorId, text, messageId = null, at = Date.now(), replyTo = null, botId = null, notify = null }) {
  if (!ticket || !ownerId || authorId !== ownerId) return [];
  const content = String(text || "").trim();
  if (!content || content.startsWith("/")) return [];
  const jobs = Object.values(d.jobs || {}).filter((j) => Number(j.ticket) === Number(ticket));
  const open = Object.values(d.decisions || {}).filter((x) => x.state === "pending" && !x.actionId && !x.binds && (x.at || 0) <= at && (jobs.some((j) => j.id === x.jobId) || Number(x.ticket) === Number(ticket)));
  const replied = open.filter((x) => repliesTo(x, replyTo, botId));
  // Review 3 F4: a Discord reply to anything but the question is the owner talking to that message's author (the player,
  // staff, another post): never an answer, and not meant for the question.
  const elsewhere = Boolean(replyTo?.id) && !replied.length;
  // Review 4 m1: a reply to a different Keir post is still never an answer, but it may be meant for the question (the
  // owner answering Keir's restatement), so it gets the notice and the context line like an unreplied message.
  const toKeir = elsewhere && Boolean(botId) && String(replyTo.authorId || "") === String(botId);
  let picks = [];
  // A reply to the question counts only when it also gives an answer: "can you link the PR here?" sent as a reply is not one.
  if (replied.length) picks = replied.map((x) => ({ x, option: namedOption(x, content, { alone: true, reply: true }), reply: true })).filter((p) => p.option);
  else if (!elsewhere) {
    const named = open.map((x) => ({ x, option: namedOption(x, content, { alone: open.length === 1 }) })).filter((p) => p.option);
    // A message that could answer several questions answers none of them.
    if (named.length === 1) picks = named;
  }
  const answered = [];
  for (const { x, option, reply } of picks) {
    if (!option.free) { x.state = "selected"; x.selectedOption = { ...option }; }
    else x.state = "answered";
    x.answeredAt = at; x.answeredBy = ownerId; x.answerText = content.slice(0, 600); x.answer = content.slice(0, 600); x.answeredVia = reply ? "ticket_channel_reply" : "ticket_channel_option"; x.answerMessage = messageId;
    answered.push(x.id);
  }
  // Not an answer: kept on each open question as context, and the question stays open.
  // Fourth pass (review M2 gap): a message that looks meant for the question is also put in front of the task that asked,
  // as context (it reads it when it next runs; owner chat in the ticket still holds automatic work for a while), every
  // time, so a second unmatched message is not lost. The owner's DM notice stays one per question.
  if (!answered.length) for (const x of open) {
    x.channelContext = [...(x.channelContext || []), { at, text: content.slice(0, 300), message: messageId }].slice(-5);
    if (!(replied.includes(x) || ((!elsewhere || toKeir) && meantFor(x, content, botId)))) continue;
    const asker = d.jobs?.[x.jobId];
    if (asker && !JOB_TERMINAL.includes(asker.state)) (asker.inbox ||= []).push({ authorId: "owner-channel", role: "system", at: new Date(at).toISOString(), decision: x.id,
      content: `The owner wrote in the ticket channel: "${content.slice(0, 400)}". It was not taken as the answer to your open question "${String(x.question).replace(/\s+/g, " ").slice(0, 160)}", which stays open. Use it as context; do not act on it as the decision.` });
    if (notify && !x.unmatchedNoticeAt) {
      const sent = notify(`owner-unmatched:${x.id}`, `Ticket ${ticket}: your message "${content.slice(0, 120)}" was not taken as your answer to "${String(x.question).replace(/\s+/g, " ").slice(0, 160)}". That question is still open. To answer, ${howToAnswer(x)}.`.replace(/[\u2013\u2014]/g, ","));
      if (sent !== false) x.unmatchedNoticeAt = at; // a preview notice does not use up the real one (review N7)
    }
  }
  if (answered.length) (d.ownerChannelAnswers ||= {})[ticket] = { at, text: content.slice(0, 600), message: messageId, decisions: answered };
  for (const j of jobs) {
    const mine = answered.filter((id) => d.decisions[id].jobId === j.id);
    if (!mine.length) continue;
    if (!Object.values(d.decisions || {}).some((y) => y.state === "pending" && y.jobId === j.id)) delete j.ownerDecisionPending;
    for (const id of mine) {
      const x = d.decisions[id];
      const what = x.selectedOption ? `chose "${x.selectedOption.label}"` : "answered";
      (j.inbox ||= []).push({ authorId: ownerId, role: "owner", at: new Date(at).toISOString(), decision: id,
        content: `The owner ${what} in the ticket channel for "${String(x.question).slice(0, 160)}": ${content.slice(0, 600)}. Treat it as the decision (direction, not execution approval). Do not tell the player it is still waiting on the owner.` });
    }
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

module.exports = { yesNo, namedOption, repliesTo, meantFor, stateFingerprint, noNewRefusal, limitationLine, currentQuestionReceipt, PASSED_ON, NOT_PASSED_ON, isHoldingLine, holdingClaimRefusal, capabilityClaim,
  quoteFactors, priceVerdictRefusal, promisesFollowUp, outstandingPromise, claimsOwnerWait, applyOwnerChannelAnswer, ownerAnsweredSince };
