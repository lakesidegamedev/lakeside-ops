"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ticketReplyState } = require("./ticket-reply-status");
const room = "1".repeat(18), card = "2".repeat(18), id = "3".repeat(18);
const ticket = { discordChannelId: room, createdAt: "2026-10-15T00:00:00Z", intake: { cardMessageId: card } };
const update = { deliveryMode: "reply", delivery: { status: "posted", channelId: room, messageId: id, postedAt: "2026-10-15T00:05:00Z" } };
const state = (...publicUpdates) => ticketReplyState({ ...ticket, publicUpdates });
test("a first reply needs a stored Discord reply in the current room", () => {
  assert.deepEqual(state(update), { state: "delivered", at: "2026-10-15T00:05:00.000Z" });
  assert.deepEqual(state(), { state: "no_receipt" });
  for (const patch of [{ status: "failed" }, { messageId: card }, { channelId: "other" }, { messageId: null }]) {
    assert.deepEqual(state({ ...update, delivery: { ...update.delivery, ...patch } }), { state: "no_receipt" });
  }
  assert.deepEqual(state({ ...update, deliveryMode: "card" }), { state: "no_receipt" });
});
test("an earlier opening's answer does not clear a reopened ticket", () => {
  assert.deepEqual(ticketReplyState({ ...ticket, publicUpdates: [update], reopenRequest: { state: "complete", completedAt: "2026-10-20" } }), { state: "no_receipt" });
  assert.equal(ticketReplyState({ ...ticket, discordChannelId: null }), null);
});
