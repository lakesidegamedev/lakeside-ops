"use strict";
// Keir 8.4.1: conversational replies and faster answers (owner, 2026-11-06).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { splitReply, DISCORD_LIMIT, MAX_CHUNKS } = require("../lib/operator/replysplit");
const clarify = require("../lib/operator/clarify");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { createGateway } = require("../lib/operator/gateway");

const squash = (s) => String(s).replace(/\s+/g, " ").trim();

test("splitter: a short reply stays one message", () => {
  assert.deepEqual(splitReply("Your plant is mothballed since turn 675."), ["Your plant is mothballed since turn 675."]);
  assert.deepEqual(splitReply(""), []);
});

test("splitter: paragraphs and sentences become short messages in order, nothing lost", () => {
  const text = "Your California plants were mothballed at turn 675 and still make nothing. That is why revenue fell.\n\nReactivating them restarts output the next turn. The loss counter does not reset, so expect one more weak turn before it clears.";
  const parts = splitReply(text);
  assert.ok(parts.length >= 2 && parts.length <= MAX_CHUNKS, JSON.stringify(parts));
  assert.ok(parts.every((p) => p.length <= 220), JSON.stringify(parts.map((p) => p.length)));
  assert.equal(squash(parts.join(" ")), squash(text));
  assert.match(parts[0], /^Your California plants/);
  assert.match(parts.at(-1), /weak turn before it clears\.$/);
});

test("splitter: a long paragraph is cut at sentence ends, never mid-sentence", () => {
  const sentence = "The freight share you hold in Indiana is sold to the open market first.";
  const text = Array.from({ length: 4 }, () => sentence).join(" ");
  const parts = splitReply(text);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.match(p, /market first\.( The freight.*market first\.)?$/);
});

test("splitter: a list stays whole with the line that introduces it", () => {
  const text = "You can fix it from the CEO office in three steps:\n1. Open the CEO office.\n2. Pick internal supply.\n3. Save the order.\n\nIt takes effect next turn, so check your sector page after the turn ends.";
  const parts = splitReply(text);
  const list = parts.find((p) => /^1\. Open/m.test(p));
  assert.ok(list && /three steps:/.test(list) && /3\. Save the order\./.test(list), JSON.stringify(parts));
  assert.equal(squash(parts.join(" ")), squash(text));
});

test("splitter: a code fence is never cut", () => {
  const code = "```\nline one\n\nline two after a blank\n```";
  const parts = splitReply(`Run this in the console and tell me exactly what it prints back to you and then do the next thing for me please now.\n\n${code}\n\nThat is all it needs. Nothing else changes on your side until the next turn runs.`);
  assert.ok(parts.includes(code), JSON.stringify(parts));
});

test("splitter: no message passes the Discord limit and long unbroken text is cut at spaces", () => {
  const text = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
  const parts = splitReply(text);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= DISCORD_LIMIT, String(p.length));
  assert.equal(squash(parts.join(" ")), squash(text));
});

test("splitter: more than the allowed messages folds the tail into the last, in order", () => {
  const text = Array.from({ length: 8 }, (_, i) => `Point number ${i + 1} is its own short idea.`).join("\n\n");
  const parts = splitReply(text);
  assert.equal(parts.length, MAX_CHUNKS);
  assert.equal(squash(parts.join(" ")), squash(text));
  assert.match(parts.at(-1), /Point number 8/);
});

