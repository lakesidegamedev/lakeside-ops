"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { expireDeadline } = require("../lib/operator/deadline");

test("a first deadline expiry extends Keir's own task instead of asking the owner", () => {
  const job = { id: "mnm", kind: "finding", state: "waiting", deadline: 1000 };
  assert.equal(expireDeadline(job, 2000, { lifetimeMs: 500 }), "extended");
  assert.equal(job.deadline, 2500); assert.equal(job.state, "queued"); assert.equal(job.deadlineExtensions, 1);
});

test("a task that runs out of time again is held for the owner", () => {
  const job = { id: "mnm", kind: "finding", state: "running", deadline: 1000, deadlineExtensions: 1 };
  assert.equal(expireDeadline(job, 2000, { lifetimeMs: 500 }), "blocked");
  assert.equal(job.state, "blocked"); assert.match(job.summary, /twice/);
});

test("live deadlines and finished or held tasks are left alone", () => {
  assert.equal(expireDeadline({ state: "running", deadline: 3000 }, 2000, { lifetimeMs: 500 }), null);
  for (const state of ["done", "dismissed", "cancelled", "blocked"]) assert.equal(expireDeadline({ state, deadline: 1 }, 2000, { lifetimeMs: 500 }), null);
});

test("a task re-blocked by its deadline alerts the owner only once (Keir 10.0.1)", () => {
  const { expireDeadline } = require("../lib/operator/deadline");
  const job = { state: "waiting", deadline: 1, deadlineExtensions: 1 };
  assert.equal(expireDeadline(job, 10, { lifetimeMs: 100 }), "blocked");
  job.state = "waiting"; // something outside put it back to waiting
  assert.equal(expireDeadline(job, 20, { lifetimeMs: 100 }), "reblocked");
  assert.equal(job.state, "blocked");
});
