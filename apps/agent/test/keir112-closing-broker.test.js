"use strict";
// Keir 11.2 second pass, item 9, through the real broker: a ticket cannot wait without a closing condition, and a turn report
// needs a reason.
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

test("turn commentary is opt-in: a turn report needs a player message or a due promise, never the closing condition alone", async () => {
  const f = setup(); f.playerWrote(30);
  const d = f.ledger.data;
  d.watch = { turnClock: { turn: 40, iteration: 3, at: f.now() } };
  await f.broker.tool(f.job, "channel_reply", { message: "Your plant has no coal supplier, so it made nothing this turn." });
  f.advance(65);
  d.watch.turnClock = { turn: 41, iteration: 3, at: f.now() };
  // A turn ran; nobody asked, no promise, no closing condition: refused.
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Turn 41: your plant still made nothing." }), /a turn having run is not a reason to post/);
  assert.equal(f.audits("turn_post_not_called_for").length, 1);
  // Keir guardrails (2026-11-22): the closing condition alone no longer licenses a recap, so turn 41 is still refused.
  f.job.closing = { closesWhen: CLOSE.closesWhen, waitingOn: CLOSE.waitingOn, on: { kind: "turn", ref: 41 }, setAt: f.now() };
  f.job.lastGameReadAt = f.now(); // the turn's figures were read in this activation
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Turn 41: the coal contract started and your plant produced its first output." }), /a turn having run is not a reason to post/);
  f.advance(65); d.watch.turnClock = { turn: 42, iteration: 3, at: f.now() };
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Turn 42: your plant kept producing and made a profit." }), /a turn having run is not a reason to post/);
  // A player message makes the next turn report an answer.
  f.playerWrote(1); f.job.lastGameReadAt = f.now();
  await f.broker.tool(f.job, "channel_reply", { message: "Turn 42: your plant kept producing and made a profit." });
  assert.equal(f.posts().length, 2);
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

test("N10: a second, substantive answer to the player's open question gets through when it names a turn", async () => {
  const f = setup(); f.playerWrote(30);
  const d = f.ledger.data;
  d.watch = { turnClock: { turn: 80, iteration: 3, at: f.now() } };
  // The player's question is an open asked item.
  d.ticketCases = { 123: { ticket: 123, claims: [], promises: [], staff: [], questions: [], asked: [], said: [], askedRefusals: 0 } };
  require("../lib/operator/ticketcase").addAsked(d.ticketCases[123], "Why did my factory produce nothing? The workers are gone.", f.now() - 30 * 60000);
  await f.broker.tool(f.job, "channel_reply", { message: "Your factory has had no workers assigned since the housing change. I am checking why the workers left." });
  f.advance(12); f.job.lastGameReadAt = f.now(); // read the workers' move
  // Not refused by the turn rule: it answers the open question (and explains the cause).
  await f.broker.tool(f.job, "channel_reply", { message: "Found it: after turn 78 your factory workers moved to the new mine because its wage is higher, so the factory produced nothing." });
  assert.equal(f.posts().length, 2);
  assert.equal(f.audits("turn_post_not_called_for").length, 0);
});

test("N10: a post the rule cannot place goes out and the doubt is recorded; unprompted turn commentary is still refused", async () => {
  const f = setup(); f.playerWrote(30);
  const d = f.ledger.data;
  d.watch = { turnClock: { turn: 80, iteration: 3, at: f.now() } };
  d.ticketCases = { 123: { ticket: 123, claims: [], promises: [], staff: [], questions: [], asked: [], said: [], askedRefusals: 0 } };
  require("../lib/operator/ticketcase").addAsked(d.ticketCases[123], "Why are my bond sales not working at all?", f.now() - 30 * 60000);
  await f.broker.tool(f.job, "channel_reply", { message: "Your company has three listings waiting in the market queue right now." });
  f.advance(65); d.watch.turnClock = { turn: 81, iteration: 3, at: f.now() }; f.job.lastGameReadAt = f.now();
  // The question is still open, the post does not clearly answer it: a doubt, posted, recorded.
  await f.broker.tool(f.job, "channel_reply", { message: "Turn 81: the market rule is still in force." });
  assert.equal(f.posts().length, 2);
  assert.equal(d.postDoubts[123][0].rule, "turn_rule");
  // Nothing owed (the ask is answered) and nothing explained: the opposite side still holds.
  d.ticketCases[123].asked[0].answeredAt = f.now();
  f.advance(65); d.watch.turnClock = { turn: 82, iteration: 3, at: f.now() }; f.job.lastGameReadAt = f.now();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Turn 82: the market rule is still in force." }), /a turn having run is not a reason to post/);
});
