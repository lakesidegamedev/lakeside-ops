"use strict";
// Keir 11.1: evidence presentation for ticket answers.
//
// Game reads that the broker actually received (market_history,
// reporter_operating_results, reporter_action_points) become, on request:
// one inline trend chart staged for Keir's next Discord answer, a dated report
// page for dense data, and, while it can still change the answer, a tracker
// page that accumulates later reads of the same scope. Nothing here posts:
// the answer's own delivery path claims the staged chart and sends it in the
// same message (claim / verify / delivered / release below). A tracker only
// changes its page, never the channel.
//
// The model names an observation id the broker minted. It never supplies a
// URL, HTML, file path, ticket, reporter or channel; those come from the
// ledger. Private (reporter_*) evidence is bound to the ticket it was read
// on and is shown only in that ticket's channel.
//
// Page audience (Keir 11.1 privacy revision):
// - Every page opened from a ticket, tracker or one-off report, is private to
//   that ticket, even when it holds only public market data. Its audience is
//   pinned at creation to the ticket's original reporter from the support
//   service's own ticket row (support_get: ticket createdAt and the character
//   in reporter.profileUrl), never from job.actorId or model arguments. No
//   verifiable reporter means no page. The web route rechecks the pin and the
//   viewer's current ownership on every request.
// - Only a one-off public market report from a public ping (no ticket) is a
//   public page, and its files carry no ticket, reporter or task.
// - No page link is ever produced until EVIDENCE_PUBLIC_BASE is set; without
//   it Keir degrades to the inline chart or a plain answer.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { redactSecrets } = require("../text");

const series = require("./evidence-series");
const { TOOLS, project } = series;
const TRACK_MS = 24 * 3600000;          // a tracker lives at most 24 h from creation
const ANSWER_WAIT_MS = 15 * 60000;      // a chart waits this long for its answer, then is dropped
const MAX_OBSERVATIONS = 200, MAX_SNAPSHOTS = 48;
const OBS_KEEP_MS = 48 * 3600000;
const PUBLIC_PAGE_TOOLS = new Set(["market_history", "commodity_market"]);

