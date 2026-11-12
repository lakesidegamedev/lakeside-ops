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
  const state = { fail: false };
  const mcp = { servers: () => ["support"], list: async () => [], call: async (...a) => { calls.push(a); if (a[1] === "kanban_add") { if (state.fail) throw new Error("kanban down"); return { id: "card-1" }; } return { ok: true, delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: "777777777777777777", replyChannel: "777777777777777777", source: { channelId: "777777777777777777", channelName: "ticket-bug-fixture-123" }, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id;
  const advance = (min) => { clock += min * 60000; };
  return { ledger, broker, job, calls, advance, now: () => clock, get mcpFail() { return state.fail; }, set mcpFail(v) { state.fail = v; } };
}

test("a release alone cannot tell the player the problem is fixed (ticket 1763)", async () => {
  const f = setup();
  f.job.releaseEvidence = { a: { main: true } };
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Your margins now include internal supply, so the -999% should be gone." }), /no receipt|figures after that turn/);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "The fix is live and working." }), /no receipt|figures after that turn/);
  // Keir 9 (replay 2026-11-12): a page change claimed without a receipt is the same claim.
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "The page has been changed so the tile now matches sold against made units." }), /no receipt|figures after that turn/);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "That block was corrected in the current update, so the option is there for you now." }), /no receipt|figures after that turn/);
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

test("a second 'won't guess' post needs code reads and a player message, a third never (ticket 1766)", async () => {
  const f = setup();
  await f.broker.tool(f.job, "channel_reply", { message: "I haven't found what mothballs your plant yet, so I won't guess." });
  f.advance(20);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Still no confirmed cause. I haven't found the rule that sets it." }), /code_exact|investigation instead/);
  // Keir 8.4: code reads alone are not enough; the player must have written since (see keir84-support-quality.test.js).
  f.job.lastCodeReadAt = f.now() + 1; f.job.observedPlayerAt = f.now() + 1; f.advance(1);
  await f.broker.tool(f.job, "channel_reply", { message: "I haven't confirmed the rule yet; the plant's coal shortage is the lead." });
  f.advance(20); f.job.lastCodeReadAt = f.now() + 1; f.job.observedPlayerAt = f.now() + 1; f.advance(1);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I still haven't traced it, so I won't guess." }), /code_exact|investigation instead/);
});

test("a factual question is not handed to Ask unread (ticket 1765)", () => {
  assert.equal(refusal("I haven't checked which sectors make ordnance and systems, so I won't guess. Ask at https://ask.lakesidegames.net can answer that.").kind, "lookup_punted");
  assert.equal(refusal("For where to invest next, Ask at https://ask.lakesidegames.net can help with strategy."), null);
});

test("a developer's ping cannot restate the answer another task posted seconds ago (ticket 1773)", async () => {
  const f = setup();
  f.job.lastCodeReadAt = 1; // an earlier code read, so the Keir 9 rule-lookup check does not apply to this test
  await f.broker.tool(f.job, "channel_reply", { message: "You're right that the two figures disagree. The Selling tile and the \"72% sold\" line are calculated from different records, and only the second matches the offered, sold and unsold counts beside it." });
  const dev = f.ledger.createJob("dev", { role: "support", kind: "command", ticket: 123, actorId: "222222222222222222", channelId: "777777777777777777", replyChannel: "777777777777777777", source: { channelId: "777777777777777777", channelName: "ticket-bug-fixture-123", authorId: "222222222222222222", at: new Date(f.now()).toISOString(), content: "Keir the selling tile shows 100% but only 72% sold" }, deadline: 9e15 });
  dev.state = "running"; dev.observedPlayerAt = f.now(); f.advance(0.25);
  await assert.rejects(f.broker.tool(dev, "channel_reply", { message: "Thanks, that matches what I'm seeing: the Selling tile and the \"72% sold\" line disagree, and only the second matches the offered, sold and unsold counts." }), /already got this update/);
});

test("a ticket cannot park on developers while its own last word is 'cause not found' (owner, 2026-11-05)", async () => {
  const f = setup();
  await f.broker.tool(f.job, "channel_reply", { message: "I haven't yet confirmed why the tile read 100% for this sector." });
  await assert.rejects(f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "developer_reply", summary: "Raised; waiting." }), /nobody is looking for it/);
  const child = f.ledger.createJob("inv2", { kind: "coding", investigation: true, codingParent: f.job.id, deadline: 9e15 });
  f.job.investigations = [child.id];
  const r = await f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "developer_reply", summary: "Investigator on it." });
  assert.equal(r.state, "waiting");
});

test("a developer talking to the player is not a ping Keir must answer (ticket 1778)", async () => {
  const f = setup();
  const ch = "777777777777777777", owner = "111111111111111111";
  const j = f.ledger.createJob("own", { role: "owner", kind: "command", ticket: 123, actorId: owner, channelId: ch, replyChannel: ch, source: { channelId: ch, channelName: "ticket-bug-fixture-123", authorId: owner, at: new Date(f.now()).toISOString(), content: "sorry\ni will unban and add a note" }, deadline: 9e15 });
  j.state = "running"; f.advance(1);
  const r = await f.broker.tool(j, "finish", { state: "done", summary: "Owner handling the unban; nothing to add." });
  assert.equal(r.state, "done");
});

