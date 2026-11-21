"use strict";
// Keir 11.4 (owner, 2026-11-21): do the thing, or say exactly what blocks it.
//
// Three exchanges in one hour. Ticket 1872 was told "It is with the developers now" while Keir's own coding worker was
// writing the fix (no developer had it). Ticket 1875's developer asked Keir for a rendered image and was told the request
// "is with the developers now". The owner was told "My ticket access is read-only". Each sentence was a deflection.
//
// Pure functions. The broker calls deflection() on every outgoing ticket and channel message. Every refusal names the
// sentence to use instead, so the answer still goes out in a true form.
const { JOB_TERMINAL } = require("./machines");

// "With the developers" and its relatives: a claim that a person on the team now holds the work.
// Keir 11.4 review (M1): "The developers have said this works as intended" and "the developers have not changed loan
// interest" are true sentences about the game and pass; so does a bare "team". The "have" form needs a held object
// (have it, have your report), so a past report ("have said", "have decided") never matches.
// Keir 11.4 release review (B1): present-tense ownership verbs stay open-ended. "The developers are working on a fix",
// "are fixing the company page crash" and "our dev team is looking into the crash" are the same false claim.
const DEV = String.raw`(?:developers?|devs?|dev team|development team)`;
const HELD = String.raw`(?:it|this|that|these|those|them|your (?:report|ticket|issue|bug|problem|request|question|case))`;
const DEV_HANDOFF = new RegExp(String.raw`\b(?:it(?:'|’)?s|this is|that is|it is|is|are|now) (?:now |still |already |currently )?(?:sitting |waiting )?with (?:the |our )?${DEV}\b` +
  String.raw`|\bin (?:the |our )?${DEV}(?:'|’)?s? hands\b|\bin the hands of (?:the |our )?${DEV}\b` +
  String.raw`|\b(?:passed|handed|raised|flagged|sent|reported|forwarded|escalated|given|put)\b[^.!?\n]{0,60}\b(?:to|with|over to) (?:the |our )?${DEV}\b` +
  String.raw`|\b(?:the |our |a |one of the |one of our )?${DEV} (?:now |already |currently )?(?:(?:have|has|got) (?:now )?${HELD}|(?:are|is) (?:now |already |currently |actively )?(?:on (?:it|this|that)|looking (?:at|into)|working on|handling|reviewing|fixing|investigating|checking)|will (?:fix|look|handle|check|pick up|sort|investigate|review))\b`, "i");
// Blanket capability refusals that were false when said.
// Keir 11.4 review (B1): only Keir saying Keir cannot produce an image. "You cannot create a second company" and "I can't make
// changes to your balance" are true answers; the subject must be "I" and the object a picture, preview or screenshot.
const CANNOT_RENDER = /\bi(?:\s+(?:can(?:'|’)?t|cannot|can not|am unable to|am not able to|have no way to)|(?:'|’)?m\s+(?:unable|not able) to)\s+(?:render|draw|take (?:an? )?screenshot|show (?:you|us) (?:an? |the )?(?:image|picture|preview|mock-?up|screenshot|render)|show (?:you |us )?(?:how it|what it) (?:would )?looks?)\b/i;
const READ_ONLY = /\b(?:my|keir(?:'|’)?s) (?:ticket |support )?access (?:is|being) read[- ]only\b|\bi (?:only )?have read[- ]only (?:ticket |support )?access\b|\bi (?:can(?:'|’)?t|cannot|can not|am unable to) (?:merge|close|create|open|resolve|reopen)(?:,? (?:or |and )?(?:merge|close|create|open|resolve|reopen))* (?:these |those |the |any )?(?:tickets?|incidents?)\b/i;

const sentencesOf = (text) => String(text || "").replace(/\s+/g, " ").match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()).filter(Boolean) || [];
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;
const NEGATED = /\b(?:not|never|no(?! (?:need|problem|worries|rush|doubt|matter)\b)|no longer|nobody|no one|none|nothing|neither|nor|isn(?:'|’)?t|aren(?:'|’)?t|haven(?:'|’)?t|hasn(?:'|’)?t|didn(?:'|’)?t|won(?:'|’)?t)\b/i;
const DEV_HANDOFF_ALL = new RegExp(DEV_HANDOFF.source, "gi");
// Keir 11.4 release review (B1): a negation exempts a handoff only when it negates the claim itself: inside the matched
// words ("passed nothing to the developers"), or in the same clause within five words before them ("I have not passed
// this", "no developer has it", "nobody has handed it to the developers"). "It is with the developers now, so you won't
// need to send anything else" is still the claim; the negation belongs to another clause.
const CLAUSE_BREAK = /[,;:()]|\b(?:and|but|so|because|since|while|although|though|then|which)\b/gi;
function negatesClaim(s, m) {
  if (NEGATED.test(m[0])) return true;
  const clause = s.slice(0, m.index).split(CLAUSE_BREAK).at(-1) || "";
  return NEGATED.test(clause.trim().split(/\s+/).slice(-5).join(" "));
}
const claimsHandoff = (s) => [...s.matchAll(DEV_HANDOFF_ALL)].some((m) => !negatesClaim(s, m));
function handoffSentence(text) {
  return sentencesOf(String(text || "").replace(QUOTED, " ")).find(claimsHandoff) || null;
}

