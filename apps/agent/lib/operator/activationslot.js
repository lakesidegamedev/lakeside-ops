"use strict";
// One scheduler lane slot: start an activation, bound it by the lane deadline,
// and hand any failure to the caller's settle rule. Kept apart from operator.js
// drain() so tests drive the same code the scheduler runs.
//
// A deadline abort is told apart from every other abort (stop, pause, staff
// claim, takeover, preemption). Those reach the controller first, so the
// deadline only counts when the signal was still live when it fired. A
// first-reply ticket whose provider hung at start-up was reported only as
// "activation aborted" and blocked with nothing posted (2026-11-20).

function deadlineError(timeoutMs) {
  const limit = timeoutMs >= 60000 ? `${Math.round(timeoutMs / 60000)}-minute` : `${Math.round(timeoutMs / 1000)}-second`;
  return new Error(`activation aborted: no result before the ${limit} turn limit`);
}

function startActivation({ lane, job, active, timeoutMs, run, settle, after = () => {}, now = Date.now }) {
  const controller = new AbortController(), startedAt = now();
  const slot = { job, controller, startedAt, timedOut: false };
  active[lane] = slot;
  const deadline = setTimeout(() => { if (!controller.signal.aborted) slot.timedOut = true; controller.abort(); }, timeoutMs);
  const done = run(controller.signal).catch((e) => {
    const timedOut = slot.timedOut && controller.signal.aborted;
    return settle(timedOut ? deadlineError(timeoutMs) : e, { aborted: controller.signal.aborted, timedOut, startedAt });
  }).finally(() => { clearTimeout(deadline); after(); active[lane] = null; });
  return { slot, done };
}

module.exports = { startActivation, deadlineError };
