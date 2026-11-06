"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createEngineering } = require("../lib/operator/engineering");
const { createRoles, scopedToken, roleGuard } = require("../lib/operator/roles");
const { createBroker } = require("../lib/operator/broker");
const { emptyLanes, pickForLanes, laneTimeoutMs } = require("../lib/operator/lanes");
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-roles-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json")); let clock = 10000000;
  const engineering = createEngineering({ ledger, now: () => clock });
  const roles = createRoles({ ledger, engineering, now: () => clock, held: (j) => j.state === "deferred" });
  return { ledger, engineering, roles, dir, advance: (ms) => { clock += ms; } };
}
const observation = (key, fields = {}) => ({ key, kind: "scan_stale", title: "Intake scan missed its deadline", evidence: "Read-only failed scan receipt", ...fields });
test("separate observer token is required and length-safe", () => {
  const key = "a".repeat(48);
  assert.equal(scopedToken({ headers: { authorization: `Bearer ${key}` } }, key), true);
  for (const v of ["", "bad", "Bearer wrong"]) assert.equal(scopedToken({ headers: { authorization: v } }, key), false);
  assert.equal(scopedToken({ headers: {} }, ""), false);
});
test("observation retry and process reload create one read-only audit, recovery does not spawn another", (t) => {
  const h = setup(t), first = h.roles.observe(observation("scan:1"));
  assert.ok(first.observation.auditJob);
  const again = createRoles({ ledger: h.ledger, engineering: h.engineering }).observe(observation("scan:1"));
  assert.equal(again.duplicate, true); assert.equal(Object.keys(h.ledger.data.jobs).length, 1);
  h.roles.observe(observation("scan:1:recovery:1", { evidence: JSON.stringify({ status: "recovered", incidentKey: "scan:1" }) }));
  assert.ok(h.ledger.data.operatorRoles.observations["scan:1"].recoveredAt); assert.equal(Object.keys(h.ledger.data.jobs).length, 1);
  assert.equal(Object.keys(h.ledger.data.actions).length, 0);
});
test("recovery wake preserves decision, staff, player reply, future wake and uncertain-effect holds", (t) => {
  const h = setup(t);
  for (const [name, fields] of Object.entries({ staff: { state: "deferred" }, player: { waitingFor: { kind: "player_reply" } }, future: { wakeAt: 9e12 }, decision: { ownerDecisionPending: true }, uncertain: { effects: { x: { state: "started" } } }, receipt: {} })) {
    const j = h.ledger.createJob(name, { kind: "ticket", role: "support", state: "blocked", effects: {}, ...fields });
    if (name === "receipt") h.ledger.data.decisions = { pending: { id: "pending", jobId: j.id, state: "pending", at: 1 } };
    h.roles.observe(observation(name, { kind: "ticket_stalled", jobId: j.id })); assert.equal(j.inbox, undefined, name);
  }
  const j = h.ledger.createJob("eligible", { kind: "ticket", state: "blocked", role: "support", effects: {} });
  h.roles.observe(observation("eligible", { kind: "ticket_stalled", jobId: j.id })); assert.equal(j.state, "queued"); assert.equal(j.inbox.length, 1);
});
test("pending decision delivery uses actual outbox and sent receipts without exposing question or tokens", (t) => {
  const h = setup(t), j = h.ledger.createJob("ticket", { kind: "ticket", state: "blocked" });
  h.ledger.data.decisions = { x: { id: "x", jobId: j.id, state: "pending", at: 1, question: "private question" } };
  assert.equal(h.roles.snapshot().jobs[0].pendingApprovals[0].deliveryStatus, "undelivered");
  h.ledger.data.outbox = { decision: { decision: "x", error: "private credential", attempts: 3 } };
  assert.equal(h.roles.snapshot().jobs[0].pendingApprovals[0].deliveryStatus, "failed");
  h.ledger.data.decisions.x.sent = { owner: { messageId: "actual-receipt" } };
  assert.equal(h.roles.snapshot().jobs[0].pendingApprovals[0].deliveryStatus, "delivered");
  assert.doesNotMatch(JSON.stringify(h.roles.snapshot()), /private question|private credential|actual-receipt/);
});
test("observer model cannot bypass broker policy through another tool session or inherit broad reads", async (t) => {
  const h = setup(t), writes = [];
  const config = { stateDir: h.dir, repositories: {}, staffIds: [], supportDeferred: () => false, roleSnapshot: () => h.roles.snapshot() };
  const broker = createBroker({ ledger: h.ledger, config, mcp: { servers: () => [], list: async () => [], call: async (...args) => { writes.push(args); return { turn: 201 }; } }, discord: async () => { throw new Error("unexpected Discord"); }, sandbox: {} });
  const j = h.ledger.createJob("audit", { kind: "probe", state: "running", role: "support", operatorRole: "watchkeeper", deadline: 9e15 });
  for (const [name, input] of [["support_action", { tool: "support_resolve" }], ["github", { action: "merge" }], ["request_heal", {}], ["read_tool", { server: "heal-ops", tool: "heal_apply" }], ["shell", { command: "whoami" }], ["raise_to_developers", { kind: "decision" }]]) await assert.rejects(broker.tool(j, name, input), /Watchkeeper/);
  const result = await broker.tool(j, "read_tool", { server: "gamestate", tool: "game_overview", args: {} }); assert.equal(result.turn, 201); assert.equal(writes.length, 1); assert.equal(writes[0][3], false);
  await broker.tool(j, "operator_roles", {});
  assert.equal(Object.keys(h.ledger.data.actions).length, 0);
});
test("engineering and audit get separate single slots under unchanged total capacity and support reservation", () => {
  const jobs = [
    { id: "support", kind: "conversation", state: "queued", role: "player", at: 1 },
    { id: "watch", kind: "probe", state: "queued", operatorRole: "watchkeeper", at: 2 },
    { id: "scout", kind: "finding", state: "queued", operatorRole: "engineering", engineeringPriority: 1, at: 1 },
    { id: "fix", kind: "finding", state: "queued", operatorRole: "engineering", engineeringPriority: 0, at: 2 },
  ];
  const picks = pickForLanes(jobs, emptyLanes(), { now: 100 });
  assert.deepEqual(picks.map((p) => [p.lane, p.job.id]), [["conversation", "support"], ["watchkeeper", "watch"], ["engineering", "fix"]]);
  const busy = emptyLanes(); busy.engineering = { job: { ...jobs[3], state: "running" } };
  assert.equal(pickForLanes(jobs, busy, { now: 100 }).some((p) => p.lane === "engineering"), false);
  assert.equal(laneTimeoutMs("watchkeeper", 9e8), 90000); assert.equal(laneTimeoutMs("engineering", 9e8), 300000);
  assert.throws(() => roleGuard({ role: "support" }, "operator_roles"), /unavailable/);
  const parent = { id: "eng", operatorRole: "engineering" }, child = { id: "child", kind: "coding", codingParent: "eng" };
  assert.throws(() => roleGuard(child, "operator_roles", {}, { eng: parent, child }), /Engineering/);
});
test("explicit read-only baseline verification creates no incident or approval and is durable", (t) => {
  const h = setup(t);
  const roles = createRoles({ ledger: h.ledger, engineering: h.engineering, config: { rolesEnabled: true }, now: () => 10000000 });
  const first = roles.verify(), again = roles.verify(); assert.equal(first.task, again.task);
  const j = h.ledger.data.jobs[first.task]; assert.equal(j.operatorRole, "watchkeeper"); assert.match(j.source.content, /not an incident/);
  assert.deepEqual(h.ledger.data.actions, {}); assert.equal(Object.keys(h.ledger.data.operatorRoles?.observations || {}).length, 0);
  h.ledger.data.paused = true; assert.throws(() => roles.verify(), /unpaused/);
});

