"use strict";
// Keir 9: calling behaviour a bug, a fault, a defect or something that "needs a code change" is a claim. Measured on a replay
// ticket: Keir explained an import ban correctly, then told the player the ban blocking shipments between their own sites was a
// bug needing a code change, when the game code does exactly that on purpose. The sentence rested on what the model thought
// the rule ought to be, not on anything it read. Pure functions only: the broker decides what to do with the answer.

const { sentencesOf, RELAY, STATUS } = require("./rulelookup");
const { clausesOf, contentStems, stem, HEDGED, CONDITIONAL, RESTATES_PLAYER } = require("./readclaim");

// A word that labels behaviour as a defect.
const DEFECT = String.raw`(?:bugs?|faults?|defects?|glitch(?:es)?|flaws?|mistakes?|errors?|oversights?|regressions?)`;
const PATTERNS = [
  // "this is a bug", "that looks like a real fault", "counts as a defect"
  { name: "is-a-bug", re: new RegExp(String.raw`\b(?:is|are|was|were|be|being|looks? like|sounds? like|seems? to be|appears? to be|counts? as|amounts? to|is really|is actually)\s+(?:(?:a|an|the|another|one)\s+)?(?:(?:real|genuine|actual|clear|known|separate|simple|code|logic|design|display|wording)\s+)*${DEFECT}\b`, "i") },
  // "a bug in the route rules", "the fault is in how the ban is applied"
  { name: "bug-in", re: new RegExp(String.raw`\b${DEFECT}\s+(?:in|with|on|where|that|which)\b|\bthe ${DEFECT}\s+is\b`, "i") },
  // "needs a code change", "needs to be fixed", "needs fixing"
  { name: "needs-change", re: /\bneeds?\s+(?:(?:a|an|the)\s+)?(?:(?:code|developer|dev|engineering|logic|rules?)\s+)?(?:change|fix|patch|correction|repair|rewrite)\b|\bneeds?\s+(?:to be\s+)?(?:fixed|fixing|changed|corrected|patched|repaired|rewritten)\b/i },
  // "should not block your own sites", "shouldn't be closing the route"
  { name: "should-not", re: /\b(?:should(?:n(?:'|’)?t| not)|ought not to|must not)\s+(?:be\s+)?(?:block\w*|stop\w*|clos\w*|prevent\w*|happen\w*|charg\w*|count\w*|cut\w*|appl\w*|treat\w*)\b/i },
  // "is broken", "works incorrectly", "is wrongly blocking"
  { name: "broken", re: /\b(?:is|are|was|were)\s+(?:currently\s+|simply\s+)?(?:broken|misbehaving|malfunctioning|wrong(?:ly)?|incorrect(?:ly)?|misapplied|misconfigured)\b|\b(?:wrongly|incorrectly|mistakenly|erroneously)\s+(?:block|clos|stop|charg|count|cut|appl|treat|prevent|reject|refus|ignor)\w*|\b(?:not|isn(?:'|’)?t|aren(?:'|’)?t|doesn(?:'|’)?t|don(?:'|’)?t) (?:working|behav(?:ing|e)|work|function(?:ing)?) (?:as (?:it|they) should|correctly|properly|right)\b/i },
  // "the code does the wrong thing", "a flaw in the game code"
  { name: "code-wrong", re: /\b(?:code|rule|logic|formula|check|calculation)\s+(?:is|looks|seems|appears)\s+(?:wrong|broken|faulty|buggy|incorrect)\b|\bbuggy\b|\bfaulty\b/i },
];

// "not a bug" and "isn't really a fault" deny the label; they are not a claim of one. Judged locally, not for the whole sentence.
const DENIED = new RegExp(String.raw`\b(?:not|isn(?:'|’)?t|aren(?:'|’)?t|wasn(?:'|’)?t|no|never|neither|nor|without|rather than)\s+(?:(?:really|actually|necessarily|quite|exactly|simply|just|a|an|the|any|real|genuine)\s+){0,3}${DEFECT}\b|\b(?:not|isn(?:'|’)?t|doesn(?:'|’)?t|don(?:'|’)?t|no longer|never)\s+(?:(?:really|actually|necessarily|currently)\s+)?(?:need|needs|require|requires)\s+(?:a |an )?(?:code |developer )?(?:change|fix|fixing)|\b(?:rather|not) (?:a|an) (?:code )?(?:change|fix)\b|\b(?:no|not a) (?:code )?(?:change|fix) (?:is |was )?(?:needed|required|necessary)\b`, "i");
// "report a bug", "file a bug", "when you hit a bug": an instruction to the player, not a finding.
const INSTRUCTION = new RegExp(String.raw`\b(?:report|file|raise|log|submit|send|open)\s+(?:(?:me|us|it|this|that|any|an?|the|another|new|a new)\s+)*${DEFECT}\b|\b${DEFECT}\s+(?:report|ticket|template|channel|form|queue)\b|\bwhen (?:you|a player)\b`, "i");
// The sentence says outright that the label is not confirmed or that it is the intended rule.
const UNCONFIRMED_LABEL = /\b(?:not (?:yet )?(?:been )?(?:confirmed|verified|established|sure|certain|clear)|unconfirmed|unverified|(?:haven(?:'|’)?t|have not|hasn(?:'|’)?t|has not|couldn(?:'|’)?t|could not|can(?:'|’)?t|cannot) (?:yet )?(?:confirm(?:ed)?|verif(?:y|ied)|tell|say|establish(?:ed)?|check(?:ed)?)\b|(?:do not|don(?:'|’)?t) (?:yet )?know (?:if|whether|that)|my best guess|may not be (?:right|correct)|not sure (?:if|whether|that))\b/i;

// The words in a read that mark behaviour as a fault: a developer's label, a code comment, a tracker entry.
const FAULT_MARK = /\b(?:bug|bugs|bugfix|fault|faults|defect|defects|glitch|regression|fixme|known issue|known problem|broken|workaround|incorrectly|wrongly|mistake|erroneous|unintended|oversight|should not|shouldn(?:'|’)?t)\b|\bTODO\b|"labels"\s*:\s*\[[^\]]*bug/i;

// The first sentence that labels behaviour a defect, or null: { pattern, sentence, clause, stems }. Skips questions, status lines,
// conditions, instructions, denials, relayed human decisions, restated player words and hedged or unconfirmed wording.
function bugClaim(message, playerText = "") {
  for (const sentence of sentencesOf(message)) {
    if (/\?\s*["')\]]*$/.test(sentence) || STATUS.test(sentence) || RELAY.test(sentence) || RESTATES_PLAYER.test(sentence)) continue;
    if (UNCONFIRMED_LABEL.test(sentence) || HEDGED.test(sentence) || CONDITIONAL.test(sentence) || INSTRUCTION.test(sentence)) continue;
    for (const clause of clausesOf(sentence)) {
      const hit = PATTERNS.find((p) => p.re.test(clause));
      if (!hit || DENIED.test(clause)) continue;
      // The words the label is about: the whole sentence, so a short clause ("so this needs a code change") keeps its subject.
      const theirs = new Set(contentStems(playerText));
      const stems = contentStems(sentence).filter((s) => !theirs.has(s) && !LABEL_STEMS.has(s));
      return { pattern: hit.name, sentence: sentence.slice(0, 240), clause: clause.slice(0, 200), stems };
    }
  }
  return null;
}

// The label's own words are not what it is about.
const LABEL_STEMS = new Set(["bug", "fault", "defect", "glitch", "flaw", "mistak", "error", "oversight", "regression", "code", "change", "fix", "patch", "correction", "need", "broken", "wrong", "incorrect", "block", "close", "clos", "stop", "happen", "prevent", "code", "logic", "taking", "forward", "raised", "reported", "filed"].map(stem));

// The window, in words, inside which the claimed subject and the fault marking must meet.
const WINDOW = 45;

// Does one read both mark a fault and name what the claim is about, close together? A read about the same subject that does not call it a
// fault (the code doing what it says) does not back the label. A claim with too little subject to match is backed only by a marking
// that names it: a fault marking alone, far from the subject, is not enough.
function readBacks(readText, stems) {
  const raw = String(readText || "").replace(/\\+"/g, '"');
  if (!FAULT_MARK.test(raw)) return false;
  if (!stems.length) return false;
  const need = Math.max(2, Math.ceil(stems.length * 0.5));
  const tokens = raw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_+/g, " ").toLowerCase().match(/[a-z][a-z'’-]*/g) || [];
  const wanted = new Set(stems), marks = [], at = [];
  tokens.forEach((t, i) => { if (FAULT_MARK.test(t) || (t === "known" && /^(?:issue|problem)/.test(tokens[i + 1] || ""))) marks.push(i); const s = stem(t); if (wanted.has(s)) at.push([i, s]); });
  if (!marks.length) return false;
  for (const m of marks) {
    const seen = new Set();
    for (const [i, s] of at) if (Math.abs(i - m) <= WINDOW) seen.add(s);
    if (seen.size >= Math.min(need, wanted.size)) return true;
  }
  return false;
}

// The claim, or null, when no read on the ticket backs it. reads: texts of reads on this ticket (never the player's words).
function unbackedBugClaim(message, reads, playerText) {
  const claim = bugClaim(message, playerText);
  if (!claim) return null;
  const texts = (reads || []).map((r) => String(r || "")).filter(Boolean);
  if (texts.some((t) => readBacks(t, claim.stems))) return null;
  return claim;
}

const REFUSAL = (claim) => `Not posted: this calls behaviour a bug, fault or defect, or says it needs a code change ("${String(claim.sentence).slice(0, 140)}"), but nothing Keir read on this ticket marks it as a fault or shows it contradicting a rule in the code. Read the code that decides it (code_search with claimType mechanic, or code_read) and say whether it is the rule. If the code does this on purpose, tell the player it is how the game works and do not call it a bug or promise a change. If the code or a developer's note marks it as a fault, quote that. If you cannot tell, say plainly "I have not confirmed this is a fault, but ...". This check asks at most twice per ticket.`;

const HEDGE = "I have not confirmed this is a fault, but ";

// After the last refusal the code labels the sentence unconfirmed instead of leaving a guess standing as a diagnosis. Never drops the
// sentence unless the draft would be too long, and the player always gets the rest of the answer.
function hedge(message, claim, maxChars) {
  const out = String(message || "");
  const at = out.indexOf(claim.sentence);
  if (at < 0) return out;
  const lead = /^(?:The|Your|That|This|It|These|Those|A|An|Both|There|Japan|National)\b/.test(claim.sentence) ? claim.sentence.slice(0, 1).toLowerCase() + claim.sentence.slice(1) : claim.sentence;
  const next = out.slice(0, at) + HEDGE + lead + out.slice(at + claim.sentence.length);
  if (!maxChars || next.length <= maxChars) return next.trim();
  return (out.slice(0, at) + out.slice(at + claim.sentence.length).replace(/^\s+/, "")).trim() || out;
}

module.exports = { bugClaim, unbackedBugClaim, readBacks, REFUSAL, HEDGE, hedge, MAX_REFUSALS: 2, PATTERNS };
