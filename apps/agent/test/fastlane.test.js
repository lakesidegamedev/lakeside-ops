"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { derivePhase, planPublication, composeAck } = require("../lib/operator/publisher");
const { admit, queuePosition, hold, CLASSES, MAX_TOTAL } = require("../lib/operator/admission");

const rec = (extra = {}) => ({ id: "ticket:1", state: "active", nextAction: "attempt", attempts: ["a1"], ...extra });

test("public phase is derived from verified release facts, never ahead of them", () => {
  assert.equal(derivePhase(rec(), {}), "investigating");
  assert.equal(derivePhase(rec(), { prepared: true, inPr: true, ciGreen: true, onDevelopment: true }), "testing");
  const live = { prepared: true, inPr: true, ciGreen: true, onDevelopment: true, onStaging: true, onMain: true, webDeployed: true, workerDeployed: true, liveVerified: true };
  assert.equal(derivePhase(rec(), live), "live");
  assert.equal(derivePhase(rec(), { ...live, liveVerified: false }), "verifying");
});

test("one message per transition; waits refresh by edit, live posts once", () => {
  const first = planPublication({ record: rec(), now: 1000 });
  assert.equal(first.action, "post");
  const same = planPublication({ record: rec(), last: { phase: first.phase, at: 1000, messageId: "m1" }, now: 2000 });
  assert.equal(same.action, "none");
  const refresh = planPublication({ record: rec(), last: { phase: first.phase, at: 1000, messageId: "m1" }, now: 1000 + 16 * 60000 });
  assert.equal(refresh.action, "edit");
  assert.equal(refresh.messageId, "m1");
});

test("acks tell the truth about queuing and never claim work started", () => {
  assert.match(composeAck({ queuedAhead: 0, startingNow: true }), /picking this up now/);
  const queued = composeAck({ queuedAhead: 3, etaMs: 12 * 60000 });
  assert.match(queued, /queued/);
  assert.match(queued, /3 items ahead/);
  assert.doesNotMatch(queued, /working on|looking into it now/i);
});

test("conversation capacity is reserved from investigation load", () => {
  const jobs = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, kind: "ticket", state: "queued", at: i })),
    { id: "q1", kind: "conversation", state: "queued", at: 99 },
  ];
  const admitted = admit(jobs, { now: 1000 });
  assert.ok(admitted.some((j) => j.id === "q1"));
  assert.ok(admitted.filter((j) => j.kind === "ticket").length <= CLASSES.investigation.capacity);
});

test("aging bound: an overdue quiet item outranks newer owner work in its class", () => {
  const now = 20 * 60000;
  const jobs = [
    { id: "new-owner", kind: "command", role: "owner", state: "queued", at: now - 1000 },
    { id: "old-ticket", kind: "ticket", role: "support", state: "queued", at: 0 },
  ];
  // owner slot taken away so both compete for the one investigation slot
  const admitted = admit(jobs, { now, config: { ...CLASSES, owner: { capacity: 0, maxWaitMs: 60000 },
    investigation: { capacity: 1, maxWaitMs: 15 * 60000 } } });
  assert.equal(admitted[0].id, "old-ticket");
});

test("queue position matches the admission ordering an ack quotes", () => {
  const jobs = [
    { id: "a", kind: "ticket", state: "queued", at: 1 },
    { id: "b", kind: "ticket", state: "queued", at: 2 },
    { id: "c", kind: "conversation", state: "queued", at: 0 },
  ];
  assert.equal(queuePosition(jobs, jobs[1], { now: 10 }), 1);
  assert.equal(queuePosition(jobs, jobs[2], { now: 10 }), 0);
});

// Review 2026-10-13 (#69): admission must carry the drain() rules it replaces.
test("held work is never admitted, and hold names the reason", () => {
  const now = 1000;
  const jobs = [
    { id: "claimed", kind: "ticket", role: "support", ticket: 1, channelId: "c1", state: "queued", at: 1 },
    { id: "decision", kind: "ticket", role: "support", ticket: 2, channelId: "c2", ownerDecisionPending: true, state: "queued", at: 2 },
    { id: "grace", kind: "ticket", role: "support", ticket: 3, channelId: "c3", resolutionSubmitted: true, state: "queued", at: 3 },
    { id: "late", kind: "ticket", role: "support", ticket: 4, channelId: "c4", deadline: 500, state: "queued", at: 4 },
    { id: "deferred", kind: "candidate", role: "support", state: "queued", at: 5 },
    { id: "owner", kind: "command", role: "owner", state: "queued", at: 6 },
  ];
  const ctx = { now, supportDeferred: true, claimedBy: (c) => c === "c1" ? "staff" : null };
  assert.deepEqual(jobs.map((j) => hold(j, ctx)),
    ["staff-owned", "support-deferred", "closure-grace", "deadline", "support-deferred", null]);
  assert.deepEqual(admit(jobs, ctx).map((j) => j.id), ["owner"]);
});

