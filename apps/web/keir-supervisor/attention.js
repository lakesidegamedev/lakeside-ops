"use strict";
// Minimal attention projection for the private supervisor. One small file per
// approval proposal, written outside the transcript store, so the app push
// dispatcher can learn "proposal X needs the owner" without ever reading chat,
// titles, summaries or patches. The file carries only an id, a state and two
// timestamps. It is an alert, never an authorization: approving still needs the
// authenticated, digest-bound request in routes.js.
//
// The matching reader is apps/agent/lib/operator/supervisorattention.js. Both
// sides share this contract: `<dir>/<proposalId>.json` =
//   { version: 1, kind: "supervisor-approval", id, state: "pending" | "closed", createdAt, updatedAt }
const fs = require("node:fs");
const path = require("node:path");

const ID = /^p_[a-f0-9]{16}$/;
const FILE = /^(p_[a-f0-9]{16})\.json$/;
const KEEP_CLOSED_MS = 7 * 86400000;

function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")).state || null; } catch { return null; }
}

// `dir` must be an explicit absolute path. No dir disables the projection.
function createAttention({ dir, now = Date.now, log = () => {} } = {}) {
  if (!dir) return null;
  if (!path.isAbsolute(dir)) throw new Error("KEIR_APPROVAL_ATTENTION_DIR must be absolute");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const wrote = new Map();

  // Bring the projection in line with the proposals. Safe to call any time and
  // as often as wanted: unchanged proposals cost no I/O after the first pass.
  // Returns the number of files it could not write, so the caller can retry.
  function sync(proposals) {
    let failed = 0;
    const seen = new Set();
    for (const p of Object.values(proposals || {})) {
      if (!ID.test(p.id)) continue;
      seen.add(p.id);
      const want = p.state === "pending" ? "pending" : "closed";
      if (wrote.get(p.id) === want) continue;
      const file = path.join(dir, `${p.id}.json`);
      try {
        // A proposal that was never alerted about needs no closing file.
        if (want === "closed" && readState(file) !== "pending") { wrote.set(p.id, want); continue; }
        writeAtomic(file, { version: 1, kind: "supervisor-approval", id: p.id, state: want, createdAt: p.createdAt, updatedAt: now() });
        wrote.set(p.id, want);
      } catch (error) { failed += 1; log(`keir-supervisor: attention projection ${p.id}: ${error.message}`); }
    }
    // A projection whose proposal was pruned can no longer be answered: close it, then age closed files out.
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return failed; }
    for (const name of names) {
      const m = FILE.exec(name);
      if (!m) continue;
      const file = path.join(dir, name);
      try {
        const body = JSON.parse(fs.readFileSync(file, "utf8"));
        if (body.state === "pending" && !seen.has(m[1])) writeAtomic(file, { ...body, state: "closed", updatedAt: now() });
        else if (body.state === "closed" && now() - (body.updatedAt || 0) > KEEP_CLOSED_MS) { fs.rmSync(file, { force: true }); wrote.delete(m[1]); }
      } catch { /* a half-written or foreign file is the reader's problem, not a reason to stop */ }
    }
    return failed;
  }

  return { dir, sync };
}

module.exports = { createAttention, ID };
