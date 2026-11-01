"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { channelGone, deliveryRefusal, keepsPriorReceipt } = require("./support-delivery-gate");

test("a merged ticket points the update at its target (ticket 1743)", () => {
  assert.match(deliveryRefusal({ status: "closed", mergedInto: 1745 }, 1743), /merged into #1745/);
});

test("a closed ticket or deleted channel refuses delivery", () => {
  assert.match(deliveryRefusal({ status: "closed" }, 1), /is closed/);
  const t = { status: "resolved", discordChannelId: "42", messages: ["hi", "Ticket channel 42 was deleted outside the bot. The conversation is unavailable"] };
  assert.equal(channelGone(t), true);
  assert.match(deliveryRefusal(t, 2), /channel was deleted/);
});

test("an open ticket with a live channel delivers", () => {
  assert.equal(deliveryRefusal({ status: "open", discordChannelId: "42", messages: [{ content: "Ticket channel 41 was deleted" }] }, 3), null);
});

test("closing a resolved ticket keeps its receipt; corrections still supersede (ticket 1736)", () => {
  const prior = { receiptId: "r1" };
  assert.equal(keepsPriorReceipt({ status: "resolved" }, prior, "closed"), true);
  assert.equal(keepsPriorReceipt({ status: "resolved" }, prior, "resolved"), false);
  assert.equal(keepsPriorReceipt({ status: "open" }, null, "closed"), false);
});
