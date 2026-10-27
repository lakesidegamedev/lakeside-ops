"use strict";
/**
 * Automatic moderation for the lakesidegames.net support form.
 *
 * The word lists are copied from A House Divided so the studio has one
 * standard:
 *   - src/lib/wiki/contentFilter.ts  HARD_BLOCK_PATTERNS, SPAM_PATTERNS
 *   - src/lib/moderation.ts          SLUR_PATTERNS, MODERATE_PROFANITY_PATTERNS
 * The AHD slur list blocks player-written news and mail. Some of its entries
 * are also ordinary words (Guinea, cracker, infidel, Mick), which a support
 * ticket for a geopolitics game will contain, so those only flag the ticket
 * for staff here. Unambiguous slurs and hate speech refuse the submission.
 *
 * moderateSubmission returns { ok:false, error } to refuse, or
 * { ok:true, flags:[reason] } where flags are shown to staff on the ticket.
 * It never acts on the player beyond refusing the submission.
 */

// Refuse outright. contentFilter.ts HARD_BLOCK_PATTERNS plus the slurs from
// moderation.ts that have no ordinary meaning. The n-word patterns require the
// double g here: both AHD lists also match the country Niger.
const HARD_BLOCK_PATTERNS = [
  /\b(n[i1]gg[e3]r(s|z)?|f[a4]gg?[o0]t(s|z)?|tr[a4]nn(y|ies))\b/i,
  /\b(k[i1]ke(s|z)?|sp[i1]c(s|z)?|w[e3]tb[a4]ck(s|z)?)\b/i,
  /\b(kill\s+(yourself|urself)|k[yi]s)\b/i,
  /\b(lolic[o0]n|sh[o0]tac[o0]n|cp\s+(link|pack|forum))\b/i,
  /\bn[i1!]+[g9]{2,}/i,
  /\bjig+a?b[o0]+\b/i,
  /\bporch\s*monk/i,
  /\bsambo\b/i,
  /\bdarkie\b/i,
  /\bpickaninny\b/i,
  /\bgook\b/i,
  /\bslant\s*eye/i,
  /\bzipper\s*head/i,
  /\bbeaner\b/i,
  /\bz[i1]+og\b/i,
  /\brag\s*head\b/i,
  /\btowel\s*head\b/i,
  /\bsand\s*n[i1]g/i,
  /\bcamel\s*jock/i,
  /\bf[a@4]+gg?[o0]+t/i,
  /\bf[a@4]+g\b/i,
  /\btr[a@4]+nn[yi]/i,
  /\bsh[e3]male\b/i,
];

// moderation.ts slurs that are also ordinary words or names ("a chink in
// the armour", Papua New Guinea). Flag for staff.
const FLAG_SLUR_PATTERNS = [
  /\bch[i1]nk(s|z)?\b/i,
  /\bcoon\b/i,
  /\bspook\b/i,
  /\bmulatt[oa]\b/i,
  /\bnip\b/i,
  /\bjap\b/i,
  /\byelow\b/i,
  /\bgreaser\b/i,
  /\bhonky\b/i,
  /\bcracker\b/i,
  /\bwhite\s*trash\b/i,
  /\bheb[e3]+\b/i,
  /\bpak[i1]\b/i,
  /\bhajji\b/i,
  /\bsquaw\b/i,
  /\bredskin\b/i,
  /\bmick\b/i,
  /\bwop\b/i,
  /\bdago\b/i,
  /\bguinea\b/i,
  /\bd[yi]+k[e3]\b/i,
  /\bpapist\b/i,
  /\bprot[e3]stant\s*scum\b/i,
  /\binfid[e3]l\b/i,
];

