"use strict";
// Keir 8.4.1 (owner, 2026-11-06, ticket 1781). A player wrote that their freight
// was stuck in two states while they own the freight sector there, and teammates
// added that the internal supply option was missing from the CEO office. Keir
// answered "Which is the problem: A, or B? Tell me which and I'll trace it."
// Both were already stated. Keir may ask a player something only when the answer
// is not in the message, the channel, the attachments, the page visits or the
// game data, and the investigation cannot go on without it. A reply whose only
// substance is an either/or question about issues the player already raised is
// refused, and Keir is sent back to investigate all of them.

const QUESTION_SENTENCE = /[^.!?\n]*\?/g;
const EITHER_OR = /\b(?:which|what)\b[^?]{0,120}\b(?:or|versus|vs\.?)\b|\b(?:is|are|do|does|did|was|were|can|could)\b[^?]{0,140}\bor\b[^?]{0,140}\?|\b(?:tell|let) me which\b|\bwhich (?:one|of (?:these|those|the two)|is it)\b|\bdo you mean\b[^?]{0,140}\bor\b/i;
const PICK_REQUEST = /\b(?:tell|let) me (?:which|what)\b|\bwhich (?:one|of)\b|\bwhich (?:is|was) the (?:problem|issue)\b/i;
// Words that name something a game record can be looked up by.
const ENTITY = /\b(?:sector|sectors|freight|logistics|manufactur\w*|company|corp(?:oration)?|ceo office|supply|plant|factory|bank|fund|bond|stock|share|market|price|tariff|trade|state|province|region|country|party|election|law|budget|loan)\b/gi;
const PLACE = /\b(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New (?:Hampshire|Jersey|Mexico|York)|North (?:Carolina|Dakota)|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South (?:Carolina|Dakota)|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)\b/g;

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

// Sentences that carry a finding, not a question.
function statements(text) {
  return clean(text).split(/(?<=[.!?])\s+/).filter((s) => s && !/\?\s*$/.test(s));
}

// The reply asks the player to pick between things, and says nothing else of weight.
function isBareEitherOr(message) {
  const text = clean(message);
  if (!text || !/\?/.test(text)) return false;
  const questions = text.match(QUESTION_SENTENCE) || [];
  if (!questions.some((q) => EITHER_OR.test(q)) && !PICK_REQUEST.test(text)) return false;
  const substance = statements(text).filter((s) => !/^(?:thanks|thank you|got it|noted|ok(?:ay)?|sure|hi|hey)\b[^.]{0,20}[.!]?$/i.test(s) && !/^(?:tell me which|let me know which)/i.test(s));
  return substance.reduce((n, s) => n + s.length, 0) < 90;
}

// How much the ticket already names: distinct entity words and places across everything
// the player and their teammates wrote, plus the pages they were looking at.
function namedByTicket({ texts = [], visits = [] } = {}) {
  const hay = texts.map(clean).join(" ");
  const words = new Set((hay.match(ENTITY) || []).map((w) => w.toLowerCase()));
  const places = new Set(hay.match(PLACE) || []);
  return { words: words.size, places: places.size, visits: visits.length, named: words.size >= 2 || places.size >= 1 && words.size >= 1 || visits.length > 0 && words.size >= 1 };
}

// Returns an error message when the reply must not go out, else null.
function needlessClarification({ message, texts, visits } = {}) {
  if (!isBareEitherOr(message)) return null;
  const known = namedByTicket({ texts, visits });
  if (!known.named) return null;
  return "Not posted: the ticket already names what is wrong"
    + (known.places ? ` (${known.places} place${known.places === 1 ? "" : "s"})` : "")
    + (known.visits ? " and the player's page visits point at it" : "")
    + ". Do not ask the player to pick between issues they already raised. Investigate every issue stated in the ticket and its channel, then reply with what you found for each. Ask a question only when the answer is not in the messages, the channel history, the screenshots, the page visits or the game data, and you cannot go on without it.";
}