const RUN_ENDED = new Set(["done", "escalated", "needs_owner", "cancelled", "reported", "failed", "abandoned"]);
const runsOf = (d) => Object.values(d?.codingWorkers?.runs || {});

// What Keir itself is doing on this ticket right now, or null. Order: a repair waiting for a sign-off, a fix in testing
// (a pull request exists), a fix being prepared (a coding worker or coding task is running).
function keirWork(d, ticketNo, jobs) {
  const n = String(ticketNo || "");
  const runs = runsOf(d).filter((r) => String(r.ticket) === n && (r.kind || "build") !== "investigation");
  const ids = new Set((jobs || []).map((j) => j.id));
  const pendingRepair = runs.some((r) => r.state === "needs_owner" && r.pr) ||
    Object.values(d?.actions || {}).some((a) => ids.has(a.jobId) && ["heal", "github"].includes(a.kind) && a.state === "pending") ||
    Object.values(d?.decisions || {}).some((x) => ids.has(x.jobId) && x.state === "pending" && (x.actionId || x.binds));
  if (pendingRepair) return "approval";
  const live = runs.filter((r) => !RUN_ENDED.has(r.state));
  if (live.some((r) => r.pr) || (jobs || []).some((j) => (j.pullRequests || []).length && !JOB_TERMINAL.includes(j.state))) return "testing";
  if (live.length || (jobs || []).some((j) => (j.raisedToDevelopers || []).some((r) => r.workerRun && !RUN_ENDED.has(d?.codingWorkers?.runs?.[r.workerRun]?.state || "running")))) return "preparing";
  if (Object.values(d?.jobs || {}).some((j) => j.codingParent && ids.has(j.codingParent) && !j.investigation && !JOB_TERMINAL.includes(j.state))) return "preparing";
  return null;
}
const FIRST_PERSON = {
  preparing: "I am preparing a fix",
  testing: "My fix is in testing",
  approval: "The fix is waiting for approval to ship",
};

// Handoffs a person on the team (not Keir) holds for this ticket: a raised item no Keir worker took (or whose worker gave
// it back to a person), a question needing a human, or an open owner decision. Each is a receipt a person can check.
function developerReceipts(d, ticketNo, jobs) {
  const out = [];
  const ids = new Set((jobs || []).map((j) => j.id));
  for (const j of jobs || []) for (const r of j.raisedToDevelopers || []) {
    if (r.id == null || r.selfOwned || r.releasedAt) continue;
    const run = r.workerRun ? d?.codingWorkers?.runs?.[r.workerRun] : null;
    if (r.workerRun && !(run && ["escalated", "needs_owner"].includes(run.state))) continue; // Keir's own worker holds it
    out.push({ kind: "card", ref: String(r.id), issue: r.issue != null ? String(r.issue) : null });
  }
  for (const x of Object.values(d?.decisions || {})) if (ids.has(x.jobId) && x.state === "pending") out.push({ kind: "decision", ref: String(x.id) });
  return out;
}

// Who the message answers: the person who wrote the message Keir is replying to, not the ticket's reporter.
// "owner", "staff" or "player". A ticket task answers staff only when its newest human message names Keir.
function audienceOf(job, config = {}, { named = null } = {}) {
  const staff = new Set([config.ownerId, ...(config.staffIds || [])].filter(Boolean));
  const roleOf = (s) => !s?.authorId ? null : s.authorId === config.ownerId ? "owner" : staff.has(s.authorId) ? "staff" : null;
  if (job?.replyChannel === "app") return "owner";
  if (["command", "conversation"].includes(job?.kind)) {
    if (job.role === "owner" && job.actorId === config.ownerId) return "owner";
    if (job.role === "support" && staff.has(job.actorId)) return "staff";
    return "player";
  }
  const human = [job?.source, ...(job?.requestInbox || []), ...(job?.inbox || [])].filter((s) => s && s.authorId && !["system", "assistant", "bot"].includes(s.role))
    .sort((a, b) => (Date.parse(a.at || "") || 0) - (Date.parse(b.at || "") || 0)).at(-1);
  const who = roleOf(human);
  const addressed = named || new RegExp(`\\b(?:keir|keith|starmer)\\b${config.botId ? `|<@!?${config.botId}>` : ""}`, "i");
  return who && addressed.test(String(human?.content || "")) ? who : "player";
}

