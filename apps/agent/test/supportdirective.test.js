"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { createAppChannel } = require("../lib/operator/appchannel");
// Persisted receipts and new guidance never convey external action consent.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-directive-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "owner", staffIds: [], stateDir: dir, repositories: {}, taskLifetimeMs: 86400000, supportDeferred: () => false };
  const app = createAppChannel({ ledger, config });
  const source = ledger.data.jobs[app.authenticatedPost("Inspect the saved support handoff", undefined, "main", { mode: "new" }).jobId]; source.state = "running";
  const job = ledger.createJob("ticket:1564", { kind: "ticket", role: "support", ticket: 1564, channelId: "channel", source: {}, deadline: Date.now() + 86400000 }); job.state = "waiting";
  const row = { directiveId: "saved-directive", sourceTaskId: source.id, sourceMessageId: source.source.messageId, content: "Historical exact owner context", at: new Date().toISOString() };
  job.inbox = [row];
  const receipt = { id: row.directiveId, sourceTaskId: source.id, sourceMessageId: row.sourceMessageId, ticket: 1564, coordinatorTaskId: job.id, outcome: "held", remainingBlockers: ["staff-owned"] };
  ledger.data.channels.channel = { claimedBy: "staff", category: "mechanics" };
  ledger.data.supportDirectives = { [receipt.id]: receipt };
  source.effects[`support-directive:${receipt.id}`] = { state: "done", result: receipt };
  let calls = 0;
  const broker = createBroker({ ledger, config, mcp: { servers: () => [], call: async () => { calls++; throw new Error("No external call expected"); } }, discord: async () => { calls++; }, sandbox: {} });
  return { ledger, config, app, source, job, receipt, broker, calls: () => calls };
}

test("forged source or approval references refuse before adoption, wake or record mutation", async t => {
  const f = fixture(t), before = structuredClone(f.receipt);
  await assert.rejects(f.broker.tool(f.source, "support_directive", { ticket: 1564, sourceMessageId: "forged" }), /source message/);
  await assert.rejects(f.broker.tool(f.source, "support_directive", { ticket: 1564, approvals: [{kind:"action",id:"not-consent",digest:"forged"}] }), /approval reference/);
  assert.equal(f.job.state, "waiting"); assert.equal(f.job.inbox.length, 1); assert.equal(f.calls(), 0);
  assert.deepEqual(f.receipt, before); assert.equal(f.ledger.data.ticketRecords, undefined);
});

test("legacy unproven origins are not backfilled by source role or saved message", async t => {
  const f = fixture(t); delete f.ledger.data.ownerMuseOrigins[f.source.id];
  await assert.rejects(f.broker.tool(f.source, "support_directive", { ticket: 1564 }), /Start a new authenticated app task/);
  assert.equal(f.calls(), 0); assert.equal(f.job.state, "waiting");
  assert.equal(f.ledger.data.ownerMuseOrigins[f.source.id], undefined);
});

test("saved receipts remain readable and consumption does not copy consent or lift pending approval", async t => {
  const f = fixture(t); f.job.state = "running";
  f.ledger.data.actions.a = { id: "a", jobId: f.job.id, state: "pending", digest: "exact-existing" };
  const before = JSON.stringify(f.ledger.data.actions);
  const rows = await f.broker.tool(f.job, "support_updates", {});
  assert.equal(rows[0].directiveId, f.receipt.id); assert.ok(f.receipt.incorporatedAt);
  assert.equal(JSON.stringify(f.ledger.data.actions), before);
  assert.equal(f.broker.supportDirectiveHeld(f.job), true);
  await assert.rejects(f.broker.tool(f.job, "calculate", { expression: "1+1" }), /held/);
  delete f.ledger.data.channels.channel.claimedBy;
  f.ledger.data.actions.a.state = "approved";
  f.broker.supportDirectiveTick(); assert.equal(f.receipt.outcome, "pending");
  assert.equal((await f.broker.tool(f.job, "calculate", { expression: "1+1" })).value, 2);
  assert.equal(f.calls(), 0);
});

for (const mode of ["staff", "paused", "category", "action", "uncertain"]) test(`saved held receipt retains ${mode} fence`, t => {
  const f = fixture(t); delete f.ledger.data.channels.channel.claimedBy;
  if (mode === "staff") f.ledger.data.channels.channel.claimedBy = "staff";
  if (mode === "paused") f.ledger.data.paused = true;
  if (mode === "category") f.ledger.data.channels.channel.category = "moderation";
  if (mode === "action") f.ledger.data.actions.a = { jobId: f.job.id, state: "pending" };
  if (mode === "uncertain") f.job.effects.write = { state: "started" };
  f.broker.supportDirectiveTick();
  assert.equal(f.job.state, "waiting"); assert.equal(f.receipt.outcome, "held"); assert.ok(f.receipt.remainingBlockers.length);
});

// 2026-10-19: an owner "close it" sat held for 2.5 hours on 1615 and 1622
// behind Keir's own closure grace and player wait.
for (const mode of ["player-wait", "closure-grace"]) test(`a held directive is released through Keir's own ${mode}`, t => {
  const f = fixture(t); delete f.ledger.data.channels.channel.claimedBy;
  if (mode === "player-wait") f.job.waitingFor = { kind: "player_reply" };
  if (mode === "closure-grace") f.job.resolutionReadyAt = 1;
  f.broker.supportDirectiveTick();
  assert.equal(f.job.state, "queued"); assert.equal(f.receipt.outcome, "woken"); assert.equal(f.job.waitingFor, undefined);
});

