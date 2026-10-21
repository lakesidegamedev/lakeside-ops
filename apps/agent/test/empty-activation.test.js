"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { emptyActivation } = require("../lib/operator/agent");
const { retryReadFailure } = require("../lib/operator/recovery");

// 2026-10-19: Claude runs returned success with zero tokens and no tool call;
// tickets 1626 and 1627 got no reply.
test("a zero-token, tool-free, text-free activation is empty", () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  assert.equal(emptyActivation({ subtype: "success", usage, result: "" }, { calls: 0 }), true);
  assert.equal(emptyActivation({ subtype: "success", usage, result: "" }, { calls: 1 }), false);
  assert.equal(emptyActivation({ subtype: "success", usage, result: "hi" }, { calls: 0 }), false);
  assert.equal(emptyActivation({ subtype: "success", usage: { ...usage, output_tokens: 5 } }, { calls: 0 }), false);
  // Providers that report no usage are not judged.
  assert.equal(emptyActivation({ subtype: "success", usage: {} }, { calls: 0 }), false);
});

test("an empty activation waits on the provider instead of blocking the ticket", () => {
  const job = { effects: {}, state: "running" };
  const error = new Error("model request failed: empty activation (no tokens, no tool call, no text) ");
  assert.equal(retryReadFailure(job, error, 1000), true);
  assert.equal(job.state, "waiting"); assert.equal(job.wakeAt, 61000);
  assert.equal(retryReadFailure(job, error, 1000), true);
  assert.equal(job.wakeAt, 1000 + 15 * 60000);
  for (let i = 0; i < 46; i++) assert.equal(retryReadFailure(job, error, 1000), true);
  assert.equal(retryReadFailure(job, error, 1000), false);
  // A started external write is never retried blind.
  assert.equal(retryReadFailure({ effects: { a: { state: "started" } } }, error, 1000), false);
});
