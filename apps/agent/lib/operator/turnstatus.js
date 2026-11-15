"use strict";
// Keir 10 (W3): the turn, in plain fields, and the turn lock recovery template.
//
// turnStatus() merges turndiag lock_status, engine engine_health and engine
// recent_turns into one answer to "is the turn running, late, or stuck". W1's
// router calls the plain function; the model calls the turn_status tool.
//
// lockResetPlan() is the owner-approved recovery for a stuck lock. It only builds
// a dry-run plan and a heal request; nothing is cleared until the owner approves
// the exact action, and a lock that is healthy, held for a person, or not yet
// stale is refused. It mirrors the admin reset-lock route's own refusals.

const parse = (v) => {
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  if (v && typeof v === "object" && typeof v.content === "string") return parse(v.content);
  return v ?? null;
};
const iso = (v) => { if (!v) return null; const t = typeof v === "object" && v.$date ? Date.parse(v.$date) : Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

async function turnStatus(call, { now = Date.now, timeoutMs = 6000 } = {}) {
  const guarded = (p) => { let timer; const late = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), timeoutMs); }); return Promise.race([Promise.resolve().then(p), late]).finally(() => clearTimeout(timer)); };
  const [lockR, healthR, turnsR, failR] = await Promise.allSettled([
    guarded(() => call("turndiag", "lock_status", {})), guarded(() => call("engine", "engine_health", {})),
    guarded(() => call("engine", "recent_turns", { limit: 5 })), guarded(() => call("turndiag", "turn_failure_detail", { attempts: 1 })),
  ]);
  const lock = lockR.status === "fulfilled" ? parse(lockR.value) : null, health = healthR.status === "fulfilled" ? parse(healthR.value) : null;
  const turnsRaw = turnsR.status === "fulfilled" ? parse(turnsR.value) : null, fail = failR.status === "fulfilled" ? parse(failR.value) : null;
  if (!lock && !health) return { readable: false, note: "Neither the turn lock nor the engine could be read just now. Say you could not check the turn; do not guess." };
  const turns = Array.isArray(turnsRaw) ? turnsRaw : Array.isArray(turnsRaw?.turns) ? turnsRaw.turns : [];
  const last = turns[0] || null;
  const finishedAt = iso(last?.finishedAt || last?.completedAt || last?.endedAt || last?.at || health?.lastTurn?.finishedAt || health?.lastTurn?.at);
  const overdue = num(lock?.overdueMin ?? health?.schedule?.overdueMin);
  const paused = Boolean(lock?.paused ?? health?.paused);
  const attempt = fail?.attempts?.[0] || null;
  const verdict = String(lock?.verdict || "");
  const stuck = /^STUCK/i.test(verdict);
  const state = stuck ? "stuck" : lock?.isProcessing ? "processing" : paused ? "paused" : overdue > 0 ? "late" : "idle";
  const out = {
    readable: true, state, verdict: verdict || null,
    currentTurn: num(lock?.currentTurn ?? health?.turn), targetTurn: num(lock?.targetTurn),
    lastTurnFinishedAt: finishedAt, expectedNextTurn: iso(lock?.nextScheduledTurn || health?.schedule?.next), overdueMinutes: overdue,
    paused, pauseReason: lock?.pauseReason || health?.pauseReason || null,
    lock: { held: Boolean(lock?.isProcessing), kind: lock?.processingKind || null, phase: lock?.processingPhase || null, runningMinutes: num(lock?.runningMin), heartbeatAgeSeconds: num(lock?.heartbeatAgeSec), startedAt: iso(lock?.processingStartedAt) },
    lastFailure: attempt ? { turn: num(fail?.turn), phase: attempt.phase || attempt.failedPhase || attempt.failedAt || null, error: String(attempt.error || attempt.message || "").slice(0, 160) || null } : null,
    recent: health?.recent ? { turns: num(health.recent.count), failures: num(health.recent.failures) } : null,
    checkedAt: new Date(now()).toISOString(),
  };
  out.instruction = state === "stuck" ? "The turn lock looks stuck. Confirm with the heartbeat age, then request_action kind turn_lock_reset with dryRun true to see the plan; only the owner can approve it."
    : state === "paused" ? "The game is paused, so no turns are due. Say that, not that something is broken."
    : state === "late" ? `The next turn is ${out.overdueMinutes} minutes overdue but nothing holds the lock. Do not promise a time; check again after the next scheduled turn.`
    : state === "processing" ? "A turn is running now. It is healthy while the heartbeat stays fresh." : "The turn engine is idle and on schedule.";
  return out;
}

// Dry-run plan for clearing a stuck lock. `lock` is turnStatus() output, `state` the raw
// gameState lock fields read through the broker's own heal-ops read.
function lockResetPlan(status, state = {}) {
  const refuse = (reason) => ({ eligible: false, reason, spec: null });
  if (!status?.readable) return refuse("the turn lock could not be read");
  if (!status.lock.held) return refuse("no turn is holding the lock, so there is nothing to clear");
  if (state.processingHoldReason) return refuse("the turn is held for a person after a mid-turn process death; it needs release-hold with the held step names, not a lock reset");
  if (status.state !== "stuck") return refuse(`the lock is not stale yet (heartbeat ${status.lock.heartbeatAgeSeconds ?? "unknown"} s old, state ${status.state}); resetting a healthy lock can run two turns at once`);
  const filter = { _id: "current", isProcessing: true };
  if (state.processingTargetTurn !== undefined && state.processingTargetTurn !== null) filter.processingTargetTurn = state.processingTargetTurn;
  if (state.processingPhase) filter.processingPhase = state.processingPhase;
  const spec = { kind: "adhoc", env: "prod", collection: "gameState", filter, action: { kind: "set", set: { isProcessing: false } }, expectedMax: 1,
    description: `Clear the stale turn lock on turn ${status.currentTurn ?? "?"} (phase ${status.lock.phase || "unknown"}, heartbeat ${status.lock.heartbeatAgeSeconds ?? "unknown"} s old). Recovery fields stay for the resume.` };
  return { eligible: true, reason: "the lock is stale and no person-hold is set", spec,
    dryRun: { clears: "isProcessing only", keeps: "processingTargetTurn, processingPhase and the phase statuses, so the resume can use them", effect: "the next scheduled run can start; no turn runs by itself, and the game stays paused if it was paused" } };
}

module.exports = { turnStatus, lockResetPlan, parse };
