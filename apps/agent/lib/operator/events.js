"use strict";
// Keir 4.0 phase 1: the durable event sink. Every audit entry, delivery and
// effect receipt is appended to a SQLite file beside the ledger, with the
// identifiers the 4.0 evidence model needs: task (ticket or request), attempt
// (job), ticket, actor, operator release. The ledger stays the authority for
// running state; this is the evidence trail that outlives ledger trimming
// (audit keeps 5,000 rows, ticketPosts an hour) and that the Rust shadow will
// read without touching ledger.json. One writer: the operator process.
//
// node:sqlite ships with Node 22; the ExperimentalWarning it emits once is
// filtered here so journald does not carry it on every start.

const fs = require("node:fs");
const path = require("node:path");

function openSink(file, { release = null, now = () => Date.now() } = {}) {
  let DatabaseSync;
  try {
    // Node's default printer is itself a "warning" listener; swap it for one
    // that drops only the SQLite experimental notice.
    const printers = process.listeners("warning");
    process.removeAllListeners("warning");
    process.on("warning", (w) => { if (w.name === "ExperimentalWarning" && /SQLite/.test(w.message)) return; for (const p of printers) p(w); });
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (e) {
    return { enabled: false, reason: String(e.message), append() {}, count: () => 0, recent: () => [], byKind: () => [], close() {} };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      task_id TEXT,
      attempt_id TEXT,
      ticket INTEGER,
      actor TEXT,
      release TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_task ON events(task_id, at);
    CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket, at);
    CREATE INDEX IF NOT EXISTS events_kind ON events(kind, at);`);
  try { fs.chmodSync(file, 0o600); } catch {}
  const insert = db.prepare("INSERT INTO events (at, kind, task_id, attempt_id, ticket, actor, release, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const countStmt = db.prepare("SELECT count(*) AS n FROM events");
  const recentStmt = db.prepare("SELECT id, at, kind, task_id, attempt_id, ticket, actor, payload FROM events WHERE (? IS NULL OR ticket = ?) ORDER BY id DESC LIMIT ?");

  // fields: { taskId, attemptId, ticket, actor, ...payload }. Identity fields
  // are lifted out; everything else is the payload. Never throws: a failed
  // evidence write must not take the operator down, but it is logged.
  function append(kind, fields = {}) {
    const { taskId = null, attemptId = null, ticket = null, actor = null, ...payload } = fields || {};
    try {
      insert.run(now(), String(kind), taskId, attemptId, Number.isFinite(Number(ticket)) && ticket !== null ? Number(ticket) : null, actor, release, JSON.stringify(payload).slice(0, 20000));
    } catch (e) { console.error(`[keir] event sink write failed: ${e.message}`); }
  }
  const kindStmt = db.prepare("SELECT at, kind, task_id, ticket, payload FROM events WHERE kind = ? AND at >= ? ORDER BY id DESC LIMIT ?");
  // Keir 7: one kind of event since a time, newest first (capability gaps).
  const byKind = (kind, since, limit = 20000) => kindStmt.all(String(kind), Number(since) || 0, limit).map((r) => { let p = {}; try { p = JSON.parse(r.payload); } catch {} return { ...p, at: r.at, kind: String(r.kind).replace(/^audit:/, ""), job: p.job || r.task_id, ticket: r.ticket }; });
  const count = () => Number(countStmt.get().n);
  const recent = ({ ticket = null, limit = 50 } = {}) => recentStmt.all(ticket, ticket, limit).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  return { enabled: true, append, count, recent, byKind, close: () => db.close() };
}

// Attempt to task: a ticket job belongs to task `ticket:N`; anything else to
// `request:<root job id>` (the same ids workrecord.js projects).
function taskIdOf(job, jobs = {}) {
  if (!job) return null;
  let root = job; const seen = new Set();
  while (root?.codingParent && jobs[root.codingParent] && !seen.has(root.id)) { seen.add(root.id); root = jobs[root.codingParent]; }
  const ticket = job.ticket || root.ticket || Number(/^ticket-.*-(\d+)$/.exec(job.source?.channelName || "")?.[1] || 0);
  return ticket ? `ticket:${ticket}` : `request:${root.id}`;
}

// Wraps a ledger so every audit entry also lands in the sink with task
// identity resolved from the audited job, and gives the operator one place
// to record deliveries and receipts.
function attachSink(ledger, sink) {
  const audit = ledger.audit;
  ledger.audit = (kind, detail = {}) => {
    audit(kind, detail);
    const job = detail.job ? ledger.data.jobs[detail.job] : null;
    sink.append(`audit:${kind}`, { taskId: job ? taskIdOf(job, ledger.data.jobs) : detail.ticket ? `ticket:${detail.ticket}` : null,
      attemptId: detail.job || null, ticket: detail.ticket ?? job?.ticket ?? null, actor: detail.actor || null, ...detail });
  };
  return ledger;
}

module.exports = { openSink, attachSink, taskIdOf };
