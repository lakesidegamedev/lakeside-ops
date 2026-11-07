"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { wakeStep } = require("../lib/operator/lifecycle");
const { admit, hold } = require("../lib/operator/admission");
const now = 1000000;
const context = { now, config: { taskLifetimeMs: 86400000 }, claimedBy: () => null, directiveHeld: () => false };
const ticket = (fields = {}) => ({ id: "coordinator", kind: "ticket", role: "support", ticket: 1789, state: "waiting", channelId: "c", ownerDecisionPending: true, deadline: now + 86400000, wakeAt: now + 60000, inbox: [], ...fields });

test("a player disputing the loss explanation reaches admission while merge approval waits", () => {
  const job = ticket({ inbox: [{ authorId: "player", content: "They dropped right when it appeared" }] });
  wakeStep(job, context);
  assert.equal(job.state, "queued");
  assert.deepEqual(admit([job], { now }).map(j => j.id), [job.id]);
  assert.equal(job.ownerDecisionPending, true, "activation is not approval");
});

test("a completed independent investigation wakes its coordinator under a pending decision", () => {
  const job = ticket({ state: "blocked", inbox: [{ role: "system", authorId: "investigator", investigationResult: true, content: "Output stayed stable; loss attribution is still open" }] });
  wakeStep(job, context);
  assert.equal(job.state, "queued");
  assert.deepEqual(admit([job], { now }).map(j => j.id), [job.id]);
});

test("an independent scheduled investigation can run while approval waits", () => {
  const job = ticket({ wakeAt: now });
  wakeStep(job, context);
  assert.equal(job.state, "queued");
  assert.equal(hold(job, { now }), null);
});

test("owner decision admission changes preserve claims, pauses and closed channels", () => {
  assert.equal(hold(ticket(), { now, claimedBy: () => "staff" }), "staff-owned");
  assert.equal(hold(ticket({ ticketPaused: true }), { now }), "owner-ticket-pause");
  assert.equal(hold(ticket({ channelClosed: true }), { now }), "owner-decision");
  assert.equal(hold(ticket({ kind: "candidate" }), { now }), "owner-decision");
});
