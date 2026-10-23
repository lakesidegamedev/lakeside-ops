"use strict";
// Keir as a dev partner in the owner's app. Work the owner did not start from
// the app (tickets, watch findings, Discord requests, role tasks) shows on the
// working-now board and in Activity. The main conversation only hears about
// what the owner should act on or would want to know unprompted: a decision
// needed, a task stuck, a fix live on the main server.
//
// Owner, 2026-10-23: every started, PR, merge, paused and finished line went
// into the chat. 353 of the 400 retained messages were these digests, and they
// pushed the owner's own conversations out of the thread.
//
// It also keeps a small board of current work for the chat's working-now bar,
// computed on the tick so the thread long poll stays cheap.
//
// Changes are coalesced: a burst settles for COALESCE_MS, and routine updates
// are at least MIN_GAP_MS apart. A decision or a stuck task goes out sooner.
// The first scan after start is a silent baseline, so a restart never replays
// history into the conversation.
const { threadOf, isAppJob, appendMessage } = require("./appchannel");
const { workStatus } = require("./workqueue");
const { ticketOf } = require("./workrecord");

const CLOSED = new Set(["done", "dismissed", "cancelled"]);
const COALESCE_MS = 2 * 60000;
const MIN_GAP_MS = 10 * 60000;
const URGENT_GAP_MS = 60000;
const MAX_LINES = 6;
const MAX_PENDING = 60;
const BOARD_ITEMS = 8;
// Change kinds that earn a line in the conversation. The rest stay on the board.
const CHAT_KINDS = new Set(["needs-you", "stuck", "live"]);
const STAGE_LABEL = { found: "investigating", written: "fix written", tested: "tested on development", sandbox: "on the sandbox", main: "live on the main server", confirmed: "live and confirmed in game", answered: "answered, no fix needed" };
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const sentence = (s, n = 180) => { const t = clip(s, n).replace(/[–—]/g, ","); return t && !/[.!?…]$/.test(t) ? `${t}.` : t; };

// Roots worth reporting: not app-started (those already speak in the thread),
// not quick conversations, probes, benchmarks or watches.
function reportable(d, job) {
  if (!job || job.codingParent || job.museParent || job.internalProbe || job.benchmark || job.appWatch) return false;
  if (job.kind === "conversation" || isAppJob(job)) return false;
  // Watchkeeper reviews are internal second opinions on observations, not work.
  if (job.operatorRole === "watchkeeper") return false;
  return true;
}

// Boilerplate first lines that say how work arrived, not what it is.
const PREAMBLE = /^(Keir watch found this before any player reported it\.?|Read-only engineering triage of game evidence|Confirmed task evidence:?|New ticket intake.*)$/i;
function cleanTitle(text) {
  const line = String(text || "").replace(/<@!?\d+>/g, "").split("\n").map(l => l.trim()).find(l => l && !PREAMBLE.test(l)) || "";
  const t = clip(line.replace(/^(Turn warning|Confirmed task evidence):\s*/i, ""), 80);
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function titleOf(d, job) {
  const ticket = Number(ticketOf(job)) || null;
  // A ticket is named by its fix when the card tracks exactly one; with several
  // fixes, a task-level line cannot say which one it is about, so the number alone.
  // A ticket without a card is named by its number: its first message or a
  // checkpoint summary reads as noise in a one-line update.
  const names = (d.statusCards?.[ticket]?.items || []).map(i => i.name).filter(Boolean);
  if (ticket) {
    const title = cleanTitle(names.length === 1 ? names[0] : d.ticketRecords?.[ticket]?.title || "");
    // The board row has room to name the first fix and count the rest.
    return { ticket, title, boardTitle: names.length > 1 ? `${cleanTitle(names[0])} and ${names.length - 1} more` : title };
  }
  const finding = Object.values(d.watch?.findings || {}).find(f => f.jobId === job.id)?.title;
  const engineering = PREAMBLE.test(job.engineeringTitle || "") ? "" : job.engineeringTitle;
  return { ticket, title: cleanTitle(engineering || finding || job.source?.content || job.summary || job.kind) };
}
const firstSentence = (s) => { const t = String(s || "").replace(/\s+/g, " ").trim(); const m = /^(.{20,}?[.!?])\s/.exec(t); return m ? m[1] : t; };
// Where the app can open this work: a ticket view, an owner task view, or the queue.
const linkOf = ({ ticket, owner }) => ticket ? "ticket" : owner ? "task" : "activity";
const label = ({ ticket, title }) => ticket ? `Ticket ${ticket}${title ? `, ${title}` : ""}` : title || "A Keir task";

function prsOf(d, job) {
  const family = Object.values(d.jobs || {}).filter(j => j.id === job.id || j.codingParent === job.id || j.museParent === job.id);
  const opened = [...new Set(family.flatMap(j => j.pullRequests || []))].map(url => {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url); return m ? { url, repository: m[1], number: Number(m[2]) } : null;
  }).filter(Boolean);
  const merged = family.flatMap(j => Object.entries(j.effects || {}).filter(([k, e]) => k.startsWith("merge:") && e.state === "done").map(([k, e]) => ({ key: k, number: Number(e.result?.number) || Number(k.split(":")[1]) || null, url: e.result?.html_url || e.result?.url || null })));
  return { opened, merged };
}

