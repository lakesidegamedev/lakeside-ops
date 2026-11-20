"use strict";
// Connected games for the owner's private Keir app: what Keir can genuinely
// read in each Lakeside game, and a bounded read-only snapshot of it.
//
// This is a fixed catalogue, not a general tool proxy. Each read names one
// reviewed MCP tool with no arguments. Every response is rebuilt field by
// field from an allow-list, so host paths, URLs, commit messages, player names
// and anything a tool adds later never reach the phone. Authentication
// (owner only) belongs to appchannel; this module never writes anything.
const { formatStatus } = require("./appstatus");

const READ_TIMEOUT_MS = 8000;

// A read is "live" only when it returned just now; a game is "partial" when only some of its reads did. "available" appears in the
// list view only: the server is registered but nothing has been read yet.
// "unsupported" means there is no read path (or no server) for it on this host.
const STATES = ["live", "partial", "unavailable", "unsupported", "available"];

const clip = (value, max = 80) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const shortSha = (value) => (/^[0-9a-f]{7,40}$/i.test(String(value || "")) ? String(value).slice(0, 7).toLowerCase() : null);
const tag = (value) => (/^[A-Za-z0-9._+-]{1,40}$/.test(String(value || "")) ? String(value) : null);
const branch = (value) => (/^[A-Za-z0-9._\/-]{1,60}$/.test(String(value || "")) ? String(value) : null);
const stamp = (value) => { const t = Date.parse(value); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const fact = (label, value) => (value === null || value === undefined || value === "" ? null : { label, value: String(value) });
const facts = (...rows) => rows.filter(Boolean);
const responding = (probe) => (probe?.reachable === true && probe.ok === true ? "Responding" : probe?.reachable === true ? "Reachable, reported a problem" : "Not responding");

function release(r) {
  const t = tag(r?.tag);
  return t ? fact("Latest release", `${t}${stamp(r?.publishedAt) ? ` (${stamp(r.publishedAt).slice(0, 10)})` : ""}`) : fact("Latest release", "None published");
}
function commit(label, c) {
  if (!c || c.error) return fact(label, "Unavailable");
  const sha = shortSha(c.sha || c.shortSha), b = branch(c.branch), at = stamp(c.committedAt);
  return sha ? fact(label, `${sha}${b ? ` on ${b}` : ""}${at ? `, ${at.slice(0, 10)}` : ""}`) : fact(label, "Unavailable");
}

// One entry per read. `summarise` receives the raw tool result and returns
// { facts, note? } or throws when the result is unusable.
const READS = {
  ahd: [{
    id: "turns", label: "Turns and engine health", server: "engine", tool: "engine_health",
    summarise(raw, now) {
      formatStatus(raw, now); // throws unless the snapshot is complete and fresh
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

// What each game cannot do, stated rather than implied.
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
      // The reason is not forwarded: tool errors can carry host detail.
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

  async function route(path, method) {
    if (path === "/games" && method === "GET") return list();
    const m = /^\/games\/([a-z][a-z-]{1,24})$/.exec(path);
    if (m && method === "GET") return read(m[1]);
    return undefined;
  }

  return { list, read, route };
}

module.exports = { createGames, GAMES, READS, STATES, TICKET_UNSUPPORTED };
