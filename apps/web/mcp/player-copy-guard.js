"use strict";

// Player ticket channels get the player's register, whichever agent writes.
// Keir checks its own posts, but other sessions post through this service
// directly, and PR, issue and CI references reached players (review
// 2026-10-19: tickets 1606, 1609, 1610, 1616, 1630).
const INTERNAL = [
  [/\b(?:PR|pull request|issue)\s*#?\s*\d{3,5}\b/i, "a PR or issue number"],
  [/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\b/i, "a GitHub link"],
  [/\bCI\b|\bCI gate\b|\bautomated checks\b/i, "CI"],
  [/\b(?:merged|merge) (?:to|into) (?:development|staging|main)\b|\bdevelopment branch\b/i, "a branch"],
  [/\b(?:decision|approval)\s+(?:DM|inbox)\b/i, "internal routing"],
  [/\btools (?:I have|available to me)\b|\b(?:discover(?:ing)?|understand(?:ing)?) (?:the |my )?(?:available )?tools\b/i, "agent narration"],
];

function internalTerm(message) {
  for (const [pattern, kind] of INTERNAL) {
    const m = pattern.exec(String(message || ""));
    if (m) return { match: m[0], kind };
  }
  return null;
}

module.exports = { internalTerm };
