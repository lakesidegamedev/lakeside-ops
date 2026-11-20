"use strict";
// Keir 11.1: the driver that keeps a live evidence tracker current.
//
// evidencepages.js owns the tracker page and appends a snapshot whenever Keir
// reads the same scope again. Without a driver that only happens when the
// player asks another question. This module re-reads the same scope on its own,
// once per newly settled game turn, and hands the result to evidencepages'
// own observe(), so the page code stays the single writer.
//
// Hard rules (tests in test/evidencemonitor.test.js):
//  - only trackers evidencepages already opened for a ticket; never opens one;
//  - dead 24 h after creation, and at the first stop, pause, takeover, kill
//    switch, closed ticket, wrong channel, wrong reporter or wrong world;
//  - a stop is silent: no Discord post, no model call, no job created or revived;
//  - read arguments are rebuilt from an allowlist and the live ticket row, never
//    replayed from saved model args;
//  - ownership is rechecked before AND after every await;
//  - every tracker (market data too) is pinned to the ticket's original reporter
//    and creation time recorded in its page meta; the live support row must still
//    match both before the read and again before anything is appended;
//  - bounded: 3 trackers per tick, one shared game_overview, a poll budget and
//    a failure budget per tracker; state is persisted so restarts do not repeat.
const fs = require("node:fs");
const path = require("node:path");
const HARD_MS = 24 * 3600000;
const PER_TICK = 3, MAX_POLLS = 300, MAX_FAILS = 8;
const GATE_MS = 60000;                       // a turn that has not moved: look again next minute (no read made)
const SETTLE_MS = [30000, 60000, 120000, 240000, 480000, 600000];
const FAIL_BASE_MS = 60000, FAIL_MAX_MS = 30 * 60000;
const PACE_MIN_MS = 10 * 60000, PACE_MAX_MS = 60 * 60000;   // only when game_overview is unavailable
const WINDOW = { market_history: 24, reporter_operating_results: 6, reporter_action_points: 24 };
const METRICS = new Set(["gdp_level", "gdp_change", "gdp_growth_rate", "commodity_price", "commodity_volume"]);
const TICKET_DONE = new Set(["resolved", "closed", "merged", "duplicate", "wontfix", "archived"]);
const HEX24 = /^[a-f0-9]{24}$/i, SEQ = /^\d{1,9}$/;

const short = (v, n) => String(v ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const num = (v) => (Number.isSafeInteger(Number(v)) && v !== null && v !== "" && v !== undefined ? Number(v) : null);

class Stop extends Error { constructor(reason) { super(reason); this.reason = reason; } }

function stateOf(d) { const s = (d.evidenceMonitor ||= {}); s.trackers ||= {}; return s; }
function pagesOf(d) { const s = (d.evidencePages ||= {}); s.observations ||= {}; s.presentations ||= {}; s.byKey ||= {}; return s; }

// The raw envelope behind an MCP result (same shapes evidencepages accepts).
function envelopeOf(result) {
  if (!result || typeof result !== "object" || result.isError || result.error) return null;
  let r = result;
  if (typeof r.text === "string" && !Array.isArray(r.rows)) { try { r = JSON.parse(r.text); } catch { return null; } }
  if (Array.isArray(r?.content) && !Array.isArray(r.rows)) {
    try { r = JSON.parse(r.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n")); } catch { return null; }
  }
  if (r?.structuredContent && !Array.isArray(r.rows)) r = r.structuredContent;
  return r && typeof r === "object" && Array.isArray(r.rows) ? r : null;
}
function worldOf(env) {
  const w = env.world;
  if (typeof w === "string") return { key: short(w, 80) || null, startedAt: null, currentTurn: null };
  if (!w || typeof w !== "object") return { key: null, startedAt: null, currentTurn: null };
  const key = short(w.worldEpochId || w.telemetryWorldId || "", 80) || null;
  const started = Date.parse(w.startedAt || "");
  return { key, startedAt: Number.isFinite(started) ? started : null, currentTurn: num(w.currentTurn) };
}
// The reporter id the live ticket row names, or null. Same strict parse the page module pins with.
const reporterIdOf = (ticket) => require("./evidencepages").characterOfProfile(ticket?.reporter?.profileUrl);
// The audience pinned into the page's own meta.json when the tracker was opened, or null.
function pinOf(p) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(path.resolve(p.dir), p.id, "meta.json"), "utf8"));
    const a = meta?.audience;
    if (meta?.id !== p.id || meta.visibility !== "ticket" || !a || a.v !== 1 || a.kind !== "ticket_reporter" || a.ticket !== p.ticket) return null;
    const created = Date.parse(a.ticketCreatedAt || "");
    if (!Number.isFinite(created) || !/^[1-9]\d{0,8}$/.test(String(a.character))) return null;
    return { character: String(a.character), createdAt: created };
  } catch { return null; }
}

