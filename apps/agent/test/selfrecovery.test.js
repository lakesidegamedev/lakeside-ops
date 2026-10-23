"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createRecovery, SPIN_ROUNDS, STARVE_MS, HOLD_MS } = require("../lib/operator/selfrecovery");

function world(jobs, t0 = 1_000_000_000) {
  let t = t0; const audits = [];
  const ledger = { data: { jobs: Object.fromEntries(jobs.map((j) => [j.id, j])) }, audit: (k, v) => audits.push([k, v]), save() {} };
  const r = createRecovery({ ledger, now: () => t });
  return { ledger, r, audits, advance: (ms) => { t += ms; }, now: () => t };
}
const slot = (job, startedAt, aborted = { v: false }) => ({ job, startedAt, controller: { abort: () => { aborted.v = true; } }, aborted });

test("a spinning ticket is nudged once, then parked and its lane released", () => {
  const job = { id: "a", kind: "ticket", ticket: 1560, state: "running", rounds: 10 };
  const w = world([job]); const s = slot(job, 0); const active = { investigation: s };
  w.r.tick(active);
  job.rounds += SPIN_ROUNDS; w.r.tick(active);
  assert.equal(job.inbox.at(-1).authorId, "self-recovery");
  assert.equal(job.state, "running");
  job.rounds += SPIN_ROUNDS; w.r.tick(active);
  assert.equal(job.state, "waiting"); assert.match(job.summary, /^Self-recovery:/); assert.equal(s.aborted.v, true);
  assert.deepEqual(w.ledger.data.recoveries.map((x) => x.action), ["nudged", "parked"]);
});

test("progress resets the spin count; a spinning side task is stopped", () => {
  const ticket = { id: "t", kind: "ticket", ticket: 1, state: "running", rounds: 0 };
  const cmd = { id: "c", kind: "command", state: "running", rounds: 0 };
  const w = world([ticket, cmd]);
  w.r.tick({});
  ticket.rounds += SPIN_ROUNDS; ticket.lastPublishedAt = 5; w.r.tick({});
  assert.equal(ticket.inbox, undefined);
  cmd.rounds += SPIN_ROUNDS; w.r.tick({}); cmd.rounds += SPIN_ROUNDS; w.r.tick({});
  assert.equal(cmd.state, "cancelled");
});

test("a task activated every minute is backed off instead of re-run (ticket 1658)", () => {
  // 104 activations in 2.5 hours, each ~30s, all refused a finish: the round
  // guard never tripped because every activation was short.
  const job = { id: "hot", kind: "ticket", ticket: 1658, state: "queued", activationAt: [] };
  const w = world([job]);
  for (let i = 0; i < 5; i++) { job.activationAt.push(w.now()); w.advance(60000); w.r.tick({}); }
  assert.equal(job.state, "waiting");
  assert.ok(job.wakeAt >= w.now() + 5 * 60000 - 60000, `wake ${job.wakeAt - w.now()}ms`);
  assert.equal(job.hotStrikes, 1);
  assert.deepEqual(w.ledger.data.recoveries.map((x) => x.action), ["backed-off"]);
  // Still looping after the delay escalates, and never cancels the work.
  for (let i = 0; i < 5; i++) job.activationAt.push(w.now());
  w.r.tick({});
  assert.equal(job.hotStrikes, 2);
  assert.ok(job.wakeAt >= w.now() + 30 * 60000);
  assert.equal(job.state, "waiting");
  // The ladder belongs to one incident: after six quiet hours it starts again,
  // so a burst days later is not punished by an old record.
  w.advance(7 * 3600000);
  job.activationAt = Array.from({ length: 5 }, (_, i) => w.now() + i);
  w.r.tick({});
  assert.equal(job.hotStrikes, 1);
});

test("a new human message, an active slot or another task's delivery keeps a hot task running", () => {
  const human = { id: "h", kind: "ticket", ticket: 2, state: "queued", activationAt: [] };
  const live = { id: "l", kind: "ticket", ticket: 3, state: "running", activationAt: [] };
  const delivered = { id: "d", kind: "ticket", ticket: 4, state: "queued", activationAt: [], inbox: [{ authorId: "job-123", content: "coding result" }] };
  const chat = { id: "c", kind: "conversation", state: "queued", activationAt: [] };
  const w = world([human, live, delivered, chat]);
  const t0 = w.now();
  for (let i = 0; i < 6; i++) for (const j of [human, live, delivered, chat]) j.activationAt.push(t0 + i);
  human.lastPlayerAt = t0 + 1;
  w.advance(1000); w.r.tick({ investigation: slot(live, t0) });
  assert.equal(human.state, "queued");
  assert.equal(live.state, "running");
  assert.equal(delivered.state, "queued");
  assert.equal(chat.state, "queued");
  assert.equal(w.ledger.data.recoveries, undefined);
});

