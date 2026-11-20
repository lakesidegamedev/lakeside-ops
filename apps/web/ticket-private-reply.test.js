"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { maybePostTicketChannelUpdate, retryPendingTicketUpdates } = require("./ticket-ship-notify");
const { publicTimeline } = require("./ticket-receipt");
const { COLLECTION } = require("./ticket-private-reply");

const FIGURES = "Your shop made 4,812,345 in sales and paid 61,200 in fees.";
const noRows = async () => {};

function setPath(obj, dotted, value) {
  const parts = dotted.split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] = o[p] || {};
  o[parts.at(-1)] = value;
}

// Minimal Mongo stand-in: tickets (push / positional set / plain set) and the private collection.
function makeDb(ticket) {
  const priv = [];
  const tickets = {
    findOne: async () => ticket,
    find: () => ({ limit: () => ({ toArray: async () => [ticket] }) }),
    updateOne: async (filter, update) => {
      if (update.$push?.publicUpdates) {
        if ((ticket.publicUpdates || []).some((u) => u.key === update.$push.publicUpdates.key)) return { modifiedCount: 0 };
        ticket.publicUpdates = [...(ticket.publicUpdates || []), update.$push.publicUpdates];
      }
      const wanted = filter["publicUpdates.key"] || filter.publicUpdates?.$elemMatch?.key;
      for (const [k, v] of Object.entries(update.$set || {})) {
        if (k.startsWith("publicUpdates.$.")) {
          const entry = ticket.publicUpdates.find((u) => u.key === wanted);
          setPath(entry, k.slice("publicUpdates.$.".length), v);
        } else setPath(ticket, k, v);
      }
      return { modifiedCount: 1 };
    },
  };
  const privateReplies = {
    findOne: async (f) => priv.find((r) => r.ticketNumber === f.ticketNumber && r.key === f.key) || null,
    updateOne: async (f, u, o) => {
      let row = priv.find((r) => r.ticketNumber === f.ticketNumber && r.key === f.key);
      if (!row && o?.upsert) priv.push(row = { ...u.$setOnInsert });
      else if (row && u.$set) Object.assign(row, u.$set);
      return { modifiedCount: 1 };
    },
  };
  return { db: { collection: (name) => (name === COLLECTION ? privateReplies : tickets) }, priv };
}

const fixtureChannel = "12".repeat(9);
const baseTicket = () => ({ _id: "t1", ticketNumber: 9, discordChannelId: fixtureChannel, publicUpdates: [] });

test("a ticket-only answer reaches Discord exactly and the public receipt stays generic", async () => {
  const ticket = baseTicket();
  const { db, priv } = makeDb(ticket);
  const sent = [];
  const out = await maybePostTicketChannelUpdate(db, {
    ticketNumber: 9, key: "progress:1", kind: "progress", deliveryMode: "reply", message: FIGURES, ticketOnly: true,
    postChannel: async (_c, content) => { sent.push(content); return { posted: true, id: "m1", channel: fixtureChannel }; },
    stripRows: noRows,
  });
  assert.equal(out.posted, true);
  assert.ok(sent[0].includes("4,812,345"), "the player gets the actual answer");
  const entry = ticket.publicUpdates[0];
  assert.equal(entry.ticketOnly, true);
  assert.ok(!/4,812|61,200|sales|fees/.test(JSON.stringify(ticket.publicUpdates)), "no figures in the public fields");
  const timeline = JSON.stringify(publicTimeline(ticket));
  assert.ok(!/4,812|61,200|sales|fees/.test(timeline), "no figures on the receipt timeline");
  assert.ok(timeline.includes("ticket channel"));
  assert.equal(priv.length, 1);
  assert.equal(priv[0].state, "posted");
  assert.equal(priv[0].text, null, "the stored text is dropped once delivered");
  assert.ok(ticket.privateEvidence.at);
});

test("a receipt reader never shows a ticket-only message even if the stored text were not generic", () => {
  const ticket = { createdAt: new Date(), publicUpdates: [{ key: "k", kind: "progress", ticketOnly: true, message: FIGURES, at: new Date() }] };
  assert.ok(!JSON.stringify(publicTimeline(ticket)).includes("4,812"));
});

