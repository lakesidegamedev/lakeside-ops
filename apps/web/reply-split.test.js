"use strict";
// Same rules as apps/agent/lib/operator/replysplit.js (see keir841-conversational.test.js).
const test = require("node:test");
const CHAT = { single: 220 }; // the old chat-style chopping, still available to callers that ask for it
const assert = require("node:assert/strict");
const { splitReply, DISCORD_LIMIT, MAX_CHUNKS } = require("./reply-split");

const squash = (s) => String(s).replace(/\s+/g, " ").trim();

test("splitter: a short reply stays one message", () => {
  assert.deepEqual(splitReply("Your plant is mothballed since turn 675.", CHAT), ["Your plant is mothballed since turn 675."]);
  assert.deepEqual(splitReply(""), []);
});

test("splitter: paragraphs and sentences become short messages in order, nothing lost", () => {
  const text = "Your California plants were mothballed at turn 675 and still make nothing. That is why revenue fell.\n\nReactivating them restarts output the next turn. The loss counter does not reset, so expect one more weak turn before it clears.";
  const parts = splitReply(text, CHAT);
  assert.ok(parts.length >= 2 && parts.length <= MAX_CHUNKS, JSON.stringify(parts));
  assert.ok(parts.every((p) => p.length <= 220), JSON.stringify(parts.map((p) => p.length)));
  assert.equal(squash(parts.join(" ")), squash(text));
});

test("splitter: a long paragraph is cut at sentence ends, never mid-sentence", () => {
  const sentence = "The freight share you hold in Indiana is sold to the open market first.";
  const parts = splitReply(Array.from({ length: 4 }, () => sentence).join(" "), CHAT);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.match(p, /market first\.( The freight.*market first\.)?$/);
});

test("splitter: a list stays whole with the line that introduces it", () => {
  const text = "You can fix it from the CEO office in three steps:\n1. Open the CEO office.\n2. Pick internal supply.\n3. Save the order.\n\nIt takes effect next turn, so check your sector page after the turn ends.";
  const parts = splitReply(text, CHAT);
  const list = parts.find((p) => /^1\. Open/m.test(p));
  assert.ok(list && /three steps:/.test(list) && /3\. Save the order\./.test(list), JSON.stringify(parts));
});

test("splitter: a code fence is never cut", () => {
  const code = "```\nline one\n\nline two after a blank\n```";
  const parts = splitReply(`Run this in the console and tell me exactly what it prints back to you and then do the next thing for me please now.\n\n${code}\n\nThat is all it needs. Nothing else changes on your side until the next turn runs.`, CHAT);
  assert.ok(parts.includes(code), JSON.stringify(parts));
});

test("splitter: no message passes the Discord limit", () => {
  const text = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
  const parts = splitReply(text, CHAT);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= DISCORD_LIMIT, String(p.length));
  assert.equal(squash(parts.join(" ")), squash(text));
});

test("splitter: more than the allowed messages folds the tail into the last", () => {
  const text = Array.from({ length: 8 }, (_, i) => `Point number ${i + 1} is its own short idea.`).join("\n\n");
  const parts = splitReply(text, CHAT);
  assert.equal(parts.length, MAX_CHUNKS);
  assert.match(parts.at(-1), /Point number 8/);
});

test("splitter: a part Keir already split passes through unchanged", () => {
  const part = "Reactivating them restarts output the next turn. The loss counter does not reset.";
  assert.deepEqual(splitReply(part, CHAT), [part]);
});

test("splitter default: a formatted multi-paragraph reply under the Discord limit stays one message", () => {
  const reply = "Let me be clear: your plants are fine.\n\n- **Output**: 1,200 units on turn 250\n- **Price**: $4.10\n\nHere's what happens next: the next turn pays you as normal.";
  assert.deepEqual(splitReply(reply), [reply]);
  const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} explains one more part of the rule in a full sentence or two.`).join("\n\n");
  const parts = splitReply(long);
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= DISCORD_LIMIT));
  assert.equal(parts.join("\n\n"), long);
});
