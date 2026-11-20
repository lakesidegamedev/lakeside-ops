"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { prepare, requestScope } = require("../lib/operator/marketbrief");

const message = { messageId: "1003", authorId: "player", channelId: "room", at: "2026-11-20T01:02:00Z", content: "Check all sectors in the US, turn 79." };
const earlier = { id: "1002", authorId: "player", at: "2026-11-20T01:00:00Z", content: "Check all sectors like freight." };

test("an explicit current-market comparison uses its own scope and only the same speaker's immediate clarification", () => {
  assert.deepEqual(requestScope(message, []), { args: { country: "US" }, turn: 79 });
  const clarifies = { ...message, content: "Full depth audit. US market, turn 79." };
  assert.deepEqual(requestScope(clarifies, [earlier]), { args: { country: "US" }, turn: 79 });
  assert.equal(requestScope(clarifies, [{ ...earlier, authorId: "someoneElse" }]), null);
  for (const content of ["Thanks", "Stop checking all markets in the US", "Check all sectors", "Check all markets US and UK", "Check all sectors in the US and Canada", "Check all markets in US since turn 50"]) {
    assert.equal(requestScope({ ...message, content }, [earlier]), null);
  }
});

test("one current report reaches the broker's existing staging path, a past turn never does", async () => {
  const job = { kind: "ticket", channelId: "room" };
  const ledger = { data: {}, save() {} };
  const calls = [];
  const broker = { readable: () => true, tool: async (_job, name, input) => {
    calls.push([name, input]);
    if (name === "present_evidence") return { report: "linked" };
    return { presentation: { observation: "ev_aaa" }, marketTurn: 79, scope: "country", country: "US", commodities: Array(27), summary: { shortages: 20, surpluses: 7 } };
  } };
  const args = { job, ledger, broker, message };
  assert.equal((await prepare({ ...args, message: { ...message, content: "Check all US markets, all sectors, turn 2" } })).availableTurn, 79);
  assert.deepEqual(calls.map(row => row[0]), ["read_tool"]);
  const brief = await prepare(args);
  assert.equal(brief.report, "linked"); assert.equal(brief.summary.shortages, 20);
  assert.deepEqual(calls.at(-1), ["present_evidence", { observation: "ev_aaa" }]);
  assert.equal(await prepare(args), null);
});
