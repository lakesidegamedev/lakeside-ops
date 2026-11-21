"use strict";
// Keir 11.2 second pass, item 9, through the real broker: a ticket cannot wait without a closing condition, a turn report
// needs a reason, and a step-back activation checkpoints first and posts at most once.
const test = require("node:test");
const assert = require("node:assert");
const { setup } = require("./keir10-post.helpers");
const closing = require("../lib/operator/closing");

const CLOSE = { closesWhen: "closes when the player's plant output after the coal fix is compared with turn 40", waitingOn: "the first turn after the fix is live" };

test("finish: a ticket cannot wait without a closing condition; with one, the wait is recorded for the code check", async () => {
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "finish", { state: "waiting", summary: "Waiting for the next turn.", wakeAfterMinutes: 60 }), /closesWhen \(what closes this ticket or finding/);
  assert.equal(f.audits("closing_condition_refused").length, 1);
  assert.equal(f.job.state, "running", "the refusal leaves the job where it was");
  await f.broker.tool(f.job, "finish", { state: "waiting", summary: "Waiting for the next turn.", wakeAfterMinutes: 60, ...CLOSE, waitOn: { kind: "turn", ref: 41 } });
  assert.equal(f.job.state, "waiting");
  assert.equal(f.job.closing.closesWhen, CLOSE.closesWhen);
  assert.deepEqual(f.job.closing.on, { kind: "turn", ref: 41 });
  assert.equal(f.job.closing.timerAt, f.job.wakeAt, "the timer this wait set is the one the code check owns");
  // A later finish keeps the recorded condition without restating it.
  f.job.state = "running";
  await f.broker.tool(f.job, "finish", { state: "waiting", summary: "Still waiting for turn 41.", wakeAfterMinutes: 60 });
  assert.equal(f.job.closing.closesWhen, CLOSE.closesWhen);
  // Done needs no condition.
  f.job.state = "running";
  await f.broker.tool(f.job, "finish", { state: "done", summary: "Answered." });
});

test("turn commentary is opt-in: a turn report needs a player message, a due promise or the closing condition", async () => {
  const f = setup(); f.playerWrote(30);
  const d = f.ledger.data;
  d.watch = { turnClock: { turn: 40, iteration: 3, at: f.now() } };
  await f.broker.tool(f.job, "channel_reply", { message: "Your plant has no coal supplier, so it made nothing this turn." });
  f.advance(65);
  d.watch.turnClock = { turn: 41, iteration: 3, at: f.now() };
  // A turn ran; nobody asked, no promise, no closing condition: refused.
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Turn 41: your plant still made nothing." }), /a turn having run is not a reason to post/);
  assert.equal(f.audits("turn_post_not_called_for").length, 1);
  // The closing condition names turn 41: that one report goes out, then the call is used up.
  f.job.closing = { closesWhen: CLOSE.closesWhen, waitingOn: CLOSE.waitingOn, on: { kind: "turn", ref: 41 }, setAt: f.now() };
  f.job.lastGameReadAt = f.now(); // the turn's figures were read in this activation
  await f.broker.tool(f.job, "channel_reply", { message: "Turn 41: the coal contract started and your plant produced its first output." });
  assert.equal(f.job.closing.turnReported, 41);
  f.advance(65); d.watch.turnClock = { turn: 42, iteration: 3, at: f.now() };
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Turn 42: your plant kept producing and made a profit." }), /a turn having run is not a reason to post/);
  // A player message makes the next turn report an answer.
  f.playerWrote(1); f.job.lastGameReadAt = f.now();
  await f.broker.tool(f.job, "channel_reply", { message: "Turn 42: your plant kept producing and made a profit." });
  assert.equal(f.posts().length, 3);
});

test("a step-back activation checkpoints first and posts at most once", async () => {
  const f = setup(); f.playerWrote(30);
  const d = f.ledger.data;
  d.ticketPace = { 123: { posts: 10, corrections: 1, firstAt: f.now() - 5 * 3600000, log: [{ at: f.now() - 3600000, by: "keir", text: "Turn 39 figures." }] } };
  f.job.closing = { closesWhen: CLOSE.closesWhen, waitingOn: CLOSE.waitingOn, on: { kind: "turn", ref: 41 } };
  assert.equal(closing.stepBack(d, f.job, f.now(), closing.DEFAULTS), true);
  assert.match(f.job.inbox.at(-1).content, /^Step back before anything else\. This ticket has 10 Keir posts\./);
  assert.match(f.job.inbox.at(-1).content, /Recorded closing condition: closes when the player's plant output/);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Your plant is waiting on its coal contract." }), /First call checkpoint with what the player actually needs/);
  f.job.history = [...(f.job.history || []), { at: new Date(f.now()).toISOString(), kind: "checkpoint", summary: "Needs: output restored. Missing: one turn with coal. Waiting on: turn 41. Last posts did not move it." }];
  await f.broker.tool(f.job, "channel_reply", { message: "Your plant is waiting on its coal contract, which starts next turn." });
  f.advance(11);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "One more thing about coal." }), /posts at most one message/);
  // Once per threshold crossing: the next activation at the same level is not a step-back.
  await f.broker.tool(f.job, "finish", { state: "waiting", summary: "Waiting for turn 41.", wakeAfterMinutes: 60 });
  assert.equal(f.job.stepBack.done, true);
  assert.equal(closing.stepBack(d, f.job, f.now(), closing.DEFAULTS), false);
});

