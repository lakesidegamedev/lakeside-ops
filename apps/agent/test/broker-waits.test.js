"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const NOW = 1000000, MINUTE = 60000;
function fixture(t, fields = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-waits-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "owner", staffIds: [], stateDir: dir, repositories: {} };
  const job = ledger.createJob("ticket:1545", { kind: "ticket", role: "support", ticket: 1545, channelId: "channel", source: {}, deadline: NOW + 86400000, ...fields });
  job.state = "running";
  const broker = createBroker({ ledger, config, mcp: { servers: () => [] }, discord: async () => { throw new Error("unexpected external call"); }, sandbox: {}, now: () => NOW });
  return { ledger, job, finish: (input) => broker.tool(job, "finish", { state: "waiting", summary: "Waiting for evidence", ...input }) };
}
test("broker honors explicitly requested six-hour support wait instead of clamping to fifteen minutes", async (t) => {
  const f = fixture(t); await f.finish({ wakeAfterMinutes: 360 });
  assert.equal(f.job.wakeAt, NOW + 360 * MINUTE);
});
test("ordinary wait defaults and bounds remain finite", async (t) => {
  for (const [requested, expected] of [[undefined, 15], [0, 1], [-1, 1], [Infinity, 15], [NaN, 15], [2000, 1440]]) {
    const f = fixture(t); await f.finish({ wakeAfterMinutes: requested }); assert.equal(f.job.wakeAt, NOW + expected * MINUTE);
  }
});
test("reply wait records bounded event metadata and durable audit receipt", async (t) => {
  for (const waitFor of ["player_reply", "developer_reply"]) {
    const f = fixture(t); await f.finish({ waitFor, wakeAfterMinutes: 1440 });
    assert.deepEqual(f.job.waitingFor, { kind: waitFor, since: NOW, deadline: NOW + 360 * MINUTE });
    assert.equal(f.job.wakeAt, f.job.waitingFor.deadline);
    assert.ok(f.ledger.data.audit.some((a) => a.kind === "reply_wait" && a.job === f.job.id && a.waitFor === waitFor));
  }
});
test("reply wait defaults to six hours but unread evidence and inbox prevent sleeping", async (t) => {
  const f = fixture(t); await f.finish({ waitFor: "player_reply" }); assert.equal(f.job.wakeAt, NOW + 360 * MINUTE);
  const unread = fixture(t, { observedPlayerAt: NOW - 1000, lastPublishedAt: NOW - 2000 });
  await unread.finish({ waitFor: "player_reply" }); assert.equal(unread.job.wakeAt, NOW + MINUTE); assert.equal(unread.job.waitingFor, undefined);
  const inbox = fixture(t, { inbox: [{ content: "new evidence" }] }); await inbox.finish({ waitFor: "developer_reply" });
  assert.equal(inbox.job.state, "queued"); assert.equal(inbox.job.waitingFor, undefined);
});
test("CI and turn subscriptions keep their safety timers and no reply label", async (t) => {
  for (const [fields, minutes] of [[{ ciWatch: { fix: {} } }, 180], [{ turnWatch: {} }, 480]]) {
    const f = fixture(t, fields); await f.finish({ waitFor: "player_reply" });
    assert.equal(f.job.wakeAt, NOW + minutes * MINUTE); assert.equal(f.job.waitingFor, undefined);
  }
});
test("pending owner decision remains pending rather than becoming a reply wait", async (t) => {
  const f = fixture(t); f.ledger.data.decisions = { choice: { jobId: f.job.id, state: "pending" } };
  await f.finish({ waitFor: "player_reply" }); assert.equal(f.job.wakeAt, NOW + 360 * MINUTE);
  assert.equal(f.job.waitingFor, undefined); assert.equal(f.ledger.data.decisions.choice.state, "pending");
});
test("fresh player reply replaces six-hour timer through the actual gateway", async (t) => {
  const f = fixture(t); await f.finish({ waitFor: "player_reply" });
  const { createGateway } = require("../lib/operator/gateway");
  const gateway = createGateway({ ledger: f.ledger, config: { ownerId: "111111111111111111", staffIds: [], botId: "333333333333333333", watched: () => true, taskLifetimeMs: 86400000 }, now: () => NOW });
  gateway.ingest({ id: "channel", name: "ticket-bug-fixture-1545", type: 0 }, { id: "666666666666666666", author: { id: "888888888888888888", username: "fixture", bot: false }, content: "Here is the requested evidence", timestamp: new Date(NOW).toISOString(), mentions: [], attachments: [] });
  assert.equal(f.job.inbox.length, 1);
  assert.equal(f.job.waitingFor, undefined);
  assert.equal(f.job.wakeAt, NOW + 45000, "normal burst debounce replaces six-hour deadline");
});
test("reply waits never extend pending approvals or promotion windows", async (t) => {
  const approval = fixture(t); approval.ledger.data.actions.a = { jobId: approval.job.id, state: "pending" };
  await approval.finish({ waitFor: "developer_reply" }); assert.equal(approval.job.wakeAt, NOW + 15 * MINUTE); assert.equal(approval.job.waitingFor, undefined);
  const promotion = fixture(t, { promotionHoldUntil: NOW + 60 * MINUTE }); await promotion.finish({ waitFor: "developer_reply" });
  assert.equal(promotion.job.wakeAt, NOW + 60 * MINUTE); assert.equal(promotion.job.waitingFor, undefined);
});

