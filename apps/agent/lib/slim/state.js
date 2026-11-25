"use strict";
// The ticket state record: a short, readable record next to each ticket that
// the session keeps up to date itself. The coordinator or the owner reads this
// instead of guessing from logs.
//
//   established   facts read on this ticket, each with where it came from
//   ruledOut      ideas checked and dropped, with why
//   promises      what the player was told would happen, and when
//   next          the next step and what it waits on
//   prs           pull requests opened for this ticket
//   approvals     promote, compensation and decision requests to the owner
//   receipts      proof behind outcome claims (fix live and checked, payment made)
//   posts         what was posted, for the spam cap and for review
//   paused        set by the owner, staff or the coordinator; stops Keir only

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CAP = { established: 60, ruledOut: 40, promises: 30, prs: 20, approvals: 30, posts: 200, receipts: 20 };

function emptyState(ticket, now = Date.now()) {
  return {
    version: 1,
    ticket: Number(ticket),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    sessionId: null,
    established: [],
    ruledOut: [],
    promises: [],
    next: null,
    prs: [],
    approvals: [],
    receipts: { fixLive: [], paid: [] },
    posts: [],
    lastHumanAt: null,
    lastPlayerAt: null,
    paused: null,
    reminder: null,
    budget: { day: null, wakes: 0, minutes: 0, alerted: false },
    closed: false,
  };
}

const short = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
const id = (prefix) => `${prefix}-${crypto.randomBytes(5).toString("hex")}`;
const tail = (arr, n) => (arr.length > n ? arr.slice(arr.length - n) : arr);

/**
 * Apply the session's own update. Additive: established facts and ruled-out
 * ideas are appended; a promise or PR is updated by id/url; next is replaced.
 * Returns the new state (the input is not mutated).
 */
function applyUpdate(state, update = {}, now = Date.now()) {
  const s = structuredClone(state);
  const at = new Date(now).toISOString();
  for (const f of update.established || []) {
    const fact = short(f.fact ?? f, 600);
    if (!fact || s.established.some((e) => e.fact === fact)) continue;
    s.established.push({ fact, source: short(f.source, 300) || null, at });
    // A fact that settles a ruled-out idea is recorded; the idea stays listed.
  }
  for (const r of update.ruled_out || update.ruledOut || []) {
    const idea = short(r.idea ?? r, 400);
    if (!idea || s.ruledOut.some((e) => e.idea === idea)) continue;
    s.ruledOut.push({ idea, why: short(r.why, 400) || null, at });
  }
  for (const p of update.promises || []) {
    const existing = p.id && s.promises.find((x) => x.id === p.id);
    if (existing) {
      if (p.status) existing.status = ["open", "kept", "dropped"].includes(p.status) ? p.status : existing.status;
      if (p.due !== undefined) existing.due = short(p.due, 120) || null;
      existing.updatedAt = at;
    } else if (p.text) {
      s.promises.push({ id: id("promise"), text: short(p.text, 400), due: short(p.due, 120) || null, status: "open", at });
    }
  }
  if (update.next) s.next = { step: short(update.next.step, 400), waitsOn: short(update.next.waits_on ?? update.next.waitsOn, 300) || null, since: at };
  for (const pr of update.prs || []) {
    const url = short(pr.url, 300);
    if (!url) continue;
    const existing = s.prs.find((x) => x.url === url);
    if (existing) Object.assign(existing, { state: short(pr.state, 40) || existing.state, updatedAt: at });
    else s.prs.push({ url, state: short(pr.state, 40) || "open", what: short(pr.what, 300) || null, at });
  }
  s.established = tail(s.established, CAP.established);
  s.ruledOut = tail(s.ruledOut, CAP.ruledOut);
  s.promises = tail(s.promises, CAP.promises);
  s.prs = tail(s.prs, CAP.prs);
  s.updatedAt = at;
  return s;
}

function addApproval(state, kind, payload, now = Date.now()) {
  const s = structuredClone(state);
  const approval = { id: id(kind), kind, status: "pending", summary: short(payload.summary || payload.question || payload.what, 300), payload, at: new Date(now).toISOString(), answer: null, answeredAt: null };
  s.approvals = tail([...s.approvals, approval], CAP.approvals);
  s.next = { step: `Wait for the owner on: ${approval.summary}`, waitsOn: `owner ${kind} ${approval.id}`, since: approval.at };
  s.updatedAt = approval.at;
  return { state: s, approval };
}

