"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createEngineering, engineeringGuard, engineeringSpec, SCOUT_INTERVAL } = require("../lib/operator/engineering");
function harness(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-engineering-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ledger.json");
  const ledger = createLedger(file);
  let time = 1000000;
  const now = () => time;
  return { ledger, file, now, advance: (ms) => { time += ms; }, engineering: createEngineering({ ledger, config, now }) };
}
const request = (key) => ({ key, title: "Repeated verified game fault", evidence: "Sensor observed the same error in two processed turns", kanbanId: 42 });

test("durable enqueue is idempotent across retries, restart and terminal keys", (t) => {
  const h = harness(t), job = h.engineering.enqueue(request("fault"));
  assert.equal(h.engineering.enqueue({ ...request("fault"), evidence: "different" }).id, job.id);
  assert.equal(job.engineeringEvidence, request("fault").evidence);
  assert.equal(job.engineeringKanbanId, 42);
  assert.equal(job.kind, "finding"); assert.equal(job.role, "support");
  assert.deepEqual(job.provider, { lane: "worker", runner: "codex", model: "gpt-6.1-sol", effort: "low", at: h.now() });
  job.state = "done"; h.ledger.save();
  const ledger = createLedger(h.file), restarted = createEngineering({ ledger, now: h.now });
  assert.equal(restarted.enqueue(request("fault")).state, "done");
  delete ledger.data.jobs[job.id]; ledger.save();
  assert.equal(restarted.enqueue(request("fault")), null);
  assert.equal(Object.keys(ledger.data.jobs).length, 0);
});

test("one active slot does not consume the separate bounded queued backlog", (t) => {
  const h = harness(t, { engineeringBacklog: 2 });
  const active = h.engineering.enqueue(request("active")); active.state = "running";
  assert.ok(h.engineering.enqueue(request("next")));
  assert.ok(h.engineering.enqueue(request("last")));
  assert.equal(h.engineering.enqueue(request("overflow")), null);
  assert.equal(h.engineering.status().capacity, 1);
  assert.equal(h.engineering.status().active, 1);
  assert.equal(h.engineering.status().queued, 2);
  assert.equal(active.state, "running");
});

test("adopts existing uncorrelated queued findings without duplicate jobs or ownership loss", (t) => {
  const h = harness(t), { ledger } = h;
  const job = ledger.createJob("finding:f", { kind: "finding", role: "support", finding: "f", actorId: "123456789012345678", issues: [123], raisedToDevelopers: [{ id: 42 }], source: { messageId: "source", content: "original verified evidence" } });
  const duplicate = ledger.createJob("finding:g", { kind: "finding", role: "support" });
  ledger.data.watch = { findings: { f: { fp: "f", state: "raised", jobId: job.id, title: "Confirmed fault", evidence: "two turns" }, g: { fp: "g", state: "raised", jobId: duplicate.id, correlatedWith: "f" } } };
  assert.deepEqual(h.engineering.tick().adopted, [job.id]);
  assert.equal(Object.keys(ledger.data.jobs).length, 2);
  assert.equal(job.operatorRole, "engineering"); assert.equal(duplicate.operatorRole, undefined);
  assert.equal(job.actorId, "123456789012345678"); assert.deepEqual(job.issues, [123]);
  assert.equal(job.source.messageId, "source"); assert.match(job.source.content, /original verified evidence/);
  assert.match(job.source.content, /read and verify/); assert.deepEqual(h.engineering.tick().adopted, []);
});

test("never takes over running, terminal, claimed, approval or uncertain findings", (t) => {
  const h = harness(t), d = h.ledger.data;
  const variants = [{ state: "running" }, { state: "done" }, { state: "waiting" }, { claimedBy: "staff" }, { effects: { write: { state: "started" } } }, { awaitingApproval: true }, { uncertain: true }, { channelId: "claimed" }, { id: "approved" }];
  d.channels.claimed = { claimedBy: "staff" };
  d.watch = { findings: {} };
  for (const [i, fields] of variants.entries()) {
    const j = h.ledger.createJob(`finding:${i}`, { kind: "finding", role: "support", ...fields });
    d.watch.findings[i] = { jobId: j.id, state: "raised" };
  }
  d.actions.approval = { jobId: "approved", state: "approved" };
  assert.deepEqual(h.engineering.tick().adopted, []);
});

