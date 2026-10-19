"use strict";
const { validationRejected } = require("./broker");

// Only a structured native argument rejection proves the write did not run.
function recoverRejectedWrites(ledger) {
  let recovered = 0;
  for (const job of Object.values(ledger.data.jobs)) {
    if (job.state !== "blocked" || job.role !== "support") continue;
    const started = Object.values(job.effects).filter(e => e.state === "started");
    if (!started.length) continue;
    const rejected = started.every(e => {
      let result; try { result = JSON.parse(e.error); } catch { return false; }
      return validationRejected(result) && result.content?.some(c => /^MCP error -32602: Input validation error: Invalid arguments for tool support_(tracker_note|public_update|set_status|resolve):/.test(c.text || ""));
    });
    if (!rejected) continue;
    for (const e of started) e.state = "rejected";
    job.state = "queued"; job.summary = "Previous support arguments were rejected before execution. Discover support_tools, correct the arguments and continue investigating.";
    ledger.audit("validation_recovered", {job:job.id}); recovered++;
  }
  if (recovered) ledger.save();
  return recovered;
}
// A provider's subscription quota running out is not a task failure: the
// provider names when the window resets, so the task waits until then and
// resumes by itself (2026-10-14: ticket 1514 was blocked by a Muse 429 that
// reset six minutes later). Bounded: at most two hours per wait, eight waits.
const QUOTA = /quota (?:is )?exhausted|usage (?:window|limit)|rate_limit_error|\b429\b.*(?:quota|rate)|(?:quota|rate).*\b429\b/i;
function waitForQuota(job, error, now = Date.now()) {
  if (!QUOTA.test(error.message)) return false;
  job.quotaWaits = (job.quotaWaits || 0) + 1;
  if (job.quotaWaits > 8) return false;
  const reset = Date.parse(/resets? (?:at )?(\d{4}-\d\d-\d\dT[\d:.]+Z)/i.exec(error.message)?.[1] || "");
  const wake = Number.isFinite(reset) && reset > now ? reset + 60000 : now + 15 * 60000;
  job.state = "waiting"; job.wakeAt = Math.min(wake, now + 2 * 3600000);
  job.summary = `The model provider's usage quota ran out; resuming automatically at ${new Date(job.wakeAt).toISOString()}. Nothing external was left half done.`;
  return true;
}
// An expired or unrefreshable subscription login is the box's problem, not the
// task's: wait for the login to come back instead of blocking the ticket
// (2026-10-19: an OAuth expiry blocked tickets 1592, 1619, 1622 and 1625 for
// hours). Bounded: every 15 minutes for up to 12 hours.
const AUTH = /Failed to authenticate|OAuth (?:session|token) (?:has )?expired|could not be refreshed|authentication_error|invalid x-api-key|not logged in/i;
function waitForAuth(job, error, now = Date.now()) {
  if (!AUTH.test(error.message)) return false;
  job.authWaits = (job.authWaits || 0) + 1;
  if (job.authWaits > 48) return false;
  job.state = "waiting"; job.wakeAt = now + 15 * 60000;
  job.summary = "The model provider's login needs renewing; retrying automatically every fifteen minutes. Nothing external was left half done.";
  return true;
}
// On start: tasks blocked only by a provider login failure, with nothing
// external in flight, resume (the login is usually back by the restart).
function recoverAuthBlocked(ledger, now = Date.now()) {
  let recovered = 0;
  for (const job of Object.values(ledger.data.jobs)) {
    if (job.state !== "blocked" || !/^model request failed:/.test(job.summary || "") || !AUTH.test(job.summary)) continue;
    if (Object.values(job.effects || {}).some(e => e.state === "started")) continue;
    job.state = "queued"; job.wakeAt = 0; job.summary = "Resumed after the model provider's login was renewed.";
    ledger.audit("auth_recovered", { job: job.id }); recovered++;
  }
  if (recovered) ledger.save();
  return recovered;
}
// A provider that answers with nothing (no tokens, no tool call) is down for
// every task at once (2026-10-19, about four hours), so retry on the login
// cadence rather than spending the three quick transient retries.
function waitForEmptyProvider(job, error, now = Date.now()) {
  if (!/^model request failed: empty activation/.test(error.message)) return false;
  job.emptyWaits = (job.emptyWaits || 0) + 1;
  if (job.emptyWaits > 48) return false;
  job.state = "waiting"; job.wakeAt = now + (job.emptyWaits === 1 ? 60000 : 15 * 60000);
  job.summary = "The model provider returned an empty reply; retrying automatically. Nothing external was left half done.";
  return true;
}
function retryReadFailure(job, error, now = Date.now()) {
  if (Object.values(job.effects).some(e => e.state === "started")) return false;
  if (waitForAuth(job, error, now)) return true;
  if (waitForEmptyProvider(job, error, now)) return true;
  // Native admission refuses before a model or tool starts. Wait for host
  // capacity instead of presenting a missing approval to the owner.
  if (/^model request failed: rust runner: resource admission refused:/.test(error.message)) {
    job.state = "waiting"; job.wakeAt = now + 30000;
    job.summary = "Waiting for shared host capacity. Keir will resume automatically.";
    return true;
  }
  if (waitForQuota(job, error, now)) return true;
  if (!/fetch failed|network|ECONNRESET|ETIMEDOUT|timed out|timeout|turn deadline exceeded|model API refused request: (429|5\d\d)\b/i.test(error.message)) return false;
  job.transientFailures = (job.transientFailures || 0) + 1;
  if (job.transientFailures > 3) return false;
  job.state = "waiting"; job.wakeAt = now + [60000,120000,300000][job.transientFailures-1];
  job.summary = "A temporary read or model connection failure interrupted investigation. Retrying automatically; no uncertain external write will be repeated.";
  return true;
}
module.exports = { recoverRejectedWrites, recoverAuthBlocked, retryReadFailure, waitForQuota, waitForAuth, waitForEmptyProvider };