function answerApproval(state, approvalId, answer, now = Date.now()) {
  const s = structuredClone(state);
  const a = s.approvals.find((x) => x.id === approvalId);
  if (!a) return { state: s, approval: null };
  a.status = answer.status || "answered";
  a.answer = short(answer.text ?? answer.choice ?? answer.status, 500);
  a.answeredAt = new Date(now).toISOString();
  s.updatedAt = a.answeredAt;
  return { state: s, approval: a };
}

function addReceipt(state, kind, receipt, now = Date.now()) {
  const s = structuredClone(state);
  const list = kind === "paid" ? s.receipts.paid : s.receipts.fixLive;
  list.push({ ...receipt, at: new Date(now).toISOString() });
  if (list.length > CAP.receipts) list.splice(0, list.length - CAP.receipts);
  s.updatedAt = new Date(now).toISOString();
  return s;
}

function recordPost(state, post, now = Date.now()) {
  const s = structuredClone(state);
  s.posts = tail([...s.posts, { at: new Date(now).toISOString(), kind: post.kind || "answer", text: short(post.text, 2000), delivered: post.delivered ?? null }], CAP.posts);
  s.updatedAt = new Date(now).toISOString();
  return s;
}

function recordHuman(state, { role, at }) {
  const s = structuredClone(state);
  const when = new Date(at || Date.now()).toISOString();
  if (["player", "staff", "owner", "participant"].includes(role)) s.lastHumanAt = when;
  if (role === "player") s.lastPlayerAt = when;
  return s;
}

/** Posts since the last message from a person. */
function postsSinceHuman(state) {
  const since = state.lastHumanAt ? Date.parse(state.lastHumanAt) : -Infinity;
  return state.posts.filter((p) => Date.parse(p.at) > since && p.delivered !== false);
}

/** A plain-text rendering for people (and for the session after compaction). */
function render(state) {
  const lines = [`Ticket ${state.ticket}${state.closed ? " (closed)" : ""}${state.paused ? ` PAUSED by ${state.paused.by}: ${state.paused.reason || "no reason given"}` : ""}`];
  const section = (title, rows) => { if (rows.length) lines.push(`${title}:`, ...rows.map((r) => `- ${r}`)); };
  section("Established", state.established.map((e) => `${e.fact}${e.source ? ` (from ${e.source})` : ""}`));
  section("Ruled out", state.ruledOut.map((r) => `${r.idea}${r.why ? `: ${r.why}` : ""}`));
  section("Promises", state.promises.filter((p) => p.status === "open").map((p) => `${p.text}${p.due ? ` (due ${p.due})` : ""} [${p.id}]`));
  if (state.next) lines.push(`Next: ${state.next.step}${state.next.waitsOn ? ` (waits on ${state.next.waitsOn})` : ""}`);
  section("Pull requests", state.prs.map((p) => `${p.url} ${p.state}`));
  section("Approvals", state.approvals.map((a) => `${a.kind} ${a.id} ${a.status}: ${a.summary}${a.answer ? ` -> ${a.answer}` : ""}`));
  section("Receipts", [...state.receipts.fixLive.map((r) => `fix live: ${r.what || r.pr || "fix"} checked by ${r.verifiedRead || "?"}`), ...state.receipts.paid.map((r) => `paid: ${r.amount} (${r.ledgerRef || "ledger"})`)]);
  if (state.reminder) lines.push(`Reminder: ${state.reminder.reason} (after ${state.reminder.after})`);
  return lines.join("\n");
}

/** File store: one JSON file per ticket, written atomically. */
function createFileStore(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (n) => path.join(dir, `ticket-${Number(n)}.json`);
  return {
    dir,
    load(n) {
      try { return JSON.parse(fs.readFileSync(file(n), "utf8")); } catch (e) { if (e.code === "ENOENT") return emptyState(n); throw e; }
    },
    save(state) {
      const f = file(state.ticket);
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(`${f}.tmp`, f);
      return state;
    },
    list() {
      return fs.readdirSync(dir).filter((f) => /^ticket-\d+\.json$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);
    },
  };
}

module.exports = { emptyState, applyUpdate, addApproval, answerApproval, addReceipt, recordPost, recordHuman, postsSinceHuman, render, createFileStore };
