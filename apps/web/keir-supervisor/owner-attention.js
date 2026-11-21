"use strict";
// What needs the owner right now. One function, used by both the private chat
// (its owner_attention tool and the "needs you" line in every job's context)
// and GET /api/keir/supervisor/attention, so the chat and the app's "needs you"
// count are computed from the same records by the same rules.
//
// It mirrors apps/ios/Ops/Attention.swift (AttentionCenter) over the server
// records the app reads:
//   1. operator decisions in state "pending" whose task origin is valid
//      (what /api/keir/app/decisions returns: appchannel.js pendingDecisions)
//   2. Keir questions in state "pending" whose task is still open
// The app also reads `needs_owner` from /api/kanban/brief, but the brief has
// never carried that key (kanban-store.js brief()), so board cards add nothing
// to the app's count and are not counted here either. Owner decisions are asked
// in chat, not through board flags.
// Tickets and tasks the app shows as "needs-you" get that state only from a
// pending decision or question in their task family (apps/agent workqueue.js
// workStatus), so they are already counted above and are not added twice.
//
// Run directly (node owner-attention.js) it prints the same JSON, which is how
// the chat model refreshes the list mid-job.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { formatET } = require("./et");

const LEDGER = process.env.KEIR_LEDGER || "/var/lib/keir-operator/ledger.json";
const JOB_TERMINAL = new Set(["done", "cancelled", "dismissed"]);

// Copy of apps/agent/lib/operator/ownermuse-policy.js origin(). The web app
// ships alone, so it cannot require the agent. owner-attention.test.js checks
// the two agree when both are present.
function normalized(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalized);
  return Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, normalized(value[k])]));
}
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(normalized(value))).digest("hex");
const appHint = (job) => job?.replyChannel === "app" || job?.channelId === "app" || job?.source?.channelId === "app";
function origin(data, job) {
  const visited = new Set();
  let current = job, scoped = false, missingReceipt = false;
  while (current) {
    if (visited.has(current.id)) return { scoped: true, valid: false };
    visited.add(current.id);
    const r = data.ownerMuseOrigins?.[current.id];
    scoped ||= Boolean(r) || appHint(current);
    if (data.jobs[current.id] !== current) return { scoped: true, valid: false };
    if (r) {
      const { digest: saved, ...payload } = r;
      if (missingReceipt || saved !== digest(payload) || r.jobId !== current.id || (r.parentId || null) !== (current.codingParent || current.museParent || null)) return { scoped: true, valid: false };
      if (!r.parentId) {
        if (r.via !== "authenticated-app-owner" || !r.actorId || !r.messageId) return { scoped: true, valid: false };
        return { scoped: true, valid: true };
      }
      const parentReceipt = data.ownerMuseOrigins?.[r.parentId];
      if (!parentReceipt || parentReceipt.digest !== r.parentDigest) return { scoped: true, valid: false };
    } else {
      missingReceipt = true;
      if (scoped) return { scoped: true, valid: false };
    }
    const parentId = current.codingParent || current.museParent;
    if (!parentId) return { scoped: false, valid: true };
    current = data.jobs[parentId];
    if (!current) return { scoped: true, valid: false };
  }
  return { scoped: true, valid: false };
}

const clip = (s, n = 200) => String(s || "").replace(/[–—]/g, ", ").replace(/\s+/g, " ").trim().slice(0, n);
const ticketNumber = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };

// ledger: the parsed operator ledger, or null when it could not be read.
function ownerAttention({ ledger, now = Date.now() } = {}) {
  const items = [];
  const seen = new Set();
  const data = ledger && typeof ledger === "object" ? { ...ledger, jobs: ledger.jobs || {} } : null;
  if (data) {
    const decisions = Object.values(data.decisions || {})
      .filter((x) => x && x.state === "pending")
      .filter((x) => { const o = origin(data, data.jobs[x.jobId]); return !o.scoped || o.valid; })
      .sort((a, b) => (b.at || 0) - (a.at || 0));
    for (const x of decisions) {
      const id = `decision:${x.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const ticket = ticketNumber(x.ticket ?? data.jobs[x.jobId]?.ticket);
      items.push({ id, kind: "decision", title: clip(x.review?.title || x.question || "Decision"), question: clip(x.question, 400), ticket, since: x.at || null, sinceET: formatET(x.at, { date: true }) });
    }
    const questions = Object.values(data.appThread?.questions || {})
      .filter((q) => q && q.state === "pending" && data.jobs[q.jobId] && !JOB_TERMINAL.has(data.jobs[q.jobId].state));
    for (const q of questions) {
      const id = `question:${q.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, kind: "question", title: clip(q.title || q.questions?.[0]?.prompt || "Keir question"), ticket: null, since: q.at || null, sinceET: formatET(q.at, { date: true }) });
    }
  }
  const complete = Boolean(data);
  return {
    count: items.length, items, checkedAt: new Date(now).toISOString(), checkedAtET: formatET(now, { date: true }), complete,
    summary: !complete
      ? "Could not read Keir's decisions and questions, so I cannot say whether anything needs the owner."
      : items.length === 0 ? "Nothing needs the owner right now." : `${items.length} ${items.length === 1 ? "thing needs" : "things need"} the owner.`,
  };
}

function readLedger(file = LEDGER) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// The live read both the route and the chat use.
function readOwnerAttention({ ledgerPath = LEDGER, now = Date.now() } = {}) {
  return ownerAttention({ ledger: readLedger(ledgerPath), now });
}

if (require.main === module) process.stdout.write(`${JSON.stringify(readOwnerAttention(), null, 2)}\n`);

module.exports = { ownerAttention, readOwnerAttention, origin, JOB_TERMINAL };
