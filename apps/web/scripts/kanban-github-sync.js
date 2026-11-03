#!/usr/bin/env node
"use strict";

// Pull GitHub issues into the ops kanban, then run board hygiene (release
// quiet cards, inbox unowned ones, expire old backlog). Run by
// ops-kanban-github-sync.timer every 15 minutes; agents can also trigger the
// sync with the kanban_github_sync MCP tool. Uses the `gh` CLI (GH_BIN,
// default "gh") with the caller's auth. --no-maintain skips hygiene.
//
//   OPS_KANBAN_DB=/path/kanban.db node scripts/kanban-github-sync.js [--repo owner/name]

const { openKanban } = require("../kanban-store");

const i = process.argv.indexOf("--repo");
const repo = i > -1 ? process.argv[i + 1] : null;
const kanban = openKanban();

kanban.syncGithub({ repo })
  .then((results) => {
    const maintained = process.argv.includes("--no-maintain") ? null : kanban.maintain();
    console.log(JSON.stringify({ db: kanban.path, synced: results, maintained }));
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(`[kanban-sync] ${error.stack || error}`);
    process.exitCode = 1;
  })
  .finally(() => kanban.close());
