"use strict";
// Read-only studio evidence for the owner's private supervisor. Two fixed
// reads and nothing else:
//
//   ticket(number)  one numbered A House Divided support record (support_get)
//   games(id?)      the game health facts the owner's phone card shows
//
// Reads go through the ops web MCP client (keir-hub-data mcpCall), which
// authenticates with this host's own configured MCP credentials. Callers pick
// a ticket number or a game id, never a server, tool, identity or argument,
// and nothing here writes. Every reply is rebuilt field by field from an
// allow-list, so raw MCP output never reaches the model. A failed read or an
// unexpected shape is reported as unavailable, never guessed at.
//
// The game section is a dependency-free copy of the phone card
// (apps/agent/lib/operator/appgames.js) because the web service ships without
// apps/agent. apps/agent/test/appgames-web-parity.test.js keeps them identical.
const fs = require("node:fs");

// ---- Game health: copy of appgames.js (keep in step; see parity test) ----

const READ_TIMEOUT_MS = 8000;
const STATES = ["live", "partial", "unavailable", "unsupported", "available"];

const clip = (value, max = 80) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const shortSha = (value) => (/^[0-9a-f]{7,40}$/i.test(String(value || "")) ? String(value).slice(0, 7).toLowerCase() : null);
const tag = (value) => (/^[A-Za-z0-9._+-]{1,40}$/.test(String(value || "")) ? String(value) : null);
const branch = (value) => (/^[A-Za-z0-9._\/-]{1,60}$/.test(String(value || "")) ? String(value) : null);
const stamp = (value) => { const t = Date.parse(value); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const fact = (label, value) => (value === null || value === undefined || value === "" ? null : { label, value: String(value) });
const facts = (...rows) => rows.filter(Boolean);
const responding = (probe) => (probe?.reachable === true && probe.ok === true ? "Responding" : probe?.reachable === true ? "Reachable, reported a problem" : "Not responding");

// The completeness and freshness rule of appstatus.formatStatus, which the
// phone card applies to engine_health before showing any AHD fact.
function checkStatus(s, now = Date.now()) {
  const checked = Date.parse(s?.checkedAt);
  if (!Number.isSafeInteger(s?.turn) || s.turn < 0 || typeof s.paused !== "boolean" || !Number.isFinite(checked) || now - checked > 120000 || checked > now + 30000)
    throw new Error("Current game status is unavailable");
}

function release(r) {
  const t = tag(r?.tag);
  return t ? fact("Latest release", `${t}${stamp(r?.publishedAt) ? ` (${stamp(r.publishedAt).slice(0, 10)})` : ""}`) : fact("Latest release", "None published");
}
function commit(label, c) {
  if (!c || c.error) return fact(label, "Unavailable");
  const sha = shortSha(c.sha || c.shortSha), b = branch(c.branch), at = stamp(c.committedAt);
  return sha ? fact(label, `${sha}${b ? ` on ${b}` : ""}${at ? `, ${at.slice(0, 10)}` : ""}`) : fact(label, "Unavailable");
}

const READS = {
  ahd: [{
    id: "turns", label: "Turns and engine health", server: "engine", tool: "engine_health",
    summarise(raw, now) {
      checkStatus(raw, now);
      const last = raw.lastTurn;
      return { facts: facts(
        fact("Turn", raw.turn), Number.isFinite(raw.year) ? fact("Year", raw.year) : null,
        fact("Game", raw.paused ? `Paused${raw.pauseReason ? `: ${clip(raw.pauseReason, 120)}` : ""}` : "Running"),
        typeof last?.success === "boolean" ? fact("Latest turn", `${last.success ? "Succeeded" : "Failed"}${Number.isFinite(last.durationMs) ? ` in ${Math.round(last.durationMs / 1000)} s` : ""}`) : null,
        Number.isSafeInteger(last?.warnings) ? fact("Warnings on latest turn", last.warnings) : null,
        stamp(raw.schedule?.next) ? fact("Next turn due (UTC)", stamp(raw.schedule.next).slice(0, 16).replace("T", " ")) : null) };
    },
  }],
  metroforge: [{
    id: "deploy", label: "Service and release health", server: "metroforge", tool: "mf_status",
    summarise(raw) {
      if (!raw || typeof raw !== "object" || (!raw.preview && !raw.api && !raw.web)) throw new Error("empty status");
      const binaries = Array.isArray(raw.sidecarBinaries) ? raw.sidecarBinaries.length : null;
      return { facts: facts(fact("Preview site", responding(raw.preview)), fact("API", responding(raw.api)), commit("Web build", raw.web), commit("Native build", raw.native), release(raw.latestRelease), binaries === null ? null : fact("Native sidecar binaries", binaries)),
        note: "Deploy and service health only. This does not read players, scores or gameplay." };
    },
  }, {
    id: "cities", label: "City bundles", server: "metroforge", tool: "mf_cities",
    summarise(raw) {
      const cities = Array.isArray(raw?.cities) ? raw.cities : null;
      if (!cities) throw new Error("no city list");
      const real = cities.filter((c) => c?.real === true).length;
      const names = cities.map((c) => clip(c?.label || c?.key, 40)).filter(Boolean).slice(0, 24);
      return { facts: facts(fact("Bundles", cities.length), fact("Real-map", real), fact("Procedural", cities.length - real), names.length ? fact("Names", names.join(", ")) : null) };
    },
  }],
  "grand-century": [{
    id: "deploy", label: "Live site and release health", server: "grand-century", tool: "gc_status",
    summarise(raw) {
      if (!raw || typeof raw !== "object" || (!raw.live && !raw.repo)) throw new Error("empty status");
      const chunk = /^assets\/index-[A-Za-z0-9_-]{1,40}\.js$/.test(String(raw.live?.indexChunk || "")) ? raw.live.indexChunk : null;
      return { facts: facts(fact("Live site", responding(raw.live)), chunk ? fact("Served bundle", chunk) : null, commit("Latest commit", raw.repo), release(raw.latestRelease)),
        note: "Reports the live site and the latest commit separately. It does not show that the live site was built from that commit, and it does not read players or gameplay." };
    },
  }],
};

const GAMES = [
  { id: "ahd", name: "A House Divided", tickets: true,
    scope: "Live turn and engine health. Player tickets and Discord pings are read through the Inbox, not here.",
    withheld: ["Player accounts, holdings and private data"] },
  { id: "metroforge", name: "MetroForge", tickets: false,
    scope: "Service and release health, and which city bundles ship.",
    withheld: ["Leaderboard (lists player names)", "Simulation runs (they execute code)"] },
  { id: "grand-century", name: "Grand Century", tickets: false,
    scope: "Live site and release health.",
    withheld: ["World simulation runs (they execute code)"] },
];
const TICKET_UNSUPPORTED = "Support tickets come from the A House Divided desk only. Nothing here connects them to this game.";

function createGames({ mcp, now = () => Date.now(), readTimeoutMs = READ_TIMEOUT_MS }) {
  const registered = () => { try { return new Set(mcp.servers()); } catch { return new Set(); } };
  const known = (id) => GAMES.find((g) => g.id === id);
  const serverOf = (id) => READS[id][0].server;

  const ticketRow = (game) => game.tickets
    ? { id: "tickets", label: "Tickets and pings", state: "available", note: "Open the Inbox. Keir reads tickets there; they are not re-read in this sheet." }
    : { id: "tickets", label: "Tickets and pings", state: "unsupported", note: TICKET_UNSUPPORTED };

  function list() {
    const have = registered();
    return { games: GAMES.map((g) => ({
      id: g.id, name: g.name, scope: g.scope, withheld: g.withheld,
      state: have.has(serverOf(g.id)) ? "available" : "unsupported",
      ...(have.has(serverOf(g.id)) ? {} : { note: "No read connection is registered for this game on the studio host." }),
    })) };
  }

  async function readOne(spec) {
    const at = now();
    const base = { id: spec.id, label: spec.label, source: `${spec.server} · ${spec.tool}`, checkedAt: new Date(at).toISOString() };
    try {
      const raw = await mcp.call(spec.server, spec.tool, {}, false, AbortSignal.timeout(readTimeoutMs));
      const out = spec.summarise(raw, at);
      return { ...base, state: "live", facts: out.facts, ...(out.note ? { note: out.note } : {}) };
    } catch {
      return { ...base, state: "unavailable", facts: [], note: "Keir could not read this just now. That says nothing about the game itself." };
    }
  }

  async function read(id) {
    const game = known(id);
    if (!game) throw Object.assign(new Error("unknown game"), { status: 404 });
    const summary = list().games.find((g) => g.id === id);
    if (summary.state === "unsupported") return { ...summary, reads: [], capabilities: [ticketRow(game)] };
    const reads = await Promise.all(READS[id].map(readOne));
    const state = reads.every((r) => r.state === "live") ? "live" : reads.some((r) => r.state === "live") ? "partial" : "unavailable";
    return { id: game.id, name: game.name, scope: game.scope, withheld: game.withheld, state, reads, capabilities: [ticketRow(game)] };
  }

  return { list, read };
}

// ---- Host bridge: the web MCP client in the shape the phone card expects ----

const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost):/;