test("a recorded promise opens one turn report, through the real post path", async () => {
  const f = setup(); f.playerWrote(30);
  const d = f.ledger.data;
  d.watch = { turnClock: { turn: 40, iteration: 3, at: f.now() } };
  await f.broker.tool(f.job, "channel_reply", { message: "Your plant has no coal supplier yet. I will check its output after the next turn." });
  assert.equal(d.ticketPromises[123][0].afterTurn, 41);
  f.advance(65); d.watch.turnClock = { turn: 41, iteration: 3, at: f.now() }; f.job.lastGameReadAt = f.now();
  await f.broker.tool(f.job, "channel_reply", { message: "Turn 41: the coal contract started and your plant produced its first output." });
  assert.equal(d.ticketPromises[123][0].state, "kept");
  f.advance(65); d.watch.turnClock = { turn: 42, iteration: 3, at: f.now() }; f.job.lastGameReadAt = f.now();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Turn 42: your plant kept producing and made a profit." }), /a turn having run is not a reason to post/);
});

test("N3: a step-back whose activation ended without finish never refuses the next activation's answer", async () => {
  const f = setup(); f.playerWrote(30);
  const d = f.ledger.data;
  d.ticketPace = { 123: { posts: 10, corrections: 0, firstAt: f.now() - 30 * 3600000, log: [] } };
  f.job.closing = { closesWhen: CLOSE.closesWhen, waitingOn: CLOSE.waitingOn, on: { kind: "turn", ref: 41 } };
  // Activation 1 is a step-back: checkpoint, one line, then the turn limit ends it (no finish).
  f.job.lastRunStartedAt = f.now();
  closing.onActivation(f.job, f.now());
  assert.equal(closing.stepBack(d, f.job, f.now(), closing.DEFAULTS), true);
  f.job.history = [...(f.job.history || []), { at: new Date(f.now()).toISOString(), kind: "checkpoint", summary: "Needs: output. Waiting on: turn 41." }];
  await f.broker.tool(f.job, "channel_reply", { message: "Your plant is waiting on its coal contract, which starts next turn." });
  assert.equal(f.job.stepBack.posted, 1);
  // The player asks again; activation 2 starts (a new run) and has the answer.
  f.advance(20); f.playerWrote(1);
  f.job.lastRunStartedAt = f.now();
  closing.onActivation(f.job, f.now());
  assert.equal(f.job.stepBack.endedAbnormally, true);
  assert.equal(closing.stepBack(d, f.job, f.now(), closing.DEFAULTS), false, "same level, and it already posted: no new step-back");
  await f.broker.tool(f.job, "channel_reply", { message: "The coal contract is signed and starts on the next turn, so your plant will produce then." });
  assert.equal(f.posts().length, 2, "the answer went out");
  assert.equal(f.audits("step_back_post_refused").length, 0);
  // The step-back limit still holds inside its own activation (the side the fix must not lose).
  const g = setup(); g.playerWrote(30);
  g.ledger.data.ticketPace = { 123: { posts: 10, corrections: 0, firstAt: g.now() - 30 * 3600000, log: [] } };
  g.job.lastRunStartedAt = g.now(); closing.onActivation(g.job, g.now());
  closing.stepBack(g.ledger.data, g.job, g.now(), closing.DEFAULTS);
  g.job.history = [{ at: new Date(g.now()).toISOString(), kind: "checkpoint", summary: "x" }];
  await g.broker.tool(g.job, "channel_reply", { message: "Your plant is waiting on its coal contract, which starts next turn." });
  g.advance(11);
  await assert.rejects(g.broker.tool(g.job, "channel_reply", { message: "One more thing about coal." }), /posts at most one message/);
});

test("N3: a step-back that crashed before it posted is tried once more on the next activation", () => {
  const d = { ticketPace: { 9: { posts: 10, corrections: 0, firstAt: Date.now() - 3600000, log: [] } }, jobs: {}, decisions: {} };
  const job = { id: "s", kind: "ticket", ticket: 9, role: "support", state: "running", at: Date.now() - 3600000, effects: {}, inbox: [], lastRunStartedAt: 1 };
  closing.onActivation(job, 1);
  assert.equal(closing.stepBack(d, job, Date.now(), closing.DEFAULTS), true);
  job.lastRunStartedAt = 2; closing.onActivation(job, 2);
  assert.equal(closing.stepBack(d, job, Date.now(), closing.DEFAULTS), true, "retried once");
  assert.equal(job.stepBack.retry, true);
  job.lastRunStartedAt = 3; closing.onActivation(job, 3);
  assert.equal(closing.stepBack(d, job, Date.now(), closing.DEFAULTS), false, "never a loop");
});