// Keir 8.4.2 (owner, 2026-11-06, mod chat). Staff asked "do you think they are alts?" under two
// screenshots that named the accounts. Keir replied "send me the two names and I'll compare them".
// In staff channels and DMs a reply whose substance is a request for names, accounts or ids is
// refused while the screenshots nearby were never opened, or while support cases matching the
// talk were never read. After two refusals on a task it goes out (a real gap is allowed through).
const ASKS_IDENTIFIERS = /\b(?:send|give|tell|share|post|paste|name|list|provide)\b[^.?!\n]{0,50}\b(?:names?|usernames?|accounts?|ids?|handles?|which (?:two|accounts?|players?|users?|ones?))\b|\bwhich (?:two |of the )?(?:accounts?|players?|users?|ones?) (?:do you|did you|you|are you|is it)\b|\bdon['’]?t know (?:which|who|what)\b[^.?!\n]{0,40}\b(?:you mean|accounts?|players?|two)\b|\bwho (?:do you|did you) mean\b|\bcan['’]?t (?:say|tell|judge|compare)[^.?!\n]{0,40}(?:without|until|because)\b/i;

function asksForIdentifiers(message) {
  const text = clean(message);
  if (!text) return false;
  if (!ASKS_IDENTIFIERS.test(text)) return false;
  const substance = statements(text).filter((s) => !ASKS_IDENTIFIERS.test(s));
  return substance.reduce((n, x) => n + x.length, 0) < 160;
}

// images: context.recentImages rows; viewed: message ids opened; cases: case numbers offered.
function unreadContextRefusal({ message, images = [], viewed = [], cases = [], refusals = 0 } = {}) {
  if (refusals >= 2 || !asksForIdentifiers(message)) return null;
  const unseen = images.filter((i) => !viewed.includes(i.messageId));
  if (!unseen.length && !cases.length) return null;
  return "Not posted: you are asking for names or accounts that may already be in front of you. "
    + (unseen.length ? `${unseen.length} screenshot${unseen.length === 1 ? "" : "s"} in this channel were never opened: call view_attachment with each context.recentImages {index, messageId} and read the names, accounts and times. ` : "")
    + (cases.length ? `Support cases match this conversation (${cases.slice(0, 5).map((n) => "#" + n).join(", ")}): open them with support_get. ` : "")
    + "Then run the tools on what you found (gamestate alt_ring_audit and trace_account for accounts) and answer with your view and a confidence. Ask only for something that is in none of the screenshots, replies, cases or game data.";
}

// Keir 8.4.2 (mod chat, 2026-11-06): the classifier called the owner's alt question "simple", it
// ran in the quick lane and the model called no lookup at all before "I can't tell". In a staff
// channel a question about people or cases is answered from records: at least one lookup
// (support_search, support_get, alt_ring_audit, trace_account...) must precede "I can't tell".
const PEOPLE_OR_CASE = /\b(?:alts?|alt ring|same (?:person|player|guy)|ban(?:ned|s)?|unban(?:ned)?|appeals?|mute[ds]?|account|accounts|player|players|user|users|company|corporation|corp|ticket|case|cases|vpn|ip|duplicate|sockpuppets?|they|them)\b/i;
const CANT_TELL = /\b(?:i can(?:['’]?t| ?not) (?:say|tell|judge|determine|confirm|know)|i (?:don['’]?t|do not) (?:know|have)|not sure|no way to tell|unable to (?:say|tell|determine)|can(?:['’]?t| ?not) (?:say|tell) (?:yet|from))\b/i;
function lookupRequiredRefusal({ question, message, lookups = 0, refusals = 0 } = {}) {
  if (refusals >= 2 || lookups > 0) return null;
  if (!PEOPLE_OR_CASE.test(clean(question)) || !CANT_TELL.test(clean(message))) return null;
  return "Not posted: staff asked about people or a case and you have looked nothing up. Before you say you cannot tell, run at least one lookup: support_search on the words in the conversation, support_get on a matching case, and for accounts gamestate alt_ring_audit or trace_account (read_tool). Then answer with your view, the evidence and a confidence. If the records really hold nothing, say what you searched.";
}

module.exports = { isBareEitherOr, namedByTicket, needlessClarification, asksForIdentifiers, unreadContextRefusal, lookupRequiredRefusal };
