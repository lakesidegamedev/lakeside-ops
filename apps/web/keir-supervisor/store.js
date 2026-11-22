"use strict";
// Durable state for the private owner supervisor: one owner session, its
// transcript, jobs, client-id dedupe and approval proposals. Every mutation is
// written with write-temp, fsync, rename before the caller sees success, so an
// accepted message or job survives a web restart. Old transcript lines move to
// an append-only archive instead of being dropped.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { EventEmitter } = require("node:events");

const HOT_MESSAGES = 1000;
const KEEP_JOBS = 200;
const KEEP_CLIENT_IDS = 2000;
const KEEP_PROPOSALS = 100;

const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
const sha = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");

function empty() {
  return { version: 1, session: id("s"), createdAt: Date.now(), seq: 0, rev: 0, messages: [], archived: 0,
    clientIds: {}, jobs: {}, jobOrder: [], proposals: {}, workspaces: {}, files: {}, preferences: {} };
}

function createStore(dir, { now = Date.now } = {}) {
  if (!path.isAbsolute(dir)) throw new Error("supervisor state dir must be absolute");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "state.json");
  const archive = path.join(dir, "transcript-archive.jsonl");
  const events = new EventEmitter(); events.setMaxListeners(200);
  let state;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") {
      // Never silently start over on a corrupt file: keep it for inspection.
      const kept = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, kept); } catch { /* unreadable as well */ }
    }
    state = empty();
  }
  for (const [k, v] of Object.entries(empty())) if (state[k] === undefined) state[k] = v;

  function save() {
    state.rev += 1;
    if (state.messages.length > HOT_MESSAGES) {
      const spill = state.messages.slice(0, state.messages.length - HOT_MESSAGES);
      const fd = fs.openSync(archive, "a", 0o600);
      try { fs.writeSync(fd, spill.map((m) => JSON.stringify(m)).join("\n") + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      state.messages = state.messages.slice(-HOT_MESSAGES);
      state.archived += spill.length;
    }
    if (state.jobOrder.length > KEEP_JOBS) {
      for (const old of state.jobOrder.slice(0, state.jobOrder.length - KEEP_JOBS)) {
        const job = state.jobs[old];
        if (job && ["queued", "running"].includes(job.state)) continue;
        delete state.jobs[old];
      }
      state.jobOrder = state.jobOrder.filter((j) => state.jobs[j]);
    }
    const ids = Object.keys(state.clientIds);
    if (ids.length > KEEP_CLIENT_IDS) {
      ids.sort((a, b) => state.clientIds[a].at - state.clientIds[b].at);
      for (const old of ids.slice(0, ids.length - KEEP_CLIENT_IDS)) delete state.clientIds[old];
    }
    const proposals = Object.values(state.proposals).sort((a, b) => a.createdAt - b.createdAt);
    for (const p of proposals.slice(0, Math.max(0, proposals.length - KEEP_PROPOSALS))) if (p.state !== "pending") delete state.proposals[p.id];
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    events.emit("change", state.rev);
  }

  function append(message) {
    const row = { id: id("m"), seq: ++state.seq, at: now(), ...message };
    row.text = String(row.text || "").slice(0, 16000);
    state.messages.push(row);
    return row;
  }

  function addJob(fields) {
    const job = { id: id("j"), state: "queued", attempts: 0, createdAt: now(), updates: 0, ...fields };
    state.jobs[job.id] = job; state.jobOrder.push(job.id);
    return job;
  }

  // Recover a prior owner conversation without putting the entire archive in
  // either process memory or the next model prompt.
  async function recall(query, beforeSeq, signal) {
    const needle = String(query || "").trim().toLowerCase();
    if (needle.length < 2 || needle.length > 160) throw new Error("Search text must be 2–160 characters.");
    const matches = [];
    function consider(row) {
      if (!Number.isSafeInteger(row.seq) || row.seq >= beforeSeq || typeof row.text !== "string") return;
      const offset = row.text.toLowerCase().indexOf(needle);
      if (offset < 0 || matches.some((m) => m.seq === row.seq)) return;
      const start = Math.max(0, offset - 150);
      matches.push({ seq: row.seq, at: row.at, role: row.role, excerpt: row.text.slice(start, start + 600) });
      if (matches.length > 12) matches.shift();
    }
    // The recent window is normally sufficient. Only scan the cold file if
    // it could still contribute to the newest twelve matches.
    for (const row of state.messages) consider(row);
    if (matches.length < 12 && state.archived > 0) {
      const recent = matches.splice(0);
      const input = fs.createReadStream(archive, { encoding: "utf8", signal });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          signal?.throwIfAborted();
          if (line) consider(JSON.parse(line));
        }
      } finally { lines.close(); input.destroy(); }
      for (const row of recent) {
        const duplicate = matches.findIndex((m) => m.seq === row.seq);
        if (duplicate >= 0) matches.splice(duplicate, 1);
        matches.push(row);
      }
    }
    return matches.slice(-12).reverse();
  }

  // Resolve when the revision moves past `rev` or the wait ends.
  function waitForChange(rev, ms, signal) {
    if (state.rev !== rev || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); events.off("change", done); signal?.removeEventListener?.("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      events.on("change", done);
      signal?.addEventListener?.("abort", done, { once: true });
    });
  }

  return { dir, get state() { return state; }, save, append, addJob, recall, waitForChange, events, sha };
}

module.exports = { createStore, HOT_MESSAGES, sha };
