"use strict";

const URL = "https://ask.lakesidegames.net";
const REPLY = `For gameplay strategy and investment advice, use Ask: ${URL}. If a screen is broken or shows incorrect figures, report that here so we can investigate.`;

function adviceQuestion(text) {
  const t = String(text || "");
  return /\b(?:where|which (?:state|country|sector|industry)|what (?:state|country|sector|industry))\b[\s\S]{0,160}\b(?:invest|build|expand)\b/i.test(t) ||
    /\b(?:should|best|recommend|advice|strategy)\b[\s\S]{0,120}\b(?:invest|build|expand|profit|company|corporation|campaign)\b/i.test(t) ||
    /\b(?:how (?:can|do|should) i|help me)\b[\s\S]{0,100}\b(?:profit|make money|invest)\b/i.test(t);
}
function requiresRedirect(job, d) {
  if (!["ticket", "conversation", "command"].includes(job.kind) || !["support", "player"].includes(job.role) || job.codingParent) return false;
  if (job.incidentCandidates?.length) return false;
  const kind = job.tags?.kind;
  // A mixed ticket retains its concrete defect work. Advice is redirected
  // separately by the brief; a gameplay category never overrides a bug.
  if (["bug_report", "data_repair", "feature_request", "design_feedback", "moderation"].includes(kind) || job.pullRequests?.length) return false;
  if (kind === "gameplay_advice") return true;
  const latest = [job.source, ...[...(job.requestInbox || []), ...(job.inbox || [])].filter(m => m && m.role !== "system")].filter(Boolean).at(-1);
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
module.exports = { URL, REPLY, adviceQuestion, requiresRedirect, guard, guardResolution };
