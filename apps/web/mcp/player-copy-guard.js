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

// Review 2026-11-01 (tickets 1739 to 1743): stand-in support sessions posting
// directly here apologised, narrated their own mistakes and talked about the
// player as "him" in the player's own channel. Same rules as Keir's
// apps/agent/lib/operator/ticketquality.js; kept local so the web release
// stays self-contained.
const VOICE = [
  [/\b(?:I(?:'m|’m| am) (?:so |very |really )?sorry\b|sorry (?:for|about|that)\b|I apologi[sz]e\b|apologies (?:for|about)\b|I owe you (?:a|an)\b|(?:that|this|it) (?:was|is) my (?:mistake|fault|error)\b|my (?:mistake|bad)\b|I got (?:it|that|this) wrong\b|taking this (?:one )?personally\b)/i,
    "an apology or a story about the mistake. State what is correct in one sentence (\"Correction: you have three agreements, not none.\") and move on"],
  [/\b(?:told|gave|showed|asked|sent|answered|promised|owe) (?:him|her)\b|\bthe reporter(?!s)\b|\bthe player has (?:the|their|an?) answer\b/i,
    "talk about the player in the third person. This is their channel: address them as \"you\", and give staff explanations privately"],
];
function voiceProblem(message) {
  for (const [pattern, kind] of VOICE) {
    const m = pattern.exec(String(message || ""));
    if (m) return { match: m[0], kind };
  }
  return null;
}

// Owner, 2026-11-01: a decision in player copy names the developer who made
// it ("Egg approved compensation"), never "the developers decided". Mirrors
// NAMED_DECISION in apps/agent/lib/operator/ticketquality.js.
const DECISION = /\b(?:developers?|devs?|owner|team|staff|moderators?) (?:have |has )?(?:decided|agreed|ruled|approved|signed off)\b|\bthe ruling (?:is|was)\b|\b(?:it|this) (?:was|has been) (?:decided|agreed|ruled)\b|\bthe decision (?:is|was) (?:to|that)\b|\b(?:approved|signed off on|ruled (?:on|that))\b(?=[^.!?]*\b(?:compensat\w*|refund\w*|credit\w*|payment|paid|reimburs\w*|exception|ruling)\b)|\b(?:compensat\w*|refund\w*|credit\w*|payment|reimburs\w*|exception)\b[^.!?]*\b(?:approved|signed off|agreed)\b/i;
const developerNames = () => String(process.env.SUPPORT_DEVELOPER_NAMES || "Egg,Ariane").split(",").map((x) => x.trim()).filter(Boolean);
function unnamedDecision(message, names = developerNames()) {
  for (const sentence of String(message || "").split(/(?<=[.!?])\s+|\n+/)) {
    if (!DECISION.test(sentence)) continue;
    if (!names.some((n) => new RegExp(`\\b${n}\\b`, "i").test(sentence))) return { match: sentence.trim().slice(0, 160), kind: `a decision credited to nobody. Name the developer who approved it (${names.join(" or ")})` };
  }
  return null;
}

module.exports = { internalTerm, voiceProblem, unnamedDecision };