// moderation.ts MODERATE_PROFANITY_PATTERNS. Swearing in a ticket is allowed,
// but staff should know before they open it.
const PROFANITY_PATTERNS = [
  /\bf[\W_]*u[\W_]*c[\W_]*k(?:\w*)?\b/i,
  /\br[\W_]*a[\W_]*p[\W_]*e(?:d|r|rs|s|ing|ist)?\b/i,
  /\bb[\W_]*i[\W_]*t[\W_]*c[\W_]*h(?:es|y|ing|es)?\b/i,
  /\bc[\W_]*u[\W_]*n[\W_]*t(?:s|y|ing)?\b/i,
  /\bs[\W_]*h[\W_]*i[\W_]*t(?:s|ty|ting)?\b/i,
  /\ba[\W_]*s[\W_]*s[\W_]*h[\W_]*o[\W_]*l[\W_]*e(?:s)?\b/i,
  /\bb[\W_]*a[\W_]*s[\W_]*t[\W_]*a[\W_]*r[\W_]*d(?:s)?\b/i,
  /\bw[\W_]*h[\W_]*o[\W_]*r[\W_]*e(?:s|y|d|ing)?\b/i,
  /\bs[\W_]*l[\W_]*u[\W_]*t(?:s|ty|ting)?\b/i,
  /\bm[\W_]*o[\W_]*t[\W_]*h[\W_]*e[\W_]*r[\W_]*f[\W_]*u[\W_]*c[\W_]*k[\W_]*e[\W_]*r(?:s)?\b/i,
];

// contentFilter.ts SPAM_PATTERNS plus a few common ticket-spam phrases.
const SPAM_PATTERNS = [
  /\b(viagra|cialis|mg\d+)\b/i,
  /\b(buy\s+followers|free\s+robux|crypto\s+giveaway)\b/i,
  /\b(seo\s+services|backlinks?\s+(service|package)|guest\s+post(ing)?\s+service)\b/i,
  /\b(online\s+casino|betting\s+tips|forex\s+signals|investment\s+opportunity)\b/i,
  /\b(earn|make)\s+\$?\d[\d,]*\s*(per|a|\/)\s*(day|week|hour)\b/i,
];

const MAX_LINKS = 2;
const LINK_RE = /\b(?:https?:\/\/|www\.)\S+|\bdiscord(?:\.gg|app\.com\/invite|\.com\/invite)\/\S+/gi;
const REPEAT_RE = /(\S)\1{9,}/;
const BLOCK_MESSAGE = "Your message contains language we do not accept. Please rewrite it and send it again.";

function countLinks(text) {
  return (text.match(LINK_RE) || []).length;
}

// A wall of capitals: at least 40 letters and over 80% of them upper case.
// Between 60% and 80% is only flagged.
function capsRatio(text) {
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < 40) return 0;
  return letters.replace(/[^A-Z]/g, "").length / letters.length;
}

function moderateSubmission({ subject = "", description = "", discord = "" }) {
  const text = `${subject}\n${description}\n${discord}`;
  // Catch letter-by-letter spellings ("k y s", "f.a.g") of the hard-blocked words too.
  const squashed = text.replace(/\b(?:\w[ ._*\-]+){2,}\w\b/g, (run) => run.replace(/[ ._*\-]+/g, ""));
  if (HARD_BLOCK_PATTERNS.some((p) => p.test(text) || p.test(squashed))) return { ok: false, error: BLOCK_MESSAGE };
  if (SPAM_PATTERNS.some((p) => p.test(text))) return { ok: false, error: "This looks like spam, so we did not send it. If it is a real problem, describe it in your own words." };
  const links = countLinks(text);
  if (links > MAX_LINKS) return { ok: false, error: `Please include no more than ${MAX_LINKS} links.` };
  if (REPEAT_RE.test(text)) return { ok: false, error: "Please remove the long runs of repeated characters and send it again." };
  const caps = Math.max(capsRatio(description), capsRatio(subject));
  if (caps > 0.8) return { ok: false, error: "Please write your message without all capitals and send it again." };

  const flags = [];
  if (FLAG_SLUR_PATTERNS.some((p) => p.test(text))) flags.push("possible slur (word with other meanings)");
  if (PROFANITY_PATTERNS.some((p) => p.test(text))) flags.push("profanity");
  if (caps > 0.6) flags.push("mostly capitals");
  if (links === MAX_LINKS) flags.push(`${links} links`);
  return { ok: true, flags };
}

module.exports = { moderateSubmission, countLinks, MAX_LINKS, BLOCK_MESSAGE };
