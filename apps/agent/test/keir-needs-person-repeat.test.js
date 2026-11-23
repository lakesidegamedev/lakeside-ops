"use strict";
// Owner, 2026-11-23: one player's "how am I VP" report in #america-chat woke intake five times. Each activation
// was refused (wrong anchor message, no problem phrase) and each DM'd the owner "Needs a person" about the same
// report. These pin the three fixes: the problem phrase, the anchor window, and one DM per report.
const test = require("node:test");
const assert = require("node:assert");
const { problemReport, snowflakeTime, handoffRefs, repeatedHandoff } = require("../lib/operator/broker");

const CHANNEL = "1488255716753019171";
const NOW = 1795400000000;

test("'Something broke' counts as a problem report", () => {
  assert.ok(problemReport("Something broke I guess, how am I VP"));
  assert.ok(problemReport("my corp is bugged"));
  assert.ok(!problemReport("Im so confused"));
  assert.ok(!problemReport("I ran for the Illinois house"));
});

test("snowflake times order the player's messages", () => {
  const first = snowflakeTime("1574225434592419974"), later = snowflakeTime("1574225529295474871");
  assert.ok(later > first && later - first < 30 * 60 * 1000);
  assert.ok(Number.isNaN(snowflakeTime("not-a-number")));
});

test("handoff refs drop the channel id", () => {
  const refs = handoffRefs(`channel ${CHANNEL}, message 1574225434592419974 and 1574225529295474871`, new Set([CHANNEL]));
  assert.deepStrictEqual(refs, ["1574225434592419974", "1574225529295474871"]);
});

function prior(over = {}) {
  return { kind: "candidate", source: { authorId: "405913216829489153", channelId: CHANNEL }, raisedToDevelopers: [{ id: 1, title: "Review intake for reported unexpected U.S. offices", needsHuman: true, notifiedAt: NOW - 600000, refs: ["1574225434592419974"] }], ...over };
}

test("a second intake for the same Discord message sends no new DM", () => {
  const job = { kind: "candidate", source: { authorId: "999", channelId: CHANNEL } };
  const hit = repeatedHandoff({ a: prior(), b: job }, job, "Check intake for unexpected U.S. office and party leadership", ["1574225434592419974"], NOW);
  assert.strictEqual(hit?.id, 1);
});

test("a second intake from the same reporter sends no new DM even without a shared message", () => {
  const job = { kind: "candidate", source: { authorId: "405913216829489153", channelId: CHANNEL } };
  assert.strictEqual(repeatedHandoff({ a: prior(), b: job }, job, "Review blocked intake for reported US office changes", [], NOW)?.id, 1);
});

test("an unrelated handoff, or one older than a day, still DMs", () => {
  const job = { kind: "ticket", source: { authorId: "1", channelId: "2" } };
  assert.strictEqual(repeatedHandoff({ a: prior(), b: job }, job, "Relink a Discord login for ticket 1890", ["1574299999999999999"], NOW), null);
  const old = prior(); old.raisedToDevelopers[0].notifiedAt = NOW - 25 * 3600 * 1000;
  const same = { kind: "candidate", source: { authorId: "405913216829489153", channelId: CHANNEL } };
  assert.strictEqual(repeatedHandoff({ a: old, b: same }, same, "x", ["1574225434592419974"], NOW), null);
});
