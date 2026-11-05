"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWatchkeeper, loadState, saveState, localUrl } = require("../lib/operator/watchkeeper");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchkeeper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = { now: 1800000000000, stateFile: path.join(dir, "state.json"), sent: [], calls: [], outage: false, deliveryFailure: false, failSensor: null, turn: 20, anomalies: [], lock: { isProcessing: false, paused: false, verdict: "idle", overdueMin: 0 } };
  f.snapshot = () => ({ heartbeat: f.now, scan: { lastSuccessAt: f.now, consecutiveFailures: 0 }, jobs: [], watch: {} });
  f.fetchImpl = async (url, opts) => {
    const body = opts.body && JSON.parse(opts.body); f.calls.push({ url, body, auth: opts.headers.Authorization });
    if (url.endsWith("/snapshot")) { if (f.outage) throw new Error("operator offline"); return response(f.snapshot()); }
    if (url.endsWith("/heartbeat")) { if (f.outage) return response({}, 503); f.heartbeat = body; return response({ ok: true, at: f.now }); }
    if (url.endsWith("/observations")) { if (f.deliveryFailure || f.outage) return response({}, 503); f.sent.push(body); return response({ ok: true }); }
    const tool = body.params.name;
    assert.equal(opts.headers.Authorization, "Bearer read-only");
    if (tool === f.failSensor) throw new Error("read failed");
    const data = tool === "game_overview" ? { turn: f.turn, paused: false } : tool === "turn_anomalies" ? { anomalies: f.anomalies } : f.lock;
    return response({ result: { content: [{ type: "text", text: JSON.stringify(data) }] } });
  };
  f.run = (extra = {}) => createWatchkeeper({ stateFile: f.stateFile, token: "scoped", readToken: "read-only", fetchImpl: f.fetchImpl, now: () => f.now, log: () => {}, auditFile: null, ...extra }).run();
  return f;
}
function response(data, status = 200) { return { ok: status === 200, status, text: async () => JSON.stringify(data) }; }
test("restart deduplicates active incidents and retries durable outbox", async t => {
  const f = fixture(t); f.deliveryFailure = true;
  f.snapshot = () => ({ heartbeat: f.now - 3600000, scan: { lastSuccessAt: f.now }, jobs: [] });
  let r = await f.run(); assert.equal(r.state.outbox.length, 1); assert.equal(r.delivered, 0);
  assert.equal(f.heartbeat.pendingObservations, 1);
  f.now += 60000; r = await f.run(); assert.equal(r.state.outbox.length, 1);
  f.deliveryFailure = false; r = await f.run(); assert.equal(r.delivered, 1);
  await f.run(); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].kind, "scan_stale");
  assert.equal(f.heartbeat.pendingObservations, 0); assert.equal(f.heartbeat.sensorFailures, 0);
});
test("operator outage does not prevent game observation and recovery follows original", async t => {
  const f = fixture(t); f.outage = true; f.lock = { isProcessing: true, paused: false, verdict: "stuck" };
  let r = await f.run(); assert.equal(r.state.outbox.length, 1);
  assert.equal(f.calls.filter(x => x.body?.method === "tools/call").length, 3);
  f.now += 60000; r = await f.run(); assert.equal(r.state.outbox.length, 2);
  assert.ok(r.state.incidents["game:stalled"].active);
  f.outage = false; f.lock = { isProcessing: false, paused: false, verdict: "idle" }; f.now += 60000;
  r = await f.run(); assert.equal(r.state.outbox.length, 0); assert.equal(f.sent.length, 4);
  const active = f.sent.find(x => x.kind === "operator_unavailable" && JSON.parse(x.evidence).status === "active");
  const recovery = f.sent.find(x => x.kind === "operator_unavailable" && JSON.parse(x.evidence).status === "recovered");
  assert.equal(JSON.parse(recovery.evidence).incidentKey, active.key);
  assert.equal(recovery.key, `${active.key}:recovery:1`);
});
test("holds, future wakes, terminal history and pending writes never become generic stalls", async t => {
  const f = fixture(t);
  const held = [{ state: "waiting", waitingFor: "player_reply" }, { ownerDecisionPending: true }, { staffHeld: true }, { uncertainEffect: true }, { wakeAt: f.now + 60000 }, { pendingApprovals: [{ id: "a", state: "pending", deliveryStatus: "delivered" }] }, { developerHandoffs: [{ state: "running" }] }, { state: "awaiting_player_reply" }, { state: "done" }];
  f.snapshot = () => ({ heartbeat: f.now, scan: { lastSuccessAt: f.now }, jobs: held.map((x, id) => ({ id: String(id), kind: "ticket", state: "running", at: f.now - 7200000, updatedAt: f.now - 7200000, ...x })) });
  await f.run(); assert.equal(f.sent.length, 0);
  f.snapshot = () => ({ heartbeat: f.now, scan: { lastSuccessAt: f.now }, jobs: [{ id: "stuck", kind: "ticket", state: "waiting", at: f.now - 7200000, updatedAt: f.now - 7200000 }, { id: "held", state: "running", staffHeld: true, pendingApprovals: [{ id: "bad", state: "pending", deliveryStatus: "failed" }] }] });
  await f.run(); assert.deepEqual(f.sent.map(x => x.kind).sort(), ["approval_delivery_failed", "ticket_stalled"]);
});
test("failed game read is isolated; successful reads still detect failures", async t => {
  const f = fixture(t); f.failSensor = "game_overview";
  f.anomalies = [{ turn: 20, kind: "turn-failed" }];
  let r = await f.run(); assert.equal(r.healthy, false);
  assert.deepEqual(f.sent.map(x => x.kind), ["game_turn_failed"]);
  f.now += 60000; r = await f.run();
  assert.deepEqual(f.sent.map(x => x.kind).sort(), ["game_turn_failed", "sensor_stale"]);
  assert.equal(r.state.sensors.lock.succeededAt, f.now);
});
test("newer successful turns retire game failures without resurrecting closed history", async t => {
  const f = fixture(t); f.anomalies = [{ turn: 20, kind: "phase-failed", phase: "economy" }];
  await f.run(); f.turn = 21; f.now += 60000; await f.run(); await f.run();
  assert.equal(f.sent.length, 2); assert.equal(JSON.parse(f.sent[1].evidence).status, "recovered");
  f.failSensor = "game_overview"; await f.run();
  assert.equal(f.sent.filter(x => x.kind === "game_turn_failed").length, 2);
});
test("recurrence creates a new episode and failed delivery remains durable", async t => {
  const f = fixture(t); f.lock.verdict = "stuck"; await f.run();
  f.lock.verdict = "idle"; f.now += 60000; await f.run();
  f.lock.verdict = "stuck"; f.now += 60000; await f.run();
  assert.deepEqual(f.sent.map(x => x.key), ["game:stalled:1", "game:stalled:1:recovery:1", "game:stalled:2"]);
});
test("atomic state is private, reloadable, and corrupt state is not overwritten", async t => {
  const f = fixture(t); await f.run();
  assert.equal(fs.statSync(f.stateFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile)), ["state.json"]);
  const old = loadState(f.stateFile); saveState(f.stateFile, { ...old, marker: true }); assert.equal(loadState(f.stateFile).marker, true);
  fs.writeFileSync(f.stateFile, "corrupt"); await assert.rejects(f.run(), /JSON/); assert.equal(fs.readFileSync(f.stateFile, "utf8"), "corrupt");
});
test("only fixed localhost destinations and known read tools are reachable", async t => {
  const f = fixture(t);
  for (const value of ["https://example.com", "http://127.0.0.1.evil.test", "http://user:pass@localhost", "http://localhost/?x=1", "file:///etc/passwd"]) assert.throws(() => localUrl(value));
  await f.run(); assert.deepEqual(f.calls.filter(x => x.body?.method).map(x => x.body.params.name).sort(), ["game_overview", "lock_status", "turn_anomalies"]);
  assert.throws(() => createWatchkeeper({ token: "token" }), /read-only/);
});
test("unresponsive transport cannot outlive run budget", async t => {
  const f = fixture(t); const keepAlive = setInterval(() => {}, 100); t.after(() => clearInterval(keepAlive));
  const start = Date.now();
  const hung = { fetchImpl: () => new Promise(() => {}), runTimeoutMs: 35, requestTimeoutMs: 100 };
  let result = await f.run(hung);
  assert.ok(Date.now() - start < 500); assert.equal(result.healthy, false); assert.equal(result.state.outbox.length, 0);
  result = await f.run(hung);
  assert.ok(Date.now() - start < 1000); assert.equal(result.state.outbox.length, 4);
});

