#!/usr/bin/env node
"use strict";

// Backfill the durable ticket history from the support records that exist,
// then check the store against them.
//   node mcp/support-history-backfill.js [--dry-run | --embed-only] [--env <file>]
// MONGODB_URI (and MONGODB_DIRECT_CONNECTION) select the database, as for the
// support server. TICKET_HISTORY_EMBED_URL enables search by meaning.
// Safe to re-run: events are keyed, so a second run stores nothing new.

const args = process.argv.slice(2);
const envAt = args.indexOf("--env");
if (envAt >= 0) require("dotenv").config({ quiet: true, path: args[envAt + 1], override: true });
const dryRun = args.includes("--dry-run");
const embedOnly = args.includes("--embed-only");

const { MongoClient } = require("mongodb");
const h = require("./support-history");

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI, { directConnection: /^(1|true)$/i.test(process.env.MONGODB_DIRECT_CONNECTION || "") });
  await client.connect();
  const db = client.db();
  const cfg = h.configFromEnv();
  const tickets = db.collection("tickets");

  // What the support records hold, counted independently of the projector.
  const [src] = await tickets.aggregate([{ $group: {
    _id: null,
    tickets: { $sum: 1 },
    messages: { $sum: { $size: { $ifNull: ["$messages", []] } } },
    posts: { $sum: { $size: { $filter: { input: { $ifNull: ["$publicUpdates", []] }, cond: { $ne: ["$$this.kind", "resolution"] } } } } },
    statuses: { $sum: { $size: { $ifNull: ["$statusHistory", []] } } },
    receipts: { $sum: { $add: [{ $size: { $ifNull: ["$resolutionHistory", []] } }, { $cond: [{ $ifNull: ["$resolution", false] }, 1, 0] }] } },
  } }]).toArray();
  console.log("support records:", JSON.stringify({ tickets: src.tickets, messages: src.messages, supportPosts: src.posts, statusChanges: src.statuses, receipts: src.receipts }));

  if (dryRun) {
    let events = 0;
    for await (const t of tickets.find({})) events += h.eventsFromTicket(t, cfg).length;
    console.log(`dry run: ${events} events would be derived`);
    await client.close();
    return;
  }

  const r = embedOnly
    ? { embedded: await h.embedMissing(db, cfg, { log: () => {} }) }
    : await h.backfill(db, cfg, { log: (m) => console.log(m) });
  console.log("backfill:", JSON.stringify(r));

  const H = db.collection(h.HISTORY);
  const byKind = Object.fromEntries((await H.aggregate([{ $group: { _id: "$kind", n: { $sum: 1 } } }]).toArray()).map((x) => [x._id, x.n]));
  const messageEvents = ["player_message", "staff_message", "participant_message", "agent_message", "system_message"].reduce((a, k) => a + (byKind[k] || 0), 0);
  const digests = await db.collection(h.DIGESTS).countDocuments();
  const embedded = await db.collection(h.DIGESTS).countDocuments({ embedding: { $exists: true } });
  const ticketsWithHistory = (await H.distinct("ticketNumber")).length;
  console.log("store:", JSON.stringify({ byKind, messageEvents, digests, embedded, ticketsWithHistory }));
  // Identical messages from one author in the same millisecond collapse into
  // one event, so messageEvents may be a little below the source count.
  const check = {
    everyTicketHasHistory: ticketsWithHistory === src.tickets && digests === src.tickets,
    messagesCovered: `${messageEvents}/${src.messages}`,
    postsCovered: `${byKind.support_post || 0}/${src.posts} (plus ticket-only replies still held)`,
    statusCovered: `${byKind.status || 0}/${src.statuses}`,
    receiptsCovered: `${byKind.resolution || 0}/${src.receipts}`,
  };
  console.log("check:", JSON.stringify(check));
  await client.close();
}

main().catch((e) => { console.error("backfill failed:", e.message); process.exit(1); });
