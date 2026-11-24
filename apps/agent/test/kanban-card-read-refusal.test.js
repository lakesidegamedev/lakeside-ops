"use strict";
// A refused board-card read has to say which card the task can read and which call
// does the work instead. The old text named only the rule, and a ticket task re-sent
// the same kanban_get five times on a card raise_to_developers had offered it.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker, cardReadRefusal } = require("../lib/operator/broker");

test("the card refusal names the readable card and the call that works", () => {
  const m = cardReadRefusal({ id: 4242, ownIds: [9001, 9002] });
  assert.match(m, /Card 4242 is not one of this task's cards/);
  assert.match(m, /may read cards 9001, 9002/);
  assert.match(m, /raise_to_developers with appendTo 4242/);
  assert.match(m, /support_get/);
  assert.doesNotMatch(m, /read only this task's own card/);
});

test("a wrong id shape is named as a shape problem, not a permission problem", () => {
  const m = cardReadRefusal({ id: "9001", ownIds: [9001] });
  assert.match(m, /not a board card id/);
  assert.match(m, /whole number/);
  assert.match(m, /not a ticket number, a review item id or a quoted string/);
});

test("a task with no cards of its own is told so, and still gets the way forward", () => {
  const m = cardReadRefusal({ id: 4242 });
  assert.match(m, /has not filed a card yet/);
  assert.match(m, /appendTo 4242/);
});

test("read_tool kanban_get reads the task's own card and refuses any other card with that guidance", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-cardread-"));
  try {
    const ledger = createLedger(path.join(dir, "ledger.json"));
    const config = { ownerId: "owner", staffIds: [], stateDir: dir, repositories: {}, scanChannels: [], supportDeferred: () => false };
    const calls = [];
    const mcp = {
      servers: () => ["ops-knowledge"],
      list: async () => [],
      call: async (server, tool, args) => { calls.push(`${server}/${tool}:${JSON.stringify(args)}`); return { id: args.id, title: "Fixture card", lane: "now", assigned_to: "keir", detail: "not projected" }; },
    };
    const broker = createBroker({ ledger, config, mcp, discord: async () => { throw new Error("unexpected"); }, sandbox: {}, now: () => 5000 });
    const job = ledger.createJob("fixture", { kind: "ticket", role: "support", ticket: 4242, repository: "AHDGame", source: {}, deadline: 9e15 });
    job.state = "running";
    job.raisedToDevelopers = [{ id: 9001, title: "Fixture handoff", at: 1, kind: "bug", blocking: false }];
    const own = await broker.tool(job, "read_tool", { server: "ops-knowledge", tool: "kanban_get", args: { id: 9001 } });
    assert.equal(own.id, 9001);
    assert.equal(own.detail, undefined, "only the summary projection is returned");
    assert.ok(calls.some((c) => c.startsWith("ops-knowledge/kanban_get")), "the own card is fetched");
    await assert.rejects(broker.tool(job, "read_tool", { server: "ops-knowledge", tool: "kanban_get", args: { id: 4243 } }), (e) => {
      assert.match(e.message, /Card 4243 is not one of this task's cards/);
      assert.match(e.message, /may read card 9001/);
      assert.match(e.message, /raise_to_developers with appendTo 4243/);
      return true;
    });
    await assert.rejects(broker.tool(job, "read_tool", { server: "ops-knowledge", tool: "kanban_get", args: { id: "9001" } }), /not a board card id/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
