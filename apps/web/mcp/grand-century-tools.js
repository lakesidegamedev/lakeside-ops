"use strict";

// Grand Century tools, served by the sims MCP since the MCP fleet
// consolidation (2026-10-22). Ported from the standalone grand-century-mcp
// server (:9740) with the same tool names, descriptions, arguments and
// answers; the sims server also answers as "grand-century" at
// /mcp/grand-century.
//
// gc_worldsim spawns an ephemeral `tsx` process running the game's
// content/season-report.ts harness (in-memory World, no database, no
// persistence beyond the JSON report it writes under docs/mcp-worldsim/).
//
// The repository path comes from the box's projects manifest, named by
// PROJECTS_MANIFEST, so no machine path is written into this repository.

const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { randomUUID } = require("crypto");
const { z } = require("zod");

function repoPath() {
  const file = process.env.PROJECTS_MANIFEST;
  if (!file) throw new Error("PROJECTS_MANIFEST is not set: it names the box's projects manifest JSON");
  const entry = JSON.parse(fs.readFileSync(file, "utf8")).entries?.["grand-century"];
  if (!entry?.path) throw new Error(`project grand-century is not in ${file}`);
  return entry.path;
}
let repo = null;
const REPO_DIR = () => (repo ||= repoPath());
const REPORTS_DIR_OF = () => path.join(REPO_DIR(), "docs", "mcp-worldsim");
const LIVE_URL = "https://lakesidegames.net/games/grand-century/";
const GH_REPO = "lakesidegamedev/grand-century";

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
  const [head, branch, dirty] = await Promise.all([
    execFileP("git", ["-C", repoPath, "log", "-1", "--format=%H|%cI|%s"]),
    execFileP("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]),
    execFileP("git", ["-C", repoPath, "status", "--porcelain"]),
  ]);
  if (!head.ok) return { error: head.stderr || "git log failed" };
  const [sha, committedAt, subject] = head.stdout.split("|");
  return {
    sha, shortSha: sha ? sha.slice(0, 12) : undefined, committedAt, subject,
    branch: branch.ok ? branch.stdout : undefined,
    dirty: dirty.ok ? dirty.stdout.length > 0 : undefined,
  };
}

async function httpProbe(url, timeoutMs = 5000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    const m = /assets\/index-([A-Za-z0-9_-]+)\.js/.exec(text);
    return { reachable: true, status: r.status, ok: r.ok, indexChunk: m ? m[0] : undefined };
  } catch (e) {
    return { reachable: false, error: e.message };
  }
}

async function latestGithubRelease(repo) {
  const r = await execFileP("gh", ["api", `repos/${repo}/releases/latest`], { timeout: 10000 });
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.stdout);
    return { tag: j.tag_name, name: j.name, publishedAt: j.published_at, url: j.html_url };
  } catch { return null; }
}

/**
 * Run content/season-report.ts as a child process to a JSON file, then read
 * and trim it. Ephemeral: each call gets its own output file (uuid-named
 * under docs/mcp-worldsim/, git-ignored) so concurrent calls never collide;
 * nothing is deleted afterward so a caller can inspect the full time series
 * on disk if the trimmed summary isn't enough.
 */
function runSeasonReport({ years, seeds, steerabilityYears, checkDeterminism, timeoutMs }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(REPORTS_DIR_OF(), { recursive: true });
    const outFile = path.join(REPORTS_DIR_OF(), `run-${randomUUID()}.json`);
    const args = [
      "tsx", "content/season-report.ts",
      `--years=${years}`,
      `--seeds=${seeds.join(",")}`,
      `--out=${path.relative(REPO_DIR(), outFile)}`,
      `--steerability-years=${steerabilityYears}`,
    ];
    if (!checkDeterminism) args.push("--no-determinism-check");
    execFile("npx", args, { cwd: REPO_DIR(), timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`season-report failed (code ${err.code ?? "?"}): ${(stderr || stdout || err.message).slice(-4000)}`));
        return;
      }
      let artifact;
      try {
        artifact = JSON.parse(fs.readFileSync(outFile, "utf8"));
      } catch (e) {
        reject(new Error(`season-report ran but output JSON unreadable: ${e.message}`));
        return;
      }
      resolve({ artifact, outFile, stdout: stdout.slice(-6000) });
    });
  });
}