// ---- broker: a split reply is ONE update ----
const CH = "777777777777777777";
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir841-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false };
  const calls = [], gaps = [];
  let visits = [];
  const mcp = { servers: () => ["support"], list: async () => [{ name: "support_public_update", inputSchema: { type: "object", additionalProperties: true } }],
    call: async (...a) => { calls.push(a); if (a[1] === "support_get") return { number: 123, supportRecentVisits: visits }; return { ok: true, delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * 3600000;
  const discord = async (_m, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-123" }] : []);
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock, sleep: async (ms) => { gaps.push(ms); } });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-123", content: "Why is my stuff stuck in Pennsylvania and Indiana but I own almost all freight in Indiana" }, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id;
  return { ledger, broker, job, calls, gaps, setVisits: (v) => { visits = v; }, advance: (min) => { clock += min * 60000; }, now: () => clock };
}
const updates = (f) => f.calls.filter((c) => c[1] === "support_public_update");

test("a long reply goes out as several messages in order, a gap apart, and counts as one update", async () => {
  const f = setup();
  const reply = "Your Indiana freight sector sells to the open market before your own manufacturing sees it. The sale order is by price, not by owner. That is why only five percent reaches your own company.\n\nNothing is missing from your account. A same-owner priority would be a rule change, so I am raising it with the developers.";
  const res = await f.broker.tool(f.job, "channel_reply", { message: reply });
  assert.equal(res.published, true);
  const sent = updates(f).map((c) => c[2].message).filter((m) => !/^Hi, I.m Keir/.test(m)); // the first-ever answer gets the standard introduction first
  assert.ok(sent.length >= 2 && res.messages === sent.length, JSON.stringify(sent));
  assert.equal(squash(sent.join(" ")), squash(reply), "order and content kept");
  assert.equal(f.gaps.length, sent.length - 1, "a pause between messages, none before the first");
  // One update to every counter: the post history and the monologue run.
  assert.equal(f.ledger.data.ticketPosts[123].filter((p) => !/^Hi, I.m Keir/.test(p.text)).length, 1);
  assert.equal(f.ledger.data.monologue[123].count, 1);
});

test("a split reply counts as one post in the post history", async () => {
  const f = setup();
  const reply = "First fact is that the freight sector sells to the open market before your own plants. Second fact is that the order is by price.\n\nThird, no money is missing.";
  await f.broker.tool(f.job, "channel_reply", { message: reply });
  f.advance(15); f.job.observedPlayerAt = f.now(); f.advance(1);
  await f.broker.tool(f.job, "channel_reply", { message: "Thanks. The same-owner priority is a rule change, so it goes to the developers. I will tell you what they decide." });
  assert.equal(f.ledger.data.ticketPosts[123].filter((p) => !/^Hi, I.m Keir/.test(p.text)).length, 2);
});

test("ordering holds when the first message is retried: delivered messages are not sent twice", async () => {
  const f = setup();
  const reply = "Short first idea that stands alone and is true for you today.\n\nSecond idea that follows it and adds the next step for you to take today in the game.";
  await f.broker.tool(f.job, "channel_reply", { message: reply });
  const before = updates(f).length;
  // The same reply again (a retried activation) reuses the recorded effects instead of resending.
  await f.broker.tool(f.job, "channel_reply", { message: reply }).catch(() => {});
  assert.equal(updates(f).length, before);
});

// ---- ticket 1781: no needless either/or questions ----
const T1781 = "Why is my stuff stuck in Pennsylvania and Indiana but I own almost all freight in Indiana, it only sells 5% to my own company, why don't my own sectors go first";
const KEIR_1781 = "Which is the problem: manufacturing not taking freight from your own logistics sector, or the internal supply option missing from the CEO office? Tell me which and I'll trace it.";

test("1781: the either/or reply is recognised as a bare clarifying question", () => {
  assert.equal(clarify.isBareEitherOr(KEIR_1781), true);
  const msg = clarify.needlessClarification({ message: KEIR_1781, texts: [T1781, "CEO office, do you have the internal supply thingy", "idk why it isn't here"], visits: [] });
  assert.match(msg, /already names what is wrong/);
  assert.match(msg, /Investigate every issue/);
});

test("1781: the broker refuses the either/or reply on that ticket and posts nothing", async () => {
  const f = setup();
  f.job.inbox = [{ authorId: "888888888888888888", content: "CEO office, do you have the internal supply thingy" }, { authorId: "999999999999999999", content: "idk why it isn't here" }];
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: KEIR_1781 }), /Do not ask the player to pick between issues they already raised/);
  assert.equal(updates(f).length, 0);
});

test("a reply with findings plus a real question is allowed", async () => {
  const f = setup();
  const message = "Your Indiana freight sector sells in price order, so your own manufacturing competes with everyone else. Did you set an internal supply order in the CEO office?";
  assert.equal(clarify.isBareEitherOr(message), false);
  await f.broker.tool(f.job, "channel_reply", { message });
  assert.ok(updates(f).length >= 1);
});

test("a question is fine when the ticket names nothing to look up", () => {
  assert.equal(clarify.needlessClarification({ message: "Is it the sales page or the loan page that breaks?", texts: ["it broke"], visits: [] }), null);
});

test("page visits count as naming the problem", () => {
  assert.ok(clarify.needlessClarification({ message: "Which page is it: sector or company?", texts: ["it is wrong sector stuff"], visits: [{ path: "/corporation/12/sectors" }] }));
});

test("plain yes or no question is not an either/or pick", () => {
  assert.equal(clarify.isBareEitherOr("Did you reactivate the California plants after turn 675?"), false);
});

// ---- speed: player messages wake quickly ----
test("a player message in a ticket wakes the task in seconds, not 45", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir841g-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const woke = [];
  const NOW = 5000;
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", watched: () => true, taskLifetimeMs: 86400000 };
  const gateway = createGateway({ ledger, config, now: () => NOW, onWake: (ms) => woke.push(ms) });
  const ch = { id: CH, name: "ticket-bug-fixture-123", type: 0 };
  const t = ledger.createJob("ticket:123", { kind: "ticket", role: "support", ticket: 123, channelId: CH, state: "waiting" });
  const msg = (content, authorId) => ({ id: String(Math.random()).slice(2, 20).padEnd(18, "1"), author: { id: authorId, username: "fixture", bot: false }, content, timestamp: new Date(NOW).toISOString(), mentions: [], attachments: [] });
  gateway.ingest(ch, msg("my freight is stuck, why", "888888888888888888"));
  assert.equal(t.wakeAt, NOW + 8000);
  assert.deepEqual(woke, [8000]);
});
