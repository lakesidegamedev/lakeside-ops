"use strict";
// Keir 10.1.3 (owner, 2026-11-17, ticket 1836): a returning player's bug ticket showed nothing for about three
// minutes, because the first post was the answer. Code now posts the progress card before preflight.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const CH = "777777777777777777";

function setup({ category = "bug", title = "Canadian Resources not existing" } = {}) {
  const ledger = createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "k1013-")), "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: [], botId: "333333333333333333", guildId: "444444444444444444" };
  const sent = [];
  const discord = async (method, url, body) => {
    if (String(url).includes("/guilds/")) return [{ id: CH, name: "ticket-bug-fixture-1836" }];
    if (method === "GET" && /\/channels\/\d+$/.test(url)) return { id: CH, guild_id: "444444444444444444", name: "ticket-bug-fixture-1836", last_message_id: "1" };
    if (method === "POST") { sent.push(body); return { id: `m${sent.length}` }; }
    return {};
  };
  const mcp = { servers: () => ["support"], list: async () => [], call: async (_s, tool) => (tool === "support_get" ? { title } : { ok: true, docs: [] }) };
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: {}, now: () => Date.now() });
  ledger.data.channels[CH] = { category };
  ledger.data.disclosed = { 1836: { at: 1, posted: false, returning: true } };
  const job = ledger.createJob("ticket:1836", { role: "support", kind: "ticket", ticket: 1836, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-1836" }, deadline: 9e15 });
  job.state = "running";
  return { ledger, broker, job, sent };
}

test("1836: a bug ticket gets its progress card at once, and it does not count as Keir's answer", async () => {
  const f = setup();
  const r = await f.broker.instantCard(f.job);
  assert.equal(r.posted, true);
  assert.ok(f.ledger.data.statusCards[1836].messageId);
  assert.equal(f.sent.length, 1);
  assert.match(JSON.stringify(f.sent[0]), /Canadian Resources not existing/);
  assert.match(JSON.stringify(f.sent[0]), /Investigating/);
  assert.equal(f.job.lastPublishedAt, undefined, "the closing logic must not treat the card as an answer");
  assert.deepEqual(await f.broker.instantCard(f.job), { skipped: "card exists" });
});

test("question tickets, staff-claimed tickets and tickets Keir already spoke in get no instant card", async () => {
  assert.deepEqual(await setup({ category: "mechanics" }).broker.instantCard(setup({ category: "mechanics" }).job), { skipped: "not a bug ticket" });
  const claimed = setup(); claimed.ledger.data.channels[CH].claimedBy = "222222222222222222";
  assert.deepEqual(await claimed.broker.instantCard(claimed.job), { skipped: "staff claimed" });
  const spoke = setup(); spoke.job.lastPublishedAt = 1;
  assert.deepEqual(await spoke.broker.instantCard(spoke.job), { skipped: "already spoke" });
});

test("a technical ticket title falls back to a plain card name", async () => {
  const f = setup({ title: "stateResourceCapacity rows missing" });
  await f.broker.instantCard(f.job);
  assert.match(JSON.stringify(f.sent[0]), /Your report/);
});