test("bookkeeping and third-person talk are refused in the player's channel (ticket 1778)", () => {
  assert.equal(refusal("Understood. The unban and note are yours, and the player has already been told the account is unbanned.").kind, "bookkeeping");
  assert.equal(refusal("I have nothing further to do on this one.").kind, "bookkeeping");
});

test("Keir 9: a reply with a dash is posted with the dash replaced, not refused", async () => {
  const f = setup();
  f.job.lastCodeReadAt = 1;
  await f.broker.tool(f.job, "channel_reply", { message: "Newer regional bills carry no lean effect \u2014 governor orders and older laws do." });
  const sent = f.calls.filter((c) => c[1] === "support_public_update").map((c) => c[2].message).join(" ");
  assert.match(sent, /no lean effect, governor orders/);
});

test("Keir 9: a ticket cannot park with the player unanswered; refused twice, then the code answers and escalates", async () => {
  const f = setup();
  f.job.observedPlayerAt = f.now() - 60000;
  // No reads needed: the obligation is the ticket's, not the job's.
  await assert.rejects(f.broker.tool(f.job, "finish", { state: "waiting", summary: "Found the cause; will post next." }), /no answer since they last wrote/);
  // A wait on the developers does not excuse it, and a second job on the same ticket shares the count.
  await assert.rejects(f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "developer_reply", summary: "Still checking." }), /no answer since they last wrote/);
  const r = await f.broker.tool(f.job, "finish", { state: "waiting", summary: "Still checking." });
  assert.match(JSON.stringify(r), /waiting/);
  const sent = f.calls.filter((c) => c[1] === "support_public_update").map((c) => c[2].message);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /haven't got a confirmed answer for you yet/);
  assert.match(sent[0], /passed it to the developers/);
  assert.ok(f.calls.some((c) => c[1] === "kanban_add"), "escalation filed");
  assert.ok(f.ledger.data.audit?.some?.((a) => a.kind === "unanswered_limitation_posted") || JSON.stringify(f.ledger.data).includes("unanswered_limitation"), "receipt recorded");
});

test("Keir 9: the refusal count is per ticket, so a fresh job cannot reset it", async () => {
  const f = setup();
  f.job.observedPlayerAt = f.now() - 60000;
  await assert.rejects(f.broker.tool(f.job, "finish", { state: "waiting", summary: "x." }), /no answer since they last wrote/);
  await assert.rejects(f.broker.tool(f.job, "finish", { state: "waiting", summary: "x." }), /no answer since they last wrote/);
  const other = f.ledger.createJob("t2", { role: "support", kind: "ticket", ticket: 123, channelId: "777777777777777777", replyChannel: "777777777777777777", source: { channelId: "777777777777777777", channelName: "ticket-bug-fixture-123" }, deadline: 9e15 });
  other.state = "running"; other.observedPlayerAt = f.job.observedPlayerAt;
  await f.broker.tool(other, "finish", { state: "waiting", summary: "x." });
  assert.equal(f.calls.filter((c) => c[1] === "support_public_update").length, 1);
});

test("Keir 9: when the escalation cannot be filed the limitation does not claim the developers have it", async () => {
  const f = setup();
  f.job.observedPlayerAt = f.now() - 60000;
  await assert.rejects(f.broker.tool(f.job, "finish", { state: "done", summary: "x." }), /no answer/);
  await assert.rejects(f.broker.tool(f.job, "finish", { state: "done", summary: "x." }), /no answer/);
  f.mcpFail = true;
  await f.broker.tool(f.job, "finish", { state: "done", summary: "x." });
  const sent = f.calls.filter((c) => c[1] === "support_public_update").map((c) => c[2].message).join(" ");
  assert.match(sent, /haven't got a confirmed answer/);
  assert.doesNotMatch(sent, /developers/);
});

test("Keir 9: after the player is answered, the ticket may park waiting", async () => {
  const f = setup();
  f.job.observedPlayerAt = f.now() - 60000; f.job.lastCodeReadAt = 1;
  await f.broker.tool(f.job, "channel_reply", { message: "Your sold line is the right figure: 139 of 195 sold." });
  const r = await f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "player_reply", summary: "Answered." });
  assert.match(JSON.stringify(r), /waiting/);
});

test("Keir 9: a holding line is not an answer once the ticket has read data", async () => {
  const f = setup();
  f.job.observedPlayerAt = f.now() - 60000;
  await f.broker.tool(f.job, "channel_reply", { message: "I'm looking into your sector history now." }).catch(() => {});
  f.job.lastGameReadAt = f.now() + 1; f.advance(1);
  await assert.rejects(f.broker.tool(f.job, "finish", { state: "waiting", summary: "Found it; will post." }), /no answer since they last wrote/);
});
