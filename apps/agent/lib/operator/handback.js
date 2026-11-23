"use strict";
// Owner rule, 2026-11-23: once a ticket is only waiting (on a player reply or a fix reaching the live game), the developer
// agent stands down and Keir owns it. The agent writes what is owed on the ticket's kanban card under "HANDOFF TO KEIR".
// Keir reads that note, keeps every owed follow-up armed, and never escalates a waiting ticket to the owner.
//
//   - Every 5 minutes the hand-back ticker reads the board. A new or changed hand-back note goes into the ticket task's
//     inbox and wakes it once.
//   - For each fix the note names (its pull requests), the ticker checks the live build: the web server and, for turn code,
//     the turn worker must run a commit that contains the fix's merge commit (livefix.verifyLiveFix). Only then is the
//     ticket task told "the fix is live now" and woken to post it. Never on a guess.
//   - A player reply wakes the task as always; closing after a quiet period is closing.js's job.
// The pure parts are here; operator.js runs the ticker.

const MARK = /HANDOFF TO KEIR/i;
const isHandback = (card) => MARK.test(`${card?.progress_summary || ""}\n${card?.detail || ""}\n${card?.detail_excerpt || ""}`);
// The note is the hand-back paragraph itself.
function noteOf(card) {
  const text = MARK.test(card?.progress_summary || "") ? card.progress_summary : (card?.detail || card?.detail_excerpt || "");
  return String(text).slice(Math.max(0, String(text).search(MARK))).slice(0, 2500);
}
// Fix PR numbers on AHDGame: the card's linked pull requests, then any "PR #N" or "#N" the note names as the fix.
function fixPrs(card) {
  const linked = (card?.pull_requests || []).map((p) => /AHDGame#(\d+)|AHDGame\/pull\/(\d+)/i.exec(String(p))).filter(Boolean).map((m) => Number(m[1] || m[2]));
  const named = [...noteOf(card).matchAll(/\bFix PR #(\d{3,6})\b/gi)].map((m) => Number(m[1]));
  return [...new Set([...linked, ...named])].filter((n) => Number.isSafeInteger(n) && n > 0);
}
function parse(card) {
  return { card: card.id, tickets: (card.tickets || []).map(Number).filter((n) => n > 0), note: noteOf(card), prs: fixPrs(card), at: card.last_progress_at || card.updated_at || null };
}

const RULES = "You own this ticket again. Do exactly what the note says is owed, in order. Post \"the fix is live\" only when Keir has told you the live build contains the fix (never from a merge or a guess). Answer the player's next message. Once the player has been quiet and nothing is owed, close the ticket under your normal closing rules. Never send this ticket to the owner: it is only waiting.";
function inboxNote(h) {
  return `A developer handed this ticket back to you (kanban card ${h.card}).\n${h.note}\n\n${RULES}`;
}
function liveNote(h, pr, v) {
  const where = Object.entries(v.deployment || {}).map(([svc, dep]) => `${svc === "web" ? "the main server" : "the turn worker"} runs ${String(dep.sha).slice(0, 10)}`).join(" and ");
  return `The fix (pull request ${pr}) is in the live build now: ${where}, both containing its merge commit ${String(v.pr?.merge_commit_sha || "").slice(0, 10)}. Do the next owed step from the hand-back note (card ${h.card}): post the fix-is-live update to the player now.`;
}

module.exports = { isHandback, noteOf, fixPrs, parse, inboxNote, liveNote, RULES, MARK };