test("a starving ticket preempts non-ticket work first, never an effect in flight", () => {
  const w = world([]);
  const starving = { id: "s", kind: "ticket", ticket: 1577, state: "queued", wakeAt: w.now() - STARVE_MS - 1 };
  const busyTicket = { id: "b", kind: "ticket", ticket: 2, state: "running" };
  const cmd = { id: "c", kind: "command", state: "running" };
  const writing = { id: "e", kind: "command", state: "running", effects: { x: { state: "executing" } } };
  Object.assign(w.ledger.data.jobs, { s: starving, b: busyTicket, c: cmd, e: writing });
  const active = { investigation: slot(busyTicket, w.now() - HOLD_MS - 1), investigation2: slot(cmd, w.now()), investigation3: slot(writing, 0), coding: slot(busyTicket, w.now()), coding2: slot(cmd, w.now()), coding3: slot(writing, 0) };
  w.r.tick(active);
  assert.equal(cmd.state, "waiting"); assert.match(cmd.summary, /^Self-recovery: lane given to ticket 1577/); assert.equal(writing.state, "running");
  assert.equal(w.ledger.data.recoveries.at(-1).forTicket, 1577);
});

test("no preemption while a usable lane is free", () => {
  const w = world([]);
  const starving = { id: "s", kind: "ticket", ticket: 9, state: "queued", wakeAt: w.now() - STARVE_MS - 1 };
  const cmd = { id: "c", kind: "command", state: "running" };
  Object.assign(w.ledger.data.jobs, { s: starving, c: cmd });
  w.r.tick({ investigation: slot(cmd, 0), investigation2: null });
  assert.equal(cmd.state, "running");
});

test("owner-requested work that spins is blocked for review, never cancelled", () => {
  const job = { id: "o", kind: "command", role: "owner", state: "running", rounds: 0 };
  const w = world([job]); const s = slot(job, 0); const active = { investigation: s };
  w.r.tick(active); job.rounds += SPIN_ROUNDS; w.r.tick(active); job.rounds += SPIN_ROUNDS; w.r.tick(active);
  assert.equal(job.state, "blocked");
  assert.match(job.summary, /^Self-recovery: .*retry it from the app/);
  assert.equal(s.aborted.v, true);
  assert.equal(w.ledger.data.recoveries.at(-1).action, "blocked");
});

test("a stale owner-decision hold is cleared and the task requeued; a live one is kept", () => {
  const stale = { id: "s", kind: "ticket", ticket: 1560, state: "blocked", ownerDecisionPending: true };
  const live = { id: "l", kind: "ticket", ticket: 1575, state: "blocked", ownerDecisionPending: true };
  const w = world([stale, live]);
  w.ledger.data.decisions = { x: { id: "x", jobId: "l", state: "pending" }, y: { id: "y", jobId: "s", state: "approved" } };
  w.r.tick({});
  assert.equal(stale.ownerDecisionPending, undefined); assert.equal(stale.state, "queued");
  assert.equal(live.ownerDecisionPending, true); assert.equal(live.state, "blocked");
});

test("a hold with no decision record (legacy handoff note) is kept", () => {
  const legacy = { id: "g", kind: "ticket", ticket: 1575, state: "blocked", ownerDecisionPending: true };
  const w = world([legacy]); w.ledger.data.decisions = {};
  w.r.tick({});
  assert.equal(legacy.ownerDecisionPending, true); assert.equal(legacy.state, "blocked");
});

test("a ticket admission cannot run never triggers preemption, and preemption is rate limited", () => {
  const { PREEMPT_GAP_MS, PREEMPT_EVERY_MS } = require("../lib/operator/selfrecovery");
  const w = world([]);
  const held = { id: "h", kind: "ticket", ticket: 1558, state: "queued", wakeAt: w.now() - STARVE_MS - 1 };
  const cmd = { id: "c", kind: "command", state: "running" };
  Object.assign(w.ledger.data.jobs, { h: held, c: cmd });
  const s = slot(cmd, 0); const active = { investigation: s, investigation2: slot({ id: "x", kind: "ticket", state: "running" }, w.now()), investigation3: slot({ id: "y", kind: "ticket", state: "running" }, w.now()) };
  for (let i = 0; i < 50; i++) w.r.tick(active, { canRun: (j) => j.id !== "h" });
  assert.equal(cmd.state, "running"); assert.equal(s.aborted.v, false);
  // Admissible: exactly one preemption, then nothing until the per-ticket window passes.
  for (let i = 0; i < 50; i++) { w.r.tick(active, { canRun: () => true }); if (cmd.state === "waiting") cmd.state = "running"; }
  assert.equal(w.ledger.data.recoveries.filter((x) => x.action === "preempted").length, 1);
  w.advance(PREEMPT_GAP_MS + 1); w.r.tick(active, { canRun: () => true });
  assert.equal(w.ledger.data.recoveries.filter((x) => x.action === "preempted").length, 1);
  w.advance(PREEMPT_EVERY_MS); w.r.tick(active, { canRun: () => true });
  assert.equal(w.ledger.data.recoveries.filter((x) => x.action === "preempted").length, 2);
});

test("blocked work nobody can act on closes after six hours, but never with an unverified effect", () => {
  const t0 = 1_000_000_000;
  const dead = { id: "d1", state: "blocked", role: "support", ticket: 1584, at: t0, updatedAt: t0, summary: "activation aborted" };
  const risky = { id: "d2", state: "blocked", role: "support", ticket: 1585, at: t0, updatedAt: t0, effects: { e: { state: "uncertain" } } };
  const w = world([dead, risky], t0);
  w.advance(5 * 3600000); w.r.tick([]);
  assert.equal(dead.state, "blocked");
  w.advance(1.5 * 3600000); w.r.tick([]);
  assert.equal(dead.state, "dismissed");
  assert.match(dead.summary, /closed after being blocked/);
  assert.equal(risky.state, "blocked");
});