// One comparable snapshot per reportable root job and per ticket status card.
function snapshot(d, config, now) {
  const jobs = {}, cards = {};
  for (const job of Object.values(d.jobs || {})) {
    if (!reportable(d, job)) continue;
    const status = CLOSED.has(job.state) ? null : workStatus(d, job, { now, config });
    const { opened, merged } = prsOf(d, job);
    // The owner reads the decision's own short summary, not the full question.
    const ids = new Set(Object.values(d.jobs || {}).filter(j => j.id === job.id || j.codingParent === job.id || j.museParent === job.id).map(j => j.id));
    const decision = Object.values(d.decisions || {}).filter(x => ids.has(x.jobId) && x.state === "pending").sort((a, b) => b.at - a.at)[0];
    jobs[job.id] = { decision: decision ? firstSentence(decision.tldr || decision.question) : "", rounds: job.rounds || 0, state: CLOSED.has(job.state) ? job.state : status.state, reason: status?.reason || "", next: status?.next || "", summary: job.summary || "",
      prs: opened.map(p => p.url), merges: merged.map(m => m.key), opened, merged, at: job.updatedAt || job.at || 0, owner: job.role === "owner", ...titleOf(d, job) };
  }
  for (const [ticket, card] of Object.entries(d.statusCards || {})) {
    cards[ticket] = Object.fromEntries((card.items || []).filter(i => i?.name).map(i => [i.name, { stage: i.stage, blocked: Boolean(i.blocked), note: i.note || "" }]));
  }
  return { jobs, cards };
}

