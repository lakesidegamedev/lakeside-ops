"use strict";

// MetroForge tools, served by the sims MCP since the MCP fleet consolidation
// (2026-10-22). Ported from the standalone metroforge-mcp server (:9737) with
// the same tool names, descriptions, arguments and answers; the sims server
// also answers as "metroforge" at /mcp/metroforge.
//
// Web-game health, city bundle metadata, leaderboard reads, and the native
// sidecar determinism/balance tools. Read-only except mf_sim_run, which spawns
// an ephemeral sidecar process, drives it over its WebSocket wire protocol to
// a target tick, and kills it; nothing is persisted.
//
// Repository paths come from the box's projects manifest, named by
// PROJECTS_MANIFEST, so no machine path is written into this repository.

const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { spawn } = require("child_process");
const { z } = require("zod");

function manifestPath(key) {
  const file = process.env.PROJECTS_MANIFEST;
  if (!file) throw new Error("PROJECTS_MANIFEST is not set: it names the box's projects manifest JSON");
  const entry = JSON.parse(fs.readFileSync(file, "utf8")).entries?.[key];
  if (!entry?.path) throw new Error(`project ${key} is not in ${file}`);
  return entry.path;
}

// Resolved on first use, like the standalone server resolved them at start.
let paths = null;
function mf() {
  if (!paths) {
    const WEB_REPO = manifestPath("metroforge");
    const NATIVE_REPO = manifestPath("metroforge-native");
    const SIDECAR_DIR = path.join(NATIVE_REPO, "dist-sidecar");
    paths = {
      WEB_REPO, NATIVE_REPO, SIDECAR_DIR,
      CITIES_DIR: path.join(WEB_REPO, "src/data/cities"),
      OSM_REGISTRY: path.join(WEB_REPO, "src/core/city/osmRegistry.ts"),
      DB_PATH: path.join(WEB_REPO, "server/data.db"),
      SIDECAR_BIN: path.join(SIDECAR_DIR, "metroforge-sidecar"),
    };
  }
  return paths;
}
const PREVIEW_URL = "http://127.0.0.1:3402/";
const API_HEALTH_URL = "http://127.0.0.1:3403/api/health";
const GH_REPO = "lakesidegamedev/metroforge-native";
const PROTOCOL_VERSION = 1; // mf-protocol PROTOCOL_VERSION (crates/mf-protocol/src/lib.rs)

function jsonResult(o) { return { content: [{ type: "text", text: JSON.stringify(o, null, 2) }] }; }
function errorResult(m) { return { content: [{ type: "text", text: "Error: " + m }], isError: true }; }

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: (stdout || "").trim(), stderr: (stderr || "").trim() });
    });
  });
}

async function gitInfo(repoPath) {
  const [head, branch] = await Promise.all([
    execFileP("git", ["-C", repoPath, "log", "-1", "--format=%H|%cI|%s"]),
    execFileP("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  if (!head.ok) return { error: head.stderr || "git log failed" };
  const [sha, committedAt, subject] = head.stdout.split("|");
  return { sha, shortSha: sha ? sha.slice(0, 12) : undefined, committedAt, subject, branch: branch.ok ? branch.stdout : undefined };
}

async function httpProbe(url, timeoutMs = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body;
    try { body = await r.clone().json(); } catch { /* not json, fine */ }
    return { reachable: true, status: r.status, ok: r.ok, body };
  } catch (e) {
    return { reachable: false, error: e.message };
  }
}

async function latestGithubRelease(repo) {
  const r = await execFileP("gh", ["api", `repos/${repo}/releases/latest`], { timeout: 10000 });
  if (!r.ok) return null; // 404 (no releases) or gh not usable — treat as "none"
  try {
    const j = JSON.parse(r.stdout);
    return { tag: j.tag_name, name: j.name, publishedAt: j.published_at, url: j.html_url };
  } catch { return null; }
}

function sidecarBinaries() {
  if (!fs.existsSync(mf().SIDECAR_DIR)) return [];
  return fs.readdirSync(mf().SIDECAR_DIR).map((f) => {
    const st = fs.statSync(path.join(mf().SIDECAR_DIR, f));
    return { file: f, bytes: st.size, mb: +(st.size / (1024 * 1024)).toFixed(1) };
  });
}

// ── mf_cities: read just the leading bytes of each bundle for key/label,
// stat() for size, and cross-check against OSM_CITY_KEYS (the real-city
// registry) for the real:true/false flag — never JSON.parse the full 6MB. ──
function osmCityKeys() {
  try {
    const src = fs.readFileSync(mf().OSM_REGISTRY, "utf8");
    const m = /OSM_CITY_KEYS\s*=\s*\[([\s\S]*?)\]/.exec(src);
    if (!m) return new Set();
    return new Set([...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((mm) => mm[1] || mm[2]));
  } catch { return new Set(); }
}

function readCityHeader(filePath) {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(600);
  const n = fs.readSync(fd, buf, 0, 600, 0);
  fs.closeSync(fd);
  const head = buf.toString("utf8", 0, n);
  const key = /"key"\s*:\s*"([^"]+)"/.exec(head);
  const label = /"label"\s*:\s*"([^"]+)"/.exec(head);
  const worldSize = /"worldSize"\s*:\s*([0-9.]+)/.exec(head);
  return { key: key ? key[1] : undefined, label: label ? label[1] : undefined, worldSize: worldSize ? Number(worldSize[1]) : undefined };
}

