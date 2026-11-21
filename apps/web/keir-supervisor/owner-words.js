"use strict";
// What the private supervisor may say to the owner (owner, 2026-11-21). The same rules the operator enforces in
// apps/agent/lib/operator/handofftruth.js, restated because the web service ships without apps/agent:
// - "It is with the developers" is never said to the owner unless it names the issue, card or pull request a person
//   holds. Keir's own work (this supervisor's or the support desk's) is said in the first person.
// - "My ticket access is read-only" and "I can't merge, close or create tickets" were false and stay unsayable: ticket
//   changes go through ticket_command. A specific refusal ("ticket 1871 is closed, so nothing can join it") is fine.
// - Times are US Eastern (ET) or relative, never UTC; internal job, workspace and worker ids are dropped.
const { etTimes } = require("./ownercopy");

const DEV_HANDOFF = /\b(?:it(?:'|’)?s|this is|that is|it is|is|are|now) (?:now |still )?with (?:the |our )?(?:developers?|devs?|dev team|team)\b|\b(?:passed|handed|raised|flagged|sent|reported|forwarded|escalated|given|put)\b[^.!?\n]{0,60}\b(?:to|with|over to) (?:the |our )?(?:developers?|devs?|dev team)\b|\b(?:the |our )?(?:developers?|devs?|dev team) (?:now |already )?(?:have|has|got|are (?:on|looking at|working on|handling|reviewing)|will (?:fix|look|handle|check|pick))\b/i;
const RECEIPT = /\b(?:issue|card|pull request|PR)\s*#?\d+/i;
const READ_ONLY = /\b(?:my|keir(?:'|’)?s|the supervisor(?:'|’)?s) (?:ticket |support )?access (?:is|being) (?:still )?read[- ]only\b|\bi (?:only )?have read[- ]only (?:ticket |support )?access\b|\bi (?:can(?:'|’)?t|cannot|can not|am unable to|have no way to) (?:merge|close|create|open|resolve|reopen|change|edit|update)(?:,? (?:or |and )?(?:merge|close|create|open|resolve|reopen|change|edit|update))* (?:these |those |the |any |support )?(?:tickets?|incidents?)\b(?!\s*#?\d)|\b(?:tickets?|support)\b[^.!?\n]{0,60}\bread[- ]only\b|\bread[- ]only\b[^.!?\n]{0,60}\b(?:tickets?|merge|incidents?)\b/i;
const SHORT_READ_ONLY = /^(?:yes,? )?(?:it(?:'|’)?s|it is|i(?:'|’)?m|i am) (?:still )?read[- ]only\b/i;
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;
const sentencesOf = (text) => String(text || "").replace(QUOTED, " ").split(/\n+/).flatMap((line) => line.match(/[^.!?]+(?:[.!?]+|$)/g) || []).map((s) => s.trim()).filter(Boolean);

// The first sentence the owner must not be told, with why and what to say instead, or null.
function refusal(text) {
  const all = String(text || "");
  const ticketTalk = /\btickets?\b|\bmerg|\bincident/i.test(all);
  for (const s of sentencesOf(all)) {
    if (DEV_HANDOFF.test(s) && !RECEIPT.test(s) && !/\b(?:not|never|no longer|isn(?:'|’)?t|aren(?:'|’)?t)\b[^.!?]{0,20}\bwith\b/i.test(s)) {
      return { sentence: s, why: "\"With the developers\" is not something to tell the owner. If Keir (you or the support desk) is doing the work, say so in the first person: \"I am preparing a fix\", \"My fix is in testing\", \"The fix is waiting for approval to ship\". If a person really holds it, name the issue, card or pull request and who has it." };
    }
    if (READ_ONLY.test(s) || (ticketTalk && SHORT_READ_ONLY.test(s))) {
      return { sentence: s, why: "That is not true. You can open an incident, merge tickets into it or into another ticket, close or reopen a ticket and add a person, with ticket_command (Keir's operator does it with its own checks). Do what the owner asked, or say in one sentence the one specific thing that blocked it and why." };
    }
  }
  return null;
}

// Everything the supervisor writes to the owner: ET times, no internal ids, no dashes.
function forOwner(text, now = Date.now()) {
  return etTimes(String(text || ""), now)
    .replace(/[\u2013\u2014]/g, ", ")
    .replace(/\b(?:job|workspace)\s+(?:j|w)_[0-9a-f]{16}\b/gi, (m) => m.split(/\s+/)[0])
    .replace(/\b[jw]_[0-9a-f]{16}\b/g, "")
    .replace(/\b(?:(?:a|the|my|coding)\s+)*worker\s+cw-\d+-\d+\b/gi, "the coding worker")
    .replace(/\bcw-\d+-\d+\b/g, "a coding worker")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Last resort when a rewrite still carries a refused sentence: drop those sentences, keep the rest.
function withoutRefused(text) {
  let out = String(text || "");
  for (let i = 0; i < 6; i++) {
    const r = refusal(out);
    if (!r) break;
    const at = out.indexOf(r.sentence);
    out = at >= 0 ? (out.slice(0, at) + out.slice(at + r.sentence.length)).replace(/[ \t]{2,}/g, " ") : out.replace(r.sentence, "");
  }
  return out.trim();
}

module.exports = { refusal, forOwner, withoutRefused, sentencesOf };