function trimArtifact(artifact) {
  return {
    generatedAt: artifact.generatedAt,
    years: artifact.years,
    seeds: artifact.seeds,
    determinism: artifact.determinism,
    aggregate: artifact.aggregate,
    perSeed: artifact.perSeed.map((entry) => ({
      seed: entry.seed,
      years: entry.years,
      summary: entry.summary,
      unifications: entry.geopolitics.unifications,
      popTypeShareStart: entry.population.popTypeShareStart,
      popTypeShareEnd: entry.population.popTypeShareEnd,
    })),
    steerability: artifact.steerability,
  };
}

function registerGrandCenturyTools(server) {
  server.tool("gc_status",
    "Grand Century repo + live deploy health: current git SHA/branch/dirty-tree, latest GitHub release tag, and the live site's currently-served JS bundle hash (fetches https://lakesidegames.net/games/grand-century/ and extracts the index-*.js chunk name) so you can tell at a glance whether prod matches the latest commit.",
    {}, async () => {
      const [repo, live, release] = await Promise.all([
        gitInfo(REPO_DIR()), httpProbe(LIVE_URL), latestGithubRelease(GH_REPO),
      ]);
      return jsonResult({
        repo: { path: REPO_DIR(), ...repo },
        live: { url: LIVE_URL, ...live },
        latestRelease: release || { note: "no GitHub releases published yet" },
      });
    });

  server.tool("gc_worldsim",
    "Run Grand Century's deterministic AI-driven world simulation for N years across one or more seeds (content/season-report.ts, an ephemeral in-memory World — no database, no persistence beyond the JSON report file written under docs/mcp-worldsim/). Returns per-seed economy summary (price index, inflation, factory profit, bankruptcy shares), population summary (growth, needs met, militancy, pop-class shares), geopolitics summary (wars started/resolved, hegemony share, unifications that fired), an aggregate across seeds, a determinism check (same seed run twice, byte-identical?), and a player-steerability report (which economic/political levers visibly move outcomes vs which are inert). Full per-year time series are NOT returned in the reply (kept small) but ARE written to the JSON file at outFile if you need to inspect them. A 100-year x 3-seed run takes several minutes — pass fewer years/seeds for a faster read, or raise timeoutSeconds.",
    {
      years: z.number().int().min(1).max(100).optional().default(60).describe("in-game years to simulate per seed (campaign starts 1820)"),
      seeds: z.array(z.number().int()).min(1).max(6).optional().default([6602, 6614, 6626]).describe("world seeds to run (each gets its own independent AI-driven campaign)"),
      steerabilityYears: z.number().int().min(1).max(50).optional().default(12).describe("years used for the player-steerability probe (separate short runs testing whether tax/tariff/reform levers visibly move outcomes)"),
      checkDeterminism: z.boolean().optional().default(true).describe("re-run the first seed a second time and confirm byte-identical results"),
      timeoutSeconds: z.number().int().min(30).max(1200).optional().default(600).describe("kill the run if it exceeds this many seconds"),
    },
    async ({ years, seeds, steerabilityYears, checkDeterminism, timeoutSeconds }) => {
      try {
        const { artifact, outFile } = await runSeasonReport({
          years, seeds, steerabilityYears, checkDeterminism, timeoutMs: timeoutSeconds * 1000,
        });
        return jsonResult({ outFile, ...trimArtifact(artifact) });
      } catch (e) { return errorResult(e.message); }
    });

  return server;
}

module.exports = { registerGrandCenturyTools };
