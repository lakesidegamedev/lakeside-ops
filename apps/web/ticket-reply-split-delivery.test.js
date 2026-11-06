"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { maybePostTicketChannelUpdate } = require("./ticket-ship-notify");

const LONG = "Your California plants were mothballed at turn 675 and still make nothing. That is why revenue fell.\n\nReactivating them restarts output the next turn. The loss counter does not reset, so expect one more weak turn before it clears.\n\nCheck your sector page after the next turn ends.";

function fakeDb(ticket) {
  const collection = {
    findOne: async () => ticket,
    updateOne: async (_filter, update) => {
      if (update.$push?.publicUpdates) ticket.publicUpdates.push(update.$push.publicUpdates);
      for (const [path, value] of Object.entries(update.$set || {})) {
        const m = /^publicUpdates\.\$\.(.+)$/.exec(path);
        if (!m) continue;
        const entry = ticket.publicUpdates[0];
        const keys = m[1].split(".");
        let target = entry;
        for (const k of keys.slice(0, -1)) target = target[k] = target[k] || {};
        target[keys.at(-1)] = value;
      }
      return { modifiedCount: 1 };
    },
  };
  return { collection: () => collection };
}

const base = { ticketNumber: 9, key: "progress:1", kind: "progress", deliveryMode: "reply", message: LONG, partGapMs: 0 };

test("a long reply is posted as several ordered messages and recorded as one update", async () => {
  const ticket = { _id: "t", ticketNumber: 9, discordChannelId: "c1", publicUpdates: [] };
  const sent = [];
  const postChannel = async (_c, content, { nonce }) => { sent.push({ content, nonce }); return { posted: true, id: `m${sent.length}`, channel: "c1" }; };
  const r = await maybePostTicketChannelUpdate(fakeDb(ticket), { ...base, postChannel });
  assert.equal(r.posted, true);
  assert.ok(sent.length >= 2 && sent.length <= 4, String(sent.length));
  assert.equal(new Set(sent.map((s) => s.nonce)).size, sent.length);
  assert.equal(ticket.publicUpdates.length, 1);
  assert.equal(ticket.publicUpdates[0].message, LONG);
  assert.deepEqual(ticket.publicUpdates[0].delivery.parts.map((p) => p.id), sent.map((_, i) => `m${i + 1}`));
  assert.equal(ticket.publicUpdates[0].delivery.messageId, "m1");
  assert.equal(ticket.publicUpdates[0].delivery.status, "posted");
});

test("a short reply is one message", async () => {
  const ticket = { _id: "t", ticketNumber: 9, discordChannelId: "c1", publicUpdates: [] };
  let sends = 0;
  await maybePostTicketChannelUpdate(fakeDb(ticket), { ...base, message: "Fixed, live now.", postChannel: async () => { sends++; return { posted: true, id: "m1", channel: "c1" }; } });
  assert.equal(sends, 1);
});

test("a retry after a mid-way failure resends only the missing parts", async () => {
  const ticket = { _id: "t", ticketNumber: 9, discordChannelId: "c1", publicUpdates: [] };
  const db = fakeDb(ticket);
  const sent = [];
  let n = 0;
  const flaky = async (_c, content) => { n++; if (n === 2) return { error: "discord 500" }; sent.push(content); return { posted: true, id: `m${n}`, channel: "c1" }; };
  const first = await maybePostTicketChannelUpdate(db, { ...base, postChannel: flaky });
  assert.equal(first.delivery.status, "failed");
  assert.equal(ticket.publicUpdates[0].delivery.parts.length, 1);
  const second = await maybePostTicketChannelUpdate(db, { ...base, postChannel: flaky });
  assert.equal(second.delivery.status, "posted");
  assert.equal(new Set(sent).size, sent.length, "no part sent twice");
  assert.equal(ticket.publicUpdates[0].delivery.parts.length, sent.length);
  assert.deepEqual(ticket.publicUpdates[0].delivery.parts.map((p) => p.index), sent.map((_, i) => i));
});

test("card mode is unchanged: one card edit, no channel messages", async () => {
  const ticket = { _id: "t", ticketNumber: 9, discordChannelId: "c1", intake: { cardMessageId: "card" }, publicUpdates: [] };
  let edits = 0, posts = 0;
  const r = await maybePostTicketChannelUpdate(fakeDb(ticket), {
    ...base, deliveryMode: "card",
    postChannel: async () => { posts++; return { posted: true, id: "x" }; },
    editCard: async () => { edits++; return { posted: true, via: "intake-card", id: "card", channel: "c1" }; },
  });
  assert.equal(r.posted, true);
  assert.equal(edits, 1);
  assert.equal(posts, 0);
});