test("engineering ancestry guard denies privileged writes and broad reads, permits draft publication", () => {
  const root = { id: "root", kind: "finding", operatorRole: "engineering" }, jobs = { root };
  for (const [name, input] of [["channel_reply", {}], ["request_heal", {}], ["execute_action", {}], ["support_action", {}], ["status_card", {}], ["github", { action: "merge" }], ["github", { action: "promote" }], ["github", { action: "close" }], ["raise_to_developers", { kind: "decision" }], ["finish", { needsOwner: true }], ["read_tool", { server: "gamestate", tool: "trace_account" }], ["read_tool", { server: "heal-ops", tool: "heal_apply" }]]) assert.throws(() => engineeringGuard(root, name, input, jobs), /Engineering/);
  for (const name of ["repository_snapshot", "shell", "delegate_fix", "review_fix", "publish_patch", "watch_turn", "checkpoint", "finish"]) assert.equal(engineeringGuard(root, name, {}, jobs), true);
  assert.equal(engineeringGuard(root, "github", { action: "status" }, jobs), true);
  assert.equal(engineeringGuard(root, "raise_to_developers", { kind: "bug" }, jobs), true);
  assert.equal(engineeringGuard(root, "read_tool", { server: "engine", tool: "engine_health" }, jobs), true);
  assert.equal(engineeringGuard({ id: "owner" }, "github", { action: "merge" }, jobs), true);
});

test("coding and investigation children inherit restrictions while retaining their narrower tool sets", () => {
  const root = { id: "root", operatorRole: "engineering" }, child = { id: "child", codingParent: "root" }, grandchild = { id: "grandchild", codingParent: "child", investigation: true }, jobs = { root, child, grandchild };
  assert.equal(engineeringGuard(child, "shell", {}, jobs), true);
  for (const name of ["publish_patch", "delegate_fix", "channel_reply", "watch_turn", "read_tool"]) assert.throws(() => engineeringGuard(child, name, {}, jobs));
  assert.equal(engineeringGuard(grandchild, "read_tool", { server: "engine", tool: "engine_health" }, jobs), true);
  assert.throws(() => engineeringGuard(grandchild, "read_tool", { server: "gamestate", tool: "trace_account" }, jobs));
  assert.throws(() => engineeringGuard(grandchild, "publish_patch", {}, jobs));
});

test("scout is opt-in, durable, bounded, lower priority and obeys the six-hour cadence and pause", (t) => {
  const h = harness(t, { engineeringScoutEnabled: true });
  h.ledger.data.paused = true; assert.equal(h.engineering.tick().skipped, true);
  h.ledger.data.paused = false;
  const first = h.engineering.tick().scout; assert.ok(first);
  const scout = h.ledger.data.jobs[first]; assert.equal(scout.engineeringPriority, 1);
  assert.match(scout.source.content, /read-only triage/);
  const saved = createLedger(h.file);
  assert.equal(saved.data.jobs[first].engineeringPriority, 1);
  assert.equal(saved.data.engineering.lastScoutAt, h.now());
  assert.equal(createEngineering({ ledger: saved, now: h.now, config: { engineeringScoutEnabled: true } }).tick().scout, null);
  const confirmed = h.engineering.enqueue(request("urgent")); assert.equal(confirmed.engineeringPriority, 0);
  h.advance(SCOUT_INTERVAL); assert.equal(h.engineering.tick().scout, null, "unresolved scout cannot accumulate");
  scout.state = "done";
  const second = h.engineering.tick().scout; assert.ok(second); assert.notEqual(first, second);
  h.ledger.data.jobs[second].state = "done";
  assert.equal(h.engineering.tick().scout, null);
  h.advance(SCOUT_INTERVAL - 1); assert.equal(h.engineering.tick().scout, null);
  h.advance(1); assert.ok(h.engineering.tick().scout);
  const off = harness(t); assert.equal(off.engineering.tick().scout, null);
});

test("provider config is parsed and status excludes actor identifiers and secret text", (t) => {
  assert.deepEqual(engineeringSpec({ engineeringProvider: "codex:gpt-6.1-sol@low" }), { runner: "codex", model: "gpt-6.1-sol", effort: "low" });
  assert.deepEqual(engineeringSpec({ engineeringProvider: "cursor:auto" }), { runner: "cursor", model: "auto", effort: "automatic" });
  assert.throws(() => engineeringSpec({ engineeringProvider: "bad" }));
  const h = harness(t), job = h.engineering.enqueue(request("safe"));
  job.actorId = "123456789012345678"; job.summary = "Actor 123456789012345678";
  const text = JSON.stringify(h.engineering.status());
  assert.doesNotMatch(text, /123456789012345678|actorId|source|evidence/);
});