function listCities() {
  const realKeys = osmCityKeys();
  if (!fs.existsSync(mf().CITIES_DIR)) return [];
  return fs.readdirSync(mf().CITIES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const full = path.join(mf().CITIES_DIR, f);
      const st = fs.statSync(full);
      const { key, label, worldSize } = readCityHeader(full);
      return { file: f, key: key || f.replace(/\.json$/, ""), label, worldSize, bytes: st.size, kb: +(st.size / 1024).toFixed(1), real: realKeys.has(key || "") };
    });
}

// ── mf_leaderboard: read-only sqlite over server/data.db (node:sqlite) ──
function openDbReadonly() {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(mf().DB_PATH, { readOnly: true });
}

function leaderboard({ scenario, limit }) {
  if (!fs.existsSync(mf().DB_PATH)) throw new Error(`no db at ${mf().DB_PATH}`);
  const db = openDbReadonly();
  try {
    const totalUsers = db.prepare("SELECT COUNT(*) c FROM users").get().c;
    const scenarios = scenario
      ? [scenario]
      : db.prepare("SELECT DISTINCT scenario FROM scores ORDER BY scenario").all().map((r) => r.scenario);
    const byScenario = scenarios.map((sc) => {
      const rows = db.prepare(
        `SELECT s.value, s.city, s.seed, s.final_tick, s.verified, u.name
         FROM scores s JOIN users u ON u.id = s.user_id
         WHERE s.scenario = ? ORDER BY s.value DESC LIMIT ?`
      ).all(sc, limit);
      return { scenario: sc, top: rows.map((r) => ({ user: r.name, value: r.value, city: r.city, seed: r.seed, finalTick: r.final_tick, verified: !!r.verified })) };
    });
    return { totalUsers, scenarios: byScenario };
  } finally {
    db.close();
  }
}

