"use strict";
// Owner rule, 2026-11-23: when a ticket is about harm caused by a bug or by one of our own changes, a reply must not stop
// at "here is exactly why you lost money". Every such reply also says what the player can do in the meantime (concrete
// in-game actions) and when the fix is expected. Open-ended strategy coaching still goes to Ask; this is about workarounds
// while we fix our own problem. Pure functions.

// The reply explains a loss: money, output or standing the player lost.
const HARM = /\b(?:lost|losing|loss(?:es)?|cost you|costing you|took|taken|drained?|fell|dropped|down by|wiped|charged (?:you )?(?:twice|again)|overcharged|underpaid|not paid|missing|idle|stopped producing|shut (?:down)?|penal(?:ty|ised|ized))\b/i;
const MONEY = /\b(?:money|cash|funds?|revenue|income|profits?|sales|earnings?|payments?|payouts?|salar(?:y|ies)|wages?|dividends?|production|output|balance|capital|shares?|votes?|seats?|approval)\b|[₳$£€]\s?\d/i;
// The reply puts the cause on us: a bug, a fault, a defect, or one of our changes.
const OURS = /\b(?:bug|fault|defect|glitch|error in the game|mistake in the game|miscalculat\w+|wrongly|incorrectly|by mistake|(?:our|a recent|the latest|last|this week's|yesterday's) (?:change|update|patch|release|fix)|(?:change|update|patch|release) (?:we|the developers) (?:made|shipped)|was not supposed to|should not have)\b/i;
const CAUSAL = /\b(?:because|due to|caused by|caused|the reason|that is why|that's why|comes from|came from|led to|result(?:ed)? (?:of|in)|explains?|down to)\b/i;

// What the player can do meanwhile: "in the meantime you can ...", "until it is fixed, ...", "for now, ...".
const MEANTIME = /\b(?:in the meantime|meanwhile|until (?:then|the fix|it is fixed|it's fixed|that (?:lands|is live))|for now|until we fix|while (?:we|the fix|it is being)|before the fix)\b/i;
// A concrete step: an instruction or "you can ...".
const ACTION = /\b(?:you can|you could|you may want to|it helps to|try|set|switch|move|sell|buy|pause|hold|keep|raise|lower|reassign|close|reopen|wait to|avoid|turn (?:on|off)|re-?enable|disable|cancel|delay)\b/i;
// An honest "nothing to do": allowed so Keir never invents a workaround (wrong advice is its own failure).
const NOTHING = /\b(?:nothing (?:you need|for you) to do|no (?:in-game )?(?:step|action|workaround) (?:helps|is needed|changes this)|you do not need to (?:do|change) anything|there is no workaround)\b/i;
// When the fix is expected: a time, a turn, or an honest "no date yet" with the stage it is at.
const WHEN = /\b(?:today|tonight|tomorrow|this (?:week|weekend|evening|afternoon|morning)|next (?:turn|day|week)|within (?:a|an|the next|\d+) (?:hour|day|turn)s?|in (?:about )?(?:a|an|\d+) (?:hour|day|turn)s?|by (?:turn \d+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|the next turn|tomorrow)|turn \d+|expected (?:on|by|in|within|after)|(?:is|are) (?:now )?live|on the main server|no (?:date|time|estimate) yet|being built|in testing|on sandbox)\b/i;

const sentences = (text) => String(text || "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

// The harm explanation in a reply that lacks a meantime step or a timing, or null. bugContext: the ticket is a bug ticket
// or Keir has raised a fix for it (a bug lane, a card, a PR); then any explained loss counts even without "bug" in the text.
function harmProblem(message, { bugContext = false } = {}) {
  const text = String(message || "");
  const explain = sentences(text).find((s) => HARM.test(s) && MONEY.test(s) && (CAUSAL.test(s) || OURS.test(s)) && !/\?\s*$/.test(s));
  if (!explain) return null;
  if (!(OURS.test(text) || bugContext)) return null;
  const meantime = (MEANTIME.test(text) && ACTION.test(text)) || NOTHING.test(text);
  const when = WHEN.test(text);
  if (meantime && when) return null;
  return { sentence: explain.slice(0, 200), missing: [meantime ? null : "meantime", when ? null : "when"].filter(Boolean) };
}

function harmRefusal(p) {
  const need = p.missing.map((m) => (m === "meantime"
    ? "what the player can do in the meantime: concrete in-game steps that limit the damage until the fix is live (\"In the meantime, you can ...\"), or, only if nothing in the game helps, say so plainly"
    : "when the fix is expected: its stage (being built, in testing, on the main server) and a time or turn if you have one, or \"no date yet\" with the stage")).join("; and ");
  return `Not posted: "${p.sentence}" explains a loss our bug or change caused, but the reply stops at the why. Add ${need}. Keep it to workarounds for our problem; open-ended strategy advice still goes to Ask.`;
}

module.exports = { harmProblem, harmRefusal };
