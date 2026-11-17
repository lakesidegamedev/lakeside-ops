"use strict";
// Keir 10.4: the guard behind team_activity. A post that closes the issue ("no fix needed", "answered, working as
// intended") or walks back an earlier statement ("correction: ...") is refused while the team is already on it
// (staff said they are fixing it, or a kanban card, worker or PR names the ticket). Ticket 1852 (2026-11-17): the owner
// wrote "I'm fixing", a card and a fix worker existed, and Keir kept posting "Answered, no fix needed" and corrections.
// Pure: text and a team_activity result in, a refusal or null out. The broker runs the tool and counts refusals.

const NO_FIX = /\bno fix (?:is )?(?:needed|required|necessary)\b|\bnothing (?:needs? )?(?:to be )?(?:fix(?:ed|ing)?|changed?)\b|\bnot a bug\b|\b(?:working|works) as (?:intended|designed|expected)\b|\b(?:this is|that is|that's|it's|it is) (?:intended|by design|expected behaviou?r)\b|\bby design\b|\banswered\b[^.\n]{0,20}\bno fix\b/i;
const CORRECTION = /\b(?:correction|to correct (?:my|an|the) (?:earlier|previous|last)|i (?:was|got that) wrong|i misspoke|i mis-?stated|scratch that|my (?:earlier|previous|last) (?:message|answer|reply|post) (?:was|had) (?:wrong|incorrect|a mistake)|(?:earlier|previous) (?:message|answer|reply) (?:was )?(?:wrong|incorrect))\b/i;

// "no_fix", "correction" or null.
function conclusionOf(text) {
  const t = String(text || "");
  if (NO_FIX.test(t)) return "no_fix";
  if (CORRECTION.test(t)) return "correction";
  return null;
}

// activity: a team_activity result. Returns the refusal text, or null when the post may go.
function refusal(kind, activity) {
  if (!kind || !activity || activity.covered !== true) return null;
  const why = activity.staffSaidFixing ? "staff said in the channel that they are fixing it" : "a card, a worker or a pull request already covers it";
  const what = kind === "no_fix" ? "that no fix is needed" : "a correction";
  return `Not posted: this tells the player ${what}, but ${why}. Do not say no fix is needed, do not argue the rule and do not post a correction. Tell the player in plain words that a fix is in progress and who is on it (the team, or a developer), with no card ids, unit names, hosts or staff names, and stop investigating that part. team_activity has the detail.`;
}

module.exports = { conclusionOf, refusal, NO_FIX, CORRECTION };
