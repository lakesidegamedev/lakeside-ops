"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { describe, start, finish, forReply } = require("../lib/operator/toolactivity");
test("tool calls have source-specific presentation and unique durable identities", () => {
  const job = { role: "owner" };
  const a = start(job, "read_tool", { server: "gamestate", tool: "trace_corp" }, 1000);
  const b = start(job, "read_tool", { server: "support", tool: "support_get" }, 1000);
  assert.notEqual(a, b); assert.equal(job.liveLog[0].state, "running");
  assert.equal(job.liveLog[0].title, "Inspect corporation"); assert.equal(job.liveLog[0].source, "Game state");
  assert.equal(job.liveLog[1].title, "Read ticket"); assert.equal(job.liveLog[1].source, "Support");
  finish(job, a, true, 210, 1210); finish(job, b, false, 420, 1420);
  assert.equal(job.liveLog[0].id, a); assert.equal(job.liveLog[0].state, "completed"); assert.equal(job.liveLog[1].state, "failed");
  assert.equal(describe("github", { action: "status" }).source, "GitHub");
});
test("completed tool activity attaches to one reply and excludes reply mechanics", () => {
  const job = { role: "owner" };
  const id = start(job, "read_tool", { server: "gamestate", tool: "game_overview" }); finish(job, id, true, 12);
  start(job, "channel_reply", { message: "private message body" });
  assert.deepEqual(forReply(job).map(c => c.id), [id]); assert.deepEqual(forReply(job), []);
  assert.equal(start({ role: "player" }, "read_tool", {}), null);
});
test("parallel tool completions are each attached once even when they finish out of order", () => {
  const job = { role: "owner" }, first = start(job, "calculate", {}), second = start(job, "chart", {});
  finish(job, second, true, 1);
  assert.deepEqual(forReply(job).map(row => row.id), [second]);
  finish(job, first, true, 2);
  assert.deepEqual(forReply(job).map(row => row.id), [first]);
  assert.deepEqual(forReply(job), []);
});