// Material differences between two snapshots, as owner-readable lines.
function changes(prev, next) {
  const out = [];
  const push = (e) => out.push({ subject: e.card ? e.id : e.subject || `job:${e.jobId}`, link: e.ticket ? "ticket" : next.jobs[e.jobId]?.owner ? "task" : "activity", ...e });
  for (const [id, j] of Object.entries(next.jobs)) {
    const p = prev.jobs[id];
    const who = label(j);
    // Work is announced once, when it first actually runs: a queued job is not
    // yet being worked, and a job that wakes again is not new.
    const running = j.state === "working" || j.rounds > 0;
    if (!CLOSED.has(j.state) && running && !p?.started) push({ id: `start:${id}`, jobId: id, ticket: j.ticket, kind: "started", text: `${who}: started. ${sentence(j.reason === "No next milestone recorded." ? "" : j.reason)}`.trim() });
    for (const pr of j.opened.filter(x => !(p?.prs || []).includes(x.url))) push({ id: `pr:${pr.url}`, jobId: id, ticket: j.ticket, kind: "pr", text: `${who}: opened PR #${pr.number} in ${pr.repository}.`, card: { type: "pr", repository: pr.repository, number: pr.number, url: pr.url } });
    for (const m of j.merged.filter(x => !(p?.merges || []).includes(x.key))) push({ id: `merge:${id}:${m.key}`, jobId: id, ticket: j.ticket, kind: "merged", text: `${who}: merged${m.number ? ` PR #${m.number}` : " a PR"}.` });
    if (!p || p.state === j.state) continue;
    if (j.state === "needs-you") push({ id: `needs:${id}:${j.at}`, jobId: id, ticket: j.ticket, kind: "needs-you", urgent: true, text: `${who}: needs your decision. ${sentence(j.decision || j.reason, 220)}` });
    else if (j.state === "stuck") push({ id: `stuck:${id}:${j.at}`, jobId: id, ticket: j.ticket, kind: "stuck", urgent: true, text: `${who}: stuck. ${sentence(j.reason)} ${sentence(j.next, 140)}`.trim() });
    else if (j.state === "done") push({ id: `done:${id}`, jobId: id, ticket: j.ticket, kind: "finished", text: `${who}: finished. ${sentence(j.summary, 220)}`.trim() });
  }
  for (const [ticket, items] of Object.entries(next.cards)) {
    const before = prev.cards[ticket] || {};
    for (const [name, item] of Object.entries(items)) {
      const was = before[name];
      const who = `Ticket ${ticket}, ${clip(name, 80)}`, subject = `card:${ticket}:${name}`;
      const stage = STAGE_LABEL[item.stage] || item.stage;
      if (!was) push({ id: `card:${ticket}:${name}:${item.stage}`, subject, ticket: Number(ticket), kind: "stage", text: `${who}: ${stage}. ${sentence(item.note)}`.trim() });
      else if (item.blocked && !was.blocked) push({ id: `paused:${ticket}:${name}:${item.note}`, subject, ticket: Number(ticket), kind: "paused", text: `${who}: paused. ${sentence(item.note)}`.trim() });
      else if (was.stage !== item.stage) push({ id: `card:${ticket}:${name}:${item.stage}`, subject, ticket: Number(ticket), kind: item.stage === "main" || item.stage === "confirmed" ? "live" : "stage", text: `${who}: now ${stage}. ${sentence(item.note)}`.trim() });
    }
  }
  return out;
}

// Current work for the chat bar: what Keir is doing now, and what needs the owner.
function board(next, now) {
  const open = Object.entries(next.jobs).filter(([, j]) => !CLOSED.has(j.state));
  const rank = { "needs-you": 0, stuck: 1, working: 2, queued: 3, waiting: 4, held: 5 };
  const count = s => open.filter(([, j]) => j.state === s).length;
  // One row per ticket: the attempt that most needs attention speaks for it.
  const seenTickets = new Set();
  const items = open.sort(([, a], [, b]) => (rank[a.state] ?? 6) - (rank[b.state] ?? 6) || b.at - a.at)
    .filter(([, j]) => !j.ticket || (!seenTickets.has(j.ticket) && seenTickets.add(j.ticket))).slice(0, BOARD_ITEMS)
    .map(([id, j]) => ({ id, ticket: j.ticket, link: linkOf(j), title: j.boardTitle || j.title || (j.ticket ? `Ticket ${j.ticket}` : "Keir task"), state: j.state, reason: clip(j.reason, 160) }));
  return { at: now, open: open.length, working: count("working"), needsYou: count("needs-you"), stuck: count("stuck"), waiting: count("waiting") + count("queued"), held: count("held"), items };
}

function createAppUpdates({ ledger, config = {}, now = () => Date.now(), save = true }) {
  const d = ledger.data;
  function state() { const t = threadOf(d); return t.updates ||= { pending: [], lastPostAt: 0 }; }
  const enabled = () => d.appThread?.preferences?.main?.updates !== false;

  function tick() {
    const u = state(), at = now();
    const next = snapshot(d, config, at);
    u.board = board(next, at);
    if (!u.seen) { u.seen = { jobs: compact(next.jobs, null), cards: next.cards }; u.baselineAt = at; if (save) ledger.save(); return { baseline: true, posted: null }; }
    const found = changes({ jobs: u.seen.jobs, cards: u.seen.cards }, next);
    u.seen = { jobs: compact(next.jobs, u.seen.jobs), cards: next.cards };
    if (enabled() && !d.paused) {
      const known = new Set(u.pending.map(e => e.id));
      for (const e of found) if (CHAT_KINDS.has(e.kind) && !known.has(e.id)) u.pending.push({ ...e, at });
      u.pending = u.pending.slice(-MAX_PENDING);
    } else u.pending = [];
    const posted = flush(at);
    if (save && (found.length || posted)) ledger.save();
    return { baseline: false, found: found.length, posted };
  }

  function flush(at) {
    const u = state();
    if (!u.pending.length) return null;
    const urgent = u.pending.some(e => e.urgent);
    const settled = at - Math.max(...u.pending.map(e => e.at)) >= (urgent ? 0 : COALESCE_MS);
    const gap = !u.lastPostAt || at - u.lastPostAt >= (urgent ? URGENT_GAP_MS : MIN_GAP_MS);
    if (!settled || !gap) return null;
    // Urgent first, then in the order they happened; later lines for the same
    // card or task replace earlier ones so a burst reads as where things ended.
    // A fix's own stage line says more than "picked up" for the same ticket.
    const latest = new Map();
    for (const e of u.pending) latest.set(e.kind === "pr" || e.kind === "merged" ? e.id : e.subject, e);
    const carded = new Set([...latest.values()].filter(e => e.subject?.startsWith("card:")).map(e => e.ticket));
    const lines = [...latest.values()].filter(e => !(e.kind === "started" && e.ticket && carded.has(e.ticket))).sort((a, b) => (b.urgent === true) - (a.urgent === true) || a.at - b.at);
    const shown = lines.slice(0, MAX_LINES), more = lines.length - shown.length;
    const text = [...shown.map(e => `- ${e.text}`), ...(more > 0 ? [`- ${more} more in Activity.`] : [])].join("\n");
    const items = shown.map(e => ({ kind: e.kind, ticket: e.ticket || null, jobId: e.jobId || null, link: e.link || "activity", text: e.text }));
    const cards = shown.filter(e => e.card).map(e => e.card);
    const message = appendMessage(d, { role: "keir", text, thread: "main", update: true, items, ...(cards.length ? { cards } : {}) }, at);
    u.pending = []; u.lastPostAt = at;
    ledger.audit?.("app_update_posted", { message: message.id, lines: lines.length, urgent });
    return message;
  }

  return { tick, board: () => state().board || null };
}

// Seen state keeps only what changes() compares. Everything present at the
// silent baseline counts as already started.
function compact(jobs, prev = null) {
  return Object.fromEntries(Object.entries(jobs).map(([id, j]) => [id, { state: j.state, prs: j.prs, merges: j.merges,
    started: !prev || Boolean(prev[id]?.started) || j.state === "working" || j.rounds > 0 }]));
}

module.exports = { createAppUpdates, changes, snapshot, board, reportable, CHAT_KINDS, COALESCE_MS, MIN_GAP_MS, URGENT_GAP_MS };