// ── sidecar wire-protocol session (shared by mf_sim_run + mf_smoke fallback) ──
// Envelope: { t: "<type>", seq?: number, p?: object } — mirrors
// metroforge/src/host/protocol.ts / metroforge-native crates/mf-protocol.
function runSidecarSession({ city = "nyc", seed = 12345, ticks = 1200, commands = [], headlessSpeed }) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(mf().SIDECAR_BIN)) return reject(new Error(`sidecar binary not found at ${mf().SIDECAR_BIN}`));
    const speed = headlessSpeed || Math.min(5000, Math.max(500, ticks * 2));
    const overallTimeoutMs = Math.min(90000, 25000 + ticks * 20);
    const child = spawn(mf().SIDECAR_BIN, ["--port", "0", "--headless-speed", String(speed)], { stdio: ["ignore", "pipe", "pipe"] });

    let settled = false;
    let ws = null;
    let stderrTail = "";
    child.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      try { ws && ws.close(); } catch { /* ignore */ }
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      if (err) reject(err); else resolve(result);
    };

    const hardTimeout = setTimeout(() => finish(new Error(`sidecar session timed out after ${overallTimeoutMs}ms (stderr tail: ${stderrTail.slice(-500)})`)), overallTimeoutMs);

    // Handshake: sidecar's first stdout line is `{"mf":"sidecar","protocolVersion":N,"port":P,"pid":PID}`.
    let handshakeBuf = "";
    let handshakeDone = false;
    child.stdout.on("data", (d) => {
      if (handshakeDone) return; // rest of stdout (if any) is ignored; control channel is the ws
      handshakeBuf += d.toString();
      const nl = handshakeBuf.indexOf("\n");
      if (nl === -1) return;
      handshakeDone = true;
      const line = handshakeBuf.slice(0, nl).trim();
      let hs;
      try { hs = JSON.parse(line); } catch (e) { return finish(new Error(`bad handshake line ${JSON.stringify(line)}: ${e.message}`)); }
      if (hs.mf !== "sidecar") return finish(new Error(`unexpected handshake mf=${hs.mf}`));
      connectWs(hs.port);
    });
    child.on("exit", (code, sig) => { if (!settled) finish(new Error(`sidecar exited early (code=${code} sig=${sig}); stderr tail: ${stderrTail.slice(-1000)}`)); });
    child.on("error", (e) => finish(new Error(`failed to spawn sidecar: ${e.message}`)));

    let seq = 1;
    let ready = false;
    let latestUi = null;
    let pendingCommands = [...commands];

    function send(t, p, withSeq) {
      const env = { t };
      if (withSeq) env.seq = seq++;
      if (p !== undefined) env.p = p;
      ws.send(JSON.stringify(env));
      return env.seq;
    }

    function applyNextCommandOrRun() {
      if (pendingCommands.length) {
        const cmd = pendingCommands.shift();
        send("command", { cmd }, true);
      } else {
        // all commands applied (or none given) — just let headless-speed run;
        // sim is already ticking in the background since `init`.
      }
    }

    function connectWs(port) {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.addEventListener("open", () => {
        send("hello", { clientProtocolVersion: PROTOCOL_VERSION });
        send("init", { seed, difficulty: "normal", presetKey: city });
      });
      ws.addEventListener("error", (e) => finish(new Error(`ws error: ${e.message || e}`)));
      ws.addEventListener("close", () => { if (!settled) finish(new Error("sidecar ws closed unexpectedly")); });
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return; // binary mask/field frames — not needed here
        let env;
        try { env = JSON.parse(ev.data); } catch { return; }
        if (env.t === "ready" && !ready) {
          ready = true;
          applyNextCommandOrRun();
        } else if (env.t === "commandResult") {
          applyNextCommandOrRun();
        } else if (env.t === "ui") {
          latestUi = env.p;
          const done = latestUi.tick >= ticks || latestUi.bankrupt || latestUi.failed;
          if (done && pendingCommands.length === 0) {
            send("requestReplay", undefined, false);
          }
        } else if (env.t === "replay") {
          const replay = env.p;
          finish(null, {
            city, seed, requestedTicks: ticks,
            reachedTick: latestUi ? latestUi.tick : replay.finalTick,
            stateHash: replay.stateHash,
            bankrupt: !!(latestUi && latestUi.bankrupt),
            failed: (latestUi && latestUi.failed) || null,
            budget: latestUi ? latestUi.cash : undefined,
            loanBalance: latestUi ? latestUi.loanBalance : undefined,
            approval: latestUi ? latestUi.approval : undefined,
            transitShare: latestUi ? latestUi.transitShare : undefined,
            coverage: latestUi ? latestUi.coverage : undefined,
            population: latestUi ? latestUi.population : undefined,
            routes: latestUi ? latestUi.routes.map((r) => ({ id: r.id, name: r.name, mode: r.mode, dailyRidership: r.dailyRidership, dailyRevenue: r.dailyRevenue, crowding: r.crowding })) : [],
          });
        } else if (env.t === "toast" && env.p && env.p.tone === "warn") {
          // surfaced via stderrTail-style visibility only; not fatal.
        }
      });
    }
  });
}

