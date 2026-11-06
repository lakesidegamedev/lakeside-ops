"use strict";
// Keir 8.4 support quality policy (owner, 2026-11-06). The tickets the owner rated unsatisfactory on
// 2026-11-05 and 06 (1763, 1766, 1772, 1775, 1757, 1750) failed the same few ways, so each is a code check
// here, not a prompt hope: repeated "still checking" posts, intermediate updates sent as replies, a
// rule explained and the ticket closed while the rule hurts the player, answers hedged away from code
// that was clear, and "handed to an investigator" with nobody assigned. Pure functions; the broker
// supplies the facts and throws the refusals.

// What a change is: one vocabulary, owned by changeclass.js. Re-exported here for the broker's policy checks.
const { CLASSES: CHANGE_CLASSES, requiresOwner, parseClass: normalizeChangeClass } = require("./changeclass");

// A rule explained as working as designed. Posted to a player who complained, then the ticket closed, this
// is the 1775, 1757 and 1750 pattern.
const AS_DESIGNED = /\b(?:works? as (?:designed|intended)|working as (?:designed|intended)|as (?:designed|intended)|by design|(?:the )?numbers (?:check out|add up|are correct|hold up|are right)|(?:is|are) correct as (?:shown|calculated)|(?:this|that|it) is (?:how|the way) [\w ,'’-]{0,60}(?:works?|is meant to work)|(?:is|are) not a (?:bug|defect|fault)|no (?:bug|fault|defect|error) (?:found|here)|nothing (?:is )?(?:wrong|broken)|no fix (?:is )?needed)/i;

function explainsIntendedBehaviour(...texts) {
  return texts.some((t) => AS_DESIGNED.test(String(t || "")));
}

// Resolve guard. ctx: { texts: [resolve message, last post to the player], decided: the owner answered a
// decision on this ticket, fixed: a fix is written or live for it, pendingDecision: an unanswered owner
// decision exists }. Returns an error string or null.
function resolveRefusal(ctx) {
  if (ctx.pendingDecision) return "Not closed: an owner decision on this ticket is still unanswered. Hold the ticket open, tell the player once that it is waiting on the owner's approval, and do not decide for the owner. The owner is re-asked every 12 hours.";
  if (ctx.decided || ctx.fixed) return null;
  if (explainsIntendedBehaviour(...(ctx.texts || []))) return "Not closed: this only explains that the rule works as designed, and the player brought a complaint. Under the owner's policy (2026-11-06) a rule that works as designed but is clearly hurting a player is not a resolution. Explain the rule to the player, say it is under review, keep the ticket open, and ask the owner with raise_to_developers kind decision: two or three concrete options, the recommended one first, changeClass rule, and what each option means for players. Resolve only after the owner has decided.";
  return null;
}

// "I haven't checked the exact trigger, so I won't quote a threshold" and "I searched, found nothing, so I
// won't tell you it exists" (ticket 1772, answer reversed five minutes later). Code is readable: read it, then
// answer with confidence, or say plainly that it does not exist once a thorough search shows that.
const TIMID_UNCHECKED = /\bI (?:haven'?t|have not) (?:yet )?(?:checked|looked up|read|verified) (?:the )?(?:exact|precise|actual|full)\b|\bso I won'?t (?:quote|state|give|name|say) (?:a|an|the) (?:exact |precise )?(?:threshold|number|figure|trigger|amount|rule|value|limit)\b/i;
const TIMID_ABSENT = /\b(?:searched|looked|checked)\b[^.!?]{0,60}\b(?:found|and found|came up with|turned up) (?:nothing|no (?:such|rule|option|way|mention))\b[^.!?]{0,80}\b(?:so )?I (?:won'?t|will not|can'?t|cannot) (?:tell you|say|claim|confirm|state)\b|\bso I won'?t tell you (?:it|that|this|there)\b/i;
const MIN_LOOKUPS = 3;
function timidRefusal(text, { lookups = 0 } = {}) {
  const s = String(text || "");
  if (TIMID_UNCHECKED.test(s)) return "Not posted: this hedges on something you can read. Look up the rule now (read_tool ops-knowledge code_exact for the name, code_search with claimType mechanic, then code_read and rg in the game checkout), then state it with the figure. Players are owed a clear answer from the code.";
  if (TIMID_ABSENT.test(s)) return lookups < MIN_LOOKUPS
    ? `Not posted: this says the search found nothing but only ${lookups} code lookup${lookups === 1 ? "" : "s"} backs it. Search exhaustively first (code_exact on the likely names, code_search worded two ways, rg in the game checkout). If it still is not there, say plainly "No, that does not exist", and if it is there, say how it works.`
    : 'Not posted: you have searched thoroughly. Do not hedge it. Say plainly "No, that does not exist" (and what the player can do instead), or answer from what the code shows. Players are owed a confident answer.';
  return null;
}

// Handoffs. "I've handed it to an investigator" is a claim about a real job; "the developers have it" is a
// claim about a real queue item or pull request. These return the ids that back a claim, for the audit record.
const INVESTIGATOR = /\b(?:handed|passed|gave|sent|put|assigned|referred)\b[^.!?]{0,60}\b(?:to|with|over to) (?:an? |the |our |one of our )?(?:investigators?|investigation|specialists?|analysts?|research(?:er)?s?)\b|\b(?:an? |the )?investigator (?:is|has been|was|now) (?:now )?(?:on|looking|checking|reading|assigned|digging|working)\b|\bhas been (?:given|handed|passed) to an investigator\b/i;
function handoffRefs(jobs, allJobs) {
  const dev = jobs.flatMap((j) => (j.raisedToDevelopers || []).filter((r) => r.id).map((r) => `queue:${r.id}`));
  const inv = jobs.flatMap((j) => (j.investigations || []).filter((id) => allJobs[id]).map((id) => `investigation:${id}`));
  const prs = jobs.flatMap((j) => (j.pullRequests || []).map((p) => `pr:${p}`));
  return { developers: [...dev, ...prs], investigators: inv };
}

// Update spam. Tickets carried 30 to 57 updates. After Keir's last post, with no new player message, a further
// post must be a milestone: a question to the player, a receipted outcome (the claims guard has already
// proved it), a correction, or a finding, which is a game or code read made since that post. Everything else
// belongs on the status card note or the tracker note.
function milestoneRefusal({ message, lastPost, claims = [], newReadSince = false, playerSpokeAfter = false, answeringStaff = false, correction = false }) {
  if (!lastPost || playerSpokeAfter || answeringStaff || correction) return null;
  if (/\?/.test(String(message || ""))) return null;
  if (claims.some((c) => !c.future)) return null;
  if (newReadSince) return null;
  return "Not posted: your last message to the player is still the newest, they have not written since, and nothing new has been read since it. A player update is for a real milestone only: a finding (read something new first), a fix written, a fix live and checked, or a question to them. Put the intermediate state on the status card note (status_card) or the tracker note instead.";
}

module.exports = { CHANGE_CLASSES, requiresOwner, normalizeChangeClass, explainsIntendedBehaviour, resolveRefusal, timidRefusal, MIN_LOOKUPS, INVESTIGATOR, handoffRefs, milestoneRefusal };
