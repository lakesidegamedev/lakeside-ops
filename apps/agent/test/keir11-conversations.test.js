"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const turn = require("../lib/operator/conversationturn");
const { pickForLanes, emptyLanes } = require("../lib/operator/lanes");
const { focusedMessages, quickQuestion } = require("../lib/operator/conversation");
const { setup } = require("./keir10-post.helpers");
const tc = require("../lib/operator/ticketcase");

const msg = (id, channelId = "ch") => ({ channelId, messageId: id, authorId: "p", role: "player", content: "Actually, I meant the amendment." });
test("an interruption fences a stale call even when another call has consumed it", async () => {
  const f = setup();
  const initial = msg("first", f.job.channelId), incoming = msg("second", f.job.channelId);
  f.job.inbox = [initial];
  turn.begin(f.job, [initial]);
  const worker = { codingResult: "child" };
  f.job.inbox.push(worker, incoming);
  turn.consume(f.job, [initial], [initial]);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "That bill is still open." }), /conversation_updates/);
  await turn.forCall(f.job, async () => {
    const result = await f.broker.tool(f.job, "conversation_updates", {});
    assert.deepEqual(result.messages, [incoming]);
    assert.throws(() => turn.check(f.job), /newer Discord/);
  });
  assert.deepEqual(f.job.inbox, [worker, incoming], "a restart can still recover the unanswered correction");
  await turn.forCall(f.job, async () => turn.answered(f.job));
  assert.deepEqual(f.job.inbox, [worker]);
  assert.deepEqual(f.job.requestInbox, [initial, incoming]);
  assert.equal(f.posts().length, 0);
});
test("only the ticket coordinator can borrow a chat slot beside its own child", () => {
  const parent = { id: "p", state: "queued", ticket: 123, kind: "ticket", channelId: "ch", inbox: [msg("1")] };
  const child = { id: "c", kind: "coding", codingParent: "p", state: "running" };
  const slots = { ...emptyLanes(), coding: {job: child} };
  assert.deepEqual(pickForLanes([parent, child], slots), [{ lane: "conversation", job: parent, replyOnly: true }]);
  assert.deepEqual(pickForLanes([parent, child], slots, { claimedBy: () => "staff" }), []);
  parent.foregroundAttempt = "1";
  assert.deepEqual(pickForLanes([parent, child], slots), [], "one failed response does not loop beside the child");
  parent.inbox.push(msg("2"));
  assert.equal(pickForLanes([parent, child], slots)[0].replyOnly, true);
  parent.inbox = [msg("wrong", "other")];
  assert.deepEqual(pickForLanes([parent, child], slots), []);
});
test("a short ticket answer settles only the actual question", () => {
  const d = {}, j = { channelId: "ch", ticket: 123, inbox: [
    { ...msg("a"), content: "Where are my cards?" },
    { ...msg("b"), content: "What happened to my amendment?" }
  ] };
  tc.syncActivation(d, j, {now: 1});
  tc.recordPost(d, j, "Your cards are visible in your collection.", {now: 2});
  const qs = d.ticketCases[123].questions;
  assert.equal(qs.find(q => q.messageId === "a").closedAt, 2);
  assert.equal(qs.find(q => q.messageId === "b").closedAt, undefined);
});
test("a replied-to screenshot survives intervening chatter", () => {
  const messages = Array.from({length: 10}, (_, i) => ({id: String(i), author: "speaker" + i, content: "caption", images: i === 0 ? [{name: "example.png"}] : []}));
  const focus = focusedMessages(messages, {replyTo: "0"});
  assert.equal(focus[0].author, "speaker0");
  assert.equal(focus[0].images[0].name, "example.png");
  assert.equal(quickQuestion("Hang on, do I need to refile?"), true);
  assert.equal(quickQuestion("Any update? Then deploy it."), false);
});

test("reply-only turns can read new owner directives before answering", async () => {
  const f = setup();
  turn.foreground.add(f.job);
  assert.equal(turn.foregroundTools.has("support_updates"), true);
  const directive = { directiveId: "d", role: "owner", content: "Hold the change." };
  f.job.inbox = [directive];
  assert.deepEqual(await f.broker.tool(f.job, "support_updates", {}), [directive]);
  assert.deepEqual(f.job.inbox, []);
});