const sha = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
const state = (d) => { const s = (d.evidencePages ||= {}); s.observations ||= {}; s.presentations ||= {}; s.byKey ||= {}; return s; };
const ticketNo = (job) => Number(job?.ticket) || Number(/-(\d+)$/.exec(job?.source?.channelName || "")?.[1]) || null;
const short = (v, n) => String(v ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const human = (key) => String(key).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

// --- capture --------------------------------------------------------------

// Called from broker tool() after every finished call. Never throws.
function observe(ledger, job, name, input, result, at = Date.now(), options = {}) {
  try {
    if (name !== "read_tool" || input?.server !== "gamestate" || !TOOLS[input.tool]) return null;
    // The typed adapter owns parsing and sanitising. Anything it cannot verify
    // against the game contract is not presentable, and Keir answers in words.
    const adapted = series.adapt(input.tool, result, { at });
    if (!adapted.ok) {
      try { ledger.audit("evidence_unpresentable", { job: job?.id, tool: input.tool, reason: short(adapted.reason, 160) }); } catch {}
      return null;
    }
    const clean = adapted.envelope;
    if (!clean.rows.length) return null;
    const s = state(ledger.data);
    const ticket = ticketNo(job);
    const args = canonical(input.args && typeof input.args === "object" ? input.args : {});
    // The scope of a read, without its window: a later read of more turns is the same question.
    const { turns, toTurn, limit, since, from, to, ...scopeArgs } = args;
    const fingerprint = sha([input.tool, scopeArgs, clean.world, clean.metric]).slice(0, 24);
    const rowsHash = sha(clean.rows).slice(0, 24);
    const id = "ev_" + sha([job.id, input.tool, args, clean.world, clean.asOfTurn, rowsHash]).slice(0, 12);
    if (!s.observations[id]) {
      s.observations[id] = { id, jobId: job.id, ticket, role: job.role || null, tool: input.tool, visibility: TOOLS[input.tool],
        args: redactSecrets(JSON.stringify(args)).slice(0, 600), fingerprint, rowsHash, at, envelope: clean };
    }
    track(ledger, s.observations[id], at, options);
    prune(s, at);
    ledger.save();
    return id;
  } catch (e) {
    try { ledger.audit("evidence_observe_failed", { job: job?.id, error: short(e.message, 200) }); } catch {}
    return null;
  }
}
function prune(s, at) {
  const live = new Set(Object.values(s.presentations).flatMap((p) => p.observations || []));
  const rows = Object.values(s.observations).sort((a, b) => a.at - b.at);
  for (const o of rows) if (!live.has(o.id) && at - o.at > OBS_KEEP_MS) delete s.observations[o.id];
  const left = Object.values(s.observations).sort((a, b) => a.at - b.at);
  for (const o of left.slice(0, Math.max(0, left.length - MAX_OBSERVATIONS))) if (!live.has(o.id)) delete s.observations[o.id];
}

// --- page store (shared with apps/web/mcp/evidence-pages.js) ---------------

// Write-once and atomic: the whole file appears under its final name or not
// at all (a full disk leaves no torn JSON), and an existing file is never
// replaced, because link() refuses an existing target with EEXIST.
function writeOnce(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o640);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.linkSync(tmp, file);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
  }
  try { const dfd = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch {}
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const snapName = (n) => `snap-${String(n).padStart(4, "0")}.json`;
function createStore(dir) {
  const root = path.resolve(dir);
  const pageDir = (id) => { if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("invalid presentation id"); return path.join(root, id); };
  // The last snapshot on disk, counting only an unbroken run from 1.
  const latest = (id) => {
    const p = pageDir(id);
    let n = 0;
    while (n < MAX_SNAPSHOTS && fs.existsSync(path.join(p, snapName(n + 1)))) n++;
    return { n, rowsHash: n ? readJson(path.join(p, snapName(n)))?.rowsHash || null : null };
  };
  return {
    dir: root,
    latest,
    create(meta, png) {
      const p = pageDir(meta.id);
      fs.mkdirSync(p, { recursive: true, mode: 0o750 });
      // Both are written once. A restart that replays creation finds them and keeps them.
      if (png) { try { writeOnce(path.join(p, "chart.png"), png); } catch (e) { if (e.code !== "EEXIST") throw e; } }
      try { writeOnce(path.join(p, "meta.json"), JSON.stringify(meta)); } catch (e) { if (e.code !== "EEXIST") throw e; }
    },
    // Snapshots are write-once, numbered from 1 with no gaps, and never
    // rewritten. The disk enforces the absolute deadline in meta.json, so a
    // restarted operator with an old ledger still cannot append late.
    // Returns written | exists | conflict | archived | expired | full | closed.
    snapshot(id, n, snap, { at = null } = {}) {
      const p = pageDir(id);
      if (fs.existsSync(path.join(p, "archived.json"))) return "archived";
      const meta = readJson(path.join(p, "meta.json"));
      if (!meta || meta.id !== id) throw new Error("page meta.json missing or unreadable");
      if (meta.kind === "tracker") {
        const deadline = Date.parse(meta.expiresAt || "");
        const when = Math.max(Date.parse(snap?.at || ""), Number.isFinite(at) ? at : -Infinity);
        if (!Number.isFinite(deadline) || !(when < deadline)) return "expired";
      } else if (n !== 1) return "closed";      // a report is one dated snapshot
      if (!Number.isSafeInteger(n) || n < 1) throw new Error("invalid snapshot number");
      if (n > MAX_SNAPSHOTS) return "full";
      const file = path.join(p, snapName(n));
      const have = latest(id);
      if (n <= have.n) return readJson(file)?.rowsHash === snap.rowsHash ? "exists" : "conflict";
      if (n !== have.n + 1) return "conflict";
      try { writeOnce(file, JSON.stringify(snap)); return "written"; } catch (e) {
        if (e.code !== "EEXIST") throw e;
        return readJson(file)?.rowsHash === snap.rowsHash ? "exists" : "conflict";
      }
    },
    // archived.json is written once; true when this call wrote it. The record
    // counts the snapshots actually on disk, so the page freezes at what exists.
    archive(id, { at, reason }) {
      const record = { at, reason, snapshots: latest(id).n };
      try { writeOnce(path.join(pageDir(id), "archived.json"), JSON.stringify(record)); return true; } catch (e) { if (e.code === "EEXIST") return false; throw e; }
    },
    archived(id) { return readJson(path.join(pageDir(id), "archived.json")); },
    remove(id) { fs.rmSync(pageDir(id), { recursive: true, force: true }); },
  };
}

// --- lifecycle ---------------------------------------------------------------

function rootTicketJob(d, ticket) { return ticket ? d.jobs?.[d.seen?.[`ticket:${ticket}`]] : null; }
// Why a live tracker must stop, or null. Every path that ends Keir's work on
// a ticket ends its tracker too.
function endReason(d, p, at, terminal) {
  if (p.archivedAt) return p.endReason || "archived";
  // Ended, archive record not yet on disk: still ended, never appended to.
  if (p.endReason) return p.endReason;
  if (p.stopRequested) return p.stopRequested;
  if (at >= p.expiresAt) return "expired";
  if (d.control?.stopped) return "keir_stopped";
  if (p.ticket) {
    const owner = d.supportOwner?.tickets?.[p.ticket] || d.supportOwner?.owner || "keir";
    if (owner !== "keir") return "takeover";
    if (d.ticketPauses?.[p.ticket]) return "paused";
    const root = rootTicketJob(d, p.ticket);
    if (root && d.channels?.[root.channelId]?.keirPaused) return "paused";
    if (root && terminal.includes(root.state)) return "ticket_closed";
    if (root && root.closedAt) return "ticket_closed";
  }
  const origin = d.jobs?.[p.jobId];
  if (!p.ticket && origin && terminal.includes(origin.state)) return "task_ended";
  return null;
}
const storeOf = (p, options = {}) => p.page === false ? null : options.store || (p.dir ? createStore(p.dir) : null);
// End a presentation. The ledger records the end at once (so nothing is
// appended), but archivedAt is set only when archived.json is durably on disk,
// or was already there. A failed disk write leaves the end pending; the sweep
// retries it every minute. Returns true when this call completed the archive.
function archiveWith(ledger, store, p, reason, at) {
  if (p.archivedAt) return false;
  if (!p.endReason) { p.endReason = short(reason, 60); p.endedAt = at; }
  if (store) {
    try {
      store.archive(p.id, { at: new Date(p.endedAt ?? at).toISOString(), reason: p.endReason });
      const rec = store.archived(p.id);
      if (!rec || typeof rec.reason !== "string") throw new Error("archive record unreadable after write");
      // The disk record wins: an earlier run may have archived it with another reason.
      p.archivedAt = Date.parse(rec.at) || p.endedAt || at; p.endReason = short(rec.reason, 60);
      delete p.archivePending; delete p.archiveError;
    } catch (e) {
      const first = !p.archivePending;
      p.archivePending = true; p.archiveError = short(e.message, 200);
      if (first) { try { ledger.audit("evidence_archive_pending", { presentation: p.id, ticket: p.ticket || null, reason: p.endReason, error: p.archiveError }); } catch {} }
      return false;
    }
  } else p.archivedAt = p.endedAt ?? at;
  try { ledger.audit("evidence_tracker_archived", { presentation: p.id, ticket: p.ticket || null, reason: p.endReason }); } catch {}
  return true;
}
// For the tracker monitor: archive one presentation with a reason. Idempotent.
// False when it was already archived, or the disk record is still pending.
function archive(ledger, p, reason, at = Date.now(), options = {}) {
  const before = JSON.stringify([p.endReason, p.archivePending, p.archiveError]);
  const changed = archiveWith(ledger, storeOf(p, options), p, short(reason, 60), at);
  if (changed || before !== JSON.stringify([p.endReason, p.archivePending, p.archiveError])) ledger.save();
  return changed;
}
// Append a changed observation to every live tracker of the same scope on the
// same ticket. Page only: never a channel post. One failing page never stops
// the others or the capture itself.
function track(ledger, obs, at, options = {}) {
  const s = state(ledger.data);
  const terminal = options.terminal || require("./machines").JOB_TERMINAL;
  for (const p of Object.values(s.presentations)) {
    if (!p.track || p.archivedAt || p.fingerprint !== obs.fingerprint || obs.envelope.trackable === false) continue;
    if ((p.ticket || null) !== (obs.ticket || null) || (!p.ticket && p.jobId !== obs.jobId)) continue;
    const store = storeOf(p, options);
    const reason = endReason(ledger.data, p, at, terminal);
    if (reason) { archiveWith(ledger, store, p, reason, at); continue; }
    if (!store) continue;
    try {
      // The disk is the record of what was written; a ledger restored from
      // before a write catches up here instead of rewriting a snapshot.
      const last = store.latest(p.id);
      if (last.n !== (p.snapshots || 0)) { p.snapshots = last.n; p.lastRowsHash = last.rowsHash; }
      if (p.lastRowsHash === obs.rowsHash || (p.snapshots || 0) >= MAX_SNAPSHOTS) continue;
      const n = (p.snapshots || 0) + 1;
      const outcome = store.snapshot(p.id, n, snapshotOf(obs, n, at), { at });
      if (outcome === "written" || outcome === "exists") { p.snapshots = n; p.lastRowsHash = obs.rowsHash; p.updatedAt = at; (p.observations ||= []).push(obs.id); }
      else if (outcome === "archived" || outcome === "expired") archiveWith(ledger, store, p, outcome === "expired" ? "expired" : "archived", at);
    } catch (e) {
      p.pageError = short(e.message, 200);
      try { ledger.audit("evidence_snapshot_failed", { presentation: p.id, ticket: p.ticket || null, error: p.pageError }); } catch {}
    }
  }
}
// What a page shows: the closed table(s) with human headings and units, the
// world, scope and time the read was made for, and the plain caveats. Private
// reads never copy their scope onto the page.
function snapshotOf(obs, n, at) {
  const env = obs.envelope, proj = project(env);
  return { n, at: new Date(at).toISOString(), observedAt: new Date(obs.at).toISOString(), rowsHash: obs.rowsHash,
    tool: env.tool, metric: env.metric, kind: env.kind || "series", unit: env.unit, unitLabel: env.unitLabel || null,
    world: env.world || null, asOfTurn: env.asOfTurn, capturedAt: env.capturedAt || null,
    scope: obs.visibility === "public" ? env.scope : {}, title: proj.table?.title || proj.label || null,
    columns: proj.table.columns, columnMeta: proj.table.columnMeta || {}, rows: proj.table.rows,
    tables: (proj.tables || []).slice(1).map((t) => ({ id: t.id, title: t.title, columns: t.columns, columnMeta: t.columnMeta || {}, rows: t.rows })),
    facts: proj.facts || [], caveats: proj.caveats || [], confidence: proj.confidence || null,
    truncated: env.truncated, sources: env.sources, gaps: env.gaps };
}
// Periodic sweep from operator.js: archives expired or ended trackers, so the
// 24 h limit holds across restarts even when nothing reads again.
function sweep(ledger, at = Date.now(), options = {}) {
  const s = state(ledger.data), terminal = options.terminal || require("./machines").JOB_TERMINAL;
  let changed = 0, touched = false;
  for (const p of Object.values(s.presentations)) {
    if (!p.track || p.archivedAt) continue;
    const store = storeOf(p, options);
    // archived.json on disk ends it whatever the ledger says (a restored ledger).
    let onDisk = null;
    try { onDisk = store?.archived(p.id) || null; } catch {}
    const reason = onDisk ? "archived" : endReason(ledger.data, p, at, terminal);
    if (!reason) continue;
    touched = true;
    if (archiveWith(ledger, store, p, reason, at)) changed++;
  }
  // Presentations are kept a week for dedupe and the delivery gate.
  for (const [id, p] of Object.entries(s.presentations)) if ((!p.track || p.archivedAt) && at - p.createdAt > 7 * 86400000) { delete s.presentations[id]; for (const [k, v] of Object.entries(s.byKey)) if (v === id) delete s.byKey[k]; changed++; }
  if (changed || touched) ledger.save();
  return changed;
}
// A player's "stop" or a staff request: archive every live tracker on the ticket.
function stop(ledger, { ticket = null, jobId = null, reason = "stopped_by_request" } = {}, at = Date.now()) {
  const s = state(ledger.data);
  let n = 0, touched = false;
  for (const p of Object.values(s.presentations)) {
    if (p.archivedAt || !p.track) continue;
    if (ticket ? p.ticket !== Number(ticket) : p.jobId !== jobId) continue;
    p.stopRequested = short(reason, 60); touched = true;
    if (archiveWith(ledger, storeOf(p), p, p.stopRequested, at)) n++;
  }
  if (touched) ledger.save();
  return n;
}
function available(ledger, job) {
  const s = state(ledger.data), ticket = ticketNo(job);
  return Object.values(s.observations).filter((o) => ticket ? o.ticket === ticket : o.jobId === job.id).sort((a, b) => b.at - a.at).slice(0, 8)
    .map((o) => ({ observation: o.id, tool: o.tool, metric: o.envelope.metric, rows: o.envelope.rows.length, asOfTurn: o.envelope.asOfTurn, trackable: o.envelope.trackable !== false,
      shown: Object.values(s.presentations).some((p) => p.fingerprint === o.fingerprint && (p.ticket || null) === (ticket || null) && p.chart) }));
}

// --- presentation -------------------------------------------------------------

// The trusted channel a presentation for this job may go to, or null.
function channelFor(d, job, ticket) {
  if (!job) return null;
  if (job.replyChannel && job.replyChannel !== "app" && job.replyChannel === job.source?.channelId) return job.replyChannel;
  // Ticket tasks answer through the support service; their channel is the
  // ticket's own, recorded when the task was created.
  if (job.kind === "ticket" && ticket && Number(job.ticket) === ticket && /^\d{16,20}$/.test(job.channelId || "")) return job.channelId;
  return null;
}
function isTicketChannel(d, job, channel, ticket) {
  if (!ticket || !channel) return false;
  const name = d.channels?.[channel]?.name || (job.source?.channelId === channel ? job.source?.channelName : null);
  const named = Number(/^ticket-.*-(\d+)$/.exec(name || "")?.[1] || 0);
  if (named) return named === ticket;
  return job.kind === "ticket" && job.channelId === channel && Number(job.ticket) === ticket;
}
// The page origin, or null. Pages are off until EVIDENCE_PUBLIC_BASE is set
// explicitly (the Caddy route must exist first); there is no default.
function pagesBase(config) {
  const raw = typeof config?.evidencePublicBase === "string" ? config.evidencePublicBase.trim().replace(/\/+$/, "") : "";
  return /^https:\/\/[a-z0-9.-]+$/i.test(raw) ? raw : null;
}
function linkFor(config, id) {
  const base = pagesBase(config);
  if (!base) throw new Error("evidence pages are off: EVIDENCE_PUBLIC_BASE is not set to a plain https origin");
  return `${base}/support/evidence/${id}`;
}

// --- page audience -------------------------------------------------------------

// The character a game profile link names (the game writes reporter.profileUrl
// at ticket creation from the opener's linked account), or null.
function characterOfProfile(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:" || !/^(?:www\.)?ahousedividedgame\.com$/i.test(u.hostname) || u.search || u.hash) return null;
    return /^\/character\/([1-9]\d{0,8})\/?$/.exec(u.pathname)?.[1] || null;
  } catch { return null; }
}
// support_get answers either as the parsed ticket or as an MCP content envelope.
function ticketRecord(r) {
  if (!r || typeof r !== "object" || r.isError) return null;
  if (Array.isArray(r.content) && r.number === undefined) {
    const text = r.content.find((c) => c?.type === "text")?.text;
    try { r = JSON.parse(text); } catch { return null; }
  }
  return r && typeof r === "object" ? r : null;
}
// Pin a private page to the ticket's original reporter, from the support
// service's own ticket row. Never from job.actorId, the message author or
// model arguments. { audience } or { why }.
async function bindAudience({ job, ticket, readTicket }) {
  if (typeof readTicket !== "function") return { why: "the ticket record cannot be read here" };
  let row = null;
  try { row = ticketRecord(await readTicket(ticket)); } catch { row = null; }
  if (!row || Number(row.number) !== ticket || (row.kind !== undefined && row.kind !== "ticket")) return { why: "the ticket record could not be read" };
  if (row.category === "investigation") return { why: "staff investigations have no player page" };
  const created = Date.parse(row.createdAt || "");
  if (!Number.isFinite(created)) return { why: "the ticket record has no creation time" };
  const character = characterOfProfile(row.reporter?.profileUrl);
  if (!character) return { why: "the ticket has no verified reporter account" };
  const cached = job?.reporterCharacter?.id;
  if (cached && String(cached) !== character) return { why: "the ticket's reporter does not match this task's reporter" };
  return { audience: { v: 1, kind: "ticket_reporter", ticket, ticketCreatedAt: new Date(created).toISOString(), character, source: "support_get" } };
}
function plainCaption(text) {
  if (text === undefined || text === null || text === "") return null;
  if (typeof text !== "string" || text.length > 200) throw new Error("caption must be plain text of at most 200 characters");
  const t = short(text, 200);
  if (/https?:\/\/|www\.|<[a-z/!]|<@|@everyone|@here|\]\(/i.test(t)) throw new Error("caption must be plain text: no links, HTML or mentions (the link is added for you)");
  if (redactSecrets(t) !== t) throw new Error("caption contains private details");
  return t;
}

