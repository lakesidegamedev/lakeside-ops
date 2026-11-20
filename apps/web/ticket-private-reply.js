"use strict";
// Keir 11.1: ticket-only replies.
//
// A reply that quotes a reporter's confidential game figures belongs in the
// reporter's own Discord channel and nowhere else. The public receipt at
// /t/<token> is a capability URL, so it renders publicUpdates[].message to
// anyone holding the link, and older receipt readers read that field too.
//
// A narrowed update therefore stores only generic status text in
// publicUpdates (message, plus ticketOnly: true). The exact text the channel
// receives lives in its own collection, keyed by (ticketNumber, key), and is
// what a Discord retry re-sends. Nothing here guesses from numbers or names:
// a reply is narrowed only when the caller asked (broker-verified reporter
// read, or a staged private chart) or the ticket was already marked.

const COLLECTION = "ticketPrivateReplies";

const GENERIC = Object.freeze({
  resolution: "Your ticket was closed. The details of the answer are in your ticket channel.",
  development: "A fix is being tested. Details are in your ticket channel.",
  production: "A fix is live. Details are in your ticket channel.",
  heal: "Your game data was corrected. Details are in your ticket channel.",
  context: "We asked for more detail in your ticket channel.",
  progress: "The team replied in your ticket channel. The details are shown there only.",
});

function genericMessage(kind) {
  return GENERIC[String(kind || "").toLowerCase()] || GENERIC.progress;
}

// Narrowing is sticky per ticket: once a private reporter read has been used
// in a ticket, every later reply on it is ticket-only.
function isNarrowed({ ticket, existing, ticketOnly } = {}) {
  return ticketOnly === true
    || Boolean(existing && existing.ticketOnly === true)
    || Boolean(ticket && ticket.privateEvidence && ticket.privateEvidence.at);
}

const indexed = new WeakSet();
async function collectionFor(db) {
  const col = db.collection(COLLECTION);
  if (typeof col.createIndex === "function" && !indexed.has(col)) {
    indexed.add(col);
    await col.createIndex({ ticketNumber: 1, key: 1 }, { unique: true }).catch(() => {});
  }
  return col;
}

/**
 * Idempotently store the exact text for one update. The first text stored
 * under a key wins, so a retry can never change what the reporter is sent.
 * Returns the stored record.
 */
async function savePrivateReply(db, ticket, { key, kind, text, deliveryMode, now = new Date() }) {
  const col = await collectionFor(db);
  const filter = { ticketNumber: Number(ticket.ticketNumber), key: String(key) };
  await col.updateOne(filter, {
    $setOnInsert: {
      ...filter,
      ticketId: String(ticket._id),
      channelId: ticket.discordChannelId ? String(ticket.discordChannelId) : null,
      kind: String(kind || "update").slice(0, 40),
      deliveryMode: deliveryMode || null,
      text: String(text),
      state: "unsent",
      createdAt: now,
    },
  }, { upsert: true });
  return col.findOne(filter);
}

async function markPosted(db, ticket, key, now = new Date()) {
  const col = await collectionFor(db);
  // The text has done its job once Discord has every part.
  await col.updateOne({ ticketNumber: Number(ticket.ticketNumber), key: String(key) }, { $set: { state: "posted", text: null, postedAt: now } });
}

async function loadPrivateReply(db, ticketNumber, key) {
  return (await collectionFor(db)).findOne({ ticketNumber: Number(ticketNumber), key: String(key) });
}

// The record is only sendable to the conversation it was written for.
function ownershipRefusal(ticket, record) {
  if (!record) return "private text missing";
  if (record.state === "posted" || record.text == null) return "private text already delivered";
  if (String(record.ticketId) !== String(ticket._id)) return "ticket changed";
  if (!ticket.discordChannelId || String(record.channelId) !== String(ticket.discordChannelId)) return "ticket channel changed";
  return null;
}

// Remember on the ticket that a private read was used. Idempotent.
async function markTicket(tickets, ticket, now = new Date()) {
  if (ticket.privateEvidence && ticket.privateEvidence.at) return;
  await tickets.updateOne({ _id: ticket._id, "privateEvidence.at": { $exists: false } }, { $set: { privateEvidence: { at: now } } });
  ticket.privateEvidence = { at: now };
}

module.exports = { COLLECTION, genericMessage, isNarrowed, savePrivateReply, loadPrivateReply, markPosted, ownershipRefusal, markTicket };
