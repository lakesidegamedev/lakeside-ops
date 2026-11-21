#!/usr/bin/env node
"use strict";

// Make kanban cards agree with their support tickets, from the command line.
// Dry run by default: prints what the pass would change and changes nothing.
// A dry run works on a snapshot copy of the kanban database, so not even the
// one-time ticket-link backfill touches the live file.
// The ops web app runs the same pass every 10 minutes (kanban-tickets.js).
//
//   OPS_KANBAN_DB=/path/kanban.db MONGODB_URI=... node scripts/kanban-ticket-reconcile.js [--apply] [--limit N]
//
// Tickets are read from the tickets collection in TICKETS_DB_NAME (default
// "a-house-divided", the database the dashboard reads). A .env beside the app
// is loaded when present, the same way server.js does.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) require("dotenv").config({ path: envPath });

const { openKanban, defaultDbPath } = require("../kanban-store");
const { createTicketStatusReader, runTicketReconcile } = require("../kanban-tickets");

const apply = process.argv.includes("--apply");
const li = process.argv.indexOf("--limit");
const limit = li > -1 ? Number(process.argv[li + 1]) : undefined;

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required to read ticket records");
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 2, serverSelectionTimeoutMS: 10_000, directConnection: true });
  const live = defaultDbPath();
  let snapshot = null;
  if (!apply) {
    const Database = require("better-sqlite3");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-dry-run-"));
    snapshot = path.join(dir, "kanban.db");
    const source = new Database(live, { readonly: true, fileMustExist: true });
    try { await source.backup(snapshot); } finally { source.close(); }
  }
  const kanban = openKanban(snapshot || live);
  try {
    await client.connect();
    const reader = createTicketStatusReader({ getDb: () => client.db(process.env.TICKETS_DB_NAME || "a-house-divided"), timeoutMs: 15_000 });
    const out = await runTicketReconcile({ store: kanban, reader, dryRun: !apply, limit });
    console.log(JSON.stringify({ db: live, ...(snapshot ? { snapshot } : {}), ...out }, null, 2));
  } finally {
    kanban.close();
    if (snapshot) fs.rmSync(path.dirname(snapshot), { recursive: true, force: true });
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[kanban-ticket-reconcile] ${error.stack || error}`);
  process.exitCode = 1;
});
