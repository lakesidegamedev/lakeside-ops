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
const DEV_HANDOFF = /\b(?:it(?:'|’)?s|this is|that is|it is|is|are|now) (?:now |still )?with (?:the |our )?(?:developers?|devs?|dev team|team)\b|\b(?:passed|handed|raised|flagged|sent|reported|forwarded|escalated|given|put)\b[^.!?\n]{0,60}\b(?:to|with|over to) (?:the |our )?(?:developers?|devs?|dev team)\b|\b(?:the |our )?(?:developers?|devs?|dev team) (?:now |already )?(?:have|has|got|are (?:on|looking at|working on|handling|reviewing)|will (?:fix|look|handle|check|pick))\b/i;
// Blanket capability refusals that were false when said.
const CANNOT_RENDER = /\b(?:i )?(?:can(?:'|’)?t|cannot|can not|am unable to|(?:am|is) not able to|have no way to)\s+(?:render|draw|produce|make|create|generate|show (?:you|us) (?:an? )?(?:image|picture|preview|mock-?up|screenshot)|take (?:an? )?screenshot|show (?:you |us )?(?:how it|what it) (?:would )?looks?)\b/i;
const READ_ONLY = /\b(?:my|keir(?:'|’)?s) (?:ticket |support )?access (?:is|being) read[- ]only\b|\bi (?:only )?have read[- ]only (?:ticket |support )?access\b|\bi (?:can(?:'|’)?t|cannot|can not|am unable to) (?:merge|close|create|open|resolve|reopen)(?:,? (?:or |and )?(?:merge|close|create|open|resolve|reopen))* (?:these |those |the |any )?(?:tickets?|incidents?)\b/i;

const sentencesOf = (text) => String(text || "").replace(/\s+/g, " ").match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()).filter(Boolean) || [];
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;
function handoffSentence(text) {
  return sentencesOf(String(text || "").replace(QUOTED, " ")).find((s) => DEV_HANDOFF.test(s) && !/\b(?:not|never|no longer|isn(?:'|’)?t|aren(?:'|’)?t)\b[^.!?]{0,20}\bwith\b/i.test(s)) || null;
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

// The one refusal for a deflection in an outgoing message, or null. ctx: { d, job, ticketNo, jobs, config, previewFailed }.
function deflection(message, { d, job, ticketNo = null, jobs = [], config = {}, previewFailed = false } = {}) {
  const text = String(message || "");
  if (CANNOT_RENDER.test(text) && !previewFailed) return `Not posted: you can render. render_preview draws a labelled preview from HTML you write (the proposed wording or layout in the game's style), and view_page shows a live game page as a signed-out visitor. Call render_preview now and post the image; if it fails, say once what failed and give the text.`;
  if (READ_ONLY.test(text)) return "Not posted: that is not true. For the owner and staff you can open an incident, merge tickets into it or into another ticket, resolve or reopen a ticket and add a person, with ticket_command. Do what was asked, or name the one operation you lack and why in one sentence.";
  const s = handoffSentence(text);
  if (!s) return null;
  const audience = audienceOf(job, config);
  const receipts = ticketNo ? developerReceipts(d, ticketNo, jobs) : [];
  if (audience !== "player") {
    // The asker is the owner or a developer. A status that names the person's own receipt is fine; a deflection is not.
    const named = receipts.some((r) => new RegExp(`(?:#|\\b)(?:${r.ref}${r.issue ? `|${r.issue}` : ""})\\b`).test(text));
    if (!named) return `Not posted: "${s.slice(0, 160)}" answers ${audience === "owner" ? "the owner" : "a developer"} who asked you directly; they are the developers. Do what they asked now with your tools, or say in one sentence the specific thing that blocks you and what would unblock it.${ticketNo ? ` If someone else does hold this work, name it (the issue or card number and who has it).` : ""}`;
    return null;
  }
  const own = ticketNo ? keirWork(d, ticketNo, jobs) : null;
  if (own && !receipts.length) return `Not posted: "${s.slice(0, 160)}" is not true. You are doing this work yourself; no developer has it. Say it in the first person, for example "${FIRST_PERSON[own]}."${own === "preparing" ? " Promise a follow-up only for when the fix is ready to try." : ""}`;
  if (!receipts.length) return `Not posted: "${s.slice(0, 160)}" needs a handoff a person can check, and none is recorded on this ticket. If you are fixing it yourself, say "${FIRST_PERSON.preparing}". If a person must act, raise it with raise_to_developers (needsHuman true) first, then say who has it.`;
  return null;
}

module.exports = { DEV_HANDOFF, CANNOT_RENDER, READ_ONLY, handoffSentence, keirWork, developerReceipts, audienceOf, deflection, FIRST_PERSON };
