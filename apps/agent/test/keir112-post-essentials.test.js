"use strict";
// Keir 11.2 third pass, through the real broker post path with every 11.2 refusal rule in force at once (the live rule, the
// turn rule, the hourly cap with its merged overflow already used): the three posts that must always get through do, and
// every refusal is recorded where a person can read it. Also the review's M6: posts answering staff are not the player's.
const test = require("node:test");
const assert = require("node:assert");
const { setup } = require("./keir10-post.helpers");

const MIN = 60000;
// The hour is full: four unprompted Keir posts since the player last wrote, and the one merged overflow already used.
function crowded({ holding = false } = {}) {
  const f = setup();
  const d = f.ledger.data;
  d.watch = { turnClock: { turn: 41, iteration: 3, at: f.now() } };
  f.job.observedPlayerAt = f.now() - 55 * MIN;
  const text = holding ? "I'm still checking this." : "Your plant output figures are as before.";
  d.ticketPosts = { 123: [50, 40, 30, 20].map((m) => ({ at: f.now() - m * MIN, jobId: f.job.id, kind: "reply", text })) };
  d.lastSubstantive = { 123: { at: f.now() - 20 * MIN, text, holding } };
  d.postOverflow = { 123: { at: f.now() - 15 * MIN, humanAt: f.job.observedPlayerAt } };
  f.job.lastGameReadAt = f.now(); f.job.turnChecks = [f.now() - 1000];
  return f;
}

test("all rules at once: an unprompted turn report is refused, and the refusal is recorded with ticket, rule and text", async () => {
  const f = crowded();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Turn 41: your plant produced 120 units." }));
  const rec = f.ledger.data.refusedPosts[123];
  assert.equal(rec.length, 1);
  assert.equal(rec[0].rule, "turn_post_not_called_for");
  assert.equal(rec[0].text, "Turn 41: your plant produced 120 units.");
  assert.equal(f.posts().length, 0);
});

test("all rules at once: the answer to the player's question goes out, after a run of holding lines", async () => {
  const f = crowded({ holding: true });
  await f.broker.tool(f.job, "channel_reply", { message: "Turn 41: your plant produced 120 units, so the coal fix worked." });
  assert.equal(f.posts().length, 1);
});

test("all rules at once: a correction goes out even after the merged overflow message", async () => {
  const f = crowded();
  await f.broker.tool(f.job, "channel_reply", { message: "Correction: turn 41 made 120 units, not 100." });
  assert.equal(f.posts().length, 1);
});

test("all rules at once: a promised follow-up that is due goes out", async () => {
  const f = crowded();
  f.ledger.data.ticketPromises = { 123: [{ id: "123-a", at: f.now() - 100 * MIN, jobId: f.job.id, state: "open", wakes: 1, wokenAt: f.now() - 5 * MIN, kind: "turn", text: "I'll check the next turn and tell you.", dueAt: f.now() - 10 * MIN, afterTurn: 41 }] };
  await f.broker.tool(f.job, "channel_reply", { message: "Turn 41: your plant produced 120 units, as I said I would check." });
  assert.equal(f.posts().length, 1);
  assert.equal(f.ledger.data.ticketPromises[123][0].state, "kept");
});

test("M6: posts answering the owner or a developer do not use up the player's hourly budget", async () => {
  const f = setup();
  const d = f.ledger.data;
  f.job.observedPlayerAt = f.now() - 30 * MIN;
  d.ticketPosts = { 123: [25, 20, 15, 10].map((m) => ({ at: f.now() - m * MIN, jobId: "staffjob", kind: "reply", text: `Answer to a staff question ${m}.`, staff: true })) };
  await f.broker.tool(f.job, "channel_reply", { message: "Your coal contract is now active and the plant is running." });
  assert.equal(f.posts().length, 1);
  // The post path marks a post from a task answering the owner.
  const owner = f.ledger.createJob("o", { role: "owner", kind: "command", ticket: 123, channelId: f.job.channelId, replyChannel: f.job.channelId, source: { channelId: f.job.channelId, at: new Date(f.now()).toISOString(), content: "Keir, what did you find?" }, deadline: 9e15 });
  owner.state = "running"; owner.codeLookups = 1; owner.lastCodeReadAt = f.now();
  f.advance(1);
  await f.broker.tool(owner, "channel_reply", { message: "The plant had no coal supplier when I looked." });
  assert.equal(d.ticketPosts[123].at(-1).staff, true);
});

test("switches: the turn rule off lets the report through; in preview it goes out and the would-be refusal is recorded", async () => {
  const off = crowded();
  off.ledger.data.postOverflow = {}; off.ledger.data.ticketPosts[123] = off.ledger.data.ticketPosts[123].slice(-1);
  const { staticControls } = require("../lib/operator/controls");
  const f = setup({ config: { controls: staticControls({ turnRule: "off" }) } });
  f.ledger.data.watch = { turnClock: { turn: 41, iteration: 3, at: f.now() } };
  f.job.observedPlayerAt = f.now() - 55 * MIN;
  f.ledger.data.ticketPosts = { 123: [{ at: f.now() - 30 * MIN, jobId: f.job.id, kind: "reply", text: "Your plant output figures are as before." }] };
  f.job.lastGameReadAt = f.now(); f.job.turnChecks = [f.now() - 1000];
  await f.broker.tool(f.job, "channel_reply", { message: "Turn 41: your plant produced 120 units." });
  assert.equal(f.posts().length, 1);
  const p = setup({ config: { controls: staticControls({}, { preview: true }) } });
  p.ledger.data.watch = f.ledger.data.watch;
  p.job.observedPlayerAt = p.now() - 55 * MIN;
  p.ledger.data.ticketPosts = { 123: [{ at: p.now() - 30 * MIN, jobId: p.job.id, kind: "reply", text: "Your plant output figures are as before." }] };
  p.job.lastGameReadAt = p.now(); p.job.turnChecks = [p.now() - 1000];
  await p.broker.tool(p.job, "channel_reply", { message: "Turn 41: your plant produced 120 units." });
  assert.equal(p.posts().length, 1);
  assert.ok(Object.keys(p.ledger.data.preview.items).some((k) => /^post-rules:would refuse \(turn_post_not_called_for\):ticket 123$/.test(k)));
});