// present_evidence. ctx: { ledger, config, job, input, now, charts, readTicket }
// readTicket(number) is the broker's support_get read; it pins private pages.
async function present({ ledger, config, job, input = {}, now = Date.now(), charts = require("../charts"), readTicket = null }) {
  const d = ledger.data, s = state(d);
  if (d.control?.stopped) throw new Error("Keir is stopped; nothing is presented until it resumes.");
  require("./supporttakeover").assertCanAct(d, job);
  if (job.replyChannel === "app" || job.source?.channelId === "app") throw new Error("present_evidence is for Discord answers; in the app use chart.");
  const ticket = ticketNo(job);
  const want = input.observation === undefined ? "latest" : input.observation;
  if (typeof want !== "string" || !(want === "latest" || /^ev_[a-f0-9]{12}$/.test(want))) throw new Error('observation must be an id from this task\'s game reads (ev_...), or "latest"');
  const mine = (o) => ticket ? o.ticket === ticket : o.jobId === job.id;
  const obs = want === "latest" ? Object.values(s.observations).filter((o) => o.jobId === job.id).sort((a, b) => b.at - a.at)[0] : s.observations[want];
  if (!obs) throw new Error("No game read to present. Read market_history, reporter_operating_results or reporter_action_points first; ordinary answers need no chart.");
  if (!mine(obs)) throw new Error("That observation belongs to another ticket or task and cannot be shown here.");
  // A player may only see their own ticket's reads, made in their own task.
  if (job.role === "player" && obs.jobId !== job.id) throw new Error("That observation was not read in this conversation.");
  const channel = channelFor(d, job, ticket);
  if (!channel) throw new Error("This task has no trusted Discord channel to attach a chart to.");
  const isPrivate = obs.visibility !== "public";
  if (isPrivate && !isTicketChannel(d, job, channel, ticket)) throw new Error("Reporter evidence is private: it can only be shown in the reporter's own ticket channel.");
  if (input.track !== undefined && typeof input.track !== "boolean") throw new Error("track must be true or false");
  const caption = plainCaption(input.caption);
  const wantTrack = input.track === true;
  if (wantTrack && !ticket) throw new Error("Trackers belong to a ticket; answer once instead.");
  if (wantTrack && obs.envelope.trackable === false) throw new Error("This read is a single-turn snapshot and cannot be tracked; answer once instead.");
  const terminal = require("./machines").JOB_TERMINAL;
  if (wantTrack && endReason(d, { ticket, jobId: job.id, expiresAt: now + 1 }, now, terminal)) throw new Error("This ticket is not live for Keir, so no tracker can start.");

  const key = `${ticket || job.id}:${obs.fingerprint}`;
  const existing = s.presentations[s.byKey[key]];
  const proj = project(obs.envelope);
  if (existing) {
    // First relevant answer only. A later call returns the existing record.
    if (wantTrack && !existing.track) throw new Error("This evidence was already shown without a tracker; a new tracker is not opened on a repeat.");
    return result(existing, config, { chart: existing.chart ? "already_shown" : "not_chartable", repeat: true });
  }
  // Page audience: anything opened from a ticket is that ticket's, whatever the
  // data. Only a public ping's one-off market report is a public page.
  const audienceKind = ticket ? "ticket" : !isPrivate && PUBLIC_PAGE_TOOLS.has(obs.tool) ? "public_aggregate" : null;
  // Render first: a refused chart leaves no record.
  let rendered = null, chartWhy = proj.why || null;
  if (proj.chart) {
    try { rendered = await charts.render(proj.chart); } catch (e) { chartWhy = short(e.message, 160); }
  }
  // Can a page be offered at all? Off until the route is configured; a private
  // page also needs a verifiable original reporter. Otherwise degrade.
  const needPage = proj.dense || wantTrack || !rendered;
  let pageWhy = null, audience = null;
  if (needPage) {
    if (!pagesBase(config)) pageWhy = "evidence pages are not enabled";
    else if (!audienceKind) pageWhy = "this evidence has no page audience";
    else if (audienceKind === "ticket") {
      const bound = await bindAudience({ job, ticket, readTicket });
      if (bound.audience && isPrivate) {
        // Reporter reads must be about the pinned reporter. A different character fails closed.
        let args = null; try { args = JSON.parse(obs.args); } catch {}
        const named = args?.character ?? args?.sequentialId;
        if (named !== undefined && /^\d+$/.test(String(named)) && String(named) !== bound.audience.character) throw new Error("This evidence is not about the ticket's reporter, so it cannot be shown. Answer in words.");
      }
      if (bound.audience) audience = bound.audience; else pageWhy = bound.why;
    }
    // The world may have moved during the ticket read.
    if (d.control?.stopped) throw new Error("Keir is stopped; nothing is presented until it resumes.");
    require("./supporttakeover").assertCanAct(d, job);
    if (s.byKey[key]) return result(s.presentations[s.byKey[key]], config, { chart: "already_shown", repeat: true });
  }
  const track = wantTrack && needPage && !pageWhy;
  const id = crypto.randomBytes(16).toString("hex");
  const dir = config.evidencePagesDir || "/var/lib/lakeside-evidence";
  const p = { id, key, fingerprint: obs.fingerprint, jobId: job.id, ticket: ticket || null, tool: obs.tool, visibility: audienceKind || "ticket", privateData: isPrivate,
    createdAt: now, expiresAt: now + (track ? TRACK_MS : 0), track, dir, observations: [obs.id], snapshots: 0, chart: false,
    channel, ...(wantTrack && !track ? { trackUnavailable: pageWhy } : {}) };

  // The page: written before the link is ever posted.
  let page = false;
  if (needPage && !pageWhy) {
    try {
      const store = createStore(dir);
      const common = { id, version: 2, createdAt: new Date(now).toISOString(), expiresAt: track ? new Date(p.expiresAt).toISOString() : null, kind: track ? "tracker" : "report",
        product: "ahd", tool: obs.tool, metric: obs.envelope.metric, unit: obs.envelope.unit, unitLabel: obs.envelope.unitLabel || null, world: obs.envelope.world || null,
        title: short(proj.chart?.title || proj.table?.title || proj.label || obs.envelope.metric, 120) };
      // A public page's files name no ticket, reporter, task or channel.
      store.create(audienceKind === "ticket" ? { ...common, visibility: "ticket", ticket, audience } : { ...common, visibility: "public_aggregate", ticket: null }, rendered?.png || null);
      const out = store.snapshot(id, 1, snapshotOf(obs, 1, now), { at: now });
      if (out !== "written" && out !== "exists") throw new Error(`first snapshot not written (${out})`);
      p.snapshots = 1; p.lastRowsHash = obs.rowsHash;
      page = true;
    } catch (e) {
      p.pageError = short(e.message, 200);
      try { ledger.audit("evidence_page_failed", { job: job.id, ticket, error: p.pageError }); } catch {}
      // Degrade: no page, no link, no tracker. The inline chart or plain words still answer.
      try { createStore(dir).remove(id); } catch {}
      pageWhy = "the page could not be written";
      if (p.track) { p.track = false; p.expiresAt = now; p.trackUnavailable = pageWhy; }
    }
  } else if (pageWhy) {
    try { ledger.audit("evidence_page_unavailable", { job: job.id, ticket, reason: pageWhy }); } catch {}
  }
  p.page = page;
  if (pageWhy && needPage) p.pageWhy = pageWhy;
  if (!rendered && !page) throw new Error(`Nothing to present: ${chartWhy || "no chartable data"}${pageWhy ? `; ${pageWhy}` : ""}. Answer in words.`);
  // The minted report link, when the page exists and this install serves pages.
  const line = page && (p.visibility !== "ticket" || isTicketChannel(d, job, channel, ticket)) ? linkLine(config, p) : null;
  const answerTo = require("./conversationturn").latestSource(job) || (/^\d{16,20}$/.test(job.source?.messageId || "") ? job.source.messageId : null);

  if (rendered) {
    const art = path.join(config.stateDir, "artifacts");
    fs.mkdirSync(art, { recursive: true, mode: 0o700 });
    // Named to match the outbox's chart attachment allowlist.
    const file = path.join(art, `chart-${job.id}-${sha([id, obs.rowsHash]).slice(0, 12)}.png`);
    if (!/^[a-f0-9]{12}$/.test(job.id)) throw new Error("task id is not attachable");
    fs.writeFileSync(file, rendered.png, { mode: 0o600 });
    // Staged for this task's next answer in this activation. Nothing is queued here.
    p.staged = { jobId: job.id, activation: job.startedAt || null, answerTo, channel, at: now,
      file, name: "ahd-evidence-chart.png", caption: caption || null, line };
    p.chart = true;
  } else if (line) {
    // Link only: dense data with no single-unit chart (a 27-market dated
    // report mixes commodity units). The answer carries the report link alone,
    // through the same claim / verify / delivered seam as a chart.
    p.staged = { jobId: job.id, activation: job.startedAt || null, answerTo, channel, at: now,
      file: null, name: null, caption: caption || null, line };
  }
  s.presentations[id] = p; s.byKey[key] = id;
  ledger.audit("evidence_presented", { job: job.id, ticket, presentation: id, tool: obs.tool, chart: p.chart, page, link: Boolean(p.staged?.line), track: p.track, visibility: p.visibility, ...(p.pageWhy ? { pageUnavailable: p.pageWhy } : {}) });
  ledger.save();
  return result(p, config, { chart: rendered ? "staged" : "not_chartable", why: rendered ? null : chartWhy });
}
// Null when links are not configured for this install.
function linkLine(config, p) {
  const url = linkFor(config, p.id);
  if (!url) return null;
  const label = `Full table${p.track ? ", updated for 24 hours" : ""}: ${url}`;
  return p.visibility === "ticket" ? `${label} (sign in at ${new URL(url).host} with the account linked to your Discord)` : label;
}
function result(p, config, { chart, why = null, repeat = false }) {
  const tracker = p.track ? (p.archivedAt || p.endReason ? `ended: ${p.endReason}` : `live_until ${new Date(p.expiresAt).toISOString()}`) : p.trackUnavailable ? "unavailable" : "off";
  const report = p.page ? (p.staged?.line ? "linked" : "written") : p.pageWhy ? "unavailable" : "not_needed";
  const note = p.pageWhy ? ` No page or link: ${p.pageWhy}.${p.trackUnavailable ? " Nothing will be tracked, so do not promise updates." : ""}` : "";
  return { presentation: p.id, chart, report, tracker, visibility: p.visibility, ...(why ? { why } : {}), ...(p.pageWhy ? { pageUnavailable: p.pageWhy } : {}),
    instruction: repeat ? "Already shown on this ticket. Do not post it again; refer to it in words if needed."
      : chart === "staged" ? `The chart is attached to your next answer in this channel. Answer in words as usual; do not paste a link or describe the image.${note}`
      : p.staged?.line ? "The full-table link is staged for the next answer. Summarize the main finding in words." : `Answer in words.${note}` };
}

