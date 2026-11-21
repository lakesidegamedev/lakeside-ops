#!/usr/bin/env node
"use strict";

// Make kanban cards agree with what they were raised from (support tickets,
// pull requests, alerts), from the command line. Dry run by default: prints
// what the pass would change and changes nothing. A dry run works on a
// snapshot copy of the kanban database, so not even the one-time link
// backfill touches the live file.
// The ops web app runs the same pass every 10 minutes (kanban-tickets.js).
//
//   OPS_KANBAN_DB=/path/kanban.db MONGODB_URI=... node scripts/kanban-reconcile.js [--apply] [--limit N]
//
// Tickets are read from the tickets collection in TICKETS_DB_NAME (default
// "a-house-divided", the database the dashboard reads); without MONGODB_URI
// the ticket rules are skipped. Pull requests are read with the gh CLI and
// unit state with systemctl (KANBAN_SOURCE_GITHUB=off / KANBAN_ALERT_SYSTEMD=off
// skip them). A .env beside the app is loaded when present, as server.js does.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) require("dotenv").config({ path: envPath });

const { openKanban, defaultDbPath } = require("../kanban-store");
const { createTicketStatusReader, runReconcile } = require("../kanban-tickets");
const { createSourceReaders } = require("../kanban-sources");

const apply = process.argv.includes("--apply");
const li = process.argv.indexOf("--limit");
const limit = li > -1 ? Number(process.argv[li + 1]) : undefined;

// A read-only copy of the live database for a dry run.
async function snapshotOf(live) {
  const Database = require("better-sqlite3");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-dry-run-"));
  const file = path.join(dir, "kanban.db");
  const source = new Database(live, { readonly: true, fileMustExist: true });
  try { await source.backup(file); } finally { source.close(); }
  return file;
}

async function main() {
  const live = defaultDbPath();
  const snapshot = apply ? null : await snapshotOf(live);
  const kanban = openKanban(snapshot || live);
  let client = null;
  try {
    let reader = null;
    if (process.env.MONGODB_URI) {
      const { MongoClient } = require("mongodb");
      client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 2, serverSelectionTimeoutMS: 10_000, directConnection: true });
      await client.connect();
      reader = createTicketStatusReader({ getDb: () => client.db(process.env.TICKETS_DB_NAME || "a-house-divided"), timeoutMs: 15_000 });
    } else {
      console.error("[kanban-reconcile] MONGODB_URI not set: ticket rules skipped");
    }
    const out = await runReconcile({ store: kanban, reader, ...createSourceReaders(), dryRun: !apply, limit });
    console.log(JSON.stringify({ db: live, ...(snapshot ? { snapshot } : {}), ...out }, null, 2));
  } finally {
    kanban.close();
    if (snapshot) fs.rmSync(path.dirname(snapshot), { recursive: true, force: true });
    if (client) await client.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[kanban-reconcile] ${error.stack || error}`);
    process.exitCode = 1;
  });
}

module.exports = { snapshotOf };