function registerMetroforgeTools(server) {
  server.tool("mf_status",
    "MetroForge health: web repo (metroforge) current git SHA/branch + preview (:3402) and API (metroforge-api.service :3403) liveness; native repo (metroforge-native) latest commit + latest GitHub release tag; sidecar binaries present in dist-sidecar/ with sizes.",
    {}, async () => {
      const [web, native, preview, api, release] = await Promise.all([
        gitInfo(mf().WEB_REPO), gitInfo(mf().NATIVE_REPO), httpProbe(PREVIEW_URL), httpProbe(API_HEALTH_URL), latestGithubRelease(GH_REPO),
      ]);
      return jsonResult({
        web: { repo: mf().WEB_REPO, ...web },
        preview: { url: PREVIEW_URL, ...preview },
        api: { url: API_HEALTH_URL, ...api },
        native: { repo: mf().NATIVE_REPO, ...native },
        latestRelease: release || { note: "no GitHub releases published yet" },
        sidecarBinaries: sidecarBinaries(),
      });
    });

  server.tool("mf_cities",
    "List MetroForge city bundles from src/data/cities/*.json: key, label, file size, and real (true if backed by an OSM import per osmRegistry.ts, false if procedural). Reads only the leading bytes of each file, never the full multi-MB JSON.",
    {}, async () => {
      try { return jsonResult({ dir: mf().CITIES_DIR, cities: listCities() }); }
      catch (e) { return errorResult(e.message); }
    });

  server.tool("mf_leaderboard",
    "Read-only query of the MetroForge sqlite leaderboard (server/data.db): top N scores per scenario (user, value, city, seed, finalTick, verified) + total registered user count. Never writes.",
    { scenario: z.string().optional().describe("scope to one scenario id, e.g. 'nyc-grid'; omit for all scenarios"), limit: z.number().int().min(1).max(50).optional().default(10) },
    async ({ scenario, limit }) => {
      try { return jsonResult(leaderboard({ scenario, limit })); }
      catch (e) { return errorResult(e.message); }
    });

  server.tool("mf_smoke",
    "Run a sidecar determinism smoke check: spawn the compiled native sidecar twice with an identical seed/tick budget and compare final state hashes (pass if equal). Falls back to this wire-protocol check because sidecar/smoke-test.ts does not exist in the metroforge repo yet (sidecar/ only has node_modules) — see notes in the result.",
    {}, async () => {
      const smokeTestPath = path.join(mf().WEB_REPO, "sidecar/smoke-test.ts");
      if (fs.existsSync(smokeTestPath)) {
        const bunPath = path.join(process.env.HOME || "", ".bun/bin/bun");
        const bun = fs.existsSync(bunPath) ? bunPath : "bun";
        const r = await execFileP(bun, ["run", "smoke-test.ts"], { cwd: path.join(mf().WEB_REPO, "sidecar"), timeout: 120000, env: { ...process.env, PATH: `${path.dirname(bun)}:${process.env.PATH}` } });
        return jsonResult({ mode: "smoke-test.ts", pass: r.ok, code: r.code, stdoutTail: r.stdout.slice(-2000), stderrTail: r.stderr.slice(-2000) });
      }
      try {
        const params = { city: "nyc", seed: 4242424242, ticks: 400, commands: [] };
        const [a, b] = await Promise.all([runSidecarSession(params), runSidecarSession(params)]);
        const pass = a.stateHash === b.stateHash && a.reachedTick === b.reachedTick;
        return jsonResult({
          mode: "wire-protocol-fallback",
          note: `sidecar/smoke-test.ts not found in ${mf().WEB_REPO} (sidecar/ has no TS source, only node_modules) — ran two identical-seed sessions against the compiled dist-sidecar binary and compared stateHash instead.`,
          pass, runA: { reachedTick: a.reachedTick, stateHash: a.stateHash }, runB: { reachedTick: b.reachedTick, stateHash: b.stateHash },
        });
      } catch (e) { return errorResult(e.message); }
    });

  server.tool("mf_sim_run",
    "Ephemeral headless balance run: spawn the native sidecar binary, connect over its WebSocket wire protocol, init a city/seed, optionally apply an array of Command JSON objects (kind:'buildStation'|'buildTrack'|'createRoute'|... matching core/types.ts), run to a target tick at high headless speed, return the final UiState summary (budget/cash, approval, transitShare, coverage, ridership+revenue by route) + stateHash, then kill the process. Nothing is persisted.",
    {
      city: z.string().optional().default("nyc").describe("city preset key, e.g. nyc/boston/chicago/... (see mf_cities)"),
      seed: z.number().int().optional().default(12345),
      ticks: z.number().int().min(1).max(20000).optional().default(1200),
      commands: z.array(z.record(z.string(), z.any())).optional().default([]).describe("array of Command objects, e.g. {kind:'buildStation', mode:'bus', pos:{x,y}}"),
    },
    async ({ city, seed, ticks, commands }) => {
      try { return jsonResult(await runSidecarSession({ city, seed, ticks, commands })); }
      catch (e) { return errorResult(e.message); }
    });

  return server;
}

module.exports = { registerMetroforgeTools };
