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
// Owner, 2026-11-01: tickets 1730 and 1742 asked the same payment three times
// ("who executes", "confirm the exact payment") after it was already chosen.
// A question about making a payment, from a task whose earlier payment
// question the owner answered in the last two days, is a re-ask.
const PAYMENT = /\b(?:pay|paid|payment|credit|refund|compensat\w*|reimburs\w*|restitution)\b/i;
const EXECUTE = /\b(?:apply|applies|execute|executes|run|runs|carry out|who (?:applies|executes|runs)|confirm the (?:exact )?(?:payment|credit|amount)|already[- ]approved|approved)\b/i;
function answeredPayment(data, job, text, now = Date.now()) {
  const t = String(text || "");
  if (!job || !PAYMENT.test(t) || !EXECUTE.test(t)) return null;
  const prior = Object.values(data.decisions || {}).filter((x) => x.jobId === job.id && x.answeredAt && x.answeredAt <= now && now - x.answeredAt < 48 * 3600000 &&
    ["selected", "approve"].includes(x.state) && PAYMENT.test(`${x.question || ""} ${x.selectedOption?.label || ""} ${x.selectedOption?.detail || ""}`));
  const last = prior.sort((a, b) => b.answeredAt - a.answeredAt)[0];
  return last ? { id: last.id, label: String(last.selectedOption?.label || last.state).slice(0, 120) } : null;
}
module.exports = { requireRealDecision, obsoleteReason, appDecisions, answeredPayment };
