"use strict";
// Keir 10.2 (owner, 2026-11-17): GitHub housekeeping Keir does itself. Closing a fixed issue and closing a
// superseded bot or agent PR are never handed to a person. These helpers decide what counts as a bot author,
// whether two PRs cover the same fix, and spot requests that ask a person to do this housekeeping.

const BOT_LOGIN = /^keir-bot$|\[bot\]$|^(?:github-actions|dependabot|renovate|copilot)\b/i;

// A bot or agent account. Never a human: an unknown login is treated as a person.
function botAuthor(user, extra = []) {
  if (!user || !user.login) return false;
  if (user.type === "Bot") return true;
  if (BOT_LOGIN.test(user.login)) return true;
  return (extra || []).some((x) => String(x).toLowerCase() === String(user.login).toLowerCase());
}

function referencedIssues(pr) {
  const text = `${pr?.body || ""}`;
  return new Set([...text.matchAll(/\b(?:refs?|close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+((?:#\d+(?:,\s*)?)+)/gi)].flatMap((m) => [...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1]))));
}

function sameIssue(a, b) {
  const x = referencedIssues(a), y = referencedIssues(b);
  for (const n of x) if (y.has(n)) return true;
  return false;
}

function closingComment(number, by) {
  return by ? `Closing as superseded: #${by} is merged and covers the same fix.` : `Closing: this PR is stale and Keir is not carrying it forward.`;
}

// Text that asks a person to do GitHub housekeeping Keir can now do itself.
const CLOSE = /\b(?:close|closing|closed?)\b[^.\n]{0,60}\b(?:issue|pr|pull request|pull|superseded|duplicate)\b|\b(?:issue|pr|pull request)\b[^.\n]{0,40}\b(?:close|closed|closing)\b|\bsuperseded (?:pr|pull request)\b/i;
const BRANCH = /\bdelete\b[^.\n]{0,40}\bbranch\b|\bbranch\b[^.\n]{0,30}\b(?:delete|deleted|cleanup|clean up)\b/i;
const RERUN = /\bre-?run\b[^.\n]{0,40}\b(?:check|job|ci|workflow|action)s?\b|\b(?:check|ci|job)s?\b[^.\n]{0,30}\bre-?run\b/i;

function housekeepingRequest(text) {
  const t = String(text || "");
  const kind = BRANCH.test(t) ? "delete a branch" : RERUN.test(t) ? "re-run a check" : CLOSE.test(t) ? "close an issue or pull request" : null;
  return kind;
}

const INSTRUCTION = (kind) => `Not sent: this asks a person to ${kind}, which Keir does itself. Call the github tool: action close_issue (number, fix = the merged PR that fixed it) to close a fixed issue, action close (number, supersededBy = the merged PR that covers it) to close a superseded bot or agent PR, action rerun_check to re-run a failed check. Only if the tool refuses for a reason you cannot change, say what it refused.`;

module.exports = { botAuthor, referencedIssues, sameIssue, closingComment, housekeepingRequest, INSTRUCTION };
