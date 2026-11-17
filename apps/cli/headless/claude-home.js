"use strict";
// Per-activation HOME for a headless Claude Code run. Each run makes a throwaway home under the state directory
// (credentials symlink, plugin and session scratch). Nothing removed them: /var/lib/keir-operator held 5275 by
// 2026-11-17. The run now removes its own home when it ends, and the operator sweeps leftovers at startup.
const fs = require("node:fs");
const path = require("node:path");

const PREFIX = "claude-home-";

function makeHome(stateDir) {
  const home = fs.mkdtempSync(path.join(stateDir, PREFIX));
  fs.mkdirSync(path.join(home, ".claude"), { mode: 0o700 });
  return home;
}

// rmSync with recursive does not follow symlinks, so the credentials link is deleted and the credentials file is not.
function removeHome(home) {
  if (!home || !path.basename(home).startsWith(PREFIX)) return false;
  try { fs.rmSync(home, { recursive: true, force: true }); return true; } catch { return false; }
}

// Directories some live process still has as its HOME or working directory. Linux only; null when /proc is not
// readable, in which case the caller must not sweep (an unknown is never "unused").
function homesInUse(stateDir, { procDir = "/proc" } = {}) {
  let pids; try { pids = fs.readdirSync(procDir).filter((n) => /^\d+$/.test(n)); } catch { return null; }
  if (!pids.length) return null;
  const root = path.resolve(stateDir) + path.sep, used = new Set();
  const mark = (text) => { for (const m of String(text).matchAll(new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + PREFIX + "[^/\\0\\s]+", "g"))) used.add(m[0]); };
  for (const pid of pids) {
    try { mark(fs.readFileSync(path.join(procDir, pid, "environ"), "latin1")); } catch {}
    try { mark(fs.readlinkSync(path.join(procDir, pid, "cwd"))); } catch {}
  }
  return used;
}

// Remove homes older than maxAgeMs that no live process uses. Returns counts; never throws.
function sweepStaleHomes({ stateDir, now = Date.now(), maxAgeMs = 24 * 3600000, procDir, log = () => {} }) {
  const out = { scanned: 0, removed: 0, inUse: 0, young: 0, failed: 0, skipped: null };
  let names; try { names = fs.readdirSync(stateDir).filter((n) => n.startsWith(PREFIX)); } catch { out.skipped = "state directory unreadable"; return out; }
  const used = homesInUse(stateDir, { procDir });
  if (!used) { out.skipped = "process table unreadable"; return out; }
  for (const name of names) {
    const full = path.join(stateDir, name);
    let st; try { st = fs.lstatSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    out.scanned++;
    if (now - st.mtimeMs < maxAgeMs) { out.young++; continue; }
    if (used.has(full)) { out.inUse++; continue; }
    if (removeHome(full)) out.removed++; else out.failed++;
  }
  if (out.removed || out.failed) log(`claude homes: removed ${out.removed} stale, ${out.failed} failed, ${out.inUse} in use`);
  return out;
}

module.exports = { PREFIX, makeHome, removeHome, homesInUse, sweepStaleHomes };
