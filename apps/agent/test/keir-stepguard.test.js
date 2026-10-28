"use strict";
// 2026-10-23 DeepSeek shadow: repeated failing reads, calls to a server that
// had timed out, and no warning before the step limit cut off the reply.
const test = require("node:test");
const assert = require("node:assert/strict");
const { refuse, failed, budgetNote } = require("../lib/operator/stepguard");
const { oidFilter } = require("../lib/operator/broker");

test("an identical failed read is refused; changed arguments are not", () => {
  const s = {};
  const call = { server: "support", tool: "support_search", args: { query: "slow" } };
  assert.equal(refuse(s, "read_tool", call), null);
  failed(s, "read_tool", call, "Input validation error at limit");
  assert.match(refuse(s, "read_tool", call), /already failed.*Input validation error/);
  assert.equal(refuse(s, "read_tool", { ...call, args: { query: "slower" } }), null);
});

test("a read that timed out blocks that tool for the activation", () => {
  const s = {};
  failed(s, "read_tool", { server: "heal-ops", tool: "heal_collections", args: { env: "prod" } }, "The operation was aborted due to timeout");
  assert.match(refuse(s, "read_tool", { server: "heal-ops", tool: "heal_collections", args: {} }), /failed to respond/);
  assert.equal(refuse(s, "read_tool", { server: "heal-ops", tool: "heal_query", args: {} }), null);
});

test("writes and finishes are never refused as repeats", () => {
  const s = {};
  failed(s, "channel_reply", { message: "x" }, "Not posted: too long");
  failed(s, "finish", { state: "done" }, "Not finished");
  assert.equal(refuse(s, "channel_reply", { message: "x" }), null);
  assert.equal(refuse(s, "finish", { state: "done" }), null);
});

test("the step budget warns near the limit only", () => {
  assert.equal(budgetNote({ maxTurns: 36, steps: 20 }), null);
  assert.match(budgetNote({ maxTurns: 36, steps: 30 }), /6 of 36 left/);
  assert.match(budgetNote({ maxTurns: 6, steps: 4 }), /2 of 6 left/);
  assert.match(budgetNote({ maxTurns: 36, steps: 36 }), /budget used/);
  assert.equal(budgetNote({ steps: 99 }), null);
});

test("$oid filter values match ids stored as text or ObjectId", () => {
  assert.deepEqual(oidFilter({ corporationId: { $oid: "abc" }, turn: 3 }), { turn: 3, $expr: { $eq: [{ $toString: "$corporationId" }, "abc"] } });
  const both = oidFilter({ _id: { $oid: "a" }, $expr: { $gt: ["$x", 1] } });
  assert.deepEqual(both.$expr, { $and: [{ $gt: ["$x", 1] }, { $eq: [{ $toString: "$_id" }, "a"] }] });
  const plain = { name: "x" };
  assert.equal(oidFilter(plain), plain);
  // Keir 6.1: an $in list of $oid values (13 live failures on 2026-10-28).
  assert.deepEqual(oidFilter({ ownerId: { $in: [{ $oid: "a" }, "b"] } }), { $expr: { $in: [{ $toString: "$ownerId" }, ["a", "b"]] } });
  const ints = { turn: { $in: [1, 2] } };
  assert.equal(oidFilter(ints), ints);
});
