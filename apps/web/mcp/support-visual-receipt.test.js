"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { recordVisualReply } = require("./support-visual-receipt");

const number = 123;
const ids = { channelId: "111111111111111111", messageId: "222222222222222222", replyTo: "333333333333333333" };
const bot = { id: "444444444444444444" };
const sent = { id: ids.messageId, channel_id: ids.channelId, author: { ...bot, bot: true },
  message_reference: { message_id: ids.replyTo }, content: "Live. Choose Compare strategies under Build.",
  attachments: [{ id: "555555555555555555", filename: "ui-desktop-abcdefabcdefabcdefab.png", content_type: "image/png" }] };

function fixture(message = sent, overrides = {}) {
  const ticket = { _id: "ticket", ticketNumber: number, discordChannelId: ids.channelId, category: "bug", status: "open", publicUpdates: [], ...overrides };
  const reads = [];
  const tickets = {
    findOne: async (filter) => !filter["publicUpdates.key"] || ticket.publicUpdates.some(row => row.key === filter["publicUpdates.key"]) ? ticket : null,
    updateOne: async (filter, update) => {
      if (!ticket.publicUpdates.some(row => row.key === filter["publicUpdates.key"].$ne)) ticket.publicUpdates.push(update.$push.publicUpdates);
    },
  };
  const fetchImpl = async (url, request) => {
    reads.push([url, request.method || "GET"]);
    return { ok: true, json: async () => url.endsWith("/users/@me") ? bot : message };
  };
  const record = () => recordVisualReply(tickets, { number, ...ids, stage: "live" }, { token: "fixture", fetchImpl });
  return { ticket, reads, record };
}

test("a preview receipt retains the reply and image once across repeated record attempts", async () => {
  const f = fixture();
  await f.record();
  await f.record();
  assert.equal(f.ticket.publicUpdates.length, 1);
  const [entry] = f.ticket.publicUpdates;
  assert.equal(entry.kind, "production");
  assert.equal(entry.delivery.messageId, ids.messageId);
  assert.equal(entry.delivery.replyTo, ids.replyTo);
  assert.deepEqual(entry.delivery.attachments, sent.attachments.map(({ id, filename }) => ({ id, filename })));
  assert.equal(f.reads.length, 2);
  assert.ok(f.reads.every(([, method]) => method === "GET"));
});

test("the support receipt rejects a different ticket channel, a non-bot receipt, or a missing image", async () => {
  await assert.rejects(fixture(sent, { discordChannelId: "666666666666666666" }).record(), /assigned ticket channel/);
  await assert.rejects(fixture({ ...sent, author: { id: ids.replyTo } }).record(), /does not match/);
  await assert.rejects(fixture({ ...sent, attachments: [] }).record(), /visual attachments/);
  await assert.rejects(fixture({ ...sent, message_reference: { message_id: ids.messageId } }).record(), /does not match/);
});
