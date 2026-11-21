"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const NOW = 1000000;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-dev-handoff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "owner", staffIds: [], stateDir: dir, repositories: {} };
  const job = ledger.createJob("finding:fixture", { kind: "finding", role: "support", source: {}, deadline: NOW + 86400000 });
  job.state = "running";
  const broker = createBroker({ ledger, config, mcp: { servers: () => ["ops-knowledge"], call: async () => ({ id: 77 }) }, discord: async () => [], sandbox: {}, now: () => NOW });
  return { ledger, job, broker, file: path.join(dir, "ledger.json") };
}
test("a blocking developer handoff cannot silently finish a finding before acceptance", async (t) => {
  const { job, broker } = fixture(t);
  await broker.tool(job, "raise_to_developers", { title: "Reviewed turn fix needs developer execution", detail: "The reviewed fix needs a developer to complete its merge and verify deployment; the finding has no authority to perform that step.", kind: "question", needsHuman: true, force: true });
  const result = await broker.tool(job, "finish", { closesWhen: "closes when the test case is settled", waitingOn: "the event this test waits for", state: "done", summary: "Filed the next step for developers; patch is not deployed." });
  assert.equal(result.state, "waiting");
  assert.equal(job.raisedToDevelopers[0].blocking, true);
});
const { createDeveloperWatch, ACK_MS, PROGRESS_MS, POLL_MS } = require("../lib/operator/developerwatch");
function watching(t, options = {}) {
  const f = fixture(t); let time = NOW; let reads = 0;
  f.job.state = "waiting";
  f.job.raisedToDevelopers = [{ id: 77, title: "Investigate", at: NOW, blocking: true }];
  let item = { id: 77, lane: "next", assigned_to: null, last_progress_at: null };
  let failure = false;
  const mcp = { call: async () => { reads++; if (failure) throw new Error("fixture read failed"); return item; } };
  const build = (ledger = f.ledger) => createDeveloperWatch({ ledger, mcp, now: () => time, ...options });
  return { ...f, build, setTime: (t) => { time = t; }, setItem: (x) => { item = { ...item, ...x }; }, fail: () => { failure = true; }, recover: () => { failure = false; }, reads: () => reads };
}
test("unaccepted handoff wakes once at deadline, including after a process restart", async (t) => {
  const f = watching(t); const watch = f.build();
  await watch.tick(); assert.equal(f.job.inbox, undefined);
  f.setTime(NOW + ACK_MS); await watch.tick();
  assert.equal(f.job.state, "queued"); assert.match(f.job.inbox[0].content, /not been accepted/);
  assert.equal(f.ledger.data.alerts.length, 1);
  f.job.state = "waiting"; f.job.inbox = []; f.ledger.save();
  const reloaded = createLedger(f.file);
  f.setTime(NOW + ACK_MS + POLL_MS); await f.build(reloaded).tick();
  assert.equal(reloaded.data.jobs[f.job.id].inbox.length, 0);
  assert.equal(reloaded.data.jobs[f.job.id].state, "waiting");
});
test("acceptance and completion are events; completion requires evidence and only requests verification", async (t) => {
  const f = watching(t); const watch = f.build();
  f.setItem({ lane: "now", assigned_to: "developer", last_progress_at: new Date(NOW).toISOString() });
  await watch.tick(); assert.match(f.job.inbox[0].content, /accepted by developer/);
  f.job.state = "waiting"; f.job.inbox = [];
  f.setTime(NOW + POLL_MS); f.setItem({ evidence_url: "https://example.com/verified", lane: "done" }); await watch.tick();
  assert.equal(f.job.raisedToDevelopers[0].releasedAt, NOW + POLL_MS);
  assert.match(f.job.inbox[0].content, /verify the actual outcome/); assert.equal(f.job.resolved, undefined);
});
test("a card closed without evidence releases the handoff and alerts once", async (t) => {
  const f = watching(t); const watch = f.build();
  f.setItem({ lane: "done", assigned_to: "developer" }); await watch.tick();
  assert.match(f.job.inbox[0].content, /closed without evidence/); assert.equal(f.job.raisedToDevelopers[0].releasedAt, NOW);
  assert.equal(f.job.state, "queued"); assert.equal(f.ledger.data.alerts.length, 1);
  f.job.state = "waiting"; f.job.inbox = [];
  for (let i = 1; i <= 3; i++) { f.setTime(NOW + i * POLL_MS); f.setItem({ progress_summary: `rewrite ${i}` }); await watch.tick(); }
  assert.equal(f.job.inbox.length, 0); assert.equal(f.job.state, "waiting"); assert.equal(f.ledger.data.alerts.length, 1);
});
test("claimed work has a separate no-progress deadline", async (t) => {
  const f = watching(t); const watch = f.build();
  f.setItem({ lane: "now", assigned_to: "developer", last_progress_at: NOW });
  await watch.tick(); f.job.state = "waiting"; f.job.inbox = [];
  f.setTime(NOW + ACK_MS); await watch.tick(); assert.equal(f.job.inbox.length, 0);
  f.setTime(NOW + PROGRESS_MS); await watch.tick(); assert.match(f.job.inbox[0].content, /no progress for two hours/);
  f.job.state = "waiting"; f.job.inbox = [];
  f.setTime(NOW + PROGRESS_MS + POLL_MS); f.setItem({ last_progress_at: NOW + PROGRESS_MS, progress_summary: "The patch now has verified test evidence" }); await watch.tick();
  assert.match(f.job.inbox[0].content, /new progress/);
});
test("read failures are bounded and a late verified completion still wakes work", async (t) => {
  const f = watching(t); const watch = f.build(); f.fail();
  for (let i = 0; i < 4; i++) { f.setTime(NOW + i * POLL_MS); await watch.tick(); }
  assert.equal(f.job.inbox.length, 1); assert.equal(f.ledger.data.alerts.length, 1);
  f.job.state = "waiting"; f.job.inbox = []; f.recover();
  f.setTime(NOW + 4 * POLL_MS); f.setItem({ lane: "done", evidence_url: "https://example.com/result" }); await watch.tick();
  assert.equal(f.job.state, "queued"); assert.match(f.job.inbox[0].content, /marked complete/);
});
test("paused, held, deferred, finished and uncertain-effect tasks are never restarted", async (t) => {
  for (const change of [f => { f.ledger.data.paused = true; }, f => { f.job.state = "deferred"; }, f => { f.job.state = "done"; }, f => { f.job.effects.write = { state: "started" }; }, f => { f.job.channelClosed = true; }]) {
    const f = watching(t); change(f); f.setTime(NOW + ACK_MS); await f.build().tick();
    assert.equal(f.reads(), 0); assert.equal(f.job.inbox, undefined);
  }
  const f = watching(t, { held: () => true }); f.setTime(NOW + ACK_MS); await f.build().tick(); assert.equal(f.reads(), 0);
});
test("polling is quiet between due reads", async (t) => {
  const f = watching(t); const watch = f.build();
  await watch.tick(); f.setTime(NOW + 1000); await watch.tick(); assert.equal(f.reads(), 1);
});
test("re-filing the same question preserves its original deadline", async (t) => {
  const f = fixture(t); f.job.raisedToDevelopers = [{ id: 77, title: "Same question", at: NOW - ACK_MS, blocking: true }];
  await f.broker.tool(f.job, "raise_to_developers", { title: "Same question", detail: "The same reviewed repair still requires developer execution and deployment verification.", kind: "question", force: true, appendTo: 77 });
  assert.equal(f.job.raisedToDevelopers.length, 1); assert.equal(f.job.raisedToDevelopers[0].at, NOW - ACK_MS);
});
test("a pending handoff never delays fresh unanswered player evidence", async (t) => {
  const f = fixture(t); f.job.kind = "ticket"; f.job.ticket = 9;
  f.job.raisedToDevelopers = [{ id: 77, at: NOW, blocking: true }];
  f.job.observedPlayerAt = NOW - 1000; f.job.lastPublishedAt = NOW - 2000;
  await f.broker.tool(f.job, "finish", { closesWhen: "closes when the test case is settled", waitingOn: "the event this test waits for", state: "waiting", waitFor: "developer_reply", summary: "waiting" });
  assert.equal(f.job.wakeAt, NOW + 60000);
});
test("legacy explicit developer waits are adopted without reclassifying all old issues", async (t) => {
  const f = watching(t); f.job.raisedToDevelopers[0].blocking = undefined;
  f.job.waitingFor = { kind: "developer_reply", since: NOW };
  await f.build().tick(); assert.equal(f.job.raisedToDevelopers[0].blocking, true); assert.equal(f.reads(), 1);
  const other = watching(t); other.job.raisedToDevelopers[0].blocking = undefined;
  await other.build().tick(); assert.equal(other.reads(), 0);
});
test("a queued decision is not withdrawn when a requested done becomes a waiting handoff", async (t) => {
  const f = fixture(t); f.job.raisedToDevelopers = [{ id: 77, at: NOW, blocking: true }];
  f.ledger.data.decisions = { fixture: { id: "fixture", jobId: f.job.id, state: "pending" } };
  await f.broker.tool(f.job, "finish", { closesWhen: "closes when the test case is settled", waitingOn: "the event this test waits for", state: "done", summary: "Handed off" });
  assert.equal(f.job.state, "waiting"); assert.equal(f.ledger.data.decisions.fixture.state, "pending");
});
test("a recovery can read its own handoff result but not unrelated queue items", async (t) => {
  const f = fixture(t); f.job.raisedToDevelopers = [{ id: 77, at: NOW, blocking: true }];
  assert.deepEqual(await f.broker.tool(f.job, "read_tool", { server: "ops-knowledge", tool: "kanban_get", args: { id: 77 } }), { id: 77 });
  for (const id of [78, "77", undefined]) await assert.rejects(f.broker.tool(f.job, "read_tool", { server: "ops-knowledge", tool: "kanban_get", args: { id } }), /confirmed developer handoffs/);
  f.job.role = "player";
  await assert.rejects(f.broker.tool(f.job, "read_tool", { server: "ops-knowledge", tool: "kanban_get", args: { id: 77 } }), /player conversation reads/);
});
test("repeating the same status with a fresh timestamp cannot hide a stalled handoff", async (t) => {
  const f = watching(t); const watch = f.build();
  f.setItem({ lane: "now", assigned_to: "developer", last_progress_at: NOW, progress_summary: "Checking the reviewed fix" });
  await watch.tick(); f.job.state = "waiting"; f.job.inbox = [];
  f.setTime(NOW + PROGRESS_MS);
  f.setItem({ last_progress_at: NOW + PROGRESS_MS, progress_summary: "Checking the reviewed fix" });
  await watch.tick();
  assert.equal(f.job.inbox.length, 1); assert.match(f.job.inbox[0].content, /no progress for two hours/);
});
test("cosmetic status rewrites do not run the model while a handoff is healthy", async (t) => {
  const f = watching(t); const watch = f.build();
  f.setItem({ lane: "now", assigned_to: "developer", last_progress_at: NOW, progress_summary: "Checking the fix" });
  await watch.tick(); f.job.state = "waiting"; f.job.inbox = [];
  f.setTime(NOW + POLL_MS);
  f.setItem({ last_progress_at: NOW + POLL_MS, progress_summary: "  CHECKING   the fix  " });
  await watch.tick(); assert.equal(f.job.inbox.length, 0); assert.equal(f.job.state, "waiting");
});

test("a question Keir files is its own work item: self-assigned, never chased, closed when the task ends", async (t) => {
  const f = fixture(t); let time = NOW; const calls = [];
  f.job.raisedToDevelopers = [{ id: 91, title: "Read the steel ledger row", at: NOW, blocking: true, selfOwned: true }];
  f.job.state = "waiting";
  const mcp = { call: async (server, tool, args) => { calls.push({ tool, args }); return { id: 91, lane: "now", assigned_to: "keir" }; } };
  const watch = createDeveloperWatch({ ledger: f.ledger, mcp, now: () => time });
  time = NOW + ACK_MS * 4; await watch.tick();
  assert.equal(f.job.inbox, undefined);
  assert.equal((f.ledger.data.alerts || []).length, 0);
  f.job.state = "done"; f.job.summary = "Read it myself and answered the player.";
  await watch.tick();
  assert.equal(calls.filter((c) => c.tool === "work_report").length, 1);
  assert.equal(calls.find((c) => c.tool === "work_report").args.event, "completed");
  assert.ok(f.job.raisedToDevelopers[0].releasedAt);
});
