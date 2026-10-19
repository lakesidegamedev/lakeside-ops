"use strict";
// Routine conversation is already authorized. Refusing a request here never
// grants execution authority to an action or changes an existing approval.
function requireRealDecision(text) {
  if (/\b(?:(?:can|may|should)\s+I|(?:permission|approval)\s+to|(?:do\s+you\s+want|would\s+you\s+like)\s+me\s+to)\s+(?:explain|investigate|summari[sz]e|describe|clarify|answer|report\s+(?:back|progress)|(?:post|send|give)\s+(?:a|an|the)\s+(?:status\s+)?update)\b/i.test(String(text || ""))) {
    throw new Error("No owner decision is needed to explain, investigate or report progress. Do that work and reply in the conversation. Consequential actions keep their exact approval requirements.");
  }
}
const appDecisions = config => config.ownerDecisionChannel === "app";
module.exports = { requireRealDecision, appDecisions };
