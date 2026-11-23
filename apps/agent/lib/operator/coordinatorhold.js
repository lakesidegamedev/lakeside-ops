"use strict";
// Keir 11.7.3 (owner, 2026-11-23, ticket 1890): when the coordinator answers a ticket itself, Keir must stay out of it
// entirely, including tasks the owner started. A ticket bot claim cannot express that (an owner claim lets owner tasks
// through), and the ledger is held in memory by the running operator. The hold is a small file the coordinator edits:
// { "1890": { "by": "coordinator", "at": "...", "until": "optional ISO time" } }.
const fs = require("node:fs");
const path = require("node:path");

function createCoordinatorHolds({ stateDir, now = () => Date.now(), file = null } = {}) {
  const target = file || (stateDir ? path.join(stateDir, "coordinator-holds.json") : null);
  function read() {
    if (!target) return {};
    try { const data = JSON.parse(fs.readFileSync(target, "utf8")); return data && typeof data === "object" ? data : {}; } catch { return {}; }
  }
  function held(ticket) {
    const n = Number(ticket);
    if (!Number.isFinite(n) || n <= 0) return null;
    const hold = read()[String(n)];
    if (!hold) return null;
    const until = hold.until ? Date.parse(hold.until) : NaN;
    if (Number.isFinite(until) && until <= now()) return null;
    return hold;
  }
  return { held, file: target };
}

module.exports = { createCoordinatorHolds };
