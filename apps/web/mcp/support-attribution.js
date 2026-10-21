"use strict";

// Attribution is separate from the delivery actor and player-facing receipt.
// A closer may explicitly credit Keir; later delivery retries preserve it.
function resolutionAttribution(existing, input, { by, now }) {
  if (!input) return existing.resolutionAttribution || null;
  return { agent: input.agent, ...(input.jobId ? { jobId: input.jobId } : {}),
    evidence: input.evidence, recordedBy: by, recordedAt: now };
}

module.exports = { resolutionAttribution };
