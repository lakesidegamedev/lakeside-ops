"use strict";
// Keir 9.0.2 (ticket 1829, 2026-11-13): a linked reporter is never asked who they are, and pacing never holds back an
// answer the player is owed.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");

function setup({ reporter = { username: "linked_player" } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir902-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { screenOutgoing: async () => ({ labels: [], refuse: null }), ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const calls = [];
  const mcp = { servers: () => ["support", "heal-ops"], list: async () => [], call: async (...a) => {
    calls.push(a);
    if (a[1] === "support_get") return { number: 123, title: "Slideshow skips", reporter, intake: { cardMessageId: "555555555555555555" } };
    if (a[1] === "heal_query" && a[2].collection === "users") return { matched: 1, docs: [{ _id: "6a19c66d1ed3632485eb98d4", username: a[2].filter.username }] };
    if (a[1] === "heal_query" && a[2].collection === "characters") return { matched: 1, docs: [{ name: "Ada Vance", sequentialId: 4242 }] };
    return { ok: true, delivery: { posted: true, delivery: { status: "posted" } } };
  } };
  let clock = 10 * 3600000;
  const discord = async (method, url) => (/messages\/555555555555555555$/.test(url) ? { id: "555555555555555555", author: { id: "333333333333333333" } } : /\/guilds\/.*\/channels$/.test(url) ? [{ id: "777777777777777777", name: "ticket-bug-fixture-123" }] : []);
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: "777777777777777777", replyChannel: "777777777777777777", source: { channelId: "777777777777777777", channelName: "ticket-bug-fixture-123" }, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id; ledger.data.disclosed = { 123: { at: 1, posted: true } };
  return { ledger, broker, job, calls, advance: (min) => { clock += min * 60000; }, now: () => clock };
}

test("a linked reporter is not asked for their character name; refused at most twice", async () => {
  const f = setup();
  for (let i = 0; i < 2; i++) await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "If you share your character name here, I can check your season summary." }), /their game account is linked/);
  // Never stuck: the third attempt is not refused for this reason.
  await f.broker.tool(f.job, "channel_reply", { message: "If you share your character name here, I can check your season summary." }).catch((e) => assert.doesNotMatch(e.message, /their game account is linked/));
});

test("an unlinked reporter may still be asked", async () => {
  const f = setup({ reporter: {} });
  await f.broker.tool(f.job, "channel_reply", { message: "What is your character name?" });
});

test("reporter_state resolves a reporter linked by username: account and characters, no 'not linked' error", async () => {
  const f = setup();
  const r = await f.broker.tool(f.job, "reporter_state", {});
  assert.deepEqual(r.account, { username: "linked_player", linked: true });
  assert.equal(r.characters[0].name, "Ada Vance");
  assert.match(r.instruction, /Never ask the player who they are/);
});

test("while the player is owed an answer, pacing does not hold back the answer (ticket 1829)", async () => {
  const f = setup();
  f.job.observedPlayerAt = f.now() - 60000;
  // Keir posted a short line a minute ago, then a finish was refused because the player had no answer.
  f.ledger.data.ticketPosts = { 123: [{ at: f.now() - 60000, jobId: f.job.id, text: "I am checking why the slideshow skips." }] };
  f.ledger.data.unansweredFinishes = { 123: { humanAt: f.now() - 60000, refused: 1 } };
  f.job.lastCodeReadAt = f.now() - 30000;
  await f.broker.tool(f.job, "channel_reply", { message: "The slideshow moves on when each slide's progress bar finishes animating. With animations turned off on your phone, that bar finishes instantly, so it jumps to the end. Turn animations back on for now: Settings, Accessibility, then switch off Remove animations. A fix is being made." });
});

test("without an owed answer, the ten-minute pacing rule still applies", async () => {
  const f = setup();
  f.ledger.data.ticketPosts = { 123: [{ at: f.now() - 60000, jobId: f.job.id, text: "I am checking why the slideshow skips." }] };
  f.job.lastCodeReadAt = f.now() - 30000;
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "The slideshow moves on when each slide's progress bar finishes animating. With animations off that bar finishes instantly. Turn animations back on for now. A fix is being made." }), /min ago|still the newest/);
});

test("a staff or owner message in the ticket does not count as the player writing (ticket 1829)", async () => {
  const f = setup();
  const before = f.job.observedPlayerAt || 0;
  const rows = [{ id: "1", author: { id: "111111111111111111", username: "owner" }, content: "their account should be linked is it not?", timestamp: new Date(f.now()).toISOString() }];
  const b2 = require("../lib/operator/broker").createBroker;
  // Re-create the broker with a Discord stub that returns the owner's message for the channel history.
  const fixture = setup(); fixture.job.observedPlayerAt = 0;
  const discord = async (method, url) => (/\/messages\?limit=50$/.test(url) ? rows : []);
  const broker = b2({ ledger: fixture.ledger, config: { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], supportDeferred: () => false, stateDir: require("os").tmpdir(), repositories: {}, watched: () => false }, mcp: { servers: () => [], list: async () => [], call: async () => ({}) }, discord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => f.now() });
  await broker.tool(fixture.job, "ticket_history", {});
  assert.equal(fixture.job.observedPlayerAt || 0, 0);
  assert.equal(before, f.job.observedPlayerAt || 0);
});

test("Keir 9.0.3: a real answer that says 'I will update you' is not a holding line; a one-line holding post still is", async () => {
  const f = setup();
  f.job.observedPlayerAt = f.now() - 120000; f.job.lastGameReadAt = f.now() - 100000;
  f.ledger.data.ticketPosts = { 123: [{ at: f.now() - 60000, jobId: "other", text: "The fix for the slideshow is written and in testing. Turning animations back on lets it play normally for now. I will update you here once it is live." }] };
  const r = await f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "developer_reply", summary: "Answered; fix in testing." });
  assert.match(JSON.stringify(r), /waiting/);
  const g = setup();
  g.job.observedPlayerAt = g.now() - 120000; g.job.lastGameReadAt = g.now() - 100000;
  g.ledger.data.ticketPosts = { 123: [{ at: g.now() - 60000, jobId: "other", text: "I will update you shortly." }] };
  await assert.rejects(g.broker.tool(g.job, "finish", { state: "waiting", waitFor: "developer_reply", summary: "Still checking." }), /no answer since they last wrote/);
});

test("Keir 9.0.3: after reporter_state resolves a username-linked reporter's one character, private reads on it are allowed", async () => {
  const f = setup();
  await f.broker.tool(f.job, "reporter_state", {});
  assert.equal(f.job.reporterCharacter.id, "4242");
  assert.equal(f.job.reporterCharacter.name, "Ada Vance");
});
