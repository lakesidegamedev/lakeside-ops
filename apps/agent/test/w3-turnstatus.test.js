"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { turnStatus, lockResetPlan } = require("../lib/operator/turnstatus");

const calls = (map) => async (server, tool) => { const v = map[`${server}/${tool}`]; if (v instanceof Error) throw v; return JSON.stringify(v ?? {}); };
const STUCK = { verdict: "STUCK: no heartbeat for 61 min", currentTurn: 1006, targetTurn: 1007, isProcessing: true, processingKind: "turn", processingPhase: "corporations", runningMin: 400, heartbeatAgeSec: 3660, nextScheduledTurn: "2026-11-15T12:00:00Z", overdueMin: 90, paused: false };

test("a stuck lock is reported in plain fields", async () => {
  const s = await turnStatus(calls({ "turndiag/lock_status": STUCK, "engine/engine_health": { turn: 1006, recent: { count: 5, failures: 1 } }, "engine/recent_turns": [{ turn: 1006, finishedAt: "2026-11-15T06:00:00Z" }], "turndiag/turn_failure_detail": { turn: 1007, attempts: [{ phase: "corporations", error: "boom" }] } }));
  assert.equal(s.state, "stuck"); assert.equal(s.lock.heartbeatAgeSeconds, 3660); assert.equal(s.lastFailure.phase, "corporations");
  assert.equal(s.lastTurnFinishedAt, "2026-11-15T06:00:00.000Z"); assert.equal(s.overdueMinutes, 90); assert.match(s.instruction, /turn_lock_reset/);
});

test("a paused game is not called broken", async () => {
  const s = await turnStatus(calls({ "turndiag/lock_status": { verdict: "idle", currentTurn: 1, isProcessing: false, paused: true }, "engine/engine_health": { turn: 1, paused: true } }));
  assert.equal(s.state, "paused"); assert.match(s.instruction, /paused/);
});

test("unreadable sources say so instead of guessing", async () => {
  const s = await turnStatus(calls({ "turndiag/lock_status": new Error("down"), "engine/engine_health": new Error("down") }));
  assert.equal(s.readable, false);
});

test("the reset plan is built only for a stale lock with no person-hold", async () => {
  const stuck = await turnStatus(calls({ "turndiag/lock_status": STUCK }));
  const plan = lockResetPlan(stuck, { processingTargetTurn: 1007, processingPhase: "corporations" });
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.spec.filter, { _id: "current", isProcessing: true, processingTargetTurn: 1007, processingPhase: "corporations" });
  assert.deepEqual(plan.spec.action.set, { isProcessing: false });
  assert.equal(lockResetPlan(stuck, { processingHoldReason: "held" }).eligible, false);
  const healthy = await turnStatus(calls({ "turndiag/lock_status": { verdict: "ok: running", isProcessing: true, heartbeatAgeSec: 10, currentTurn: 5 } }));
  assert.match(lockResetPlan(healthy).reason, /not stale/);
  const idle = await turnStatus(calls({ "turndiag/lock_status": { verdict: "idle", isProcessing: false } }));
  assert.match(lockResetPlan(idle).reason, /nothing to clear/);
});
