"use strict";
// Keir 10, track W2: the post path. Guard deadlock (ticket 1812), the post budget.
const test = require("node:test");
const assert = require("node:assert");
const { setup } = require("./keir10-post.helpers");

const ANSWER = "Your plant is idle because it has no coal supplier. Renew the contract and it starts again next turn.";
const EXTRA = "The fix is live on the main server now.";

test("1812: an answer, then a refused extra post, then a paced retry: the flag never arms and finish succeeds", async () => {
  const f = setup(); f.playerWrote(5);
  await f.broker.tool(f.job, "channel_reply", { message: ANSWER });
  assert.equal(f.posts().length, 1);
  f.advance(1);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: EXTRA }), /outcome Keir has no receipt/);
  assert.equal(f.job.replyRefusedPending, undefined, "the player already has an answer to their latest message");
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Your plant is idle because it has no coal supplier, so renew the contract and it runs next turn." }), /already got this update|this task posted/);
  assert.equal(f.job.replyRefusedPending, undefined);
  await f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "player_reply", summary: "Answered; waiting for the player." });
  assert.equal(f.job.state, "waiting");
});

test("1812: a stale flag is cleared at finish once the player's latest message has a real answer", async () => {
  const f = setup(); f.playerWrote(5);
  f.job.replyRefusedPending = true; // armed earlier, before the answer went out by another task
  const other = f.ledger.createJob("t2", { role: "support", kind: "ticket", ticket: 123, channelId: "777777777777777777", replyChannel: "777777777777777777", source: { channelId: "777777777777777777" }, deadline: 9e15 });
  (f.ledger.data.ticketPosts ||= {})[123] = [{ at: f.now() - 60000, jobId: other.id, kind: "reply", text: ANSWER }];
  await f.broker.tool(f.job, "finish", { state: "done", summary: "Answered by the other task." });
  assert.equal(f.job.replyRefusedPending, undefined);
  assert.ok(["done", "waiting"].includes(f.job.state), f.job.state);
});

test("1812: while an answer is owed, pacing lets one corrected post through and the flag clears", async () => {
  const f = setup(); f.playerWrote(20);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: EXTRA }), /outcome Keir has no receipt/);
  assert.equal(f.job.replyRefusedPending, true, "no real answer yet, so the corrected answer is owed");
  // Meanwhile three holding lines went out since the player wrote, the last one just now: the monologue cap would hold the next post.
  (f.ledger.data.monologue ||= {})[123] = { humanAt: f.job.observedPlayerAt, count: 3, at: f.now() - 30000 };
  f.ledger.data.ticketPosts = { 123: [{ at: f.now() - 30000, jobId: f.job.id, kind: "reply", text: "I'm still looking into it." }] };
  await f.broker.tool(f.job, "channel_reply", { message: ANSWER });
  assert.equal(f.posts().length, 1, "the corrected answer is posted despite the monologue cap");
  assert.equal(f.job.replyRefusedPending, undefined);
  await f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "player_reply", summary: "Answered." });
  assert.equal(f.job.state, "waiting");
});

test("1812: an owed corrected answer is not held back by the three minute other-task rule", async () => {
  const f = setup(); f.playerWrote(20);
  const other = f.ledger.createJob("t2", { role: "support", kind: "ticket", ticket: 123, channelId: "777777777777777777", replyChannel: "777777777777777777", source: { channelId: "777777777777777777" }, deadline: 9e15 });
  f.ledger.data.ticketPosts = { 123: [{ at: f.now() - 20000, jobId: other.id, kind: "reply", text: "Hi, I'm Keir, the support assistant for this game." }] };
  f.job.replyRefusedPending = true;
  await f.broker.tool(f.job, "channel_reply", { message: ANSWER });
  assert.equal(f.posts().length, 1);
});

test("post budget: reports what the rules allow and rides along on a pacing refusal", async () => {
  const f = setup(); f.playerWrote(5);
  let b = f.broker.postBudget(f.job);
  assert.equal(b.replyOwed, true);
  assert.equal(b.postsLeftBeforePause, 3);
  assert.equal(b.lastPost, null);
  assert.equal(b.correctionAllowed, true);
  await f.broker.tool(f.job, "channel_reply", { message: ANSWER });
  b = f.broker.postBudget(f.job);
  assert.equal(b.replyOwed, false);
  assert.equal(b.posts24h, 1);
  assert.equal(b.postsLeftBeforePause, 2);
  assert.ok(b.longPostInSec > 0 && b.longPostInSec <= 600);
  assert.match(b.lastPost.text, /no coal supplier/);
  f.advance(1);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "The contract renews at the start of next turn. Your plant restarts once it is renewed. Output then returns to normal over two turns." }),
    (e) => /this task posted in ticket/.test(e.message) && /Post budget: 2 posts left/.test(e.message) && /long post is allowed in/.test(e.message));
  assert.equal(f.broker.postBudget({ kind: "command" }), null, "not a ticket job");
});