function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error("read timed out"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    promise.then((v) => { signal.removeEventListener("abort", stop); resolve(v); }, (e) => { signal.removeEventListener("abort", stop); reject(e); });
  });
}

// Only the fixed (server, tool) pairs below are ever passed to mcpCall.
function hostBridge({ mcpCall, configPath }) {
  return {
    servers() {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return Object.entries(cfg?.mcpServers || {}).filter(([, v]) => LOCAL.test(String(v?.url || ""))).map(([k]) => k);
    },
    call: (server, tool, args, _write, signal) => untilAborted(Promise.resolve().then(() => mcpCall(server, tool, args, { configPath })), signal),
  };
}

// ---- Support record evidence ----

const SNOWFLAKE = /^\d{16,20}$/;
const NOT_RECORDED = "not recorded";
const CHANGE_KINDS = new Set(["development", "production", "heal"]);
const DELIVERY_STATES = new Set(["posted", "pending", "failed", "skipped"]);
const TIMELINE_CAP = 80;

const text = (value, max) => clip(value, max) || null;
const actor = (value) => clip(value, 60) || NOT_RECORDED;
const snowflake = (value) => (SNOWFLAKE.test(String(value ?? "")) ? String(value) : null);

class ShapeError extends Error {}

// Where one recorded Discord delivery actually went. "delivered" is true only
// for a post with a real message id in this ticket's own channel (or the
// channel it had before a reopen). Anything else is described, not counted.
function deliveryOf(d, { room, previous, card }) {
  if (!d || typeof d !== "object") return { status: "not recorded", delivered: false, where: "No delivery record." };
  const status = DELIVERY_STATES.has(d.status) ? d.status : "unknown";
  const attempts = Number.isSafeInteger(d.attempts) ? d.attempts : null;
  const base = { status, delivered: false, ...(attempts !== null ? { attempts } : {}) };
  if (status === "pending") return { ...base, where: "Not delivered yet: the send was still pending." };
  if (status === "failed") return { ...base, where: `Not delivered: the send failed${text(d.error, 160) ? ` (${text(d.error, 160)})` : ""}.` };
  if (status === "skipped") return { ...base, where: `Not delivered: skipped${text(d.reason, 160) ? ` (${text(d.reason, 160)})` : ""}.` };
  if (status !== "posted") return { ...base, where: "The delivery state is not one the support service records. Treat it as unknown." };
  const channel = snowflake(d.channelId), message = snowflake(d.messageId), at = stamp(d.postedAt);
  if (!channel || !message) return { ...base, where: "Marked posted, but no Discord channel or message id was recorded, so delivery is unverified." };
  if (card && message === card) return { ...base, messageId: message, postedAt: at, where: "Edited the ticket's intake card. That is not a new message in the channel." };
  if (room && channel === room) return { ...base, delivered: true, channel: "this ticket's channel", messageId: message, postedAt: at, where: "Delivered to this ticket's own Discord channel." };
  if (previous && channel === previous) return { ...base, delivered: true, channel: "this ticket's earlier channel (before it was reopened)", messageId: message, postedAt: at, where: "Delivered to the channel this ticket had before it was reopened." };
  return { ...base, messageId: message, postedAt: at, where: "Posted to a Discord channel that is not this ticket's channel. It does not count as a reply on this ticket." };
}