test("explicit long ordinary waits cannot bury unanswered evidence", async (t) => {
  const f = fixture(t, { observedPlayerAt: NOW - 1000, lastPublishedAt: NOW - 2000 });
  await f.finish({ wakeAfterMinutes: 360 }); assert.equal(f.job.wakeAt, NOW + MINUTE);
});

test("watcher findings keep their requested turn wait even with a polluted player clock", async (t) => {
  const f = fixture(t, { kind: "finding", ticket: null, channelId: null, source: { content: "Turn 322 failed", at: new Date(NOW - 1000).toISOString() }, observedPlayerAt: NOW - 1000 });
  await f.finish({ wakeAfterMinutes: 35 });
  assert.equal(f.job.state, "waiting");
  assert.equal(f.job.wakeAt, NOW + 35 * MINUTE);
});

test("activation clears a prior reply gate before durably entering running state", async (t) => {
  const f = fixture(t); await f.finish({ waitFor: "player_reply" });
  const { createAgent } = require("../lib/operator/agent");
  const agent = createAgent({ ledger: f.ledger, broker: {}, config: { stateDir: os.tmpdir(), briefFile: path.join(__dirname, "../KEIR.md"), maxRounds: 2 } });
  const stop = new Error("stop before model launch");
  f.ledger.save = () => { assert.equal(f.job.state, "running"); assert.equal(f.job.waitingFor, undefined); throw stop; };
  await assert.rejects(agent.run(f.job, new AbortController().signal), (e) => e === stop);
});

test("a wait with nothing subscribed backs off, and a player message resets it", async (t) => {
  // Tickets 1651 and 1663 re-read the same deployment every fifteen minutes
  // for hours on 2026-10-23. The first look is normal; the rest are slower.
  const f = fixture(t);
  const waits = [];
  for (let i = 0; i < 4; i++) { f.job.state = "running"; await f.finish({}); waits.push(Math.round((f.job.wakeAt - NOW) / MINUTE)); }
  assert.deepEqual(waits, [15, 30, 60, 120]);
  // A player message is new input: the ladder starts again.
  f.job.state = "running"; f.job.lastPlayerAt = NOW + 5000;
  await f.finish({});
  assert.equal(Math.round((f.job.wakeAt - NOW) / MINUTE), 15);
});

test("a reply hand-back fires once per player message, not on every wait", async (t) => {
  // Ticket 1643 re-ran every 89 seconds for hours because this fired forever.
  const f = fixture(t, { lastPlayerAt: NOW - 1000, lastPublishedAt: NOW - 2000 });
  await f.finish({ wakeAfterMinutes: 30 });
  assert.equal(f.job.wakeAt, NOW + MINUTE, "first wait hands back to the driver");
  f.job.state = "running";
  await f.finish({ wakeAfterMinutes: 30 });
  assert.equal(f.job.wakeAt, NOW + 30 * MINUTE, "same message does not hand back again");
  f.job.state = "running"; f.job.lastPlayerAt = NOW + 5000;
  await f.finish({ wakeAfterMinutes: 30 });
  assert.equal(f.job.wakeAt, NOW + MINUTE, "a new player message earns its own hand-back");
});

test("real progress resets the quiet ladder instead of escalating on it", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) { f.job.state = "running"; await f.finish({}); }
  assert.equal(Math.round((f.job.wakeAt - NOW) / MINUTE), 30);
  f.job.state = "running"; f.job.lastPublishedAt = NOW - 1;
  await f.finish({});
  assert.equal(Math.round((f.job.wakeAt - NOW) / MINUTE), 15);
});
