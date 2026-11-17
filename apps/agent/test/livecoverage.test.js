"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mainCovered } = require("../lib/operator/livecoverage");

const rel = (...shas) => Object.fromEntries(shas.map((s) => [s, { main: true }]));

test("two pull requests with one release on main is not live yet (ticket 1842, 06:37)", () => {
  const jobs = [{ id: "a", pullRequests: ["pr/6690"], releaseEvidence: {} }, { id: "b", pullRequests: ["pr/6685"], releaseEvidence: rel("bfcd") }];
  assert.equal(mainCovered(jobs), false);
});
test("both releases on main is live", () => {
  const jobs = [{ id: "a", pullRequests: ["pr/6690"], releaseEvidence: rel("05d8", "3ae1") }, { id: "b", pullRequests: ["pr/6685"], releaseEvidence: rel("bfcd") }];
  assert.equal(mainCovered(jobs), true);
});
test("a single pull request with one release is live; no release is not", () => {
  assert.equal(mainCovered([{ pullRequests: ["pr/1"], releaseEvidence: rel("x") }]), true);
  assert.equal(mainCovered([{ pullRequests: ["pr/1"], releaseEvidence: {} }]), false);
});
test("a cancelled job's pull request does not hold the ticket back", () => {
  assert.equal(mainCovered([{ state: "cancelled", pullRequests: ["pr/2"] }, { pullRequests: ["pr/1"], releaseEvidence: rel("x") }]), true);
});
