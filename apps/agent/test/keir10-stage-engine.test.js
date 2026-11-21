"use strict";
// Keir 10 stage engine: a status card moves forward on receipts without a model run.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");

const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
process.env.KEIR_DEPLOYED_SHA_CMD = "/fixture/probe.sh";
const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-definite-")); dirs.push(dir);
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  return { dir, ledger, config };
};


async function setup(itemNames = ["Factory panel shows zero"]) {
  const { ledger, config } = mk(); const posts = [], patches = []; let clock = 5000;
  const discord = async (method, route, body) => {
    if (method === "GET" && /\/guilds\//.test(route)) return [{ id: "777777777777777777", name: "ticket-bug-x-123", guild_id: config.guildId }];
    if (method === "GET" && /\/users\/@me$/.test(route)) return { id: config.botId, avatar: null };
    if (method === "GET" && /\/channels\/777777777777777777$/.test(route)) return { id: "777777777777777777", name: "ticket-bug-x-123", guild_id: config.guildId };
    if (method === "GET" && /messages\?limit=100/.test(route)) return [];
    if (method === "GET" && /messages\?limit=1$/.test(route)) return posts.length ? [{ id: String(900 + posts.length) }] : [];
    if (method === "POST" && /messages$/.test(route)) { posts.push(body); return { id: String(900 + posts.length) }; }
    if (method === "PATCH") { patches.push(body); return {}; }
    return []; };
  const broker = createBroker({ ledger, config, mcp: { servers: () => ["support"], list: async () => [], call: async () => ({ ok: true }) }, discord, sandbox: {}, now: () => (clock += 1000), exec: async () => "" });
  const t = ledger.createJob("ticket:123", { kind: "ticket", role: "support", ticket: 123, channelId: "777777777777777777", source: { channelId: "777777777777777777", channelName: "ticket-bug-x-123" }, deadline: 9e15 }); t.state = "waiting";
  ledger.data.seen["ticket:123"] = t.id; t.investigatedReads = 5;
  await broker.adminStatusCard(123, { items: itemNames.map((name) => ({ name, stage: "found", blocked: false, note: "" })), status: "" });
  return { ledger, broker, job: t, patches };
}

test("a merged fix moves a one-fix card to Tested with no model run, and a second tick changes nothing", async () => {
  const f = await setup();
  assert.deepEqual(await f.broker.stageTick(), [], "no receipt yet, no move");
  f.job.effects["merge:1"] = { state: "done" };
  const moved = await f.broker.stageTick();
  assert.deepEqual(moved, [{ ticket: 123, item: "Factory panel shows zero", stage: "tested" }]);
  assert.equal(f.ledger.data.statusCards[123].items[0].stage, "tested");
  assert.equal(f.job.state, "waiting", "a Tested move does not wake the model");
  assert.deepEqual(await f.broker.stageTick(), []);
});

test("the main server release moves the card and wakes the model once to check the player's figures", async () => {
  const f = await setup();
  f.job.effects["merge:1"] = { state: "done" };
  f.job.pullRequests = ["https://github.com/lakesidegamedev/AHDGame/pull/7001"];
  f.job.releaseEvidence = { a: { development: true, staging: true, main: true, repository: "AHDGame", pr: 7001 } };
  const moved = await f.broker.stageTick();
  assert.equal(moved[0].stage, "main");
  assert.equal(f.job.state, "queued");
  assert.match(f.job.inbox.at(-1).content, /live on the main server/);
  assert.equal(f.job.inbox.at(-1).authorId, "stage-engine");
});

test("a card with several fixes, an answered fix and a blocked fix are left to the model", async () => {
  const many = await setup(["First fix", "Second fix"]);
  many.job.effects["merge:1"] = { state: "done" };
  assert.deepEqual(await many.broker.stageTick(), []);
  const f = await setup();
  f.job.effects["merge:1"] = { state: "done" };
  assert.deepEqual(await f.broker.advanceCardStage(123, "Factory panel shows zero", "found", {}), { advanced: false, reason: "not forward" });
  assert.equal((await f.broker.advanceCardStage(123, "No such fix", "tested", {})).advanced, false);
  assert.equal((await f.broker.advanceCardStage(999, "x", "tested", {})).reason, "no card");
});

test("a human interruption defers the live notice and the stage tick delivers it once after the reply", async () => {
  const f = await setup();
  f.job.pullRequests = ["https://github.com/lakesidegamedev/AHDGame/pull/7001"];
  f.job.releaseEvidence = { patch: { development: true, staging: true, main: true, repository: "AHDGame", pr: 7001 } };
  f.job.inbox = [{ messageId: "m", authorId: "p", channelId: f.job.channelId, role: "player" }];
  await f.broker.stageTick();
  const card = f.ledger.data.statusCards[123];
  assert.equal(card.pendingLiveNotice.names.length, 1);
  assert.equal(card.liveNotified?.length || 0, 0);
  f.job.inbox = [];
  f.job.state = "waiting";
  await f.broker.stageTick();
  assert.equal(card.pendingLiveNotice, undefined);
  assert.equal(card.liveNotified.length, 1);
  await f.broker.stageTick();
  assert.equal(f.ledger.data.audit.filter(a => a.kind === "live_notice").length, 1);
});
