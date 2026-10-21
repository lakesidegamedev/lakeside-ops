"use strict";
// A ticket task that has submitted its resolution hands the ticket to the bot,
// which closes the channel. The background drain settles that task to waiting
// while it waits for the closure, and to blocked if the channel never closes.
//
// Never settle a task that is mid-activation: the drain runs every second, so
// it flipped the task to waiting the moment its own support_resolve landed,
// and the rest of that activation was refused with "task execution authority
// is inactive: this task is waiting. Its turn is over" (7 tasks, 2026-10-21:
// remember, checkpoint, player_note and finish, all in the turn that resolved
// the ticket). A running task ends its own turn through its finish call; the
// drain settles it on the next tick after that.
const CLOSE_STALL_MS = 20 * 60000;
const SETTLED = ["done", "cancelled", "blocked", "running"];
const STALLED_SUMMARY = "Resolution is recorded, but the bot has not closed the ticket channel after 20 minutes. Inspect receipt delivery.";

// Returns null when the task keeps its current state, or the state the drain
// should apply.
function settleSubmittedResolution(job, now = Date.now()) {
  if (!job?.resolutionSubmitted || job.resolved) return null;
  if (SETTLED.includes(job.state)) return null;
  // Kept as a raw subtraction so a task with no recorded submission time waits
  // instead of being reported as stalled.
  if (now - job.resolutionSubmittedAt > CLOSE_STALL_MS) return { state: "blocked", summary: STALLED_SUMMARY };
  return { state: "waiting" };
}

module.exports = { settleSubmittedResolution, CLOSE_STALL_MS, STALLED_SUMMARY };
