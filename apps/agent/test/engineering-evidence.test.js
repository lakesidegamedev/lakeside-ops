"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { createEngineering } = require("../lib/operator/engineering");
function setup(t, exec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-eng-evidence-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json")), config = { stateDir: dir, repositories: {}, staffIds: [], supportDeferred: () => false, engineeringKanbanId: 123 };
  const calls = [], broker = createBroker({ ledger, config, mcp: { servers: () => [], list: async () => [], call: async (...args) => { calls.push(args); return { id: args[2].id, title: "Own work", lane: "now", detail: "private", events: [{ secret: true }] }; } }, discord: async () => { throw new Error("unexpected Discord"); }, sandbox: {}, ...(exec ? { exec } : {}) });
  const engineering = createEngineering({ ledger }), job = engineering.enqueue({ key: "ci", title: "CI evidence", evidence: "Verified classifier failure", kanbanId: 123 });
  job.state = "running";
  return { ledger, config, broker, calls, engineering, job };
}
test("engineering can read only its own configured card through the real broker", async (t) => {
  const h = setup(t), input = { server: "ops-knowledge", tool: "kanban_get", args: { id: 123 } };
  const result = await h.broker.tool(h.job, "read_tool", input);
  assert.equal(result.id, 123); assert.equal(result.detail, undefined); assert.equal(result.events, undefined);
  await assert.rejects(h.broker.tool(h.job, "read_tool", { ...input, args: { id: 124 } }), /only|scope/);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][3], false);
});
test("new evidence resumes the existing engineering job exactly once without duplicate work", (t) => {
  const h = setup(t); h.job.state = "waiting"; h.job.wakeAt = 9e15;
  const receipt = h.engineering.followup({ task: h.job.id, key: "actions-receipt:1", evidence: "Read-only Actions timing receipts are now available; inspect original run attempts." });
  assert.equal(receipt.woken, true); assert.equal(h.job.state, "queued"); assert.equal(h.job.inbox.length, 1);
  h.job.state = "waiting";
  assert.equal(h.engineering.followup({ task: h.job.id, key: "actions-receipt:1", evidence: "Same receipt" }).duplicate, true);
  assert.equal(h.job.state, "waiting"); assert.equal(h.job.inbox.length, 1); assert.equal(Object.keys(h.ledger.data.jobs).length, 1);
});
test("follow-up preserves holds, child work, expiration and terminal state across reload", (t) => {
  for (const hold of ["paused", "decision", "effect", "child", "staff", "expired", "reply", "approval"]) {
    const h = setup(t); h.job.state = "waiting"; h.job.wakeAt = 9e15;
    if (hold === "paused") h.ledger.data.paused = true;
    if (hold === "decision") h.ledger.data.decisions = { x: { jobId: h.job.id, state: "pending" } };
    if (hold === "approval") h.job.awaitingApproval = true;
    if (hold === "effect") h.job.effects.x = { state: "started" };
    if (hold === "child") h.ledger.createJob("child", { codingParent: h.job.id, state: "queued" });
    if (hold === "staff") h.job.staffActiveUntil = 9e15;
    if (hold === "expired") h.job.deadline = 1;
    if (hold === "reply") h.job.waitingFor = { kind: "developer_reply" };
    const receipt = h.engineering.followup({ task: h.job.id, key: "receipt", evidence: "New verified evidence" });
    assert.equal(receipt.woken, false, hold); assert.equal(h.job.state, "waiting", hold);
    const restored = createEngineering({ ledger: createLedger(h.ledger.file || path.join(h.config.stateDir, "ledger.json")) });
    assert.equal(restored.followup({ task: h.job.id, key: "receipt", evidence: "Repeated receipt" }).duplicate, true);
  }
  const h = setup(t); h.job.state = "done";
  assert.throws(() => h.engineering.followup({ task: h.job.id, key: "new", evidence: "New data" }), /resurrected/);
  assert.equal(h.job.inbox, undefined);
});
test("engineering card scope follows descendants without permitting unrelated cards", async (t) => {
  const h = setup(t), child = h.ledger.createJob("child", { kind: "coding", investigation: true, role: "support", state: "running", codingParent: h.job.id, deadline: 9e15 });
  const result = await h.broker.tool(child, "read_tool", { server: "ops-knowledge", tool: "kanban_get", args: { id: 123 } });
  assert.equal(result.id, 123);
  await assert.rejects(h.broker.tool(child, "read_tool", { server: "ops-knowledge", tool: "kanban_get", args: { id: 999 } }));
});

test("engineering GitHub evidence passes the real broker and exposes only read endpoints", async (t) => {
  const calls = [], sha = "a".repeat(40);
  const h = setup(t, async (exe, args) => {
    assert.equal(exe, "/usr/bin/gh"); assert.equal(args[0], "api"); assert.equal(args.length, 2); calls.push(args[1]);
    if (args[1].endsWith("/pulls/7")) return JSON.stringify({ number: 7, head: { sha }, base: { sha }, merged: false });
    if (args[1].includes("/actions/workflows/")) return JSON.stringify({ workflow_runs: [], total_count: 0 });
    if (args[1].includes("/git/commits/")) return JSON.stringify({ tree: { sha } });
    if (args[1].startsWith("search/issues?")) return JSON.stringify({ total_count: 1, items: [{ number: 8, title: "CI", state: "open", body: "unexposed", assignees: [{ login: "staff" }] }] });
    throw new Error("Unexpected API " + args[1]);
  });
  const result = await h.broker.tool(h.job, "github", { action: "ci_runs", number: 7 });
  assert.equal(result.number, 7);
  const issues = await h.broker.tool(h.job, "github", { action: "issues", query: "CI state:open" });
  assert.equal(issues.issues[0].body, undefined); assert.equal(issues.issues[0].number, 8);
  const before = calls.length;
  await assert.rejects(h.broker.tool(h.job, "github", { action: "issues", query: "CI OR repo:other/repo" }), /remove repo:, org: or user:/);
  await assert.rejects(h.broker.tool(h.job, "github", { action: "merge", number: 7 }), /Engineering/);
  h.job.role = "player";
  await assert.rejects(h.broker.tool(h.job, "github", { action: "ci_runs", number: 7 }), /players can discuss/);
  assert.equal(calls.length, before);
});
