"use strict";
// Routine conversation is already authorized. Refusing a request here never
// grants execution authority to an action or changes an existing approval.
function requireRealDecision(text) {
  if (/\b(?:restart|resume|unpause)\b|\bclear\b[^.?!]*\bpause\b|\bhand\b[^.?!]*\bback\b|\b(?:continue|proceed)\b[^.?!]*\bbest verified\b/i.test(String(text || ""))) {
    throw new Error("No owner decision: operational permissions require a bound action with exact scope and evidence. Investigate the dependency; do not ask permission to recover internal task state or override another operator's hold.");
  }
  if (/\b(?:(?:can|may|should)\s+I|(?:permission|approval)\s+to|(?:do\s+you\s+want|would\s+you\s+like)\s+me\s+to)\s+(?:explain|investigate|summari[sz]e|describe|clarify|answer|report\s+(?:back|progress)|(?:post|send|give)\s+(?:a|an|the)\s+(?:status\s+)?update)\b/i.test(String(text || ""))) {
    throw new Error("No owner decision is needed to explain, investigate or report progress. Do that work and reply in the conversation. Consequential actions keep their exact approval requirements.");
  }
}
function obsoleteReason(decision, data) {
  if (decision.selfRecovery) return "Synthetic recovery questions are not action approvals";
  if (decision.actionId && !data.actions?.[decision.actionId]) return "Approval has no bound action";
  if (decision.actionId && data.actions[decision.actionId].jobId !== decision.jobId) return "Approval belongs to a different task";
  if (!decision.actionId && !decision.binds) {
    try { requireRealDecision(decision.question); } catch (error) { return error.message; }
  }
  return null;
}
const appDecisions = config => config.ownerDecisionChannel === "app";
module.exports = { requireRealDecision, obsoleteReason, appDecisions };
