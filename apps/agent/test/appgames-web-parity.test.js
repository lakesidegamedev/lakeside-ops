"use strict";
// The private supervisor in the ops web service answers "how is <game>" with a
// dependency-free copy of the phone game card, because apps/web ships without
// apps/agent (apps/web/keir-supervisor/studio-evidence.js). This keeps the two
// identical: same catalogue, same facts, same failure states, for the same raw
// tool results. The release build ships apps/agent alone, so the web copy is
// only present in the full repository; the check runs there and skips in a release.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const phone = require("../lib/operator/appgames");

const webFile = path.join(__dirname, "../../web/keir-supervisor/studio-evidence.js");
const skip = !fs.existsSync(webFile) && "web app not in this tree";
const NOW = Date.parse("2026-11-20T12:00:00Z");

const engine = (over = {}) => ({ turn: 241, year: 1994, paused: false, checkedAt: new Date(NOW - 5000).toISOString(), lastTurn: { success: true, durationMs: 283180, warnings: 2 }, schedule: { next: "2026-11-20T18:00:00Z" }, ...over });
const mf = (over = {}) => ({ web: { sha: "a1b2c3d4e5f6a7b8", committedAt: "2026-11-19T10:00:00Z", branch: "master" }, preview: { reachable: true, ok: true }, api: { reachable: true, ok: false },
  native: { error: "missing" }, latestRelease: { tag: "v0.9.1", publishedAt: "2026-11-01T00:00:00Z" }, sidecarBinaries: [{}, {}], ...over });
const cities = (over = {}) => ({ cities: [{ key: "nyc", label: "New York", real: true }, { key: "gen", real: false }, null], ...over });
const gc = (over = {}) => ({ repo: { sha: "0123456789abcdef", committedAt: "2026-11-17T00:00:00Z", branch: "master" }, live: { reachable: true, ok: true, indexChunk: "assets/index-AbC_123.js" }, latestRelease: null, ...over });

// Raw tool results that exercise every branch the card has: complete, partial,
// stale, paused, malformed, empty and failing reads.
const CASES = [
  {},
  { "engine/engine_health": () => engine({ paused: true, pauseReason: "maintenance\nwindow", year: undefined, lastTurn: { success: false } }) },
  { "engine/engine_health": () => engine({ checkedAt: new Date(NOW - 10 * 60000).toISOString() }) },
  { "engine/engine_health": () => engine({ turn: -1 }) },
  { "engine/engine_health": () => { throw new Error("down"); } },
  { "metroforge/mf_status": () => ({}) },
  { "metroforge/mf_status": () => mf({ web: { sha: "not-a-sha" }, latestRelease: { tag: "bad tag!" }, sidecarBinaries: undefined }) },
  { "metroforge/mf_cities": () => ({ cities: "none" }) },
  { "metroforge/mf_cities": () => cities({ cities: [] }) },
  { "grand-century/gc_status": () => gc({ live: { reachable: false, indexChunk: "../../etc/passwd" }, latestRelease: { tag: "v1.0.0", publishedAt: "bad" } }) },
  { "grand-century/gc_status": () => null },
];
const SERVER_SETS = [["engine", "metroforge", "grand-century"], ["engine"], [], null];

function bridge(over, servers) {
  const tools = { "engine/engine_health": () => engine(), "metroforge/mf_status": () => mf(), "metroforge/mf_cities": () => cities(), "grand-century/gc_status": () => gc(), ...over };
  return {
    servers: () => { if (!servers) throw new Error("no config"); return servers; },
    call: async (server, tool) => { const f = tools[`${server}/${tool}`]; if (!f) throw new Error("unknown"); return f(); },
  };
}

test("the supervisor's game health copy matches the phone game card", { skip }, async () => {
  const web = require(webFile);
  assert.deepEqual(web.GAMES, phone.GAMES);
  assert.deepEqual(web.STATES, phone.STATES);
  assert.equal(web.TICKET_UNSUPPORTED, phone.TICKET_UNSUPPORTED);
  const meta = (reads) => Object.fromEntries(Object.entries(reads).map(([id, list]) => [id, list.map(({ id: r, label, server, tool }) => ({ r, label, server, tool }))]));
  assert.deepEqual(meta(web.READS), meta(phone.READS));
  for (const servers of SERVER_SETS) {
    for (const over of CASES) {
      const a = phone.createGames({ mcp: bridge(over, servers), now: () => NOW });
      const b = web.createGames({ mcp: bridge(over, servers), now: () => NOW });
      assert.deepEqual(b.list(), a.list());
      for (const g of phone.GAMES) assert.deepEqual(await b.read(g.id), await a.read(g.id), `${g.id} with ${JSON.stringify(servers)} ${Object.keys(over)}`);
    }
  }
});
