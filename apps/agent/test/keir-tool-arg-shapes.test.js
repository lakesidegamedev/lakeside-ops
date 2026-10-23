"use strict";
// 2026-10-23 DeepSeek trace: support_search always failed on limit 60, every
// knowledge_query sent `query` instead of `text`, and calculate refused 1000
// in a millisecond conversion.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { calculate } = require("../lib/operator/knowledge");
const NOW = 1000000;

function fixture(t, { role = "support", reply = { items: [] } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-args-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "owner", staffIds: [], stateDir: dir, repositories: {}, supportDeferred: () => false };
  const job = ledger.createJob("ticket:fixture", { kind: role === "owner" ? "command" : "ticket", role, ticket: 1577, source: {}, deadline: NOW + 86400000 });
  job.state = "running";
  const calls = [];
  const mcp = { servers: () => ["ops-knowledge", "support"], list: async () => [], call: async (server, tool, args) => { calls.push([server, tool, args]); return reply; } };
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox: {}, now: () => NOW });
  return { job, broker, calls };
}

test("support_search stays inside the server's limit of 40", async (t) => {
  const f = fixture(t);
  await f.broker.tool(f.job, "read_tool", { server: "support", tool: "support_search", args: { kind: "ticket", query: "slow", limit: 20 } });
  const [, , args] = f.calls.find((c) => c[1] === "support_search");
  assert.equal(args.limit, 40);
  assert.equal(args.openOnly, true);
});

test("knowledge_query accepts query or question as its text", async (t) => {
  for (const key of ["query", "question"]) {
    const f = fixture(t, { role: "owner", reply: [] });
    await f.broker.tool(f.job, "read_tool", { server: "ops-knowledge", tool: "knowledge_query", args: { [key]: "union wages" } });
    const [, , args] = f.calls.find((c) => c[1] === "knowledge_query");
    assert.equal(args.text, "union wages");
    assert.equal(args[key], undefined);
  }
});

test("calculate allows unit conversion constants, not other unread figures", () => {
  assert.equal(calculate("(1792783563181-1792783520454)/1000", [1792783563181, 1792783520454]), 42.727);
  assert.equal(calculate("7200000/3600000", [7200000]), 2);
  assert.throws(() => calculate("5000*2", []), /not in anything you read/);
  assert.throws(() => calculate("1001+1", []), /not in anything you read/);
});
