"use strict";
// A task deadline is Keir's own timer, not a question for the owner. The
// first expiry extends it once and the work carries on; only a task that runs
// out of time again is held for the owner (owner, 2026-10-16: an MNM
// settlement investigation reached the app as "Needs you" when the only
// sensible move was to keep going).
const MAX_EXTENSIONS = 1;
const TIMEOUT_SUMMARY = "Task ran out of time twice. Keir needs to recover from the last saved step.";

function expireDeadline(job, now, { lifetimeMs }) {
  if (!(job.deadline < now) || ["done", "dismissed", "cancelled", "blocked"].includes(job.state)) return null;
  if ((job.deadlineExtensions || 0) < MAX_EXTENSIONS) {
    job.deadlineExtensions = (job.deadlineExtensions || 0) + 1;
    job.deadline = now + lifetimeMs;
    if (job.state === "waiting") job.state = "queued";
    return "extended";
  }
  job.state = "blocked";
  job.summary = TIMEOUT_SUMMARY;
  // Keir 10.0.1 (2026-11-15): three finding tasks were put back to waiting on every tick and re-blocked here, so the owner
  // alert fired about once a second (1,867 times in 30 minutes). Alert once per task; later re-blocks are silent.
  if (job.deadlineBlockedAt) return "reblocked";
  job.deadlineBlockedAt = now;
  return "blocked";
}

module.exports = { expireDeadline, MAX_EXTENSIONS, TIMEOUT_SUMMARY };
