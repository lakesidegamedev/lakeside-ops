"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { isGameStatusQuery, formatStatus, readGameStatus } = require("../lib/operator/appstatus");
const snapshot = () => ({ turn: 241, year: 1994, paused: false, checkedAt: new Date().toISOString(), lastTurn: { success: true, durationMs: 283180, warnings: 2 }, recent: { count: 24, failures: 0 }, schedule: { next: "2026-10-16T18:00:00Z" } });
test("only an exact status intent bypasses model routing", () => {
  for (const s of ["Game status", "Please show me the game status?", "How is the game running?"]) assert.equal(isGameStatusQuery(s), true, s);
  for (const s of ["Game status and restart it", "Change game status", "Game status for my country", "Explain game status", "Pause the game"]) assert.equal(isGameStatusQuery(s), false, s);
});
test("current game status makes one read-only bounded health call", async () => {
  let calls = 0;
  const result = await readGameStatus({ call: async (server, tool, args, write, signal) => {
    calls++; assert.equal(server, "engine"); assert.equal(tool, "engine_health"); assert.deepEqual(args, {}); assert.equal(write, false); assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false); return snapshot();
  } });
  assert.equal(calls, 1); assert.match(result, /turn 241, year 1994/); assert.match(result, /4 minutes 43 seconds/); assert.match(result, /2 warnings/); assert.match(result, /0 failed attempts across the last 24 recorded turn attempts/); assert.match(result, /18:00 UTC/);
});
test("paused and failed states are reported without implying healthy operation", () => {
  const s = snapshot(); s.paused = true; s.pauseReason = "operator pause"; s.lastTurn.success = false; s.schedule.overdueMin = 9;
  const result = formatStatus(s);
  assert.match(result, /game is paused: operator pause/); assert.match(result, /latest turn failed/); assert.match(result, /9 minutes overdue/); assert.doesNotMatch(result, /game is running/);
});
test("stale, future and malformed health snapshots cannot fabricate a current answer", () => {
  for (const change of [{ checkedAt: new Date(Date.now() - 121000).toISOString() }, { checkedAt: new Date(Date.now() + 31000).toISOString() }, { checkedAt: undefined }, { turn: null }, { paused: undefined }]) assert.throws(() => formatStatus({ ...snapshot(), ...change }), /unavailable/);
});
test("health failures propagate rather than returning a stale success", async () => {
  await assert.rejects(readGameStatus({ call: async () => { throw Error("health unavailable"); } }), /health unavailable/);
});