function summariseTicket(raw, number, at) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.kind !== "ticket" || raw.number !== number || typeof raw.status !== "string" || !stamp(raw.createdAt))
    throw new ShapeError("unexpected shape");
  const gaps = [];
  const arr = (key) => {
    if (raw[key] === undefined || raw[key] === null) return [];
    if (Array.isArray(raw[key])) return raw[key].filter((x) => x && typeof x === "object");
    gaps.push(`${key} had an unexpected shape and was left out.`);
    return [];
  };
  const room = snowflake(raw.conversation?.channelId), previous = snowflake(raw.conversation?.previousChannelId);
  const card = snowflake(raw.intake?.cardMessageId);
  const reopenedAt = stamp(raw.conversation?.reopenedAt);
  const investigation = raw.category === "investigation";
  if (!room && !investigation) gaps.push("No Discord channel is recorded for this ticket, so no reply can be verified as delivered to it.");

  const events = [];
  const ask = { at: stamp(raw.createdAt), actor: "player", kind: "player_ask", reporter: text(raw.reporter, 60), title: text(raw.title, 160), text: text(raw.description, 800) };
  events.push(ask);

  for (const h of arr("statusHistory")) {
    events.push({ at: stamp(h.at), actor: actor(h.by), kind: "status_change", status: text(h.status, 40), ...(text(h.source, 30) ? { via: text(h.source, 30) } : {}), ...(text(h.note, 200) ? { note: text(h.note, 200) } : {}) });
  }

  const updates = [];
  for (const u of arr("publicUpdates")) {
    const mode = u.deliveryMode === "reply" ? "reply" : u.deliveryMode === "card" ? "card" : "not recorded";
    const delivery = deliveryOf(u.delivery, { room, previous, card });
    const entry = { at: delivery.postedAt || stamp(u.at), actor: `${NOT_RECORDED} (sent by the support service; the record does not name who asked for it)`, kind: "player_update",
      updateKind: text(u.kind, 40) || NOT_RECORDED, mode, ...(u.ticketOnly === true ? { ticketOnly: true } : {}), ...(u.supersededAt ? { superseded: true } : {}),
      text: text(u.message, 500), delivery };
    events.push(entry); updates.push(entry);
  }

  let resolution = null;
  if (raw.resolution && typeof raw.resolution === "object") {
    const r = raw.resolution;
    const actions = Array.isArray(r.actions) ? r.actions.map((a) => text(typeof a === "string" ? a : a?.label, 200)).filter(Boolean).slice(0, 12) : [];
    resolution = { at: stamp(r.resolvedAt) || stamp(raw.resolvedAt) || stamp(raw.closedAt) || stamp(r.createdAt), actor: actor(r.closedBy || raw.resolvedBy || raw.closedBy), kind: "resolution_receipt",
      ...(text(r.source, 20) ? { via: text(r.source, 20) } : {}), text: text(r.message, 600), actionsStated: actions, ...(text(r.followUp, 300) ? { followUp: text(r.followUp, 300) } : {}),
      channelDelivery: r.channelDelivery ? deliveryOf(r.channelDelivery, { room, previous, card }) : { status: "not recorded", delivered: false, where: "No channel post of this resolution is recorded." } };
    events.push(resolution);
  } else if (raw.resolution !== null && raw.resolution !== undefined) gaps.push("resolution had an unexpected shape and was left out.");

  const credit = raw.resolutionAttribution;
  if (credit && typeof credit === "object") {
    events.push({ at: stamp(credit.recordedAt), actor: actor(credit.recordedBy), kind: "resolution_credit", creditedTo: text(credit.agent, 60) || NOT_RECORDED,
      ...(text(credit.jobId, 160) ? { jobId: text(credit.jobId, 160) } : {}), statedEvidence: text(credit.evidence, 300) });
  }

  for (const r of arr("copyRefusals")) {
    events.push({ at: stamp(r.at), actor: actor(r.by), kind: "refused_post", ...(text(r.tool, 40) ? { tool: text(r.tool, 40) } : {}), reason: text(r.kind, 160), note: "Blocked by the copy guard. It never reached the player." });
  }
  for (const e of arr("evidenceDeliveries")) {
    events.push({ at: stamp(e.at), actor: NOT_RECORDED, kind: "evidence_chart", presentation: text(e.presentation, 60), status: text(e.status, 30) || NOT_RECORDED,
      attachedToMessage: Boolean(snowflake(e.messageId) && snowflake(e.attachmentId)), ...(text(e.reason, 120) ? { reason: text(e.reason, 120) } : {}) });
  }
  if (raw.mergedInto !== null && raw.mergedInto !== undefined) {
    events.push({ at: stamp(raw.mergedAt), actor: actor(raw.mergedBy), kind: "merged", into: Number.isSafeInteger(raw.mergedInto) ? raw.mergedInto : text(raw.mergedInto, 20) });
  }
  if (reopenedAt) events.push({ at: reopenedAt, actor: NOT_RECORDED, kind: "reopened", note: "Moved to a new Discord channel." });

  const timeOf = (e) => (e.at ? Date.parse(e.at) : Infinity);
  const timeline = events.map((e, i) => [e, i]).sort((a, b) => timeOf(a[0]) - timeOf(b[0]) || a[1] - b[1]).map(([e]) => e);
  if (timeline.some((e) => !e.at)) gaps.push("Some entries carry no time and are listed last, in record order.");
  const shown = timeline.length > TIMELINE_CAP ? [ask, ...timeline.filter((e) => e !== ask).slice(-(TIMELINE_CAP - 1))] : timeline;
  if (shown.length < timeline.length) gaps.push(`The timeline has ${timeline.length} entries; the player's ask and the latest ${TIMELINE_CAP - 1} are shown.`);

  // First verified reply in the current room since it opened (or reopened),
  // the same rule the support desk uses for its "replied" state.
  const since = Date.parse(reopenedAt || raw.createdAt);
  const firstReply = updates.filter((u) => u.mode === "reply" && u.delivery.delivered && u.delivery.channel === "this ticket's channel" && Date.parse(u.delivery.postedAt) >= since)
    .sort((a, b) => Date.parse(a.delivery.postedAt) - Date.parse(b.delivery.postedAt))[0] || null;

  const messages = Array.isArray(raw.messages) ? raw.messages.filter((m) => typeof m === "string" && m.trim()) : [];
  const lastChange = timeline.filter((e) => e.kind === "status_change").pop() || null;
  const claims = [
    ...updates.filter((u) => CHANGE_KINDS.has(u.updateKind) && !u.superseded).map((u) => ({ at: u.at, said: `player update (${u.updateKind})`, delivered: u.delivery.delivered, text: u.text })),
    ...(resolution ? resolution.actionsStated.map((a) => ({ at: resolution.at, said: "resolution receipt action", text: a })) : []),
  ];

  return {
    ticket: number, state: "read", source: "support · support_get", checkedAt: new Date(at).toISOString(),
    title: text(raw.title, 160), category: text(raw.category, 40),
    ...(investigation ? { privateInvestigation: true, note: "Private investigation: there is no player channel and nothing here was sent to a player." } : {}),
    status: { current: text(raw.status, 40), lastSetBy: lastChange ? lastChange.actor : NOT_RECORDED, lastSetAt: lastChange ? lastChange.at : null,
      meaning: "A status is a label someone set. It is not proof that anything was done." },
    playerAsk: ask,
    otherMessages: { count: messages.length, latest: messages.slice(-3).map((m) => text(m, 300)), note: "Stored without author or time; do not attribute them to anyone." },
    replies: { recorded: updates.length, deliveredToThisTicket: updates.filter((u) => u.delivery.delivered).length,
      firstVerifiedReplyAt: firstReply ? firstReply.delivery.postedAt : null,
      note: "Delivered means Discord returned a message id in this ticket's own channel. A pending, failed, skipped or other-channel send was not delivered." },
    timeline: shown,
    actionProof: {
      gameChangeProven: false,
      statement: "This support record cannot prove the game was changed. Replies, status labels, resolution text and credit record what someone said or set, not a change in the game.",
      claimsOfChange: claims,
      pointers: Object.fromEntries([["fixSessionId", text(raw.fixSessionId, 80)], ["trackerItemId", text(raw.trackerItemId, 80)]].filter(([, v]) => v)),
      checkNext: "Confirm a data correction in heal history, or a code fix by its pull request and deploy, before saying the game changed.",
    },
    ...(gaps.length ? { gaps } : {}),
  };
}

