"use strict";
// Keir 9: a ticket reply must not say what a page, record or panel "shows", "says" or "records" unless a read on this
// ticket actually returned those words. The failure measured on replay tickets: the model reads "the tile uses the
// allocation record" and tells the player the tile "is reading how much output you put up for sale", or reads a panel's own
// text "short of inputs" and says "your record says inputs held the run back" when the record names no such cut. Pure
// functions only: the broker decides what to do with the answer.

// The things a player can look at. A claim needs one of these as its subject.
const SOURCE = "gauge|meter|indicator|widget|counter|label|metric|page|panel|tile|record|records|log|logs|screen|chip|badge|line|figures?|numbers?|data|report|history|ledger|table|chart|row|bar|game|dashboard|readout|display";
// What the subject is said to do with the information.
const VERB = "shows?|showed|shown|says?|said|records?|recorded|reads?|reading|lists?|listed|names?|named|notes?|noted|saved?|stores?|stored|logged|counts?|counted|counting|uses?|used|using|treats?|treated|measures?|measured|displays?|displayed|reports?|reported|marks?|marked|tracks?|tracked|tracking|showing|saying|recording|listing|naming|noting|saving|storing|logging|displaying|reporting|marking";
const CLAIM = new RegExp(`\\b(?:${SOURCE})\\b((?:\\s+[\\w%'’.-]+){0,3}?)\\s+(?:(?:is|are|was|were|has|have|had|did|does|do)\\s+)?(?:(?:been|still|actually|only|just|also|now|simply)\\s+)*(?:${VERB})\\b([^]*)$`, "i");
// "The 100% was the share of output you put up for sale": a figure said to be a measure of something.
const MEASURE_SUBJECT = "gauge|meter|indicator|counter|metric|tile|figure|number|value|percentage|percent|label|badge|chip|bar|line|total|count|reading|\\d[\\d,.]*\\s?%";
const MEASURE = new RegExp(`\\b(?:${MEASURE_SUBJECT})(?:\\s+[\\w%'’.-]+){0,2}?\\s+(?:is|was|means|meant|represents|represented|measures|measured|equals|stands for)\\s+(?:(?:really|actually|simply|just|only|in fact)\\s+)?((?:the\\s+)?(?:share|amount|number|count|total|percentage|fraction|proportion|measure|sum|ratio|rate|portion)\\s+of\\b[^]*|how\\s+(?:much|many)\\b[^]*|an?\\s+(?:count|measure|total|share|ratio|percentage)\\b[^]*)$`, "i");
const NOT_A_CLAIM_GAP = /\b(?:to|should|must|need|needs|needed|if|whether|so that)\b/i; // "asked for the tile to show X" is a request, not a finding

