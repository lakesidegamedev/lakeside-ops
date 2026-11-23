"use strict";
// 2026-11-23 (ticket 1884, owner): asked why revenue fell 500k, Keir read one site, answered for it, and wrote "I still need
// the rest of your sites' results to pin down the full drop". Players read that as THEM having to send it, and Keir could
// read every site itself. Two rules, enforced on every player-facing post:
//   (a) game data Keir can read is read before answering: a post that says it covers only part of a total and still
//       "needs" the rest is refused until the rest is read;
//   (b) Keir never phrases its own missing lookups as something it needs: it says what it is doing next and when it will
//       post. It asks the player only for what only the player knows (what they saw, when, what they expected, a screenshot).
// Pure functions.

// Game records Keir reads itself: sites, companies, figures, records, histories.
const GAME_DATA = /\b(?:sites?|plants?|factor(?:y|ies)|mines?|stores?|offices?|clinics?|depots?|branch(?:es)?|compan(?:y|ies)|corporations?|subsidiar(?:y|ies)|sectors?|results?|figures?|numbers?|data|records?|ledgers?|accounts?|balances?|books|statements?|reports?|histor(?:y|ies)|revenues?|sales|income|profits?|cash|production|output|inventor(?:y|ies)|stock|prices?|costs?|payments?|payouts?|transactions?|holdings?|shares?|bonds?|loans?|votes?|polls?|turns?)\b/i;
// "I still need ...", "I need to see your ...", "I do not have your ...", "I am missing ...", "waiting on your ...".
const NEED = /\b(?:i|we)\s+(?:still\s+|also\s+|first\s+|will\s+)?(?:need|require)\b|\b(?:i|we)\s+(?:am|are)\s+(?:still\s+)?(?:missing|lacking|waiting (?:on|for) (?:your|the rest))\b|\b(?:i|we)\s+(?:do not|don't|dont|cannot|can't|cant)\s+(?:yet\s+)?(?:have|see)\s+(?:your|the rest of|the other|all of)\b|\b(?:i|we)\s+(?:have not|haven't|havent)\s+(?:got|seen|received)\s+(?:your|the rest|the other)\b|\bwithout (?:your|the rest of your|the other)\b/i;
// What only the player can give: what they saw or did, when, where, what they expected, a screenshot or a link.
const PLAYER_ONLY = /\b(?:screenshot|screen ?shot|picture|image|link|url|what you (?:saw|see|expected|meant|did|clicked|tried)|which (?:page|screen|button|tab)|when (?:you|this) (?:first )?(?:saw|noticed|happened|did)|what (?:you were|happened when)|your (?:discord|username|browser|device|platform)|steps you took)\b/i;
// "That accounts for part of the drop", "this explains only some of it".
const PARTIAL = /\b(?:accounts? for|explains?|covers?|is)\s+(?:only\s+)?(?:part|some|a (?:part|share|portion)|one part)\s+of\b|\b(?:the rest|the other|remaining)\s+(?:of\s+)?(?:your\s+)?(?:sites?|plants?|compan(?:y|ies)|stores?|offices?|clinics?|depots?|sectors?|results?)\b/i;
// Keir's own next step, which is the right way to say it: "I am reading the other sites now and will post ...".
const OWN_STEP = /\b(?:i|we)(?:'|’)?(?:m| am| are|'re|’re| will|'ll|’ll)\s+(?:now\s+)?(?:reading|read|checking|check|pulling|pull|looking (?:up|at)|look (?:up|at)|going through|go through|tracing|trace|adding up|add up)\b/i;

// The data is the player's own, or the rest of what was asked about.
const THEIRS = /\b(?:your|yours|the rest|the other|remaining|all (?:of )?(?:the|your))\b/i;

const sentences = (text) => String(text || "").replace(/"[^"\n]*"|“[^”\n]*”/g, " ").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

// The first sentence that phrases Keir's own lookup as a need, or null. { sentence, kind: "need" | "partial" }.
function ownLookupProblem(message) {
  const all = sentences(message);
  for (const s of all) {
    if (/\?\s*$/.test(s) || PLAYER_ONLY.test(s)) continue;
    if (NEED.test(s) && GAME_DATA.test(s) && THEIRS.test(s) && !OWN_STEP.test(s)) return { sentence: s.slice(0, 200), kind: PARTIAL.test(String(message)) ? "partial" : "need" };
  }
  return null;
}

function ownLookupRefusal(p) {
  const head = `Not posted: "${p.sentence}" reads to the player as if they have to send you game data. They do not: you read it yourself.`;
  const gather = p.kind === "partial"
    ? " This answer covers only part of what they asked about. Read every site, company or record that feeds the total (reporter_state lists what they own; then read each one) and answer for all of them in one message."
    : " Read the records now with your read tools and answer from them.";
  return `${head}${gather} If a read truly fails, say what you are doing next and when you will post (for example "I am reading your other sites now and will post the full breakdown within the hour"), and never write "I still need" or "I need your" for something you can look up. Ask the player only for what only they know: what they saw, when, which page, what they expected, a screenshot.`;
}

module.exports = { ownLookupProblem, ownLookupRefusal };
