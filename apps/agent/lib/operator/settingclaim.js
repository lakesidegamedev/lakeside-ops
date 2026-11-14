"use strict";
// Keir 9.0.4 (ticket 1829): telling a player to change a setting is a claim about what controls the behaviour. A reply that
// says "turn off X in Settings" must rest on a read of this ticket that contains the setting's name and path words together.
// Pure functions only: the broker decides what to do with the answer.
const readClaim = require("./readclaim");

// Verbs that change a setting. "turn", "switch", "flip" need an on/off word near them.
const ONOFF_VERB = "turn|switch|flip";
const DIRECT_VERB = "disable|enable|untick|tick|uncheck|deactivate|activate|toggle";
const CHANGE_VERB = "change|set|adjust";
const PATH_CUE = /\b(?:go to|open|head to|navigate to|tap|select|choose|visit)\s+(?:the\s+|your\s+|its\s+)?(?:\w+\s+)?(?:settings?|preferences|options|menu)\b/i;
const SETTINGISH = /\b(?:settings?|preferences?|options?|toggle|switch|mode|menu)\b/i;

// What may stand before the verb for it to be an instruction to the player (an imperative or a "you can" form).
const LEAD = /(?:^|[,;:]\s*|\b(?:then|and|please|just|simply|first|now|also|next|try(?: to)?|instead|otherwise|for now|you (?:can|could|should|need to|must|have to|may want to|might want to|will need to|(?:'|’)ll need to|(?:'|’)ll want to|want to)|(?:can|could|would|will) you(?: please)?)\s+)$/i;

const CONFIRM_HEDGE = /\b(?:(?:have not|haven(?:'|’)?t|not|cannot|can(?:'|’)?t|unable to)\s+(?:yet\s+)?(?:confirm|confirmed|verify|verified)|unconfirmed)\b/i;
const NEGATED_INSTR = /\b(?:do not|don(?:'|’)?t|never|no need to|not need to|needn(?:'|’)?t|without)\b/i;
const REQUEST_FORM = /^\s*(?:(?:can|could|would|will) you\b)/i;

// Words that name the act or the menu, not the setting. Words that name the platform (phone, android, system) stay: a read of the
// game's own switch does not back an instruction about the phone's.
const GENERIC = new Set(("setting settings option options preference preferences menu tab section toggle toggled toggles switch switched switches button turn turned turns off on back again enable enabled disable disabled " +
  "untick tick uncheck check deactivate activate change changed set adjust flip app application go goes open head navigate tap select choose visit find look click press then first next " +
  "please try just simply need want around through there here look looks about can could should must it them this that for now instead otherwise power slider checkbox box item entry").split(/\s+/));

const sentencesOf = (text) => String(text || "").replace(/\s+/g, " ").match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()).filter(Boolean) || [];
const TERMINATOR = /\s+(?:to (?:see|check|test|stop|avoid|make|help|get|confirm|find)|so\b|because\b|since\b|which\b|until\b|and then\b|and (?:see|check|tell|let|try)\b|then (?:check|see|tell|let|try)\b|before\b|while\b|if\b|for now\b|instead\b|rather\b|whenever\b|when\b|that way\b)|[.;:!?]|,\s+(?:and|but|so|which|then (?:check|see|tell|let|try))\b/i;

function stemsOf(text) {
  const words = String(text || "").replace(/['’]s\b/g, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_+/g, " ").toLowerCase().match(/[a-z][a-z'’-]*/g) || [];
  return readClaim.contentStems(words.filter((w) => !GENERIC.has(w)).join(" "));
}