// A clause that denies, hedges or restates the player is not a claim of a fact read.
const NEGATED = /\b(?:not|no|none|nothing|never|neither|nor|without|cannot|can(?:'|’)?t|isn(?:'|’)?t|doesn(?:'|’)?t|don(?:'|’)?t|didn(?:'|’)?t|wasn(?:'|’)?t|hasn(?:'|’)?t|haven(?:'|’)?t|won(?:'|’)?t|couldn(?:'|’)?t|missing|blank|empty|unable)\b/i;
const HEDGED = /\b(?:may|might|could|possibly|perhaps|probably|likely|seems?|appears?|suspect|suspected|guess|think|unclear|not clear|unconfirmed|unverified|not (?:yet )?(?:confirmed|verified|established|sure)|have not confirmed|haven(?:'|’)?t confirmed|cannot confirm|can(?:'|’)?t confirm|do not know|don(?:'|’)?t know|if so|in theory|best guess)\b/i;
const RESTATES_PLAYER = /\b(?:you (?:said|wrote|told|mentioned|reported|describe[sd]?|saw|see)|your (?:message|report|ticket|description|screenshot|post)|as you (?:said|put it|wrote|describe[sd]?))\b/i;
const STATUS = /^\s*(?:i(?:'|’)?m|i am|i(?:'|’)?ll|i will|we(?:'|’)?ll|we will|let me|going to)\b/i;
// A condition or a general instruction ("if a screen shows wrong figures, report it here") describes no page that was read.
const CONDITIONAL = /\b(?:if|unless|whenever|whether|in case|any time|anytime)\b/i;
const FUTURE = /\b(?:will|would|should|going to|shall)\s+(?:be\s+)?(?:show|read|say|record|list|name|display|use|count)/i;

const STOP = new Set(("the a an and or of to in on at for from by with as is are was were be been being it its this that these those there here your you yours " +
  "my our their his her they them we us i me he she which who whom what when where why how than then so but if not no yes do does did done have has had having " +
  "can could will would should may might must also just only still now very more most much many some any all each every both such same other another own " +
  "up out off over under into onto about after before again once per via like thing things way one two three first last next new old different " +
  "page panel tile record records log logs screen chip badge line figure figures number numbers data report history ledger table chart row bar game sector farm plant site " +
  "corporation company account dashboard readout display show shows showed shown say says said list lists listed name names named note notes noted save saves saved " +
  "store stores stored logged count counts counted counting use uses used using treat treats measure measures measured mark marks marked track tracks tracked read reads reading " +
  "turn turns get gets got make makes made take takes took see sees saw look looks looked tell tells told give gives gave come comes came go goes went seem seems appear appears " +
  "instead something anything nothing everything whole actual actually really simply already always never even else though however because since while").split(/\s+/));

const stem = (w) => {
  let s = w.toLowerCase();
  const irregular = { held: "hold", sold: "sell", took: "take", paid: "pay", bought: "buy", made: "make", kept: "keep", sent: "send", lost: "lose", got: "get", ran: "run" };
  if (irregular[s]) return irregular[s];
  if (s.length > 5) s = s.replace(/(?:ing|ed|es|ly)$/, "");
  else if (s.length > 3) s = s.replace(/s$/, "");
  if (s.length > 4) s = s.replace(/s$/, "");
  if (s.length > 4) s = s.replace(/e$/, "");
  return s;
};
const wordsOf = (text) => String(text || "")
  .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_]+/g, " ")
  .toLowerCase().match(/[a-z][a-z'’-]*/g) || [];
const contentStems = (text) => [...new Set(wordsOf(text).filter((w) => w.length > 2 && !STOP.has(w)).map(stem).filter((s) => s.length > 2 && !STOP.has(s)))];

const sentencesOf = (text) => String(text || "").replace(/\s+/g, " ").match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()).filter(Boolean) || [];
const clausesOf = (sentence) => sentence.split(/\s*;\s+|,?\s+(?:rather than|instead of)\s+|,\s+not\s+|,\s+(?:but|and|so|while|which|though|although|yet)\s+|\s+(?:but|so)\s+/i).map((c) => c.trim()).filter(Boolean);

// The clauses of a message that state what a source shows, with the stems of what they say it shows.
// Each: { sentence, clause, object, stems }. A clause with no content word after the verb (only figures, say) is not returned:
// figures are checked by the number check.
function readClaims(message) {
  const out = [];
  for (const sentence of sentencesOf(message)) {
    if (/\?\s*["')\]]*$/.test(sentence) || STATUS.test(sentence)) continue;
    const clauses = clausesOf(sentence);
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i];
      let m = CLAIM.exec(clause);
      if (!m) { const k = MEASURE.exec(clause); if (!k) continue; m = [k[0], "", k[1]]; m.index = k.index; }
      const object = String(m[2] || "").trim();
      const claimText = clause.slice(m.index);
      if (NOT_A_CLAIM_GAP.test(m[1] || "") || NEGATED.test(clause) || HEDGED.test(clause) || (i > 0 && HEDGED.test(clauses[i - 1])) || RESTATES_PLAYER.test(sentence) || FUTURE.test(claimText) || CONDITIONAL.test(clause) || (i > 0 && CONDITIONAL.test(clauses[i - 1]))) continue;
      const stems = contentStems(object);
      if (!stems.length) continue;
      out.push({ sentence, clause, object: object.slice(0, 160), stems });
    }
  }
  return out;
}

// Longest span, in words, inside which the claimed words must all (or nearly all) appear in one read.
const WINDOW = 40;
// How many of the claimed words may be missing: none for up to four, one for five to nine, and so on.
const allowedMissing = (n) => Math.floor(n / 5);

// Does one read's text contain the claimed words close together?
function windowBacks(readText, stems) {
  const tokens = wordsOf(readText).map(stem);
  const need = stems.length - allowedMissing(stems.length);
  if (need <= 0) return true;
  const wanted = new Set(stems), at = [];
  tokens.forEach((t, i) => { if (wanted.has(t)) at.push([i, t]); });
  for (let a = 0; a < at.length; a++) {
    const seen = new Set();
    for (let b = a; b < at.length && at[b][0] - at[a][0] < WINDOW; b++) seen.add(at[b][1]);
    if (seen.size >= need) return true;
  }
  return false;
}

// Words the player supplied are theirs, not a finding: restating them is not a claim about a record.
const withoutPlayerWords = (stems, playerText) => {
  const theirs = new Set(contentStems(playerText));
  return stems.filter((s) => !theirs.has(s));
};

// The claims in a message that no read backs. reads: array of read texts for this ticket (never the player's own words);
// playerText: what the player wrote in the ticket.
function unbackedClaims(message, reads, playerText) {
  const texts = (reads || []).map((r) => String(r || "")).filter(Boolean);
  const bad = [];
  for (const c of readClaims(message)) {
    const stems = withoutPlayerWords(c.stems, playerText);
    if (!stems.length) continue;
    if (!texts.some((t) => windowBacks(t, stems))) bad.push({ ...c, stems });
  }
  return bad;
}

const REFUSAL = (claim) => `Not posted: this says what a page, record or panel shows ("${String(claim.clause).slice(0, 140)}"), but nothing Keir read on this ticket contains that. Either quote what the read actually returned (read the page or record again if you need to), or say plainly that the cause is not confirmed, for example "I have not confirmed this, but ...". Do not state a cause or a recorded fact that no read showed. This check asks at most twice per ticket.`;

const HEDGE = "I have not confirmed this, but ";

// After the last refusal: the code labels each unbacked clause as unconfirmed instead of leaving a guess standing as a recorded fact.
// A clause is never dropped silently and the player always gets the rest of the answer.
function hedge(message, claims, maxChars) {
  let out = String(message || "");
  for (const c of claims) {
    const at = out.indexOf(c.sentence);
    if (at < 0) continue;
    const lead = /^(?:The|Your|That|This|It|These|Those|A|An|Both|There)\b/.test(c.sentence) ? c.sentence.slice(0, 1).toLowerCase() + c.sentence.slice(1) : c.sentence;
    const labelled = HEDGE + lead;
    const next = out.slice(0, at) + labelled + out.slice(at + c.sentence.length);
    out = !maxChars || next.length <= maxChars ? next : out.slice(0, at) + out.slice(at + c.sentence.length).replace(/^\s+/, "");
  }
  return out.trim() || String(message || "");
}

module.exports = { clausesOf, stem, HEDGED, CONDITIONAL, RESTATES_PLAYER, readClaims, unbackedClaims, windowBacks, contentStems, REFUSAL, HEDGE, hedge, MAX_REFUSALS: 2 };