test("a failed delivery retries with the exact private text, idempotently, and stays generic publicly", async () => {
  const ticket = baseTicket();
  const { db, priv } = makeDb(ticket);
  const failing = await maybePostTicketChannelUpdate(db, {
    ticketNumber: 9, key: "progress:2", kind: "progress", deliveryMode: "reply", message: FIGURES, ticketOnly: true,
    postChannel: async () => ({ error: "discord 500" }), stripRows: noRows,
  });
  assert.equal(failing.posted, undefined);
  assert.equal(ticket.publicUpdates[0].delivery.status, "failed");
  assert.equal(priv[0].text, FIGURES);

  // The stock retry loop reads only publicUpdates, so it passes the generic text.
  const realFetch = global.fetch, realToken = process.env.DISCORD_BOT_TOKEN;
  const bodies = [];
  process.env.DISCORD_BOT_TOKEN = "test-token";
  global.fetch = async (_url, init) => { bodies.push(init && init.body ? JSON.parse(init.body).content : null); return { ok: true, json: async () => ({ id: "m2" }), text: async () => "" }; };
  try {
    const result = await retryPendingTicketUpdates(db, {});
    assert.equal(result.posted, 1);
  } finally { global.fetch = realFetch; if (realToken === undefined) delete process.env.DISCORD_BOT_TOKEN; else process.env.DISCORD_BOT_TOKEN = realToken; }
  assert.ok(bodies.some((b) => b && b.includes("4,812,345")), "retry sends the exact authorized text");
  assert.ok(!/4,812|sales/.test(JSON.stringify(ticket.publicUpdates)));
  assert.equal(priv.length, 1, "one private record per key");
  assert.equal(ticket.publicUpdates[0].delivery.status, "posted");
});

test("a retry does not send when the ticket moved to another channel", async () => {
  const ticket = baseTicket();
  const { db } = makeDb(ticket);
  await maybePostTicketChannelUpdate(db, {
    ticketNumber: 9, key: "progress:3", kind: "progress", deliveryMode: "reply", message: FIGURES, ticketOnly: true,
    postChannel: async () => ({ error: "discord 500" }), stripRows: noRows,
  });
  ticket.discordChannelId = "999999999999999999";
  let sends = 0;
  const out = await maybePostTicketChannelUpdate(db, {
    ticketNumber: 9, key: "progress:3", kind: "progress", deliveryMode: "reply", message: "x", ticketOnly: true,
    postChannel: async () => { sends++; return { posted: true, id: "m", channel: "c" }; }, stripRows: noRows,
  });
  assert.equal(sends, 0);
  assert.equal(out.skipped, "ticket channel changed");
});

test("a retry whose private record is gone fails closed instead of posting the generic line as the answer", async () => {
  const ticket = baseTicket();
  const { db, priv } = makeDb(ticket);
  await maybePostTicketChannelUpdate(db, {
    ticketNumber: 9, key: "progress:4", kind: "progress", deliveryMode: "reply", message: FIGURES, ticketOnly: true,
    postChannel: async () => ({ error: "discord 500" }), stripRows: noRows,
  });
  priv.length = 0;
  let sends = 0;
  const out = await maybePostTicketChannelUpdate(db, {
    ticketNumber: 9, key: "progress:4", kind: "progress", deliveryMode: "reply", message: "anything", ticketOnly: true,
    postChannel: async () => { sends++; return { posted: true, id: "m", channel: "c" }; }, stripRows: noRows,
  });
  assert.equal(sends, 0);
  assert.equal(out.skipped, "private text missing");
});

test("once a ticket used a private read, later updates and the resolution notice stay generic without the option", async () => {
  const ticket = baseTicket();
  const { db, priv } = makeDb(ticket);
  const post = async () => ({ posted: true, id: "m", channel: fixtureChannel });
  await maybePostTicketChannelUpdate(db, { ticketNumber: 9, key: "progress:5", kind: "progress", deliveryMode: "reply", message: FIGURES, ticketOnly: true, postChannel: post, stripRows: noRows });
  const later = "Your operating profit was 4,751,145 after fees.";
  await maybePostTicketChannelUpdate(db, { ticketNumber: 9, key: "progress:6", kind: "progress", deliveryMode: "reply", message: later, postChannel: post, stripRows: noRows });
  await maybePostTicketChannelUpdate(db, { ticketNumber: 9, key: "resolution:r1", kind: "resolution", message: `Resolved. ${later}`, receiptUrl: "https://example.test/t/tok", postChannel: post, stripRows: noRows });
  const publicJson = JSON.stringify(ticket.publicUpdates);
  assert.ok(!/4,751|4,812|profit|sales/.test(publicJson));
  assert.ok(ticket.publicUpdates.every((u) => u.ticketOnly === true));
  assert.equal(priv.length, 3);
});

test("normal public updates are unchanged: text is public, no private record, no marker", async () => {
  const ticket = baseTicket();
  const { db, priv } = makeDb(ticket);
  const sent = [];
  const out = await maybePostTicketChannelUpdate(db, {
    ticketNumber: 9, key: "production:1", kind: "production", deliveryMode: "reply", message: "The fix is live on the main server.",
    postChannel: async (_c, content) => { sent.push(content); return { posted: true, id: "m", channel: fixtureChannel }; }, stripRows: noRows,
  });
  assert.equal(out.posted, true);
  assert.equal(ticket.publicUpdates[0].message, "The fix is live on the main server.");
  assert.equal(ticket.publicUpdates[0].ticketOnly, undefined);
  assert.equal(priv.length, 0);
  assert.equal(ticket.privateEvidence, undefined);
  assert.equal(out.ticketOnly, undefined);
  assert.ok(JSON.stringify(publicTimeline(ticket)).includes("The fix is live on the main server."));
});
