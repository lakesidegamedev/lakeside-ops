"use strict";
// Keir 9.0.3: a sentence that says a player's account is not linked, has no Discord link or has no character is a claim about
// live data. A staff question in a ticket channel was answered "not linked" from a lookup that never read the link, in front of
// the player, when the account had one. The sentence needs a read on this ticket that shows it. Pure functions only.

const { sentencesOf } = require("./rulelookup");
const { HEDGED, CONDITIONAL } = require("./readclaim");

const NOT_LINKED = /\b(?:not|isn(?:'|’)?t|aren(?:'|’)?t|never (?:been )?|hasn(?:'|’)?t been|has not been|no longer)\s+(?:yet\s+|currently\s+)?linked\b|\bunlinked\b|\bno (?:linked |discord |game |player )*(?:account|link|discord link|discord)\b(?! needed)|\b(?:carries|has|have|shows?|with|had)\s+no\s+(?:\w+\s+)?link\b/i;
const NO_CHARACTER = /\b(?:has|have|had|carries|shows?|with)\s+no\s+(?:current\s+|active\s+|linked\s+)?characters?\b|\bno (?:current |active |linked )?characters? (?:on|for|under|in) (?:the |their |this )?(?:account|profile)\b|\b(?:doesn(?:'|’)?t|does not|don(?:'|’)?t|do not)\s+(?:currently\s+)?have\s+(?:a|any)\s+characters?\b/i;
const DISCORD = /\bdiscord\b/i;
// Keir 9.0.4 (owner): purchases, refunds and subscriptions are account facts too.
const PURCHASE = /\b(?:has|have|had|did|didn(?:'|’)?t|did not|hasn(?:'|’)?t|has not|never|already|was|were|got|received)\b[^.!?\n]{0,40}\b(?:purchased|bought|paid|subscribed|refunded|charged|a refund|the refund|a purchase|a payment|a subscription|supporter)\b|\b(?:no|their|the) (?:refund|purchase|payment|subscription)s? (?:was|were|has been|have been) (?:issued|processed|made|paid|received|completed|cancelled|refunded|charged)\b/i;
const REAL_MONEY = /\b(?:patreon|supporter|subscri\w*|store|premium|perk|real money|paypal|stripe|credit card|card payment|refund\w*|app store|google play|play store)\b/i;
const PURCHASE_SHOWN = /\b(?:purchase|payment|patreon|subscription|refund|order|entitlement|supporter|stripe|invoice)\w*"?\s*[:=]/i;
// "I could not confirm", "not verified": the sentence says outright that it is not established.
const UNCONFIRMED = /\b(?:not (?:yet )?(?:been )?(?:confirmed|verified|established|sure|certain|clear)|unconfirmed|unverified|(?:haven(?:'|’)?t|have not|hasn(?:'|’)?t|has not|couldn(?:'|’)?t|could not|can(?:'|’)?t|cannot) (?:yet )?(?:confirm(?:ed)?|verif(?:y|ied)|tell|say|establish(?:ed)?|check(?:ed)?|read)\b|(?:do not|don(?:'|’)?t) (?:yet )?know (?:if|whether)|not sure (?:if|whether))\b/i;
// What a read shows when the account does have a link or a character.
const DISCORD_SHOWN = /\bdiscord(?:Id|_id)"?\s*[:=]\s*"?\d{5,}|"?discordLinked"?\s*[:=]\s*true\b/i;
const DISCORD_ABSENT = /"?discordLinked"?\s*[:=]\s*false\b/i;
const LINK_SHOWN = /\bdiscord(?:Id|_id)"?\s*[:=]\s*"?\d{5,}|"linked"\s*[:=]\s*true\b|\blinked\s*[:=]\s*true\b/i;
const CHARACTER_SHOWN = /\bsequentialId"?\s*[:=]\s*"?\d+|"?characters"?\s*[:=]\s*\[\s*\{/i;

// The first sentence stating an account fact, or null: { kind: "link" | "discord" | "character", sentence }.
function accountClaim(message) {
  for (const sentence of sentencesOf(message)) {
    if (/\?\s*["')\]]*$/.test(sentence) || UNCONFIRMED.test(sentence) || HEDGED.test(sentence) || CONDITIONAL.test(sentence)) continue;
    // Real-money purchases only: in-game charges ("the licence was charged twice") are game data, not account facts.
    if (PURCHASE.test(sentence) && REAL_MONEY.test(sentence)) return { kind: "purchase", sentence: sentence.slice(0, 240) };
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
  if (claim.kind === "purchase") return PURCHASE_SHOWN.test(text) ? null : { ...claim, reason: "unread" };
  if (claim.kind === "character") {
    if (characterShown) return { ...claim, reason: "contradicted" };
    return reads.length || inspections.length ? null : { ...claim, reason: "unread" };
  }
  // Keir 9.0.4: "linked to the ticket" (the game account behind the reporter's username) and "Discord link" are different facts.
  if (claim.kind === "discord") {
    const discordShown = DISCORD_SHOWN.test(text) || inspections.some((i) => i?.account?.discordLinked === true);
    const discordAbsent = DISCORD_ABSENT.test(text) || inspections.some((i) => i?.account?.discordLinked === false);
    if (discordShown) return { ...claim, reason: "contradicted" };
    return discordAbsent || /discord/i.test(text) ? null : { ...claim, reason: "unread" };
  }
  if (linkShown) return { ...claim, reason: "contradicted" };
  return reads.length || inspections.length ? null : { ...claim, reason: "unread" };
}

// Refused twice per ticket; after that the code labels the sentence as not checked (labelUnchecked), so an unread account
// fact never reaches the player as a fact and finishing is never blocked.
const MAX_REFUSALS = 2;
const UNCHECKED = "I have not checked this yet, so it may be wrong: ";
// Every account sentence in the message is labelled, not only the first.
function labelUnchecked(message) {
  let out = String(message), from = 0;
  for (const sentence of sentencesOf(out)) {
    if (!accountClaim(sentence)) continue;
    const at = out.indexOf(sentence, from);
    if (at < 0) continue;
    const labelled = UNCHECKED + sentence.charAt(0).toLowerCase() + sentence.slice(1);
    out = out.slice(0, at) + labelled + out.slice(at + sentence.length); from = at + labelled.length;
  }
  return out;
}
const REFUSAL = (c) => c.reason === "contradicted"
  ? `Not posted: "${c.sentence.slice(0, 160)}" says the account is not linked or has no character, but a read on this ticket shows a link or a character. Re-read it (reporter_state, or the users and characters records) and state what it shows.`
  : `Not posted: "${c.sentence.slice(0, 160)}" states a fact about the player's account (link, characters or purchases), and nothing read in this activation shows that${c.kind === "discord" ? " (the linked-account lookup does not include the Discord link field; read the user record with its Discord field)" : ""}. Read it first (reporter_state, or the users and characters records), or say plainly that you have not checked yet, then check.`;

module.exports = { accountClaim, unbackedAccountClaim, REFUSAL, MAX_REFUSALS, labelUnchecked, UNCHECKED };