function createMonitor({ ledger, config = {}, log = () => {}, read, currentTurn = null, readTicket, held = () => false,
  evidencePages = null, now = () => Date.now(), perTick = PER_TICK, hardMs = HARD_MS } = {}) {
  if (typeof read !== "function" || typeof readTicket !== "function") throw new Error("evidence monitor needs read and readTicket");
  const pages = () => evidencePages || require("./evidencepages");
  const terminal = () => require("./machines").JOB_TERMINAL;
  const stats = { ticks: 0, polls: 0, appended: 0, archived: 0, failures: 0, lastTickAt: null, lastError: null };
  let running = false;

  // --- state -------------------------------------------------------------
  function monitorOf(p, at) {
    const s = stateOf(ledger.data);
    let m = s.trackers[p.id];
    if (m) return m;
    const first = pagesOf(ledger.data).observations[p.observations?.[0]];
    const seen = (p.observations || []).map((id) => pagesOf(ledger.data).observations[id]?.envelope?.asOfTurn).filter(Number.isSafeInteger);
    const w0 = first?.envelope?.world;
    m = s.trackers[p.id] = { id: p.id, ticket: p.ticket, createdAt: p.createdAt, tool: p.tool, lastTurn: seen.length ? Math.max(...seen) : null, lastCurrentTurn: null,
      world: typeof w0 === "string" && w0 ? w0 : null, nextAt: Number(p.createdAt) + GATE_MS, polls: 0, fails: 0, settleTries: 0, pace: PACE_MIN_MS, lastPollAt: null, lastOutcome: null, scopeFrom: first?.id || null };
    return m;
  }
  const deadline = (p) => Math.min(Number(p.expiresAt) || Infinity, Number(p.createdAt) + hardMs);

  // --- archive -------------------------------------------------------------
  // Archiving is evidencepages' own sweep: marking stopRequested makes endReason
  // return our reason, so the page store, audit and ledger stay in one place.
  function end(p, reason, at) {
    const m = stateOf(ledger.data).trackers[p.id];
    if (m) { m.done = short(reason, 60); m.doneAt = at; m.nextAt = null; }
    if (!p.archivedAt) { p.stopRequested = short(reason, 60); pages().sweep(ledger, at, { terminal: terminal() }); }
    stats.archived++;
    try { ledger.audit("evidence_monitor_ended", { presentation: p.id, ticket: p.ticket || null, reason: short(reason, 60), polls: m?.polls || 0 }); } catch {}
    ledger.save();
  }

  // --- trust ----------------------------------------------------------------
  // The ledger half of the check: synchronous, so it is cheap to repeat after an await.
  function ledgerGate(p, at) {
    const d = ledger.data;
    if (!p.track || p.archivedAt) throw new Stop(p.archivedAt ? "archived" : "not_a_tracker");
    if (!p.ticket) throw new Stop("no_ticket");
    if (at >= deadline(p)) throw new Stop("expired");
    const reason = pages().endReason(d, p, at, terminal());
    if (reason) throw new Stop(reason);
    if (typeof p.channel !== "string" || !/^\d{16,20}$/.test(p.channel)) throw new Stop("no_channel");
    const ch = d.channels?.[p.channel];
    if (ch?.keirPaused) throw new Stop("paused");
    const named = Number(/^ticket-.*-(\d+)$/.exec(ch?.name || "")?.[1] || 0);
    if (named && named !== p.ticket) throw new Stop("channel_changed");
    const root = d.jobs?.[d.seen?.[`ticket:${p.ticket}`]];
    if (root && root.channelId && root.channelId !== p.channel) throw new Stop("channel_changed");
  }
  // The live ticket row: still this ticket, still open, same channel, and the reporter's character.
  async function ticketGate(p, signal) {
    const pin = pinOf(p);
    if (!pin) throw new Stop("audience_unpinned");
    const t = await readTicket(p.ticket, signal);
    if (!t || typeof t !== "object") throw new Error("ticket row unavailable");
    if (Number(t.number) !== p.ticket) throw new Stop("ticket_mismatch");
    // The pin: same ticket creation time and same reporter as when the page was opened (market data included).
    if (Date.parse(t.createdAt || "") !== pin.createdAt) throw new Stop("ticket_recreated");
    const who = reporterIdOf(t);
    if (!who) throw new Stop("reporter_unverifiable");
    if (who !== pin.character) throw new Stop("reporter_changed");
    if (TICKET_DONE.has(String(t.status || "").toLowerCase()) || t.closedAt || t.resolvedAt || t.mergedInto || t.mergedAt) throw new Stop("ticket_closed");
    const c = t.conversation;
    if (c && (c.channelClosed || c.channelDeleted || c.status === "closed")) throw new Stop("ticket_closed");
    if (c?.channelId && String(c.channelId) !== p.channel) throw new Stop("channel_changed");
    return t;
  }

  // --- read arguments, rebuilt -------------------------------------------------
  // Saved args are a model's words: only allowlisted keys of the right shape survive,
  // and identity comes from the live ticket row.
  function argsFor(p, ticket) {
    const first = pagesOf(ledger.data).observations[stateOf(ledger.data).trackers[p.id]?.scopeFrom || p.observations?.[0]];
    let saved;
    try { saved = JSON.parse(first?.args || "null"); } catch { saved = null; }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Stop("scope_unreadable");
    const tool = p.tool;
    if (!WINDOW[tool]) throw new Stop("tool_not_monitorable");
    if (tool === "market_history") {
      if (!METRICS.has(saved.metric)) throw new Stop("scope_unreadable");
      const args = { metric: saved.metric, turns: WINDOW[tool] };
      if (saved.country !== undefined) { if (!/^[A-Za-z]{2,3}$/.test(String(saved.country))) throw new Stop("scope_unreadable"); args.country = String(saved.country); }
      if (saved.region !== undefined) { if (!/^[A-Za-z0-9_-]{1,12}$/.test(String(saved.region))) throw new Stop("scope_unreadable"); args.region = String(saved.region); }
      if (saved.commodity !== undefined) { if (!/^[a-z0-9_]{1,40}$/.test(String(saved.commodity))) throw new Stop("scope_unreadable"); args.commodity = String(saved.commodity); }
      return args;
    }
    // reporter_*: the reporter is whoever the live ticket names, and it must still be who was read.
    const id = reporterIdOf(ticket);
    if (!id) throw new Stop("reporter_unverifiable");
    const was = saved.character === undefined ? null : String(saved.character).trim();
    if (was && was !== id) throw new Stop("reporter_changed");
    const cached = ledger.data.jobs?.[p.jobId]?.reporterCharacter?.id;
    if (cached && String(cached) !== id) throw new Stop("reporter_changed");
    if (saved.ticket !== undefined && Number(saved.ticket) !== p.ticket) throw new Stop("ticket_mismatch");
    const args = { ticket: p.ticket, character: id, turns: WINDOW[tool] };
    if (saved.corporation !== undefined) { if (!(SEQ.test(String(saved.corporation)) || HEX24.test(String(saved.corporation)))) throw new Stop("scope_unreadable"); args.corporation = String(saved.corporation); }
    return args;
  }

  // --- one tracker -----------------------------------------------------------------
  const backoff = (n, base, max) => Math.min(max, base * 2 ** Math.max(0, n - 1));

  async function poll(p, m, turnNow, signal) {
    const at = now();
    ledgerGate(p, at);
    const ticket = await ticketGate(p, signal);
    ledgerGate(p, now());
    const args = argsFor(p, ticket);
    m.polls++; m.lastPollAt = now(); stats.polls++;
    const result = await read(p.tool, args, signal);
    // After the await the world may have changed under us: check everything again.
    const after = now();
    if (signal?.aborted) throw new Error("monitor cancelled");
    ledgerGate(p, after);
    const ticketAfter = await ticketGate(p, signal);
    ledgerGate(p, now());
    if (args.character !== undefined && reporterIdOf(ticketAfter) !== args.character) throw new Stop("reporter_changed");
    const env = envelopeOf(result);
    if (!env) throw new Error("gamestate returned no envelope");
    if (env.tool && env.tool !== p.tool) throw new Stop("tool_mismatch");
    const w = worldOf(env), asOf = num(env.asOfTurn);
    if (w.key && m.world && w.key !== m.world) throw new Stop("world_reset");
    if (w.startedAt && w.startedAt > p.createdAt) throw new Stop("world_reset");
    if ((asOf !== null && m.lastTurn !== null && asOf < m.lastTurn) || (w.currentTurn !== null && m.currentTurnSeen != null && w.currentTurn < m.currentTurnSeen)) throw new Stop("world_reset");
    if (w.key) m.world = w.key;
    if (w.currentTurn !== null) m.currentTurnSeen = w.currentTurn;
    m.fails = 0;
    const turnCursor = turnNow;                                  // the gate's own clock; the envelope's currentTurn is only a regression check
    if (asOf === null || (m.lastTurn !== null && asOf <= m.lastTurn)) {
      // Nothing new settled yet.
      m.lastOutcome = "unchanged";
      if (turnCursor != null && ++m.settleTries > SETTLE_MS.length) { m.lastCurrentTurn = turnCursor; m.settleTries = 0; m.nextAt = now() + GATE_MS; }
      else m.nextAt = now() + (turnCursor != null ? SETTLE_MS[Math.min(m.settleTries - 1, SETTLE_MS.length - 1)] : (m.pace = Math.min(PACE_MAX_MS, m.pace * 2)));
      return "unchanged";
    }
    // A new settled turn: append through the pages module's own observe(). A stub stands in for the job, so no job is touched.
    const origin = pagesOf(ledger.data).observations[m.scopeFrom];
    const stub = { id: p.jobId, ticket: p.ticket, role: origin?.role || null };
    const before = p.snapshots || 0;
    const id = pages().observe(ledger, stub, "read_tool", { server: "gamestate", tool: p.tool, args }, result, now(), { terminal: terminal() });
    const obs = id ? pagesOf(ledger.data).observations[id] : null;
    if (!obs) throw new Error("page module did not accept the read");
    if (obs.fingerprint !== p.fingerprint) throw new Stop("scope_changed");
    m.lastTurn = asOf; m.settleTries = 0; m.pace = PACE_MIN_MS;
    if (turnCursor != null) m.lastCurrentTurn = turnCursor;
    m.nextAt = now() + GATE_MS;
    const appended = (p.snapshots || 0) > before;
    if (appended) { stats.appended++; try { ledger.audit("evidence_monitor_appended", { presentation: p.id, ticket: p.ticket, asOfTurn: asOf, snapshots: p.snapshots }); } catch {} }
    m.lastOutcome = appended ? "appended" : "deduped";
    return m.lastOutcome;
  }

  // The turn gate: should this tracker read now?
  function wantsRead(m, turnNow, at) {
    if (turnNow == null) return at - (m.lastPollAt ?? m.createdAt) >= m.pace;        // no turn signal: paced, backed off
    if (m.settleTries > 0) return true;                                                // a turn moved and has not settled: retry on the settle schedule
    const seen = m.lastCurrentTurn ?? m.lastTurn;                                      // before the first poll, the turn the page already holds
    return seen == null || turnNow > seen;
  }

  async function one(p, turnNow, signal) {
    const m = monitorOf(p, now());
    try {
      if (turnNow != null && m.lastTurn != null && turnNow < m.lastTurn) throw new Stop("world_reset");   // the game's turn is behind what the page holds
      if (!wantsRead(m, turnNow, now())) { m.nextAt = now() + GATE_MS; return "gated"; }
      const out = await poll(p, m, turnNow, signal);
      ledger.save();
      return out;
    } catch (e) {
      if (e instanceof Stop) { end(p, e.reason, now()); return `ended:${e.reason}`; }
      m.fails++; stats.failures++; stats.lastError = short(e.message, 200);
      m.lastOutcome = `error: ${short(e.message, 120)}`;
      if (m.fails >= MAX_FAILS) { end(p, "monitor_failed", now()); return "ended:monitor_failed"; }
      m.nextAt = now() + backoff(m.fails, FAIL_BASE_MS, FAIL_MAX_MS);
      ledger.save();
      return "failed";
    } finally {
      if (m.polls >= MAX_POLLS && !m.done && !p.archivedAt) end(p, "poll_budget", now());
    }
  }

  // --- tick -------------------------------------------------------------------------
  async function tick({ signal } = {}) {
    if (running) return { skipped: "busy" };
    running = true;
    const summary = { checked: 0, appended: 0, archived: 0, failed: 0, gated: 0, due: 0 };
    try {
      stats.ticks++; stats.lastTickAt = now();
      const d = ledger.data, s = pagesOf(d), at = now();
      const live = Object.values(s.presentations).filter((p) => p.track && !p.archivedAt);
      // Housekeeping: forget monitor state for presentations that are gone.
      const ms = stateOf(d).trackers;
      for (const id of Object.keys(ms)) if (!s.presentations[id]) delete ms[id];
      if (!live.length) return summary;
      // The kill switch ends trackers silently, as the pages contract says.
      if (held()) { for (const p of live) end(p, "kill_switch", at); summary.archived = live.length; return summary; }
      // Expiry and ownership end trackers even when nothing is due.
      for (const p of live) { try { ledgerGate(p, at); } catch (e) { if (e instanceof Stop) { end(p, e.reason, at); summary.archived++; } } }
      const due = Object.values(s.presentations).filter((p) => p.track && !p.archivedAt)
        .map((p) => [p, monitorOf(p, at)]).filter(([, m]) => !m.done && (m.nextAt ?? 0) <= at).sort((a, b) => a[1].nextAt - b[1].nextAt);
      summary.due = due.length;
      if (!due.length) { ledger.save(); return summary; }
      let turnNow = null;
      if (currentTurn) { try { turnNow = num(await currentTurn(signal)); } catch (e) { stats.lastError = short(`turn: ${e.message}`, 200); } }
      for (const [p] of due.slice(0, perTick)) {
        if (signal?.aborted) break;
        const out = await one(p, turnNow, signal);
        summary.checked++;
        if (out === "appended") summary.appended++; else if (out === "gated") summary.gated++; else if (out === "failed") summary.failed++; else if (out.startsWith("ended")) summary.archived++;
      }
      return summary;
    } finally { running = false; }
  }

  const status = () => ({ ...stats, live: Object.values(pagesOf(ledger.data).presentations).filter((p) => p.track && !p.archivedAt).length,
    trackers: Object.values(stateOf(ledger.data).trackers).map((m) => ({ id: m.id, ticket: m.ticket, polls: m.polls, fails: m.fails, lastTurn: m.lastTurn, lastOutcome: m.lastOutcome, done: m.done || null, nextAt: m.nextAt })) });

  return { tick, status, argsFor, envelopeOf };
}

module.exports = { createMonitor, envelopeOf, worldOf, reporterIdOf, HARD_MS, PER_TICK, MAX_POLLS, MAX_FAILS };
