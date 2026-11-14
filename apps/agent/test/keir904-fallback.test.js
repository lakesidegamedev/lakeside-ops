"use strict";
// Keir 9.0.4 (ticket 1829): the "no confirmed answer yet" line never follows a real answer and never replaces an answer
// that is being reshaped after a refusal. Generic wording.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");

const CH = "777777777777777777";
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir904-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const state = { screen: null };
  const config = { screenOutgoing: async () => (state.screen ? { labels: [], refuse: state.screen } : { labels: [], refuse: null }), ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const calls = [];
  const mcp = { servers: () => ["support"], list: async () => [], call: async (...a) => { calls.push(a); return { ok: true, delivery: { posted: true, delivery: { status: "posted" } } }; } };
  const discord = async (_m, url) => (/\/guilds\/.*\/channels$/.test(String(url)) ? [{ id: CH, name: "ticket-bug-fixture-123" }] : []);
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  // The ledger keeps one job per ticket here; a later task is modelled by clearing the per-task refused-answer hold.
  const mk = () => { const j = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-123", content: "The slideshow jumps to the end." }, deadline: 9e15 }); j.state = "running"; delete j.replyRefusedPending; return j; };
  const a = mk(); ledger.data.seen["ticket:123"] = a.id; ledger.data.disclosed = { 123: { at: 1, posted: true } };
  a.observedPlayerAt = clock - 5 * 60000; a.lastGameReadAt = clock - 4 * 60000; a.codeLookups = 1; a.lastCodeReadAt = clock - 4 * 60000;
  const limitation = () => calls.filter((c) => c[1] === "support_public_update" && /confirmed answer for you yet/.test(c[2].message || "")).length;
  const finish = (job, summary = "Found the cause.") => broker.tool(job, "finish", { state: "waiting", waitFor: "developer_reply", summary });
  return { ledger, broker, a, mk, calls, state, limitation, finish, advance: (m) => { clock += m * 60000; }, now: () => clock };
}
const ANSWER = "The slideshow moves on when each slide's progress bar finishes. With motion reduced the bar finishes at once, so it jumps. A fix is being made.";

test("1829 sequence: draft refused by the screen, rewrite refused, finishes: no limitation line; once the answer posts, finish succeeds", async () => {
  const f = setup();
  f.state.screen = "names code files";
  await assert.rejects(f.broker.tool(f.a, "channel_reply", { message: ANSWER }));
  f.state.screen = null;
  await assert.rejects(f.broker.tool(f.a, "channel_reply", { message: "See broker.js and the slideshow.js file for the cause of the jump." }));
  const b = f.mk(); // a later task on the same ticket (same job here, hold cleared)
  for (let i = 0; i < 2; i++) await assert.rejects(f.finish(b), /no answer since they last wrote/);
  for (let i = 0; i < 2; i++) await assert.rejects(f.finish(b), /Post your reshaped answer now/);
  assert.equal(f.limitation(), 0, "no limitation line while the answer is being reshaped");
  await f.broker.tool(b, "channel_reply", { message: ANSWER });
  await f.finish(b);
  assert.equal(f.limitation(), 0);
});

test("bounded: after two reshape refusals the limitation line is allowed, so finishing is never blocked", async () => {
  const f = setup();
  await assert.rejects(f.broker.tool(f.a, "channel_reply", { message: "See broker.js and the slideshow.js file." }));
  const b = f.mk();
  for (let i = 0; i < 4; i++) await assert.rejects(f.finish(b));
  await f.finish(b);
  assert.equal(f.limitation(), 1);
});

test("an old refusal (over 15 minutes) does not hold the limitation line back", async () => {
  const f = setup();
  await assert.rejects(f.broker.tool(f.a, "channel_reply", { message: "See broker.js and the slideshow.js file." }));
  f.advance(16);
  const b = f.mk();
  for (let i = 0; i < 2; i++) await assert.rejects(f.finish(b), /no answer since they last wrote/);
  await f.finish(b);
  assert.equal(f.limitation(), 1);
});

test("a real answer since the player wrote means no limitation line, even with a holding line posted after it", async () => {
  const f = setup();
  f.ledger.data.ticketPosts = { 123: [
    { at: f.now() - 3 * 60000, jobId: "x", text: ANSWER },
    { at: f.now() - 2 * 60000, jobId: "x", text: "I will update you shortly." } ] };
  await assert.rejects(f.broker.tool(f.a, "channel_reply", { message: "See broker.js and the slideshow.js file." }));
  const b = f.mk();
  await f.finish(b);
  assert.equal(f.limitation(), 0);
});

test("the other way: only a holding line since the player wrote is still owed an answer", async () => {
  const f = setup();
  f.ledger.data.ticketPosts = { 123: [{ at: f.now() - 2 * 60000, jobId: "x", text: "I will update you shortly." }] };
  const b = f.mk();
  await assert.rejects(f.finish(b), /no answer since they last wrote/);
});

test("a real answer from before the player's last message does not count", async () => {
  const f = setup();
  f.ledger.data.ticketPosts = { 123: [{ at: f.now() - 20 * 60000, jobId: "x", text: ANSWER }] };
  const b = f.mk();
  await assert.rejects(f.finish(b), /no answer since they last wrote/);
});
