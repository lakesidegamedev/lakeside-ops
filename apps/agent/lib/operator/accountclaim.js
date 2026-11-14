"use strict";
// Keir 9.0.3: a sentence that says a player's account is not linked, has no Discord link or has no character is a claim about
// live data. A staff question in a ticket channel was answered "not linked" from a lookup that never read the link, in front of
// the player, when the account had one. The sentence needs a read on this ticket that shows it. Pure functions only.

const { sentencesOf } = require("./rulelookup");
const { HEDGED, CONDITIONAL } = require("./readclaim");

const NOT_LINKED = /\b(?:not|isn(?:'|’)?t|aren(?:'|’)?t|never (?:been )?|hasn(?:'|’)?t been|has not been|no longer)\s+(?:yet\s+|currently\s+)?linked\b|\bunlinked\b|\bno (?:linked |discord |game |player )*(?:account|link|discord link|discord)\b(?! needed)|\b(?:carries|has|have|shows?|with|had)\s+no\s+(?:\w+\s+)?link\b/i;
const NO_CHARACTER = /\b(?:has|have|had|carries|shows?|with)\s+no\s+(?:current\s+|active\s+|linked\s+)?characters?\b|\bno (?:current |active |linked )?characters? (?:on|for|under|in) (?:the |their |this )?(?:account|profile)\b|\b(?:doesn(?:'|’)?t|does not|don(?:'|’)?t|do not)\s+(?:currently\s+)?have\s+(?:a|any)\s+characters?\b/i;
const DISCORD = /\bdiscord\b/i;
// "I could not confirm", "not verified": the sentence says outright that it is not established.
const UNCONFIRMED = /\b(?:not (?:yet )?(?:been )?(?:confirmed|verified|established|sure|certain|clear)|unconfirmed|unverified|(?:haven(?:'|’)?t|have not|hasn(?:'|’)?t|has not|couldn(?:'|’)?t|could not|can(?:'|’)?t|cannot) (?:yet )?(?:confirm(?:ed)?|verif(?:y|ied)|tell|say|establish(?:ed)?|check(?:ed)?|read)\b|(?:do not|don(?:'|’)?t) (?:yet )?know (?:if|whether)|not sure (?:if|whether))\b/i;
// What a read shows when the account does have a link or a character.
const LINK_SHOWN = /\bdiscord\w*"?\s*[:=]\s*"?\d{5,}|"?linked"?\s*[:=]\s*true\b/i;
const CHARACTER_SHOWN = /\bsequentialId"?\s*[:=]\s*"?\d+|"?characters"?\s*[:=]\s*\[\s*\{/i;

// The first sentence stating an account fact, or null: { kind: "link" | "discord" | "character", sentence }.
function accountClaim(message) {
  for (const sentence of sentencesOf(message)) {
    if (/\?\s*["')\]]*$/.test(sentence) || UNCONFIRMED.test(sentence) || HEDGED.test(sentence) || CONDITIONAL.test(sentence)) continue;
    if (NO_CHARACTER.test(sentence)) return { kind: "character", sentence: sentence.slice(0, 240) };
    if (NOT_LINKED.test(sentence)) return { kind: DISCORD.test(sentence) ? "discord" : "link", sentence: sentence.slice(0, 240) };
  }
  return null;
}

// reads: the text of every account-bearing read on this ticket (reporter_state results, users and characters queries).
// inspections: the structured reporter_state results kept on the ticket's tasks.
// Returns null when the claim stands on a read that agrees with it, else { kind, sentence, reason: "unread" | "contradicted" }.
function unbackedAccountClaim(message, { reads = [], inspections = [] } = {}) {
  const claim = accountClaim(message);
  if (!claim) return null;
  const text = reads.join("\n");
  const linkShown = LINK_SHOWN.test(text) || inspections.some((i) => i?.account?.linked === true);
  const characterShown = CHARACTER_SHOWN.test(text) || inspections.some((i) => (i?.characters || []).length > 0 || i?.character);
  if (claim.kind === "character") {
    if (characterShown) return { ...claim, reason: "contradicted" };
    return reads.length || inspections.length ? null : { ...claim, reason: "unread" };
  }
  if (linkShown) return { ...claim, reason: "contradicted" };
  // "No Discord link" needs a read that includes the Discord field at all; the linked-account lookup does not.
  if (claim.kind === "discord") return /discord/i.test(text) ? null : { ...claim, reason: "unread" };
  return reads.length || inspections.length ? null : { ...claim, reason: "unread" };
}

const MAX_REFUSALS = 1;
const REFUSAL = (c) => c.reason === "contradicted"
  ? `Not posted: "${c.sentence.slice(0, 160)}" says the account is not linked or has no character, but a read on this ticket shows a link or a character. Re-read it (reporter_state, or the users and characters records) and state what it shows.`
  : `Not posted: "${c.sentence.slice(0, 160)}" states whether the player's account is linked or has a character, and nothing read on this ticket shows that${c.kind === "discord" ? " (the linked-account lookup does not include the Discord link field; read the user record with its Discord field)" : ""}. Read it first (reporter_state, or the users and characters records), or say plainly that you have not checked.`;

module.exports = { accountClaim, unbackedAccountClaim, REFUSAL, MAX_REFUSALS };
