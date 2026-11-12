"use strict";
// Keir 9: a ticket message that states a game rule or a cause should rest on the game code, not on the
// data on screen. Pure functions only: the broker decides what to do with the answer.

// What counts as stating a rule or a cause. One table, one comment per pattern.
const PATTERNS = [
  // Causal wording: the message says why something happened.
  { kind: "cause", name: "because", re: /\bbecause\b/i },
  { kind: "cause", name: "comes-from", re: /\b(?:comes?|came|stems?|stemmed) from\b/i },
  { kind: "cause", name: "that-is-why", re: /\b(?:that(?:'|’)?s|that is|this is|which is|it is) (?:exactly )?why\b|\bis why\b/i },
  { kind: "cause", name: "the-reason", re: /\b(?:the|main|real|likely|only) reason\b/i },
  { kind: "cause", name: "caused-by", re: /\bcaused by\b/i },
  { kind: "cause", name: "due-to", re: /\bdue to\b|\bas a result of\b|\bresults? from\b|\b(?:is|are) driven by\b/i },
  { kind: "cause", name: "explains", re: /\bwhich explains\b|\bthat explains\b|\bexplains why\b/i },
  { kind: "cause", name: "holds-back", re: /\b(?:holds?|holding|keeps?|keeping) [\w' -]{1,40}? back\b/i },
  // Designed-behaviour wording: the message claims how the game is meant to work.
  { kind: "cause", name: "is-designed", re: /\b(?:is|are|was|were) (?:by )?designed\b|\bby design\b|\bworks? as designed\b/i },
  { kind: "cause", name: "intended", re: /\bintended (?:behaviou?r|design|effect)\b|\b(?:is|are|works?|working) as intended\b/i },
  { kind: "cause", name: "not-a-bug", re: /\bnot a bug\b|\bisn(?:'|’)?t a bug\b|\bno bug\b/i },
  // Rule wording: the message states what the game does or allows.
  { kind: "rule", name: "only-x-can", re: /\bonly (?:the |a |an |your |one )?[\w' -]{1,30}? (?:can|may|are allowed to|is allowed to)\b/i, notFirstPerson: false },
  { kind: "rule", name: "cannot", re: /\bcannot\b|\bcan(?:'|’)?t\b|\bcan not\b|\b(?:is|are) not allowed\b|\baren(?:'|’)?t allowed\b/i, notFirstPerson: true },
  { kind: "rule", name: "never", re: /\bnever\b/i, notFirstPerson: true },
  { kind: "rule", name: "always", re: /\balways\b/i, notFirstPerson: true },
  { kind: "rule", name: "game-sets", re: /\bthe game (?:sets|fixes|caps|limits|decides|applies|charges|rounds|uses)\b/i },
  { kind: "rule", name: "each-turn", re: /\b(?:each|every|per|once a|once per) (?:game )?turn\b/i },
  { kind: "rule", name: "unlocks", re: /\bunlocks?\b|\bunlocked (?:by|at|when|after)\b/i },
  { kind: "rule", name: "requires", re: /\brequires?\b|\bneeds? (?:at least|to have|a minimum)\b|\bneeds (?:a |an |more than |two |three |\d)|\b(?:is|are) capped at\b|\bat most\b|\b(?:minimum|maximum) of\b/i },
  // How something is counted or worked out.
  { kind: "rule", name: "counts", re: /\bcounts? (?:toward|towards|as|against|for|only|once|twice)\b|\b(?:is|are|isn(?:'|’)?t|aren(?:'|’)?t|not|only|also|never) counted\b/i },
  { kind: "rule", name: "calculated", re: /\b(?:is|are|isn(?:'|’)?t|gets?|being|not) (?:calculated|computed|worked out|derived)\b|\bcalculated (?:from|as|by|using)\b/i },
];

// Sentences that are not claims.
const RELAY = /\b(?:the )?(?:developers?|devs?|owner|team|studio)\b[^.!?]{0,40}\b(?:decided|approved|agreed|confirmed|signed off|ruled|said|wants|asked|are going to|will (?:be )?(?:look|fix|change|ship|handle))\b/i; // relays a human decision
// An acknowledgement opening is stripped, not exempted: "Thanks, the game always charges 5%" still states a rule
// (audit 2026-11-12). "Thanks for the report." strips to nothing and is skipped.
const ACK_LEAD = /^\s*(?:(?:thanks|thank you)(?: (?:a lot|so much|again))?(?: for (?:the |your |that |this |all the )?(?:report|info|information|details?|screenshots?|update|reply|patience|help|waiting|feedback|clarification|context|message|ticket))?|got it|noted|understood|sure|okay|ok|will do|no problem|you(?:'|’)?re welcome|hi|hello|hey)\b[\s,.!:;\u2014-]*/i;
const stripAck = (sentence) => { let t = sentence; for (let i = 0; i < 3; i++) { const n = t.replace(ACK_LEAD, ""); if (n === t) break; t = n; } return t.trim(); };
const STATUS = /^\s*(?:i(?:'|’)?m|i am|i(?:'|’)?ll|i will|we(?:'|’)?re|we are|we(?:'|’)?ll|we will|still|now|currently)\b[^.!?]{0,60}\b(?:check(?:ing)?|look(?:ing)?|read(?:ing)?|investigat(?:e|ing)|wait(?:ing)?|work(?:ing)?|trac(?:e|ing)|going|review(?:ing)?|digging|compar(?:e|ing)|come back|get back|report back|update you)\b/i; // status line
const FIRST_PERSON = /^\s*(?:i|i(?:'|’)?m|i(?:'|’)?ve|i(?:'|’)?ll|we|we(?:'|’)?ve)\b/i; // "I can't see your records" is about Keir, not a rule

const sentencesOf = (text) => String(text || "").replace(/\s+/g, " ").match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()).filter(Boolean) || [];
const isQuestion = (s) => /\?\s*["')\]]*$/.test(s);

// The first rule or cause the message states, or null: { kind, pattern, sentence }.
function ruleClaim(message) {
  for (const raw of sentencesOf(message)) {
    const sentence = stripAck(raw);
    if (!sentence || isQuestion(sentence) || RELAY.test(sentence) || STATUS.test(sentence)) continue;
    const hit = PATTERNS.find((p) => p.re.test(sentence) && !(p.notFirstPerson && FIRST_PERSON.test(sentence)));
    if (hit) return { kind: hit.kind, pattern: hit.name, sentence: sentence.slice(0, 200) };
  }
  return null;
}
const assertsRule = (message) => Boolean(ruleClaim(message));

// The refusal text. Names the tool so the model does not guess one.
const REFUSAL = "Not posted: this states a game rule or a cause, and nothing in this ticket has read the game code. Search the game code for the rule first: read_tool on server ops-knowledge, tool code_search, with args {\"question\": <the rule in plain words>, \"claimType\": \"mechanic\", \"source\": \"dev\"} (code_exact when you know the symbol, code_read for a whole file). Read the deciding code, then answer from it in at most five short sentences. This check asks at most twice per ticket.";

// Second refusal on a ticket whose code lookups all failed or came back empty.
const REFUSAL_UNCONFIRMED = "Not posted: this states a game rule or a cause, and no code lookup on this ticket has returned anything yet. Either find the rule with a lookup that returns results (code_search with claimType mechanic, code_exact for a symbol, code_read for a file), or say plainly in the reply that this is not yet confirmed from the game code, for example \"I have not confirmed this in the game code yet, but ...\". This is the last time this check asks.";

// The message itself says the rule or cause is not confirmed.
const UNCONFIRMED = /\b(?:not (?:yet )?(?:been )?(?:confirmed|verified|checked)|unconfirmed|unverified|(?:haven(?:'|’)?t|have not|hasn(?:'|’)?t|has not|couldn(?:'|’)?t|could not) (?:yet )?(?:confirmed|verified|checked|found|read)\b[^.!?]{0,40}\b(?:code|rule|this|that|it)\b|not (?:yet )?sure|my best guess|may not be (?:right|correct))\b/i;
const statesUnconfirmed = (message) => UNCONFIRMED.test(String(message || ""));

// A code lookup result that carries something: hits, files, text or a path. Errors and empty sets carry nothing.
function codeResultHasContent(result) {
  let v = result;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return v.trim().length > 40 && !/^\s*(?:no (?:results|matches)|error)\b/i.test(v); } }
  if (v == null || typeof v !== "object") return false;
  if (v.isError || v.error) return false;
  if (Array.isArray(v.content) && v.content.length) return v.content.some((c) => c?.type === "text" && codeResultHasContent(c.text));
  for (const k of ["hits", "results", "files", "chunks", "matches", "items"]) if (Array.isArray(v[k])) return v[k].length > 0;
  if (typeof v.text === "string" || typeof v.content === "string") return String(v.text || v.content).trim().length > 0;
  return Boolean(v.path) && Object.keys(v).length > 1;
}

module.exports = { PATTERNS, assertsRule, ruleClaim, REFUSAL, REFUSAL_UNCONFIRMED, statesUnconfirmed, codeResultHasContent };