// The instruction in one sentence, or null: { sentence, phrase, stems }.
function instructionIn(sentence) {
  const s = String(sentence || "").trim();
  if (!s || CONFIRM_HEDGE.test(s) || NEGATED_INSTR.test(s)) return null;
  if (/\?\s*["')\]]*$/.test(s) && !REQUEST_FORM.test(s)) return null;
  const verbRe = new RegExp(`\\b(${ONOFF_VERB}|${DIRECT_VERB}|${CHANGE_VERB})\\b`, "gi");
  let m;
  while ((m = verbRe.exec(s))) {
    const verb = m[1].toLowerCase();
    const before = s.slice(0, m.index);
    if (!LEAD.test(before)) continue;
    const tail = s.slice(m.index + m[0].length);
    const cut = TERMINATOR.exec(tail);
    const object = cut ? tail.slice(0, cut.index) : tail;
    const near = object.split(/\s+/).slice(0, 8).join(" ");
    if (new RegExp(`^(?:${ONOFF_VERB})$`).test(verb) && !/\b(?:on|off)\b/i.test(near)) continue;
    if (new RegExp(`^(?:${CHANGE_VERB})$`).test(verb) && !SETTINGISH.test(s)) continue;
    // The menu path said before the verb ("Go to Settings, Accessibility, then switch off Remove animations") names the setting too.
    const pathAt = before.search(PATH_CUE);
    const phrase = (pathAt >= 0 ? before.slice(pathAt) : "") + " " + object;
    const stems = stemsOf(phrase);
    if (!stems.length) continue;
    return { sentence: s, phrase: phrase.trim().slice(0, 160), stems };
  }
  // A menu path on its own: "Go to Settings, Accessibility, Remove animations."
  const p = PATH_CUE.exec(s);
  if (p && LEAD.test(s.slice(0, p.index))) {
    const rest = s.slice(p.index + p[0].length);
    const cut = TERMINATOR.exec(rest);
    const stems = stemsOf(cut ? rest.slice(0, cut.index) : rest);
    if (stems.length) return { sentence: s, phrase: s.slice(p.index).slice(0, 160), stems };
  }
  return stateInstructionIn(s);
}

// Keir 9.0.5 (replay, 2026-11-14): three more instruction forms reached a player unbacked:
//   "make sure animations are not turned off in your Android accessibility settings"   (state wanted)
//   "check your Android accessibility settings"                                         (where to look)
//   "the only ways to watch it are turning X off ... with Android animations on"         (a gerund way)
const STATE_WORD = "(?:on|off|enabled|disabled|switched (?:on|off)|turned (?:on|off))";
const ENSURE = new RegExp(`\\b(?:make sure|ensure|check(?: that| whether)?|confirm(?: that)?|double-check(?: that)?|verify(?: that)?|keep)\\b([^.!?]{1,90}?)\\b(?:is|are|stays?|remains?|is still|are still|has|have)?\\s*(?:not\\s+)?(?:been\\s+)?${STATE_WORD}\\b([^.!?]{0,80})`, "i");
const LOOK_IN = /\b(?:check|look (?:in|at|under)|open|go into|go to)\s+(?:your|the|their)\s+([\w' -]{2,60}?)\s+(?:settings?|preferences|options|menu)\b/i;
const GERUND_WAY = /\b(?:only ways?|the way|best way|easiest way|you can (?:watch|play|fix|get)[^.!?]{0,40}?by|by)\b[^.!?]{0,60}?\b(?:turning|switching|disabling|enabling|setting)\b([^.!?]{1,120})/i;
function stateInstructionIn(s) {
  if (/\?\s*["')\]]*$/.test(s) && !REQUEST_FORM.test(s)) return null;
  if (CONFIRM_HEDGE.test(s) || /\b(?:no need to|don(?:'|’)?t need to|do not need to|needn(?:'|’)?t)\b/i.test(s)) return null;
  for (const re of [ENSURE, LOOK_IN, GERUND_WAY]) {
    const m = re.exec(s);
    if (!m) continue;
    const phrase = m.slice(1).filter(Boolean).join(" ").trim();
    const stems = stemsOf(phrase);
    if (stems.length) return { sentence: s, phrase: m[0].trim().slice(0, 160), stems };
  }
  return null;
}

// Instructions in a message that no read backs. reads: texts of reads on this ticket (never Keir's own posts or notes).
function unbackedSettingClaims(message, reads) {
  const texts = (reads || []).map((r) => String(r || "")).filter(Boolean);
  const bad = [];
  for (const sentence of sentencesOf(message)) {
    const c = instructionIn(sentence);
    if (!c) continue;
    if (!texts.some((t) => readClaim.windowBacks(t, c.stems))) bad.push(c);
  }
  return bad;
}

const REFUSAL = (claim) => `Not posted: this tells the player to change a setting ("${String(claim.phrase).slice(0, 140)}"), but nothing Keir read on this ticket names that setting. Read the code that controls the behaviour (code_search with claimType mechanic, or code_read) and name the setting the code shows, in the words the game uses and where to find it. Do not send the player to a phone or system setting, or any switch, that no read showed. If you cannot confirm it, say so plainly: "This may help, but I have not confirmed it: ...". This check asks at most twice per ticket.`;

const HEDGE = "This may help, but I have not confirmed it: ";

// After the last refusal the code labels the instruction as unconfirmed; the player still gets the rest of the answer.
function hedge(message, claims, maxChars) {
  let out = String(message || "");
  for (const c of claims) {
    const at = out.indexOf(c.sentence);
    if (at < 0) continue;
    const lead = /^[A-Z][a-z]/.test(c.sentence) ? c.sentence.slice(0, 1).toLowerCase() + c.sentence.slice(1) : c.sentence;
    const next = out.slice(0, at) + HEDGE + lead + out.slice(at + c.sentence.length);
    out = !maxChars || next.length <= maxChars ? next : out.slice(0, at) + out.slice(at + c.sentence.length).replace(/^\s+/, "");
  }
  return out.trim() || String(message || "");
}

module.exports = { instructionIn, unbackedSettingClaims, stemsOf, REFUSAL, HEDGE, hedge, MAX_REFUSALS: 2 };
