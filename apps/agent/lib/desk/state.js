"use strict";
// Read-only loader for Keir's state. Never writes the ledger.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The operator replaces the file by rename, so a parse error means a rare torn read. Retry.
function readLedger(file, { tries = 5, wait = 80 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { last = e; if (e.code === "ENOENT") return {}; sleepSync(wait); }
  }
  throw last;
}

function readUsage(file, { maxBytes = 3 * 1024 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - maxBytes), buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const out = [];
    for (const line of lines) { if (!line.trim()) continue; try { const r = JSON.parse(line); if (r.event === "activation") out.push(r); } catch { /* partial line */ } }
    return out;
  } catch { return []; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function unitActive(unit) {
  try { return execFileSync("systemctl", ["is-active", unit], { encoding: "utf8", timeout: 4000 }).trim() === "active"; }
  catch { return false; }
}

function releaseOf(file) {
  try { return fs.readFileSync(file, "utf8").split("\n")[0].trim().slice(0, 60) || null; } catch { return null; }
}

function loadState(cfg, { now = Date.now() } = {}) {
  return {
    now,
    active: unitActive(cfg.unit),
    release: releaseOf(cfg.releaseFile),
    ledger: readLedger(path.join(cfg.stateDir, "ledger.json")),
    usage: readUsage(path.join(cfg.stateDir, "usage.jsonl")),
  };
}

module.exports = { loadState, readLedger, readUsage, unitActive, releaseOf };
