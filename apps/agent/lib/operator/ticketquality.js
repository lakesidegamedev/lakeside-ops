"use strict";
// Ticket post quality checks from the 2026-11-01 review of tickets 1736 to
// 1747. Each one is a failure that reached a player even though the brief
// already forbade it, so it is now checked in code. Pure: text and
// receipts in, refusal reason out (null when the post may go).

// Apologies and self-narration (1742: "I owe you a correction ... I am sorry
// for it"; 1743: "I'm taking this one personally"; 1739: "sorry for the
// earlier advice"). A correction states what is right, in one line.
const CONFESSIONAL = /\b(?:I(?:'m|’m| am) (?:so |very |really )?sorry\b|sorry (?:for|about|that)\b|I apologi[sz]e\b|apologies (?:for|about)\b|I owe you (?:a|an)\b|(?:that|this|it) (?:was|is) my (?:mistake|fault|error)\b|my (?:mistake|bad)\b|I got (?:it|that|this) wrong\b|taking this (?:one )?personally\b)/i;

// A ticket channel talks to the player as "you" (1742: "it is why I told him
// twice that nothing was signed", posted in his own channel).
// "The player" alone is left out: reports about another player's account
// (1743, 1745) legitimately name a third party.
const THIRD_PERSON = /\b(?:told|gave|showed|asked|sent|answered|promised|owe) (?:him|her)\b|\bthe reporter(?!s)\b|\bthe player has (?:the|their|an?) answer\b/i;

// Claims that something does not exist (1742: an empty lookup, asked the
// wrong way, became "nothing is signed" twice while three contracts existed).
const ABSENCE = /\b(?:nothing (?:is |was |has been )?(?:signed|recorded|on record|on file|filed|booked)|(?:there is|there's|there are|has|have|had) no [\w ]{1,30}?(?:on record|recorded|on file|in either direction|anywhere)|no [\w ]{1,30}? (?:is|are|was|were) (?:recorded|on record|on file)|(?:none|nothing) (?:on record|recorded|exists?)|does not exist|doesn't exist|never existed)\b/i;

// Commitments to change what players see (1736: "We'll make the mine's page
// show these deliveries", never built; 1742: "I am having that wording fixed").
const PROMISE = /\b(?:we|I)(?:'ll|’ll| will| are going to| am going to)\s+(?:make|have|get|fix|change|add|remove|relabel|replace|update|reword)\b[^.!?]*\b(?:page|screen|panel|wording|label|display|figure|button|card|show|shows|tab)\b|\b(?:I(?:'m|’m| am)|we(?:'re|’re| are)) (?:fixing|changing|replacing|rewording|relabel(?:l)?ing|adding)\b|\bhaving (?:that|this|it|the)[\w ]{0,25}? (?:fixed|changed|replaced|reworded)\b|\b(?:is|are) on (?:the|its|their) way\b|\b(?:will|is going to) (?:appear|be shown|be added|show up)\b/i;

// Decisions credited to developers or the owner (1742: "the developers
// decided to compensate everyone" with no decision on record).
const DECISION = /\b(?:developers?|devs?|owner|team|staff|moderators?) (?:have |has )?(?:decided|agreed|ruled|approved|signed off)\b|\bthe ruling (?:is|was)\b|\b(?:it|this) (?:was|has been) (?:decided|agreed|ruled)\b|\bthe decision (?:is|was) (?:to|that)\b/i;

const sentenceOf = (text, re) => {
  for (const s of String(text || "").split(/(?<=[.!?])\s+|\n+/)) if (re.test(s)) return s.trim().slice(0, 160);
  return null;
};

// ctx: { emptyReads: [{ sig }], escalated, building, decided }
function refusal(text, ctx = {}) {
  let s = sentenceOf(text, CONFESSIONAL);
  if (s) return { kind: "confessional", sentence: s, reason: `"${s}" apologises or talks about Keir. Players get the right fact, not the story of the mistake. State what is correct in one sentence ("Correction: you have three agreements, not none.") and move on.` };
  s = sentenceOf(text, THIRD_PERSON);
  if (s) return { kind: "third_person", sentence: s, reason: `"${s}" talks about the player in the third person in their own channel. Address them as "you". If a developer asked why something went wrong, that answer is private: give it to them in their own task, not as a ticket post.` };
  s = sentenceOf(text, ABSENCE);
  const distinct = new Set((ctx.emptyReads || []).map((r) => r.sig)).size;
  if (s && (ctx.emptyReads || []).length && distinct < 2) return { kind: "absence_unconfirmed", sentence: s, reason: `"${s}" says something does not exist, and the read behind it came back empty. An empty answer can mean the question was wrong (ticket 1742: "nothing is signed" while three contracts existed). Confirm with a second, differently shaped read (by id instead of name, the other side of the relationship, or view_page on the player's own screen) before telling the player it is not there.` };
  s = sentenceOf(text, PROMISE);
  if (s && !ctx.escalated && !ctx.building) return { kind: "promise_unbacked", sentence: s, reason: `"${s}" promises a change the player will see, and nothing for it exists yet. Raise it with raise_to_developers or start the fix first; then the promise is backed. Otherwise say you have noted it, not that it is coming (ticket 1736 promised a page change that was never built).` };
  s = sentenceOf(text, DECISION);
  if (s && !ctx.decided) return { kind: "decision_unrecorded", sentence: s, reason: `"${s}" reports a developer or owner decision that is not on record for this ticket. Ask with raise_to_developers kind decision and wait for the answer, or record the decision a developer gave in this channel as a ticket fact with its source, then post.` };
  return null;
}

// Does a read come back empty? Recognises the shapes the game and support
// tools return; anything else counts as non-empty.
function emptyResult(result) {
  let v = result;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return /^\s*(?:\[\]|\{\}|null|no (?:results|matches|records)\b)/i.test(v); } }
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v !== "object") return false;
  if (Array.isArray(v.content) && v.content.length === 1 && v.content[0]?.type === "text") return emptyResult(v.content[0].text);
  for (const k of ["matched", "count", "total"]) if (v[k] === 0) return true;
  for (const k of ["docs", "items", "results", "rows", "records", "contracts", "agreements"]) if (Array.isArray(v[k])) return v[k].length === 0;
  return false;
}

module.exports = { refusal, emptyResult, CONFESSIONAL, THIRD_PERSON, ABSENCE, PROMISE, DECISION };
