#!/usr/bin/env node
"use strict";

// One-time move of Keir's open counter cards (automatic tool-gap and failure
// alert cards) off the board into the counter list. Dry run by default, on a
// snapshot copy of the kanban database: prints which cards would move, under
// which signature, which cards stay because someone worked on them, and
// changes nothing. --apply writes to the live database: each card's history
// is replayed into its counter and the card is completed with a note saying
// where it went. Running it twice moves nothing the second time.
//
//   OPS_KANBAN_DB=/path/kanban.db node scripts/kanban-counters-migrate.js [--apply] [--limit N] [--brief]

const fs = require("node:fs");
const path = require("node:path");
const { openKanban, defaultDbPath } = require("../kanban-store");
const { snapshotOf } = require("./kanban-reconcile");

const apply = process.argv.includes("--apply");
const brief = process.argv.includes("--brief");
const li = process.argv.indexOf("--limit");
const limit = li > -1 ? Number(process.argv[li + 1]) : 500;

async function main() {
  const live = defaultDbPath();
  const snapshot = apply ? null : await snapshotOf(live);
  const kanban = openKanban(snapshot || live);
  try {
    const out = kanban.counters.migrateCards({ dryRun: !apply, limit });
    // A dry run also shows the counter list the move would produce, from the snapshot.
    let preview = null;
    if (!apply) {
      kanban.counters.migrateCards({ dryRun: false, limit });
      preview = kanban.counters.list({ limit: 25 }).counters.map((c) => ({ signature: c.signature, last_7_days: c.last_7_days, last_30_days: c.last_30_days, tasks: c.tasks, tickets: c.tickets.slice(-5), cards: c.migrated_from_cards }));
    }
    const shown = brief ? { ...out, changes: undefined } : out;
    console.log(JSON.stringify({ db: live, ...(snapshot ? { snapshot } : {}), ...shown, ...(preview ? { top_counters_after: preview } : {}) }, null, 2));
  } finally {
    kanban.close();
    if (snapshot) fs.rmSync(path.dirname(snapshot), { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[kanban-counters-migrate] ${error.stack || error}`);
  process.exitCode = 1;
});