test("role audits use the configured qualified route for verification and incidents", (t) => {
  const h = setup(t);
  for (const spec of ["codex:gpt-6.1-sol@low", "claude:claude-opus-5-5@medium"]) {
    h.advance(6 * 3600000);
    const roles = createRoles({ ledger: h.ledger, engineering: h.engineering, now: () => 1e8 + (spec.startsWith("codex") ? 0 : 6 * 3600000), config: { rolesEnabled: true, watchkeeperProvider: spec } });
    const receipt = roles.verify(), j = h.ledger.data.jobs[receipt.task];
    assert.equal(`${j.provider.runner}:${j.provider.model}@${j.provider.effort}`, spec);
    j.state = "done";
    const audit = roles.observe(observation(`route:${spec.split(":")[0]}`));
    const spawned = h.ledger.data.jobs[audit.observation.auditJob];
    assert.equal(`${spawned.provider.runner}:${spawned.provider.model}@${spawned.provider.effort}`, spec);
    spawned.state = "done";
  }
});
test("a failed turn opens one urgent engineering task per turn, even with a full backlog (turn 697)", (t) => {
  const h = setup(t);
  for (let i = 0; i < 12; i++) h.engineering.enqueue({ key: `filler:${i}`, title: "Filler finding", evidence: "x" });
  const fail = (key) => h.roles.observe({ key, kind: "game_turn_failed", title: "Game turn 697 corporationTurn failed", evidence: JSON.stringify({ anomaly: { turn: 697, phase: "corporationTurn", kind: "turn-failed" } }) });
  const first = fail("game:failure:697:corporationTurn:1");
  const task = h.ledger.data.jobs[first.observation.engineeringTask];
  assert.ok(task, "engineering task opened");
  assert.equal(task.operatorRole, "engineering"); assert.equal(task.engineeringPriority, -1);
  assert.match(task.source.content, /turn_failure_detail for turn 697/);
  fail("game:failure:697:turn:1");
  assert.equal(Object.values(h.ledger.data.jobs).filter((j) => j.engineeringKey === "engineering:turn-failure:697").length, 1);
  const dm = JSON.stringify(h.ledger.data.alerts || {}).includes("engineering lane is on it");
  assert.ok(dm, "the owner hears that Keir is on it");
});