test("meaningful progress survives restart and repeated activations cannot reset its clock", async t => {
  const f = fixture(t); const initial = f.now;
  const job = { id: "ticket", kind: "ticket", state: "queued", at: initial, progressFingerprint: "same evidence" };
  f.snapshot = () => ({ heartbeat: f.now, scan: { lastSuccessAt: f.now }, jobs: [job] });
  await f.run();
  f.now += 20 * 60000; job.state = "running"; job.updatedAt = f.now; job.startedAt = f.now;
  let result = await f.run(); assert.equal(f.sent.length, 0); assert.equal(result.state.jobProgress.ticket.meaningfulAt, initial);
  f.now += 11 * 60000; job.state = "waiting"; job.updatedAt = f.now; job.startedAt = f.now;
  result = await f.run(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].kind, "ticket_stalled");
  assert.equal(result.state.jobProgress.ticket.meaningfulAt, initial);
  job.progressFingerprint = "new verified receipt"; f.now += 60000;
  result = await f.run(); assert.equal(result.state.jobProgress.ticket.meaningfulAt, f.now);
  assert.equal(JSON.parse(f.sent[1].evidence).status, "recovered");
  f.now += 20 * 60000; job.updatedAt = f.now; await f.run(); assert.equal(f.sent.length, 2);
});
test("role audits and unticketed engineering jobs cannot report their own ticket stalls", async t => {
  const f = fixture(t);
  f.snapshot = () => ({ heartbeat: f.now, scan: { lastSuccessAt: f.now }, jobs: [
    { id: "watch", kind: "probe", operatorRole: "watchkeeper", state: "running", at: f.now - 7200000 },
    { id: "engineering", kind: "kanban", operatorRole: "engineering", state: "blocked", at: f.now - 7200000 },
  ] });
  const result = await f.run(); assert.equal(f.sent.length, 0); assert.deepEqual(result.state.jobProgress, {});
});
test("a single failed read that recovers next run raises nothing", async t => {
  const f = fixture(t); f.failSensor = "lock_status";
  await f.run(); assert.equal(f.sent.length, 0);
  f.failSensor = null; f.now += 60000; const r = await f.run();
  assert.equal(f.sent.length, 0); assert.equal(r.state.sensors.lock.failures, undefined);
});

test("a conversation audit that stops running is reported, then recovers", async t => {
  const f = fixture(t); let auditAt = f.now - 3 * 3600000;
  const extra = { auditFile: "audit.json", readFile: () => JSON.stringify({ at: auditAt }) };
  await f.run(extra);
  assert.ok(f.sent.some(o => o.kind === "sensor_stale" && /conversation audit/.test(o.summary || o.title || JSON.stringify(o))));
  auditAt = f.now; f.now += 60000; const sent = f.sent.length;
  await f.run(extra);
  assert.ok(f.sent.length >= sent);
});
