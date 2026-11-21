"use strict";
const { JOB_TERMINAL } = require("./machines");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { track } = require("./machines");

// One writer owns the ledger. Corruption is fatal: authority must never reset.
function createLedger(file) {
  let data = { version: 1, paused: false, cursors: {}, seen: {}, jobs: {}, actions: {}, outbox: {}, channels: {}, intake: [], audit: [] };
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (data.version !== 1) throw new Error("unsupported operator ledger version");
  let lastSaved = null;
  // Every job and approval request has its state checked against machines.js.
  // Records are created in several files, so save() sweeps for new ones too.
  const unexpected = (machine, record, from, to) => audit("unexpected_transition", { machine, [machine]: record.id, from, to, ticket: record.ticket });
  function trackAll() {
    for (const j of Object.values(data.jobs || {})) track(j, "job", unexpected);
    for (const a of Object.values(data.actions || {})) track(a, "action", unexpected);
    for (const x of Object.values(data.decisions || {})) track(x, "decision", unexpected);
    for (const r of Object.values(data.codingWorkers?.runs || {})) track(r, "codingRun", unexpected);
    for (const f of Object.values(data.watch?.findings || {})) track(f, "finding", unexpected);
  }
  trackAll();
  function save() {
    trackAll();
    const serialized = JSON.stringify(data);
    // drain runs every second, including when idle. Only skip byte-identical
    // snapshots that this writer has already durably committed. Changed
    // receipts fsync the file and, on POSIX, its directory. Windows does not
    // support fsync on directory handles; a file flush must still succeed.
    if (serialized === lastSaved) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp`;
    const fd = fs.openSync(temp, "w", 0o600);
    try { fs.writeSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    if (process.platform !== "win32") {
      const dir = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    lastSaved = serialized;
  }
  const id = () => crypto.randomBytes(6).toString("hex");
  // Calls go through the exported handle so a sink attached later (events.js)
  // sees the ledger's own internal audits too, not only callers'.
  function audit(kind, detail) { ledger.audit(kind, detail); }
  function auditLocal(kind, detail) { data.audit.push({ at: Date.now(), kind, ...detail }); data.audit = data.audit.slice(-5000); }
  // The owner does not want Keir DMs (2026-10-12). Everything Keir would page
  // them about lands in alerts for /status, the ops dashboard and the shadow
  // review. Only Keir's reply to a task the owner gave it by DM still DMs.
  const QUIET = /^(?:close-stalled|deadline|scan-error|intake-delivery|delivery|legacy-handoff|closed|error|decision|action|effect-error|recovery|digest):/;
  function notify(key, destination, content, extra = {}) {
    if (destination === "owner" && QUIET.test(key)) {
      data.alerts = [...(data.alerts || []).filter((a) => a.key !== key), { key, content: String(content).slice(0, 2000), at: Date.now() }].slice(-200);
      console.log(`[keir] alert ${key}: ${String(content).slice(0, 300)}`);
      return;
    }
    if (!data.outbox[key]) data.outbox[key] = { id: id(), destination, content, at: Date.now(), attempts: 0, ...extra };
  }
  function createJob(key, fields) {
    if (data.seen[key]) return data.jobs[data.seen[key]];
    const job = { id: id(), state: "queued", at: Date.now(), updatedAt: Date.now(), rounds: 0, messages: [], effects: {}, ...fields };
    // Keir 11.2: a finding remembers the game world it was raised in, so it can expire when that world is gone (closing.js).
    if (job.kind === "finding" && job.world === undefined && data.watch?.turnClock?.iteration != null) job.world = data.watch.turnClock.iteration;
    data.jobs[job.id] = track(job, "job", unexpected);
    data.seen[key] = job.id;
    audit("created", { job: job.id, role: job.role, source: key });
    return job;
  }
  // A write that was in flight at process death has an unknown outcome. Never
  // repeat it blindly, even if the remote write may be idempotent.
  function recover() {
    for (const a of Object.values(data.actions)) if (a.state === "executing" && data.jobs[a.jobId]?.effects[`action:${a.id}`]?.state === "done") a.state = "done";
    // An effect rejected before anything ran leaves nothing in flight. The broker marks the action
    // failed when it sees the rejection; one rejected afterwards (recovery.js) kept "executing" and
    // made its job read as holding an uncertain write for good.
    for (const a of Object.values(data.actions)) if (a.state === "executing" && data.jobs[a.jobId]?.effects[`action:${a.id}`]?.state === "rejected") a.state = "failed";
    // A request still pending on a finished task has nobody to act on it.
    for (const a of Object.values(data.actions)) if (a.state === "pending" && JOB_TERMINAL.includes(data.jobs[a.jobId]?.state)) a.state = "withdrawn";
    for (const job of Object.values(data.jobs)) {
      if (job.state !== "running") continue;
      const uncertain = Object.values(job.effects).some((e) => e.state === "started");
      job.state = uncertain ? "blocked" : "queued";
      job.summary = uncertain ? "Restart interrupted an external action; inspect its receipt before retrying." : "Resuming after operator restart.";
      if (uncertain) notify(`recovery:${job.id}`, "owner", `Task ${job.id}: ${job.summary}`);
    }
    save();
  }
  const ledger = { data, save, audit: auditLocal, notify, createJob, recover, id };
  return ledger;
}
module.exports = { createLedger };