test("one attempt per work record: two jobs on one ticket are not admitted together", () => {
  const jobs = [
    { id: "a", kind: "ticket", role: "support", ticket: 9, state: "queued", at: 1 },
    { id: "b", kind: "command", role: "support", ticket: 9, state: "queued", at: 2 },
    { id: "c", kind: "ticket", role: "support", ticket: 10, state: "running", at: 0 },
    { id: "d", kind: "ticket", role: "support", ticket: 10, state: "queued", at: 3 },
  ];
  assert.deepEqual(admit(jobs, { now: 10 }).map((j) => j.id), ["a"]);
});

test("total admission never exceeds the dedicated-slot service budget", () => {
  const jobs = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `q${i}`, kind: "conversation", state: "queued", at: i })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `o${i}`, kind: "command", role: "owner", state: "queued", at: i })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, kind: "ticket", role: "support", ticket: i + 1, state: "queued", at: i })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `k${i}`, kind: "coding", role: "support", state: "queued", at: i })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `w${i}`, kind: "probe", role: "support", operatorRole: "watchkeeper", state: "queued", at: i })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `e${i}`, kind: "finding", role: "support", operatorRole: "engineering", state: "queued", at: i })),
  ];
  assert.equal(MAX_TOTAL, Object.values(CLASSES).reduce((n, c) => n + c.capacity, 0));
  const selected = admit(jobs, { now: 10 });
  assert.ok(selected.length <= MAX_TOTAL);
  assert.equal(selected.filter((j) => j.operatorRole === "engineering").length, 1);
  assert.equal(selected.filter((j) => j.operatorRole === "watchkeeper").length, 1);
  assert.ok(selected.some((j) => j.kind === "ticket"));
  const busy = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, kind: "ticket", role: "support", ticket: 100 + i, state: "running", at: 0 }));
  assert.equal(admit([...busy, ...jobs], { now: 10, active: { investigation: 3, coding: 3, owner: 1, conversation: 1, engineering: 1, watchkeeper: 1 } }).length, 1);
});

test("an owner correction does not wait behind ticket investigations", () => {
  const jobs = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, kind: "ticket", role: "support", ticket: i + 1, state: "queued", at: i })),
    { id: "fix-that", kind: "command", role: "owner", state: "queued", at: 50 },
  ];
  assert.ok(admit(jobs, { now: 60, active: { investigation: 2 } }).some((j) => j.id === "fix-that"));
});

test("one investigation slot prefers support tickets when they are ready", () => {
  const jobs = [
    { id: "staff-cmd", kind: "command", role: "support", state: "queued", at: 1 },
    { id: "staff-cmd2", kind: "command", role: "support", state: "queued", at: 2 },
    { id: "ticket", kind: "ticket", role: "support", ticket: 5, state: "queued", at: 3 },
  ];
  assert.ok(admit(jobs, { now: 10 }).some((j) => j.id === "ticket"));
});

test("a waiting parent's polling timer cannot starve its queued investigator", () => {
  const parent = { id: "parent", kind: "ticket", ticket: 7, state: "queued", at: 1, lastPublishedAt: 1 };
  const child = { id: "child", kind: "coding", investigation: true, codingParent: parent.id, state: "queued", at: 2 };
  assert.deepEqual(admit([parent, child], { now: 100 }).map(j => j.id), ["child"]);
  parent.inbox = [{ content: "New evidence from player" }];
  assert.ok(admit([parent, child], { now: 100 }).some(j => j.id === parent.id));
});

test("read-only investigators do not wait behind an unrelated coding worker", () => {
  const coder = { id: "coder", kind: "coding", state: "running", at: 1 };
  const child = { id: "investigator", kind: "coding", investigation: true, state: "queued", at: 2 };
  assert.ok(admit([coder, child], { now: 100 }).some(j => j.id === child.id));
});

test("a blocked or deferred child returns control to its parent", () => {
  for (const state of ["blocked", "deferred", "done", "cancelled", "dismissed"]) {
    const parent = { id: "parent", kind: "ticket", ticket: 7, state: "queued", at: 1 };
    const child = { id: "child", kind: "coding", investigation: true, codingParent: parent.id, state, at: 2 };
    assert.ok(admit([parent, child], { now: 100 }).some(j => j.id === parent.id), state);
  }
});

test("delegated work inherits its root ticket's staff hold and stops after root completion", () => {
  const parent = { id: "parent", kind: "ticket", role: "support", ticket: 7, channelId: "ticket-channel", state: "deferred", at: 1 };
  const child = { id: "child", kind: "coding", role: "support", investigation: true, codingParent: parent.id, state: "queued", at: 2 };
  assert.deepEqual(admit([parent, child], { now: 100, claimedBy: id => id === parent.channelId ? "staff" : null }), []);
  parent.state = "done";
  assert.deepEqual(admit([parent, child], { now: 100 }), []);
  parent.state = "waiting";
  assert.deepEqual(admit([parent, child], { now: 100 }).map(j => j.id), [child.id]);
});