// --- delivery seam (the answer's own delivery path) --------------------------

// Why a staged chart may not go out now, or null. Rechecked at claim time and
// again just before the message is sent.
function blocked(d, p, job, at) {
  if (!p || !p.staged || !job || p.jobId !== job.id) return "evidence record missing";
  if (p.staged.deliveredAt) return "already delivered";
  if (p.staged.released) return `released: ${p.staged.released}`;
  if (d.control?.stopped) return "keir_stopped";
  if (at - p.createdAt > ANSWER_WAIT_MS) return "stale";
  const channel = channelFor(d, job, p.ticket);
  if (!channel || channel !== p.channel || channel !== p.staged.channel) return "channel no longer trusted";
  // Reporter data stays in its ticket channel. Records from before privateData
  // existed used visibility "ticket" for exactly that.
  if ((p.privateData ?? p.visibility === "ticket") && !isTicketChannel(d, job, channel, p.ticket)) return "private evidence outside its ticket";
  if (p.ticket) {
    const owner = d.supportOwner?.tickets?.[p.ticket] || d.supportOwner?.owner || "keir";
    if (owner !== "keir") return "takeover";
    const root = rootTicketJob(d, p.ticket);
    if (d.ticketPauses?.[p.ticket] || (root && d.channels?.[root.channelId]?.keirPaused) || d.channels?.[channel]?.keirPaused) return "paused";
  }
  if (!p.staged.file && !p.staged.line) return "nothing staged";
  if (p.staged.file && !fs.existsSync(p.staged.file)) return "chart file missing";
  return null;
}
// Called by the answer's delivery path (channel_reply outbox entry or the
// ticket support update) while it builds that answer. Returns the one staged
// chart for this task, this activation and this channel, or null. A claim is
// bound to `key` (the answer's own idempotency key): the same key gets the
// same claim back after a retry or restart; a different answer gets nothing,
// so one chart never rides on two messages.
function claim(ledger, job, { channel, key, at = Date.now() } = {}) {
  const d = ledger.data, s = state(d);
  if (!job || typeof key !== "string" || !key) return null;
  const mine = Object.values(s.presentations).filter((p) => p.staged && p.jobId === job.id && !p.staged.deliveredAt && !p.staged.released)
    .filter((p) => (p.staged.activation || null) === (job.startedAt || null) && (!channel || p.staged.channel === channel))
    .sort((a, b) => b.createdAt - a.createdAt);
  const p = mine.find((x) => x.staged.claimKey === key) || mine.find((x) => !x.staged.claimKey);
  if (!p) return null;
  const why = blocked(d, p, job, at);
  if (why) { p.staged.released = why; ledger.audit("evidence_chart_released", { presentation: p.id, job: job.id, reason: why }); ledger.save(); return null; }
  if (!p.staged.claimKey) { p.staged.claimKey = key; p.staged.claimedAt = at; ledger.save(); }
  return { presentation: p.id, ticket: p.ticket, visibility: p.visibility, channel: p.staged.channel, answerTo: p.staged.answerTo,
    files: p.staged.file ? [{ path: p.staged.file, name: p.staged.name, chart: true }] : [], line: p.staged.line || null, caption: p.staged.caption || null };
}
// The last check before sending a message that carries a claimed chart.
// { ok: true } or { ok: false, reason }: on false send the answer text alone
// (without the files and the link line) and call release().
function verify(ledger, presentationId, { job, key, at = Date.now() } = {}) {
  const p = state(ledger.data).presentations[presentationId];
  if (!p?.staged || p.staged.claimKey !== key) return { ok: false, reason: "not claimed by this answer" };
  if (p.staged.deliveredAt) return { ok: false, reason: "already delivered" };
  const why = blocked(ledger.data, p, job, at);
  return why ? { ok: false, reason: why } : { ok: true };
}
// Record the Discord receipt of the message that carried the chart.
// A delivery needs Discord's stored message id; a chart also needs its
// attachment id, a link-only delivery needs the posted message to carry it.
function delivered(ledger, presentationId, { messageId = null, attachmentId = null, linked = false, at = Date.now() } = {}) {
  const p = state(ledger.data).presentations[presentationId];
  if (!p?.staged || p.staged.deliveredAt) return false;
  if (!messageId || (p.staged.file ? !attachmentId : !linked)) return false;
  p.staged.deliveredAt = at; p.staged.messageId = String(messageId).slice(0, 30); p.staged.attachmentId = attachmentId ? String(attachmentId).slice(0, 30) : null;
  p.staged.linked = Boolean(linked && p.staged.line);
  ledger.audit("evidence_chart_delivered", { presentation: p.id, ticket: p.ticket || null, messageId: p.staged.messageId, chart: Boolean(p.staged.file), linked: p.staged.linked });
  ledger.save();
  return true;
}
// The answer went out without the chart (or will not go out). The chart is
// never sent later on its own.
function release(ledger, presentationId, reason = "released") {
  const p = state(ledger.data).presentations[presentationId];
  if (!p?.staged || p.staged.deliveredAt || p.staged.released) return false;
  p.staged.released = short(reason, 80);
  ledger.audit("evidence_chart_released", { presentation: p.id, reason: p.staged.released });
  ledger.save();
  return true;
}

// The presentation an answer key was bound to, whatever its state now. Used
// to keep that answer's support update key stable across retries.
function boundTo(ledger, job, key) {
  if (!job || typeof key !== "string" || !key) return null;
  return Object.values(state(ledger.data).presentations).find((p) => p.staged && p.jobId === job.id && p.staged.claimKey === key) || null;
}

module.exports = { TOOLS, TRACK_MS, ANSWER_WAIT_MS, PUBLIC_PAGE_TOOLS, pagesBase, characterOfProfile, bindAudience, observe, project, createStore, present, claim, verify, delivered, release, sweep, stop, archive, available, endReason, linkFor, boundTo };
