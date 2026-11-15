#!/usr/bin/env node
"use strict";
// Collects one Reset Watch snapshot from the game database (read-only) and the
// deploy pipeline's release records, then writes latest.json and appends one
// line per turn to the world's history file. Safe to run every few minutes.
//
// Env: RESET_WATCH_MONGODB_URI, else HEAL_MONGODB_URI_PROD (the live game
// database; the dashboard's own MONGODB_URI is the ops tools store, not the
// game), RESET_WATCH_DB, RESET_WATCH_DIR, AUTODEPLOY_DIR.
const fs = require("node:fs");
const { MongoClient } = require("mongodb");
const rw = require("../reset-watch");

async function main() {
  const uri = process.env.RESET_WATCH_MONGODB_URI || process.env.HEAL_MONGODB_URI_PROD;
  if (!uri) throw new Error("RESET_WATCH_MONGODB_URI or HEAL_MONGODB_URI_PROD is required");
  const dir = process.env.RESET_WATCH_DIR || "/var/lib/lakeside-ops-dashboard/reset-watch";
  const autodeployDir = process.env.AUTODEPLOY_DIR || "/var/lib/autodeploy";
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const client = new MongoClient(uri, { maxPoolSize: 4, serverSelectionTimeoutMS: 15000 });
  await client.connect();
  try {
    const db = client.db(process.env.RESET_WATCH_DB || "a-house-divided");
    const gameState = await rw.readGameState(db);
    const worldId = rw.worldIdentity(gameState).id;
    const history = rw.loadHistory(dir, worldId);
    const turnHistory = rw.loadTurns(dir, worldId);
    const snapshot = await rw.collect(db, { autodeployDir, history, turnHistory, gameState });
    rw.writeLatest(dir, snapshot);
    const res = rw.appendHistory(dir, snapshot);
    console.log(JSON.stringify({ world: snapshot.world.id, turn: snapshot.world.turn, historyTurns: res.turns, verdicts: Object.fromEntries(Object.entries(snapshot.verdicts).map(([k, v]) => [k, v.level])) }));
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`reset-watch collect failed: ${e.message}`);
  process.exitCode = 1;
});