function createStudioEvidence({ mcpCall, configPath, ledgerPath, now = () => Date.now(), readTimeoutMs = READ_TIMEOUT_MS, ticketTimeoutMs = 20000 } = {}) {
  if (typeof mcpCall !== "function") throw new Error("mcpCall is required");
  if (!configPath) throw new Error("configPath is required");
  const mcp = hostBridge({ mcpCall, configPath });
  const games = createGames({ mcp, now, readTimeoutMs });

  async function ticket(number, signal) {
    const n = Number(number);
    if (!Number.isSafeInteger(n) || n < 1 || n > 9999999) throw new Error("number must be a whole ticket number");
    const at = now();
    let raw;
    try {
      const timeout = AbortSignal.timeout(ticketTimeoutMs);
      raw = await mcp.call("support", "support_get", { kind: "ticket", number: n }, false, signal ? AbortSignal.any([signal, timeout]) : timeout);
    } catch {
      // The reason is not forwarded: tool errors can carry host detail.
      return { ticket: n, state: "unavailable", checkedAt: new Date(at).toISOString(),
        note: `Keir could not read support ticket #${n} just now: it may not exist, may not be visible to this host, or the support service did not answer. That says nothing about what happened on the ticket.` };
    }
    try { return summariseTicket(raw, n, at); }
    catch (e) {
      if (!(e instanceof ShapeError)) throw e;
      return { ticket: n, state: "unavailable", checkedAt: new Date(at).toISOString(),
        note: `The support service answered for ticket #${n} in a shape Keir does not recognise, so nothing from it is reported. Treat the ticket's history as unavailable.` };
    }
  }

  async function queue(signal) {
    const checkedAt = new Date(now()).toISOString();
    const timeout = AbortSignal.timeout(readTimeoutMs);
    let raw;
    try {
      raw = await mcp.call("support", "support_list", { kind: "ticket", openOnly: true, includeReplyState: true, limit: 60 },
        false, signal ? AbortSignal.any([signal, timeout]) : timeout);
    } catch { return { state: "unavailable", checkedAt }; }
    if (!Array.isArray(raw?.items) || raw.items.length > 60 || raw.count !== raw.items.length ||
        raw.items.some((row) => !Number.isSafeInteger(row?.number) || row.number < 1 || typeof row.title !== "string")) {
      return { state: "unavailable", checkedAt };
    }

    let ledger;
    try { if (ledgerPath) ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")); } catch { /* The support queue is still readable. */ }
    const snapshotAt = now();
    const fresh = Number.isFinite(ledger?.heartbeat) && Math.abs(snapshotAt - ledger.heartbeat) < 120000;
    const items = raw.items.map((row) => {
      const job = fresh && ledger.jobs?.[ledger.seen?.[`ticket:${row.number}`]];
      const current = job?.kind === "ticket" && job.ticket === row.number && ["running", "queued", "waiting", "blocked"].includes(job.state);
      const waitingFor = current && job.state === "waiting" && ["player_reply", "developer_reply"].includes(job.waitingFor?.kind)
        ? job.waitingFor.kind : null;
      return {
        number: row.number, title: text(row.title, 180), status: text(row.status, 40),
        reply: ["delivered", "no_receipt"].includes(row.replyState?.state) ? row.replyState.state : "unknown",
        work: current ? job.state : null, waitingFor,
      };
    });
    return { state: "read", checkedAt, source: "Support MCP and Keir's current coordinator state", items, possiblyMore: items.length === 60 };
  }

  async function health(id) {
    if (id !== undefined && id !== null && id !== "" && !GAMES.some((g) => g.id === id)) throw new Error(`unknown game; one of ${GAMES.map((g) => g.id).join(", ")}`);
    const ids = id ? [id] : GAMES.map((g) => g.id);
    const out = await Promise.all(ids.map((g) => games.read(g)));
    return {
      games: out.map(({ capabilities, ...g }) => g),
      meaning: "The same facts as the owner's phone game card, read just now. 'unavailable' means Keir could not read it, which says nothing about the game. 'unsupported' means no read path exists on this host. Nothing else about these games was read.",
    };
  }

  return { ticket, queue, games: health };
}

module.exports = { createStudioEvidence, createGames, summariseTicket, deliveryOf, hostBridge, GAMES, READS, STATES, TICKET_UNSUPPORTED };
