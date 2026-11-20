"use strict";
// Reader for the private supervisor's attention projection (see
// apps/web/keir-supervisor/attention.js). The dispatcher gets a proposal id and
// whether it is still pending, never any chat, title, summary or patch. Needs an
// explicitly configured absolute directory; without one there is no reader and
// the rest of app push behaves exactly as before.
const fs = require("node:fs");
const path = require("node:path");

const FILE = /^(p_[a-f0-9]{16})\.json$/;
const MAX_BYTES = 2048;
// An approval nobody acted on for this long is no longer worth waking a phone for.
const ATTENTION_MAX_MS = 72 * 3600000;

function createAttentionReader({ dir, now = Date.now, maxAgeMs = ATTENTION_MAX_MS } = {}) {
  if (!dir) return null;
  const configured = path.isAbsolute(dir);
  function read(name) {
    const m = FILE.exec(name);
    if (!m) return null;
    try {
      const file = path.join(dir, name);
      if (fs.statSync(file).size > MAX_BYTES) return null;
      const b = JSON.parse(fs.readFileSync(file, "utf8"));
      if (b.version !== 1 || b.kind !== "supervisor-approval" || b.id !== m[1] || !["pending", "closed"].includes(b.state) || !Number.isFinite(b.createdAt)) return null;
      return { id: b.id, state: b.state, createdAt: b.createdAt };
    } catch { return null; }
  }
  const live = (row) => Boolean(row) && row.state === "pending" && now() - row.createdAt <= maxAgeMs;
  return {
    configured,
    // Pending, fresh proposals, oldest first. An unreadable directory is an empty answer, not a crash.
    pending() {
      if (!configured) return [];
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return []; }
      return names.map(read).filter(live).sort((a, b) => a.createdAt - b.createdAt);
    },
    // Fresh read, used again right before a send and when a held-back send is released.
    isPending(id) { return configured && FILE.test(`${id}.json`) && live(read(`${id}.json`)); },
  };
}

module.exports = { createAttentionReader, ATTENTION_MAX_MS };