test("saved held directive wakes once after an existing hold clears and keeps exact approvals", t => {
  const f = fixture(t);
  f.ledger.data.actions.a = { id: "a", jobId: f.job.id, state: "approved", digest: "unchanged", approvedBy: "owner" };
  const before = JSON.stringify(f.ledger.data.actions);
  f.broker.supportDirectiveTick(); assert.equal(f.job.state, "waiting");
  delete f.ledger.data.channels.channel.claimedBy;
  f.broker.supportDirectiveTick(); f.broker.supportDirectiveTick();
  assert.equal(f.job.state, "queued"); assert.equal(f.receipt.outcome, "woken"); assert.equal(f.job.inbox.length, 1);
  assert.equal(JSON.stringify(f.ledger.data.actions), before);
});

test("source receipt mirror stays synchronized with canonical incorporation after restart", async t => {
  const f = fixture(t); f.ledger.save();
  const ledger = createLedger(path.join(f.config.stateDir, "ledger.json"));
  const broker = createBroker({ ledger, config: f.config, mcp: { servers: () => [] }, discord: async () => {}, sandbox: {} });
  const job = ledger.data.jobs[f.job.id]; job.state = "running";
  await broker.tool(job, "support_updates", {});
  const canonical = ledger.data.supportDirectives[f.receipt.id];
  const mirrored = ledger.data.jobs[f.source.id].effects[`support-directive:${f.receipt.id}`].result;
  assert.ok(canonical.incorporatedAt); assert.equal(mirrored.incorporatedAt, canonical.incorporatedAt);
  broker.supportDirectiveTick(); assert.equal(job.inbox.length, 0);
});

test("a moderation coordinator hold gives the owner a private read-only investigation path", async t => {
  const f = fixture(t); Object.assign(f.config, { botId: "999", guildId: "guild", staffIds: ["123"] });
  f.ledger.data.channels.channel = { category: "moderation", claimedBy: "123" };
  const before = JSON.stringify(f.ledger.data.actions);
  const mcp = { servers: () => ["gamestate", "support"], call: async (server, tool, args, write) => {
    assert.equal(write, false);
    if (server === "support" && tool === "support_get") return { number: 1564, category: "moderation", status: "open", conversation: { channelId: "channel" } };
    assert.equal(server, "gamestate"); assert.equal(tool, "trace_corp"); return { corporation: "fixture", evidence: "read-only ledger result" };
  } };
  const discord = async (method, url) => { assert.equal(method, "GET"); return url.includes("/messages") ? [{ author: { id: "999", bot: true }, content: "<@123> has claimed this ticket", timestamp: new Date().toISOString() }] : { id: "channel", guild_id: "guild", name: "ticket-1564" }; };
  const broker = createBroker({ ledger: f.ledger, config: f.config, mcp, discord, sandbox: {} });
  const receipt = await broker.tool(f.source, "support_directive", { ticket: 1564, sourceMessageId: f.source.source.messageId });
  assert.equal(receipt.outcome, "held"); assert.deepEqual(receipt.remainingBlockers.sort(), ["staff-category", "staff-owned"]);
  assert.equal(receipt.ownerInvestigation?.taskId, f.source.id);
  assert.equal(receipt.ownerInvestigation?.replyChannel, "app");
  assert.equal(receipt.ownerInvestigation?.mode, "read-only");
  assert.match(receipt.ownerInvestigation?.instruction || "", /Continue.*read_tool/);
  assert.match(receipt.ownerInvestigation.instruction, /does not block/);
  const result = await broker.tool(f.source, "read_tool", { server: "gamestate", tool: "trace_corp", args: { corporation: "fixture" } });
  assert.equal(result.evidence, "read-only ledger result");
  assert.equal(f.ledger.data.channels.channel.claimedBy, "123"); assert.equal(f.ledger.data.channels.channel.category, "moderation");
  assert.equal(broker.supportDirectiveHeld(f.job), true); assert.equal(JSON.stringify(f.ledger.data.actions), before);
  await assert.rejects(broker.tool(f.source, "request_action", { kind: "host_command" }), /cannot run arbitrary/);
  assert.equal(Object.keys(f.ledger.data.actions).length, 0);
  const duplicate = await broker.tool(f.source, "support_directive", { ticket: 1564, sourceMessageId: f.source.source.messageId });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.ownerInvestigation.taskId, f.source.id);
  f.ledger.data.actions.pending = { id: "pending", jobId: f.job.id, state: "pending", digest: "unchanged" };
  const pending = await broker.tool(f.source, "support_directive", { ticket: 1564, sourceMessageId: f.source.source.messageId });
  assert.equal(pending.ownerInvestigation, undefined); assert.ok(pending.remainingBlockers.includes("pending-action"));
  assert.equal(f.ledger.data.actions.pending.state, "pending"); assert.equal(f.ledger.data.actions.pending.digest, "unchanged");
});

// 2026-10-19: 1615 refused the owner's "close it" because an earlier owner
// follow-up had set a closure hold.
test("an owner directive to close lifts the owner's own closure hold", () => {
  const src = fs.readFileSync(path.join(__dirname, "../lib/operator/supportdirective.js"), "utf8");
  assert.match(src, /if \(target\.ownerClosureHold && \/\\b\(\?:close\|resolve\)\\b\/i\.test/);
  assert.match(src, /delete target\.ownerClosureHold;/);
});
