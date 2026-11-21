#!/usr/bin/env node
"use strict";

// Make kanban cards agree with what they were raised from (support tickets,
// pull requests, alerts), from the command line. Dry run by default: prints
// what the pass would change and changes nothing. A dry run works on a
// snapshot copy of the kanban database, so not even the one-time link
// backfill touches the live file.
// The ops web app runs the same pass every 10 minutes (kanban-tickets.js).
//
//   OPS_KANBAN_DB=/path/kanban.db TICKETS_MONGODB_ENV_FILE=/path/game-db.env node scripts/kanban-reconcile.js [--apply] [--limit N]
//
// Tickets are read as ticket-db.js describes: TICKETS_MONGODB_ENV_FILE or
// TICKETS_MONGODB_URI, else MONGODB_URI; database TICKETS_DB_NAME (default
// "a-house-divided", the database the dashboard reads). Without any, or
// when the database has no tickets collection, the ticket rules are skipped. Pull requests are read with the gh CLI and
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
const { createTicketDb } = require("../ticket-db");

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
  const env = !process.env.TICKETS_MONGODB_ENV_FILE && !process.env.TICKETS_MONGODB_URI && process.env.MONGODB_URI
    ? { ...process.env, TICKETS_MONGODB_URI: process.env.MONGODB_URI, TICKETS_MONGODB_DIRECT_CONNECTION: "true" } : process.env;
  const ticketDb = createTicketDb(env);
  try {
    if (ticketDb.error) console.error(`[kanban-reconcile] ${ticketDb.error}: ticket rules skipped`);
    const reader = createTicketStatusReader({ getDb: ticketDb.getDb, unavailable: ticketDb.error, timeoutMs: 15_000 });
    const out = await runReconcile({ store: kanban, reader, ...createSourceReaders(), dryRun: !apply, limit });
    console.log(JSON.stringify({ db: live, ...(snapshot ? { snapshot } : {}), tickets_from: ticketDb.source, ...out }, null, 2));
  } finally {
    kanban.close();
    if (snapshot) fs.rmSync(path.dirname(snapshot), { recursive: true, force: true });
    await ticketDb.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[kanban-reconcile] ${error.stack || error}`);
    process.exitCode = 1;
  });
}

module.exports = { snapshotOf };
