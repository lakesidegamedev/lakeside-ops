"use strict";
// A submitted resolution used to be settled by the drain even while the task
// was still running: the state flipped to waiting and the agent's own finish
// (plus remember and checkpoint) were refused as "this task is waiting. Its
// turn is over" in the same activation that resolved the ticket.
const test = require("node:test");
const assert = require("node:assert/strict");
const { settleSubmittedResolution, CLOSE_STALL_MS } = require("../lib/operator/ticketclosure");

const now = 1000 * 60 * 60;
const submitted = (extra = {}) => ({ kind: "ticket", role: "support", ticket: 4, channelId: "channel", resolutionSubmitted: true, resolutionSubmittedAt: now - 60000, ...extra });

test("a running task settles its own turn after resolving instead of being flipped to waiting mid-activation", () => {
  assert.equal(settleSubmittedResolution(submitted({ state: "running" }), now), null);
});

test("an idle submitted resolution waits for the channel to close, and reports a stall after twenty minutes", () => {
  assert.deepEqual(settleSubmittedResolution(submitted({ state: "waiting" }), now), { state: "waiting" });
  assert.deepEqual(settleSubmittedResolution(submitted({ state: "queued" }), now), { state: "waiting" });
  const stalled = settleSubmittedResolution(submitted({ state: "waiting", resolutionSubmittedAt: now - CLOSE_STALL_MS - 1 }), now);
  assert.equal(stalled.state, "blocked");
  assert.match(stalled.summary, /has not closed the ticket channel/);
});

test("a closed, failing or unresolved-without-submission ticket keeps its own state", () => {
  for (const extra of [{ state: "done" }, { state: "cancelled" }, { state: "blocked" }, { state: "waiting", resolved: true }, { state: "waiting", resolutionSubmitted: false }])
    assert.equal(settleSubmittedResolution(submitted(extra), now), null);
});
