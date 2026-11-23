"use strict";

const URL = "https://ask.lakesidegames.net";
const REPLY = `For gameplay strategy and investment advice, use Ask: ${URL}. If a screen is broken or shows incorrect figures, report that here so we can investigate.`;

// Keir 10 (W3): Ask's own health. In November Ask refused nearly every question
// while Keir kept redirecting players to it. A fresh "failing" or "down" reading
// (from the ask tool's health action) switches the redirect off; the context says
// why. Unknown or stale readings leave the redirect as it was.
const ASK_STATE = { status: null, at: 0, refusalRate: null };
const ASK_FRESH_MS = 30 * 60000;
function noteAskHealth(health, at = Date.now()) {
  if (!health || !health.status) return;
  ASK_STATE.status = health.status; ASK_STATE.at = at; ASK_STATE.refusalRate = Number.isFinite(Number(health.refusalRate)) ? Number(health.refusalRate) : null;
}
function askUnavailable(now = Date.now()) { return ["failing", "down"].includes(ASK_STATE.status) && now - ASK_STATE.at < ASK_FRESH_MS; }
function askNote(now = Date.now()) {
  if (!askUnavailable(now)) return null;
  return ASK_STATE.status === "down" ? "Ask is not answering right now. Do not redirect players to it for strategy or how-to questions; answer from your own reads or say you could not confirm."
    : `Ask is refusing most questions right now (${Math.round((ASK_STATE.refusalRate || 0) * 100)}% of its recent answers). Do not redirect players to it; answer from your own reads (including the lore wiki) or say what you could not confirm.`;
}
function resetAskHealth() { ASK_STATE.status = null; ASK_STATE.at = 0; ASK_STATE.refusalRate = null; }

function adviceQuestion(text) {
  const t = String(text || "");
  return /\b(?:where|which (?:state|country|sector|industry)|what (?:state|country|sector|industry))\b[\s\S]{0,160}\b(?:invest|build|expand)\b/i.test(t) ||
    /\b(?:should|best|recommend|advice|strategy)\b[\s\S]{0,120}\b(?:invest|build|expand|profit|company|corporation|campaign)\b/i.test(t) ||
    /\b(?:how (?:can|do|should) i|help me)\b[\s\S]{0,100}\b(?:profit|make money|invest)\b/i.test(t);
}
function latestInput(job) {
  return [job.source, ...[...(job.requestInbox || []), ...(job.inbox || [])].filter(m => m && m.role !== "system" && !m.codingResult && !m.investigationResult && !m.directiveId)].filter(Boolean).at(-1);
}
function bugFollowup(job) {
  const latest = latestInput(job);
  return job.tags?.kind === "gameplay_advice" && latest && latest !== job.source &&
    /\b(?:broken|error|incorrect|missing|not working|cannot log in|can.t log in)\b|\b(?:shares|holding|balance)\b[\s\S]{0,100}\b(?:but|says|wrong)\b/i.test(String(latest.content || ""));
}
function fixOnTicket(job, d) {
  const ticket = Number(job.ticket);
  if (!Number.isFinite(ticket) || ticket <= 0 || !d) return false;
  const card = d.statusCards?.[ticket];
  if ((card?.items || []).some((i) => i && i.stage && i.stage !== "found")) return true;
  return Object.values(d.jobs || {}).some((j) => Number(j?.ticket) === ticket && j.pullRequests?.length);
}
function requiresRedirect(job, d) {
  if (!["ticket", "conversation", "command"].includes(job.kind) || !["support", "player"].includes(job.role) || job.codingParent) return false;
  if (job.incidentCandidates?.length) return false;
  if (askUnavailable()) return false;
  const kind = job.tags?.kind;
  // A mixed ticket retains its concrete defect work. Advice is redirected
  // separately by the brief; a gameplay category never overrides a bug.
  if (["bug_report", "data_repair", "feature_request", "design_feedback", "moderation"].includes(kind) || job.pullRequests?.length) return false;
  if (bugFollowup(job)) return false;
  // A loss our own change caused is not advice: any fix on the ticket, from any task or a
  // developer, means the player gets a real answer and the meantime steps (ticket 1884).
  if (fixOnTicket(job, d)) return false;
  if (kind === "gameplay_advice") return true;
  const latest = latestInput(job);
  return adviceQuestion(latest?.content);
}
function guard(job, d, message) {
  if (requiresRedirect(job, d) && String(message || "").trim() !== REPLY)
    throw new Error(`Not posted: gameplay advice belongs in Ask. Send this short redirect instead of researching the player's investments: ${REPLY}`);
}
function guardResolution(job, d, args) {
  if (!requiresRedirect(job, d)) return;
  guard(job, d, args.message);
  if ((args.actions || []).some(text => text !== "Directed gameplay advice to Ask.") ||
      (args.followUp && args.followUp !== "Report a concrete bug here if something is broken."))
    throw new Error("Advice resolution must contain only the Ask redirect, action 'Directed gameplay advice to Ask.', and optional follow-up 'Report a concrete bug here if something is broken.'. Do not add investment advice.");
}
module.exports = { fixOnTicket, noteAskHealth, askUnavailable, askNote, resetAskHealth, URL, REPLY, adviceQuestion, bugFollowup, requiresRedirect, guard, guardResolution };