// The one refusal for a deflection in an outgoing message, or null.
// ctx: { d, job, ticketNo, jobs, config, previewFailed, renderOffered, ticketCommandsOn }.
// Keir 11.4 review: a guard refuses only the specific false claim. "I cannot render" is checked only when this activation
// was offered render_preview (renderOffered, default true) and no render has failed; "my access is read-only" only when
// the reader is the owner or staff and ticket commands are switched on. Where the code cannot tell, the message goes out.
function deflection(message, { d, job, ticketNo = null, jobs = [], config = {}, previewFailed = false, renderOffered = true, ticketCommandsOn = true } = {}) {
  const text = String(message || "");
  if (CANNOT_RENDER.test(text) && renderOffered && !previewFailed) return `Not posted: you can render. render_preview draws a labelled preview from HTML you write (the proposed wording or layout in the game's style), and view_page shows a live game page as a signed-out visitor. Call render_preview now and post the image; if it fails, say once what failed and give the text.`;
  const audience = audienceOf(job, config);
  if (READ_ONLY.test(text) && audience !== "player" && ticketCommandsOn) return "Not posted: that is not true. For the owner and staff you can open an incident, merge tickets into it or into another ticket, resolve or reopen a ticket and add a person, with ticket_command. Do what was asked, or name the one operation you lack and why in one sentence.";
  const s = handoffSentence(text);
  if (!s) return null;
  const receipts = ticketNo ? developerReceipts(d, ticketNo, jobs) : [];
  if (audience !== "player") {
    // The asker is the owner or a developer. A status that names the person's own receipt is fine; a deflection is not.
    // Outside a ticket there is no receipt list, so a sentence naming a pull request, issue or card number is a status.
    const named = ticketNo ? receipts.some((r) => new RegExp(`(?:#|\\b)(?:${r.ref}${r.issue ? `|${r.issue}` : ""})\\b`).test(text))
      : /\b(?:PR|pull request|issue|card)\s*#?\d+\b|#\d+\b/i.test(text);
    if (!named) return `Not posted: "${s.slice(0, 160)}" answers ${audience === "owner" ? "the owner" : "a developer"} who asked you directly; they are the developers. Do what they asked now with your tools, or say in one sentence the specific thing that blocks you and what would unblock it.${ticketNo ? ` If someone else does hold this work, name it (the issue or card number and who has it).` : ""}`;
    return null;
  }
  const own = ticketNo ? keirWork(d, ticketNo, jobs) : null;
  if (own && !receipts.length) return `Not posted: "${s.slice(0, 160)}" is not true. You are doing this work yourself; no developer has it. Say it in the first person, for example "${FIRST_PERSON[own]}."${own === "preparing" ? " Promise a follow-up only for when the fix is ready to try." : ""}`;
  if (!receipts.length) return `Not posted: "${s.slice(0, 160)}" needs a handoff a person can check, and none is recorded on this ticket. If you are fixing it yourself, say "${FIRST_PERSON.preparing}". If a person must act, raise it with raise_to_developers (needsHuman true) first, then say who has it.`;
  return null;
}

// Keir 11.4 review: a refusal is never the end of an answer. After the guard has refused twice in one activation, the
// broker posts the message without the sentences that make the false claim, so the rest of the answer still goes out.
// Returns the remaining text (paragraphs kept), or "" when every sentence was a deflection.
function withoutDeflections(message, ctx = {}) {
  const parts = String(message || "").split(/((?<=[.!?])[ \t]+|\n+)/);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const piece = parts[i], sep = parts[i + 1] || "";
    if (piece.trim() && deflection(piece, ctx)) { if (/\n/.test(sep) && out.length) out[out.length - 1] = out[out.length - 1].replace(/[ \t]+$/, "") + sep; continue; }
    out.push(piece + sep);
  }
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = { DEV_HANDOFF, CANNOT_RENDER, READ_ONLY, handoffSentence, keirWork, developerReceipts, audienceOf, deflection, withoutDeflections, FIRST_PERSON };
