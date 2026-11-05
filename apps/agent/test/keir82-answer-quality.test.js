"use strict";
// Keir 8.2: answer-quality guards from the 2026-11-05 conversation review
// (tickets 1763, 1765, 1766) and the expired-login outage that day.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { refusal } = require("../lib/operator/ticketquality");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir82-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const calls = [];
  const mcp = { servers: () => ["support"], list: async () => [], call: async (...a) => { calls.push(a); return { ok: true, delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: "777777777777777777", replyChannel: "777777777777777777", source: { channelId: "777777777777777777", channelName: "ticket-bug-fixture-123" }, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id;
  const advance = (min) => { clock += min * 60000; };
  return { ledger, broker, job, calls, advance, now: () => clock };
}

test("a release alone cannot tell the player the problem is fixed (ticket 1763)", async () => {
  const f = setup();
  f.job.releaseEvidence = { a: { main: true } };
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Your margins now include internal supply, so the -999% should be gone." }), /no receipt|figures after that turn/);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "The fix is live and working." }), /no receipt|figures after that turn/);
  // A turn on the fix, then a read of their figures: now it may be said.
  f.job.turnChecks = [f.now()]; f.advance(1); f.job.lastGameReadAt = f.now();
  await f.broker.tool(f.job, "channel_reply", { message: "Your chemicals page now shows the internal supply income." });
  // The player writes back that it is still wrong: the old read no longer covers the claim.
  f.advance(40); f.job.observedPlayerAt = f.now();
  f.ledger.data.ticketPosts = {};
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "It is fixed on your page now." }), /no receipt|figures after that turn/);
  // Future tense stays allowed.
  await f.broker.tool(f.job, "channel_reply", { message: "Once the next turn runs, the margins will include internal supply." });
});

test("'now on the main server' is a release claim", async () => {
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "The margin fix is now on the main server." }), /no receipt|github where/);
});

test("two tasks cannot both announce the same release within half an hour", async () => {
  const f = setup();
  f.job.releaseEvidence = { a: { main: true } };
  await f.broker.tool(f.job, "channel_reply", { message: "The wording change is live on the main server." });
  const other = f.ledger.createJob("t2", { role: "support", kind: "ticket", ticket: 123, channelId: "777777777777777777", replyChannel: "777777777777777777", source: { channelId: "777777777777777777", channelName: "ticket-bug-fixture-123" }, deadline: 9e15, releaseEvidence: { a: { main: true } } });
  other.state = "running";
  f.advance(5);
  await assert.rejects(f.broker.tool(other, "channel_reply", { message: "The outputs fix went live on the main server." }), /told this is live/);
});

test("a second 'won't guess' post needs code reads, a third needs an investigator (ticket 1766)", async () => {
  const f = setup();
  await f.broker.tool(f.job, "channel_reply", { message: "I haven't found what mothballs your plant yet, so I won't guess." });
  f.advance(20);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Still no confirmed cause. I haven't found the rule that sets it." }), /code_search|delegate_investigation/);
  f.job.lastCodeReadAt = f.now() + 1; f.advance(1);
  await f.broker.tool(f.job, "channel_reply", { message: "I haven't confirmed the rule yet; the plant's coal shortage is the lead." });
  f.advance(20); f.job.lastCodeReadAt = f.now() + 1; f.advance(1);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I still haven't traced it, so I won't guess." }), /investigator now/);
  const child = f.ledger.createJob("inv", { kind: "coding", investigation: true, codingParent: f.job.id, deadline: 9e15 });
  f.job.investigations = [child.id];
  await f.broker.tool(f.job, "channel_reply", { message: "I haven't found the cause yet; an investigator is reading the mothball rule now." });
});

test("a factual question is not handed to Ask unread (ticket 1765)", () => {
  assert.equal(refusal("I haven't checked which sectors make ordnance and systems, so I won't guess. Ask at https://ask.lakesidegames.net can answer that.").kind, "lookup_punted");
  assert.equal(refusal("For where to invest next, Ask at https://ask.lakesidegames.net can help with strategy."), null);
});
