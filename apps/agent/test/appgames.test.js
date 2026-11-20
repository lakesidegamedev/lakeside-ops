"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createGames, GAMES, READS } = require("../lib/operator/appgames");
const musePolicy = require("../lib/operator/ownermuse-policy");

const NOW = Date.parse("2026-11-20T12:00:00Z");
// Synthetic tool results shaped like the real MCP output, with host paths, URLs and names planted to prove they never pass through.
const engine = () => ({ turn: 241, year: 1994, paused: false, checkedAt: new Date(NOW - 5000).toISOString(), lastTurn: { success: true, durationMs: 283180, warnings: 2 }, schedule: { next: "2026-11-20T18:00:00Z" }, secretField: "do-not-leak" });
const mf = () => ({
  web: { repo: "/srv/private/metroforge", sha: "a1b2c3d4e5f6a7b8", shortSha: "a1b2c3d4e5f6", committedAt: "2026-11-19T10:00:00Z", subject: "fix: Alice's payout bug", branch: "master" },
  preview: { url: "http://127.0.0.1:3402", reachable: true, status: 200, ok: true, body: { user: "alice" } },
  api: { url: "http://127.0.0.1:3403/health", reachable: false, error: "connect ECONNREFUSED /srv/private" },
  native: { repo: "/srv/private/native", sha: "ffeeddccbbaa0011", committedAt: "2026-11-18T10:00:00Z", branch: "master" },
  latestRelease: { tag: "v0.9.1", name: "Alice build", publishedAt: "2026-11-01T00:00:00Z", url: "https://example.test/rel" },
  sidecarBinaries: [{ file: "sidecar-linux", bytes: 1, mb: 1 }, { file: "sidecar-mac", bytes: 1, mb: 1 }],
});
const cities = () => ({ dir: "/srv/private/cities", cities: [{ file: "nyc.json", key: "nyc", label: "New York", bytes: 9, kb: 1, real: true }, { file: "gen.json", key: "gen", label: "Genville", real: false }] });
const gc = () => ({ repo: { path: "/srv/private/gc", sha: "0123456789abcdef", committedAt: "2026-11-17T00:00:00Z", branch: "master", dirty: true, subject: "secret subject" }, live: { url: "https://example.test/gc", reachable: true, status: 200, ok: true, indexChunk: "assets/index-AbC_123.js" }, latestRelease: null });

function bridge(over = {}) {
  const calls = [];
  const tools = { "engine/engine_health": engine, "metroforge/mf_status": mf, "metroforge/mf_cities": cities, "grand-century/gc_status": gc, ...over };
  return { calls, servers: () => ["engine", "metroforge", "grand-century", "support"], call: async (server, tool, args, write, signal) => {
    calls.push({ server, tool, args, write, signal });
    const f = tools[`${server}/${tool}`]; if (!f) throw new Error("unknown " + tool); return f();
  } };
}
const make = (mcp) => createGames({ mcp, now: () => NOW });
const dump = (v) => JSON.stringify(v);

test("the list names every game and is available only where a server is registered, without reading anything", async () => {
  const mcp = bridge();
  const out = await make(mcp).route("/games", "GET");
  assert.deepEqual(out.games.map((g) => g.id), ["ahd", "metroforge", "grand-century"]);
  assert.ok(out.games.every((g) => g.state === "available"));
  assert.equal(mcp.calls.length, 0);
  const none = createGames({ mcp: { servers: () => ["engine"] }, now: () => NOW }).list();
  assert.deepEqual(none.games.map((g) => [g.id, g.state]), [["ahd", "available"], ["metroforge", "unsupported"], ["grand-century", "unsupported"]]);
});

test("every read is one fixed, argument-free, non-write call with a timeout", async () => {
  const mcp = bridge();
  const g = make(mcp);
  for (const id of ["ahd", "metroforge", "grand-century"]) await g.read(id);
  assert.deepEqual(mcp.calls.map((c) => `${c.server}/${c.tool}`), ["engine/engine_health", "metroforge/mf_status", "metroforge/mf_cities", "grand-century/gc_status"]);
  for (const c of mcp.calls) { assert.deepEqual(c.args, {}); assert.equal(c.write, false); assert.ok(c.signal instanceof AbortSignal); }
});

test("every catalogue read is on the owner read list, and nothing that writes, simulates or lists players is", () => {
  for (const specs of Object.values(READS)) for (const s of specs) assert.ok(musePolicy.MCP_READS[s.server].includes(s.tool), `${s.server}/${s.tool}`);
  for (const bad of ["mf_leaderboard", "mf_sim_run", "mf_smoke"]) assert.ok(!musePolicy.MCP_READS.metroforge.includes(bad), bad);
  assert.ok(!musePolicy.MCP_READS["grand-century"].includes("gc_worldsim"));
});

test("snapshots are rebuilt from an allow-list: no paths, urls, commit subjects, names or unknown fields", async () => {
  const g = make(bridge());
  const text = dump([await g.read("ahd"), await g.read("metroforge"), await g.read("grand-century")]);
  for (const leak of ["/srv/", "127.0.0.1", "http", "alice", "Alice", "payout", "secret", "do-not-leak", "ECONNREFUSED", "sidecar-linux", "Alice build"]) assert.ok(!text.includes(leak), `leaked ${leak}`);
});

