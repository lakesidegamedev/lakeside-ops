"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { retryReadFailure, recoverAuthBlocked } = require("../lib/operator/recovery");

const AUTH = "model request failed: Failed to authenticate: OAuth session expired and could not be refreshed";

test("a provider login failure waits and retries instead of blocking", () => {
  const job = { effects: {} };
  assert.equal(retryReadFailure(job, new Error(AUTH), 1000), true);
  assert.equal(job.state, "waiting"); assert.equal(job.wakeAt, 1000 + 15 * 60000);
  job.authWaits = 48;
  assert.equal(retryReadFailure(job, new Error(AUTH), 1000), false);
});

test("a login failure with a write in flight is not retried", () => {
  const job = { effects: { k: { state: "started" } } };
  assert.equal(retryReadFailure(job, new Error(AUTH)), false);
});

test("on start, tasks blocked only by a login failure resume; others stay blocked", () => {
  const saved = [], audits = [];
  const ledger = { data: { jobs: {
    a: { id: "a", state: "blocked", summary: AUTH, effects: {} },
    b: { id: "b", state: "blocked", summary: AUTH, effects: { k: { state: "started" } } },
    c: { id: "c", state: "blocked", summary: "External action needs receipt inspection: x", effects: {} },
    d: { id: "d", state: "done", summary: AUTH, effects: {} },
  } }, save: () => saved.push(1), audit: (k, v) => audits.push([k, v]) };
  assert.equal(recoverAuthBlocked(ledger), 1);
  assert.equal(ledger.data.jobs.a.state, "queued");
  assert.equal(ledger.data.jobs.b.state, "blocked");
  assert.equal(ledger.data.jobs.c.state, "blocked");
  assert.equal(ledger.data.jobs.d.state, "done");
  assert.equal(saved.length, 1);
});
