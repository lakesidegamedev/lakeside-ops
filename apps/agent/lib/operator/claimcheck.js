"use strict";
// Keir 10 claim check. Two checks on a draft player post, run by check_draft and by every real post so the two always agree:
//   contradiction: the draft says the opposite of an earlier post on the same ticket about the same thing, with no
//                  "Correction:" lead-in (ticket 1812: "a fix is being built" then "no fix is being built").
//   unlockConflict: the draft names a unit, branch or feature as available when a read this activation says it is locked
//                  (ticket 1812: "not available until 1944" read, then "you can recruit them" posted).
// Pure functions. No ledger, no clock beyond what the caller passes.

const STOP = new Set(("a an the this that these those it its is are was were be been being am do does did has have had will would shall should can could may might must " +
  "not no never cannot cant dont doesnt isnt arent wasnt werent hasnt havent didnt wont yet now already still just also " +
  "to of in on at for from by with as and or but if so than then there here you your yours we our i my me they them their he she his her " +
  "up out off over into onto about after before until when while which who whom what whose how why all any some one two three more most").split(/\s+/));

const words = (text) => String(text || "").toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter(Boolean);
const content = (text, drop = new Set()) => new Set(words(text).filter((w) => w.length > 2 && !STOP.has(w) && !drop.has(w)));
const sentencesOf = (text) => String(text || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
const CORRECTION = /^(?:correction|to correct my (?:last|previous|earlier) message)\b/i;

// Each predicate has a positive and a negative form. A claim is one predicate with its polarity and its subject words.
// Negative forms are tested first, so "is not live" never reads as the positive "is live".
const PREDICATES = [
  { name: "being built",
    neg: /\b(?:no|not any) (?:fix|change|patch|repair|update|work)\b[^.!?]{0,40}\b(?:is|are|being|planned|underway|in progress|under way)\b|\b(?:is|are) not (?:being )?(?:built|worked on|developed|written|fixed|planned)\b|\bnot (?:building|working on|planning|fixing)\b|\bnothing is being (?:built|worked on|fixed)\b|\bno one is (?:building|working on|fixing)\b/i,
    pos: /\b(?:is|are) being (?:built|worked on|developed|written|fixed|prepared)\b|\b(?:fix|change|patch|repair|update)\b[^.!?]{0,30}\b(?:is|are) (?:in progress|underway|under way|planned|being)\b|\b(?:i am|i'm|we are|we're|the developers are) (?:building|working on|writing|preparing|fixing)\b|\bhas been (?:built|written|prepared)\b/i },
  { name: "live",
    neg: /\b(?:is|are) not (?:yet |now )?(?:live|released|out|deployed|shipped|available)\b|\b(?:isn't|aren't|isnt|arent) (?:yet |now )?(?:live|released|out|deployed|shipped)\b|\bnot (?:been )?(?:released|deployed|shipped) yet\b|\bnot live\b|\bhas not (?:been )?(?:released|reached|gone live)\b|\bhasn't (?:been )?(?:released|reached|gone live)\b/i,
    pos: /\b(?:is|are|now|has been|have been) (?:now )?(?:live|released|deployed|shipped|out)\b|\blive on the main server\b|\bgone live\b|\bwent live\b/i },
  { name: "available",
    neg: /\b(?:is|are) (?:not|no longer) (?:yet |currently )?(?:available|unlocked|open|possible)\b|\b(?:isn't|aren't|isnt|arent) (?:yet |currently )?(?:available|unlocked|open|possible)\b|\bunavailable\b|\bnot (?:yet )?(?:available|unlocked)\b|\blocked\b/i,
    pos: /\b(?:is|are|now|currently) (?:now |currently )?(?:available|unlocked|open)\b|\bavailable to you\b|\bis possible\b|\bare possible\b/i },
  { name: "can",
    neg: /\b(?:cannot|can't|cant|can not|unable to|not able to|are not allowed to|aren't allowed to|isn't allowed to|may not|do not allow|does not allow|doesn't allow|don't allow)\b/i,
    pos: /\b(?:can|are able to|is able to|are allowed to|is allowed to|may)\b(?! not)/i },
];

// The verbs that signal the predicate are dropped so what is left is the subject.
const PRED_WORDS = new Set("built build building worked working work developed written write fixed fix planned prepared progress underway live released release deployed shipped available unlocked open possible locked allowed able allow allows recruit".split(/\s+/));
// "can" claims share a subject only through what follows the modal; keep verbs for those.
const CAN_DROP = new Set(["able", "allowed", "allow", "allows"]);

function claimsOf(sentence) {
  const out = [];
  for (const p of PREDICATES) {
    const neg = p.neg.test(sentence), pos = !neg && p.pos.test(sentence);
    if (!neg && !pos) continue;
    out.push({ pred: p.name, polarity: neg ? "neg" : "pos", subject: content(sentence, p.name === "can" ? CAN_DROP : PRED_WORDS) });
  }
  return out;
}
// Shared subject: the smaller subject is mostly contained in the larger one. With no subject words at all, the two sentences
// are about the same unnamed thing (ticket-level "the fix"), which counts as shared for the building and live predicates.
function sameSubject(a, b, pred) {
  if (!a.size || !b.size) return pred === "being built" || pred === "live";
  let shared = 0; for (const w of a) if (b.has(w)) shared++;
  return shared >= 2 || shared / Math.min(a.size, b.size) >= 0.5;
}

/**
 * The first sentence of the draft that says the opposite of an earlier post on this ticket, or null.
 * posts: [{ at, text, kind }] from the ticket's post history; cards are skipped. A draft that opens with "Correction:" is intended.
 */
function contradiction(message, posts = [], { now = Date.now() } = {}) {
  const text = String(message || "").trim();
  if (!text || CORRECTION.test(text)) return null;
  const mine = sentencesOf(text).flatMap((s) => claimsOf(s).map((c) => ({ ...c, sentence: s })));
  if (!mine.length) return null;
  for (const post of [...posts].filter((p) => p && p.text && p.kind !== "status_card" && !String(p.text).startsWith("[status card]")).slice(-12).reverse()) {
    for (const earlier of sentencesOf(post.text)) {
      for (const c of claimsOf(earlier)) {
        const hit = mine.find((m) => m.pred === c.pred && m.polarity !== c.polarity && sameSubject(m.subject, c.subject, c.pred));
        if (hit) return { kind: "contradiction", pred: c.pred, sentence: hit.sentence.slice(0, 220), earlier: earlier.slice(0, 220), minutesAgo: Math.max(0, Math.round((now - (post.at || now)) / 60000)) };
      }
    }
  }
  return null;
}

// "X: not available until 1944", "X unlocks in 1944", "X opens in 1950", "X is locked until the second era".
const LOCK = /\b(?:not (?:yet )?(?:available|unlocked|usable|recruitable|buildable|open)(?: (?:until|before|till|in))|unlocks? (?:in|at|with|after|when|once)|opens? in (?:the year )?\d{4}|becomes? available (?:in|at|after|when|once|from)|locked (?:until|behind)|not available before)\b/i;
const NEGATES = /\b(?:not|cannot|can't|cant|isn't|isnt|aren't|arent|never|no|until|unlocks?|opens?|later|once|after|from \d{4}|in \d{4}|yet)\b/i;
const AVAILABLE = /\b(?:is|are|now|currently|already) (?:now |currently |already )?(?:available|unlocked|open|usable|recruitable|buildable)\b|\byou can (?:now |already )?(?:recruit|build|get|use|buy|field|train|deploy|raise|access|unlock|form|order|station|base)\b|\bcan be (?:recruited|built|bought|fielded|trained|deployed|raised|accessed|formed|ordered)\b|\bis there for you\b/i;

// The words just before a lock phrase name what is locked: the noun phrase in the same clause.
function lockedNouns(evidenceText) {
  const out = [];
  for (const line of String(evidenceText || "").split(/\n+/)) {
    for (const part of line.split(/(?<=[.;!?])\s+|\s*\|\s*|\s{2,}/)) {
      const m = LOCK.exec(part);
      if (!m) continue;
      const before = part.slice(0, m.index).replace(/\[[a-z_]+\]/gi, " ").replace(/["'`*_{}\[\]():,]+/g, " ");
      const noun = [...content(before.split(/\b(?:is|are|will be|was|which|that)\b/i)[0]).values()].slice(-4);
      if (noun.length) out.push({ nouns: noun, lock: part.trim().slice(0, 220) });
    }
  }
  return out;
}

/**
 * A draft sentence that calls a locked thing available, or null. evidenceText: what the task read this activation
 * (job.evidenceText). Generic on purpose: the lock phrase and the noun come from the read, nothing is hard coded.
 */
function unlockConflict(message, evidenceText) {
  const locks = lockedNouns(evidenceText);
  if (!locks.length) return null;
  for (const s of sentencesOf(message)) {
    if (!AVAILABLE.test(s) || NEGATES.test(s.replace(AVAILABLE, " "))) continue;
    const have = content(s);
    for (const l of locks) {
      const hits = l.nouns.filter((w) => have.has(w));
      if (hits.length >= Math.min(2, l.nouns.length) && hits.length > 0) return { kind: "unlock", noun: hits.join(" "), sentence: s.slice(0, 220), lock: l.lock };
    }
  }
  return null;
}

function contradictionRefusal(hit) {
  return `Not posted: this contradicts what the player was told ${hit.minutesAgo} min ago ("${hit.earlier}"). If the situation changed, start the post with "Correction:" and say what changed and why. If it did not, drop "${hit.sentence}" and keep one consistent account.`;
}
function unlockRefusal(hit) {
  return `Not posted: "${hit.sentence}" says ${hit.noun} is available, but a read this task made says it is locked ("${hit.lock}"). Tell the player it is not available yet and what it waits on, in the game's own words.`;
}

module.exports = { contradiction, unlockConflict, lockedNouns, claimsOf, contradictionRefusal, unlockRefusal, CORRECTION };