test("live reads carry real values and an exact check time", async () => {
  const g = make(bridge());
  const ahd = await g.read("ahd"), mfOut = await g.read("metroforge"), gcOut = await g.read("grand-century");
  assert.equal(ahd.state, "live");
  const f = (out, i, label) => out.reads[i].facts.find((x) => x.label === label)?.value;
  assert.equal(f(ahd, 0, "Turn"), "241"); assert.equal(f(ahd, 0, "Game"), "Running"); assert.equal(f(ahd, 0, "Latest turn"), "Succeeded in 283 s");
  assert.equal(ahd.reads[0].checkedAt, "2026-11-20T12:00:00.000Z"); assert.equal(ahd.reads[0].source, "engine · engine_health");
  assert.equal(f(mfOut, 0, "Preview site"), "Responding"); assert.equal(f(mfOut, 0, "API"), "Not responding");
  assert.equal(f(mfOut, 0, "Web build"), "a1b2c3d on master, 2026-11-19"); assert.equal(f(mfOut, 0, "Latest release"), "v0.9.1 (2026-11-01)"); assert.equal(f(mfOut, 0, "Native sidecar binaries"), "2");
  assert.equal(f(mfOut, 1, "Bundles"), "2"); assert.equal(f(mfOut, 1, "Real-map"), "1"); assert.equal(f(mfOut, 1, "Names"), "New York, Genville");
  assert.equal(f(gcOut, 0, "Live site"), "Responding"); assert.equal(f(gcOut, 0, "Served bundle"), "assets/index-AbC_123.js"); assert.equal(f(gcOut, 0, "Latest release"), "None published");
});

test("a failed or stale read is unavailable, never live, and the error text is not forwarded", async () => {
  const boom = () => { throw new Error("connect ECONNREFUSED /srv/private/token=abc"); };
  const g = make(bridge({ "metroforge/mf_status": boom, "engine/engine_health": () => ({ ...engine(), checkedAt: new Date(NOW - 300000).toISOString() }) }));
  const mfOut = await g.read("metroforge");
  assert.equal(mfOut.reads[0].state, "unavailable"); assert.deepEqual(mfOut.reads[0].facts, []);
  assert.equal(mfOut.reads[1].state, "live"); assert.equal(mfOut.state, "partial");
  assert.ok(!dump(mfOut).includes("ECONNREFUSED"));
  const ahd = await g.read("ahd");
  assert.equal(ahd.state, "unavailable"); assert.equal(ahd.reads[0].state, "unavailable");
});

test("an empty or malformed tool result cannot be reported as live", async () => {
  const g = make(bridge({ "metroforge/mf_status": () => ({}), "metroforge/mf_cities": () => ({ text: "hi" }), "grand-century/gc_status": () => ({ text: "hi" }) }));
  assert.equal((await g.read("metroforge")).state, "unavailable");
  assert.equal((await g.read("grand-century")).state, "unavailable");
});

test("tickets are supported only for A House Divided", async () => {
  const g = make(bridge());
  assert.equal((await g.read("ahd")).capabilities[0].state, "available");
  for (const id of ["metroforge", "grand-century"]) {
    const out = await g.read(id), row = out.capabilities[0];
    assert.equal(row.state, "unsupported"); assert.match(row.note, /A House Divided desk only/);
  }
  assert.ok(GAMES.filter((x) => x.tickets).map((x) => x.id).join() === "ahd");
});

test("a game with no registered server is unsupported and triggers no read", async () => {
  let called = 0;
  const g = createGames({ mcp: { servers: () => ["engine"], call: async () => { called++; return {}; } }, now: () => NOW });
  const out = await g.read("metroforge");
  assert.equal(out.state, "unsupported"); assert.deepEqual(out.reads, []); assert.equal(called, 0);
});

test("only the catalogue's GET routes exist; unknown ids and writes are refused or ignored", async () => {
  const mcp = bridge(), g = make(mcp);
  await assert.rejects(g.route("/games/unknown-game", "GET"), (e) => e.status === 404);
  assert.equal(await g.route("/games/metroforge", "POST"), undefined);
  assert.equal(await g.route("/games", "POST"), undefined);
  assert.equal(await g.route("/games/..%2Fetc", "GET"), undefined);
  assert.equal(mcp.calls.length, 0);
});

// Access path: the real app server and the real agent router, owner only.
test("through the app server only the owner reaches the games routes, and a write method reaches nothing", async (t) => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { createLedger } = require("../lib/operator/store");
  const { createAppChannel, createAppServer } = require("../lib/operator/appchannel");
  const { createAppAgent } = require("../lib/operator/appagent");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-games-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { ownerId: "owner", botId: "keir", staffIds: [], taskLifetimeMs: 86400000, stateDir: dir };
  const ledger = createLedger(path.join(dir, "ledger.json")), app = createAppChannel({ ledger, config });
  const mcp = bridge(), agent = createAppAgent({ ledger, config, app, mcp, notebook: null });
  const server = createAppServer({ app, artifactsDir: dir, agentRoutes: agent.route, authenticate: async (req) => req.headers.cookie === "ops_session=good" ? "owner" : req.headers.cookie === "ops_session=staff" ? "staff" : false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/keir/app`, headers = { cookie: "ops_session=good", "content-type": "application/json" };
  assert.equal((await fetch(`${base}/games`)).status, 401);
  assert.equal((await fetch(`${base}/games/metroforge`)).status, 401);
  assert.equal((await fetch(`${base}/games/metroforge`, { headers: { cookie: "ops_session=staff" } })).status, 403);
  assert.equal(mcp.calls.length, 0);
  const listed = await (await fetch(`${base}/games`, { headers })).json();
  assert.equal(listed.games.length, 3);
  const detail = await (await fetch(`${base}/games/metroforge`, { headers })).json();
  assert.equal(detail.state, "live"); assert.equal(detail.reads.length, 2);
  assert.equal((await fetch(`${base}/games/metroforge`, { method: "DELETE", headers })).status, 404);
  assert.equal((await fetch(`${base}/games/nope`, { headers })).status, 404);
  assert.ok(mcp.calls.every((c) => c.write === false));
});
