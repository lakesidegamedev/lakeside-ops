"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { retryBlockedOwnerWork } = require("../lib/operator/releaseretry");

test("a release retries the owner's recent blocked request once (the unpublished tax report)", () => {
  const now = 10 * 86400000, owner = "111";
  const data = { jobs: {
    tax: { id: "tax", kind: "command", role: "owner", actorId: owner, state: "blocked", updatedAt: now - 3600000 },
    old: { id: "old", kind: "command", role: "owner", actorId: owner, state: "blocked", updatedAt: now - 3 * 86400000 },
    staff: { id: "staff", kind: "command", role: "support", actorId: "222", state: "blocked", updatedAt: now - 3600000 },
    asked: { id: "asked", kind: "command", role: "owner", actorId: owner, state: "blocked", updatedAt: now - 3600000 },
  }, decisions: { d: { jobId: "asked", state: "pending" } } };
  assert.deepEqual(retryBlockedOwnerWork(data, { ownerId: owner, releaseId: "r1", now }), ["tax"]);
  assert.equal(data.jobs.tax.state, "queued");
  assert.match(data.jobs.tax.inbox[0].content, /retry the remaining step once/);
  data.jobs.tax.state = "blocked";
  assert.deepEqual(retryBlockedOwnerWork(data, { ownerId: owner, releaseId: "r1", now }), [], "once per release");
  assert.deepEqual(retryBlockedOwnerWork(data, { ownerId: owner, releaseId: "r2", now }), ["tax"]);
});
