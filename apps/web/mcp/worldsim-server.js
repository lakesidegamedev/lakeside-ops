// World Simulator MCP — two distinct simulation tools live here:
//
// 1. sim_economy_whatif / sim_snapshot / sim_list / sim_compare — sandboxed
//    "what-if" projections seeded from LIVE game data. Reads game collections
//    read-only; writes ONLY to sim_scenarios. A directional economy model
//    (calibrated to current prices, then projects demand/supply shocks
//    forward) — NOT the canonical turn engine.
// 2. sim_run_world / sim_run_status / sim_balance_report / sim_compare_runs /
//    sim_experiment_report — drives the REAL turn engine (a-house-divided's
//    processTurn(), via scripts/sim/runWorld.ts) against an isolated sandbox
//    MongoDB, all-NPP-driven. This MCP process is a raw-Mongo Node process
//    and cannot import the game's TypeScript engine — it's a thin job-queue
//    front end. The actual work happens in scripts/sim/worker.ts (game repo,
//    feat/npp-autonomy-v3 branch), a separate always-on process that polls
//    the simJobs collection below and runs the engine against its own
//    isolated sandbox DB (127.0.0.1:27018 on this box, never production).
//    This MCP only ever reads/writes simJobs (orchestration metadata —
//    status/turn count/timestamps, never game-engine state) and
//    simExperimentReports (deterministic seat/party-org/corporation
//    timelines + end-state metrics, written by
//    scripts/sim/collectExperimentReport.ts as a third worker.ts step).
//   node mcp/worldsim-server.js   (default :9732)
require("dotenv").config({ quiet: true, path: require("path").join(__dirname, "..", ".env") });
const crypto = require("crypto");
const { z } = require("zod");
const { MongoClient } = require("mongodb");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { createServer } = require("../packages/mcp-server");
const store = require("../knowledge-store");
const tokens = require("../agent-tokens");
const { marketSystemModeSchema } = require("./worldsim-modes");
const { buildExperimentReportResponse } = require("./worldsim-experiment-report");
const { readWorldsimExperimentReport, readWorldsimTelemetryPage } = require("./worldsim-report-storage");
const { sourceWorktreeSchema, sourceCommitSchema, assertSimSourcePin, assertCampaignPriceRun } = require("./worldsim-source");
const { worldsimSandboxName } = require("./worldsim-sandbox-name");

const PORT = parseInt(process.env.WORLDSIM_MCP_PORT || "9732", 10);
// Sim control-plane (simJobs + simExperimentReports) lives on the LOCAL
// flat-rate Mongo, NOT Railway prod — the worker polls it every 15s and it's
// pure orchestration metadata, so keeping it off the usage-billed prod cluster
// avoids continuous metered reads. Only the live-economy tools
// (sim_economy_whatif/snapshot/list/compare) still read prod (via `db`).
const SIM_CONTROL_URI = process.env.SIM_CONTROL_URI || "mongodb://127.0.0.1:27018";
const SIM_CONTROL_DB = process.env.SIM_CONTROL_DB || "sim_control";
const SANDBOX = "sim_scenarios"; // the only collection sim_economy_whatif/snapshot/list/compare write to
const SIM_JOBS = "simJobs"; // the only collection sim_run_world/status/balance_report/compare_runs touch
const SIM_ELECTION_REPORTS = "simElectionReports"; // the only collection sim_election_report reads — written by scripts/sim/collectElectionReport.ts (game repo) for elections-only runs: per-election vote trajectories + margin/dynamism roll-ups
const SAFE_TOKEN = /^[a-zA-Z0-9_-]{1,64}$/; // mirrors scripts/sim/worker.ts's assertSafeToken — keeps job fields out of Mongo db names / child argv unsanitized
const { simTurnsSchema } = require("../worldsim-limits");

// Load current economy and calibrate an implied elasticity per commodity so that
// base*(D/S)^e == current price. Clamped to a sane range.
async function loadEconomy(db) {
  const cps = await db.collection("commodityPrices").find({}, { projection: { commodity: 1, basePrice: 1, globalPrice: 1, globalSupply: 1, globalDemand: 1 } }).toArray();
  return cps.filter((c) => c.basePrice && c.globalSupply > 0 && c.globalDemand > 0).map((c) => {
    const ratio = c.globalDemand / c.globalSupply;
    let e = ratio !== 1 ? Math.log(c.globalPrice / c.basePrice) / Math.log(ratio) : 0.6;
    if (!isFinite(e)) e = 0.6;
    e = Math.max(0.15, Math.min(1.5, e));
    return { commodity: c.commodity, base: c.basePrice, price: c.globalPrice, supply: c.globalSupply, demand: c.globalDemand, elasticity: +e.toFixed(3) };
  });
}
function priceOf(c, supply, demand) {
  const p = c.base * Math.pow(demand / supply, c.elasticity);
  return Math.max(0.01, p);
}

// The two databases the worldsim tools read and write: the game database
// (`db`, live economy and sim_scenarios) and the sim control-plane (`ctrlDb`).
async function connectWorldsim() {
  const db = await store.getDb(process.env.MONGODB_URI);
  await tokens.ensureIndexes(db);
  // Separate connection for the sim control-plane on the local flat-rate Mongo.
  const ctrlClient = new MongoClient(SIM_CONTROL_URI);
  await ctrlClient.connect();
  const ctrlDb = ctrlClient.db(SIM_CONTROL_DB);
  console.log(`[worldsim-mcp] sim control-plane on ${SIM_CONTROL_URI} db=${SIM_CONTROL_DB}`);
  return { db, ctrlDb };
}

// The worldsim tools on any MCP server: their own (below) and, since the MCP
// fleet consolidation, the sims server, which also answers as ops-worldsim at
// /mcp/worldsim.
function registerWorldsimTools(server, { db, ctrlDb }) {

  server.tool("sim_economy_whatif",
    "Project the game economy forward under a hypothetical shock. Calibrated to live prices at t=0. Apply per-turn demand/supply growth (as %), optionally to a single commodity, and get the price trajectory + an inflation index (avg price/base). Directional projection, not the live engine.",
    { turns: z.number().int().min(1).max(60).optional().default(12),
      demandPct: z.number().min(-50).max(50).optional().default(0).describe("per-turn demand change %, e.g. 5 = +5%/turn"),
      supplyPct: z.number().min(-50).max(50).optional().default(0).describe("per-turn supply change %"),
      commodity: z.string().optional().describe("limit the shock to one commodity; omit for economy-wide"),
      elasticityOverride: z.number().min(0.1).max(2).optional() },
    async ({ turns, demandPct, supplyPct, commodity, elasticityOverride }) => {
      const econ = await loadEconomy(db);
      const targets = commodity ? econ.filter((c) => c.commodity.toLowerCase() === commodity.toLowerCase()) : econ;
      if (!targets.length) return jsonResult({ error: "no matching commodity", available: econ.map((c) => c.commodity) });
      const sim = econ.map((c) => ({ ...c, S: c.supply, D: c.demand, e: elasticityOverride || c.elasticity }));
      const idx = [];
      const startPrices = {}; sim.forEach((c) => (startPrices[c.commodity] = c.price));
      for (let t = 1; t <= turns; t++) {
        sim.forEach((c) => {
          const shocked = commodity ? c.commodity.toLowerCase() === commodity.toLowerCase() : true;
          if (shocked) { c.D *= 1 + demandPct / 100; c.S *= 1 + supplyPct / 100; }
        });
        const infl = sim.reduce((a, c) => a + priceOf({ base: c.base, elasticity: c.e }, c.S, c.D) / c.base, 0) / sim.length;
        idx.push({ turn: t, inflationIndex: +infl.toFixed(3) });
      }
      const result = (commodity ? targets : sim.slice().sort((a, b) => priceOf({ base: b.base, elasticity: b.e }, b.S, b.D) / b.base - priceOf({ base: a.base, elasticity: a.e }, a.S, a.D) / a.base).slice(0, 8))
        .map((c) => { const s = sim.find((x) => x.commodity === c.commodity); const end = priceOf({ base: s.base, elasticity: s.e }, s.S, s.D);
          return { commodity: c.commodity, startPrice: +startPrices[c.commodity].toFixed(2), endPrice: +end.toFixed(2), changePct: +(((end / startPrices[c.commodity]) - 1) * 100).toFixed(1), elasticity: s.e }; });
      return jsonResult({ scenario: { turns, demandPct, supplyPct, commodity: commodity || "economy-wide" },
        startInflation: 1, endInflation: idx[idx.length - 1].inflationIndex, inflationTrajectory: idx, commodities: result,
        note: "Directional projection calibrated to live prices; not the canonical turn engine." });
    });

  server.tool("sim_snapshot", "Save a labeled snapshot of the current economy as a scenario baseline (writes only to sim_scenarios).",
    { label: z.string() }, async ({ label }) => {
      const econ = await loadEconomy(db);
      const gs = (await db.collection("gameState").findOne({ _id: "current" }))
        || (await db.collection("gameState").findOne({ isActive: true }));
      const doc = { label, ts: new Date(), turn: gs && gs.currentTurn, year: gs && gs.currentYear,
        avgInflation: +(econ.reduce((a, c) => a + c.price / c.base, 0) / econ.length).toFixed(3),
        commodities: econ.map((c) => ({ commodity: c.commodity, price: c.price, base: c.base, supply: c.supply, demand: c.demand })) };
      const r = await db.collection(SANDBOX).insertOne(doc);
      return jsonResult({ saved: true, id: String(r.insertedId), label, turn: doc.turn, avgInflation: doc.avgInflation });
    });

  server.tool("sim_list", "List saved scenario snapshots.", {}, async () => {
    const rows = await db.collection(SANDBOX).find({}, { projection: { label: 1, ts: 1, turn: 1, avgInflation: 1 } }).sort({ ts: -1 }).limit(30).toArray();
    return jsonResult(rows.map((r) => ({ id: String(r._id), label: r.label, turn: r.turn, avgInflation: r.avgInflation, ts: r.ts })));
  });

  server.tool("sim_compare", "Compare a saved snapshot's economy against the current live economy (drift per commodity + inflation delta).",
    { label: z.string().describe("snapshot label") }, async ({ label }) => {
      const snap = await db.collection(SANDBOX).findOne({ label }, { sort: { ts: -1 } });
      if (!snap) return jsonResult({ error: "no snapshot named " + label });
      const econ = await loadEconomy(db);
      const nowMap = {}; econ.forEach((c) => (nowMap[c.commodity] = c.price));
      const drift = snap.commodities.map((c) => ({ commodity: c.commodity, then: +c.price.toFixed(2), now: nowMap[c.commodity] != null ? +nowMap[c.commodity].toFixed(2) : null,
        changePct: nowMap[c.commodity] != null ? +(((nowMap[c.commodity] / c.price) - 1) * 100).toFixed(1) : null })).sort((a, b) => Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0));
      const nowInfl = +(econ.reduce((a, c) => a + c.price / c.base, 0) / econ.length).toFixed(3);
      return jsonResult({ label, fromTurn: snap.turn, snapshotInflation: snap.avgInflation, currentInflation: nowInfl, inflationDelta: +(nowInfl - snap.avgInflation).toFixed(3), drift: drift.slice(0, 12) });
    });

  server.tool(
    "sim_run_world",
    "Run the REAL turn engine headlessly on a fresh isolated sandbox world (NOT the live game) — every NPP fully autonomous, for seed-balance auditing before a preset goes LIVE. Enqueues a job; a separate worker process picks it up within ~15s. Use sim_run_status to poll progress and sim_balance_report once complete. A few hundred turns can take a long time (plausibly hours) — this returns immediately, it does not wait. Pass marketSystemMode to exercise the structural-market rollout tier (default leaves the preset's own default, i.e. \"off\").",
    {
      preset: z.string().regex(SAFE_TOKEN).describe('e.g. "2019-default", "1991-default"'),
      turns: simTurnsSchema(z).describe("how many turns to advance"),
      seed: z.string().regex(SAFE_TOKEN).describe("RNG seed label — also used to derive the sandbox db name; same seed twice continues the same world if it already exists"),
      startPolicy: z.enum(["immediate", "window"]).optional().describe("defaults to immediate for explicit MCP requests"),
      marketSystemMode: marketSystemModeSchema(z).optional().describe("structural-market rollout tier"),
      labourSystemMode: z.enum(["off", "wages", "macro", "unions", "full"]).optional(),
      autonomyLevel: z.enum(["v3", "v4", "v5"]).optional(),
      allFeatureFlags: z.boolean().optional(),
      campaignEraPriceLevelEnabled: z.boolean().optional().describe("Sandbox-only #2119 control (false) or treatment (true); requires source pin and window policy"),
      freightSettlementMode: z.enum(["shadow", "active"]).optional(),
      canonicalFreightBillingEnabled: z.boolean().optional(),
      shortageResponsiveSourcingEnabled: z.boolean().optional(),
      indexFundBondLiquidityEnabled: z.boolean().optional(),
      equityLiquidityFacilityEnabled: z.boolean().optional(),
      nppMarketCoverageEnabled: z.boolean().optional(),
      nppFragileMarketSupplyEnabled: z.boolean().optional(),
      sourceWorktree: sourceWorktreeSchema(z),
      sourceCommit: sourceCommitSchema(z),
    },
    async ({ preset, turns, seed, startPolicy = "immediate", sourceWorktree, sourceCommit, ...options }) => {
      // Pinned source (#136): shape-checked here, persisted unchanged;
      // canonical/clean/HEAD validation is the AHDGame worker's job.
      let pin = null;
      try {
        pin = assertSimSourcePin(sourceWorktree, sourceCommit);
      } catch (e) {
        return jsonResult({ error: e.message });
      }
      try {
        assertCampaignPriceRun(options.campaignEraPriceLevelEnabled, pin, startPolicy);
      } catch (e) {
        return jsonResult({ error: e.message });
      }
      const runId = crypto.randomUUID();
      const dbName = worldsimSandboxName(seed, runId, options.campaignEraPriceLevelEnabled);
      const now = new Date();
      await ctrlDb.collection(SIM_JOBS).insertOne({
        _id: runId, runId, preset, turns, seed, dbName,
        startPolicy,
        ...(pin ? { sourceWorktree: pin.sourceWorktree, sourceCommit: pin.sourceCommit } : {}),
        ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
        status: "queued", currentTurn: 0, error: null,
        createdAt: now, updatedAt: now,
      });
      return jsonResult({ runId, status: "queued", preset, turns, seed, startPolicy,
        sourceWorktree: pin ? pin.sourceWorktree : "(worker default)",
        sourceCommit: pin ? pin.sourceCommit : "(worker default)",
        ...options, note: "Poll with sim_run_status." });
    }
  );

  server.tool(
    "sim_run_status",
    "Poll a sim_run_world job's progress.",
    { runId: z.string() },
    async ({ runId }) => {
      const job = await ctrlDb.collection(SIM_JOBS).findOne({ _id: runId });
      if (!job) return jsonResult({ error: "no job with that runId" });
      return jsonResult({
        runId, status: job.status, preset: job.preset, turns: job.turns, seed: job.seed,
        sourceWorktree: job.sourceWorktree || "(worker default)",
        sourceCommit: job.sourceCommit || "(worker default)",
        sourceRepoDir: job.sourceRepoDir,
        sourceCommitVerified: job.sourceCommitVerified,
        currentTurn: job.currentTurn ?? 0, lastMessage: job.lastMessage, lastWarnings: job.lastWarnings,
        error: job.error, metricsAvailable: !!job.metrics, metricsError: job.metricsError,
        createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt,
      });
    }
  );

  server.tool(
    "sim_balance_report",
    "Read the balance-metric report for a completed sim_run_world job — wealth concentration (NPP Gini/top-1%), electoral competitiveness, office turnover, crisis outcomes, and economic stability (inflation/volatility).",
    { runId: z.string() },
    async ({ runId }) => {
      const job = await ctrlDb.collection(SIM_JOBS).findOne({ _id: runId });
      if (!job) return jsonResult({ error: "no job with that runId" });
      if (!job.metrics) {
        return jsonResult({ error: `no metrics yet — job status is "${job.status}"`, status: job.status, metricsError: job.metricsError || null });
      }
      return jsonResult({ runId, preset: job.preset, seed: job.seed, status: job.status, ...job.metrics });
    }
  );

  server.tool(
    "sim_compare_runs",
    "Diff two completed sim_run_world balance reports (e.g. two seeds, or a preset before/after a tuning change) per metric dimension.",
    { runIdA: z.string(), runIdB: z.string() },
    async ({ runIdA, runIdB }) => {
      const [a, b] = await Promise.all([
        ctrlDb.collection(SIM_JOBS).findOne({ _id: runIdA }),
        ctrlDb.collection(SIM_JOBS).findOne({ _id: runIdB }),
      ]);
      if (!a || !a.metrics) return jsonResult({ error: `runIdA has no metrics yet (status: ${a ? a.status : "not found"})` });
      if (!b || !b.metrics) return jsonResult({ error: `runIdB has no metrics yet (status: ${b ? b.status : "not found"})` });
      const flat = (m, prefix) => Object.entries(m).flatMap(([k, v]) =>
        typeof v === "object" && v !== null ? Object.entries(v).map(([k2, v2]) => [`${prefix}${k}.${k2}`, v2]) : [[`${prefix}${k}`, v]]
      );
      const af = Object.fromEntries(flat(a.metrics, ""));
      const bf = Object.fromEntries(flat(b.metrics, ""));
      const diff = Object.keys(af).filter((k) => typeof af[k] === "number" && typeof bf[k] === "number")
        .map((k) => ({ metric: k, a: af[k], b: bf[k], delta: +(bf[k] - af[k]).toFixed(4) }));
      return jsonResult({
        runIdA, runIdB,
        a: { preset: a.preset, seed: a.seed, turn: a.metrics.turn },
        b: { preset: b.preset, seed: b.seed, turn: b.metrics.turn },
        diff,
      });
    }
  );

  server.tool(
    "sim_experiment_report",
    "Deterministic report for a completed simulation: sampled operational timelines, end-state metrics and unsampled coverage with exact missing turns. Chunked long-horizon points remain complete in storage and are retrieved through sim_experiment_telemetry pages. maxPoints caps operational timelines only.",
    { runId: z.string(), maxPoints: z.number().int().min(10).max(5000).optional().default(500) },
    async ({ runId, maxPoints }) => {
      const report = await readWorldsimExperimentReport(ctrlDb, runId, maxPoints);
      if (!report) {
        const job = await ctrlDb.collection(SIM_JOBS).findOne({ _id: runId });
        return jsonResult({
          error: "no experiments report for that runId yet",
          jobStatus: job ? job.status : "not found",
          experimentsReportError: job ? job.experimentsReportError || null : null,
        });
      }
      return jsonResult(buildExperimentReportResponse({ ...report, runId }, maxPoints));
    }
  );

  server.tool(
    "sim_experiment_telemetry",
    "Retrieve an exact unsampled page of approval or macro evidence from a completed simulation report. Follow nextOffset and pass generation to keep all pages on one immutable report generation. No simulation or game state is changed.",
    { runId: z.string(), section: z.enum(["approval", "macro"]), field: z.enum(["points", "series"]).optional().default("points"), offset: z.number().int().min(0).optional().default(0), limit: z.number().int().min(1).max(100).optional().default(50), generation: z.string().optional() },
    async ({ runId, section, field, offset, limit, generation }) => {
      const page = await readWorldsimTelemetryPage(ctrlDb, runId, section, field, offset, limit, generation);
      return jsonResult(page || { error: "no experiment report for that runId yet" });
    }
  );

  server.tool(
    "sim_run_election",
    "Run an ELECTIONS-ONLY headless sim on a fresh isolated sandbox world (NOT the live game): the real turn engine with the economy/finance/ledger phases skipped, so it plays out primaries, presidential primaries, presidential + down-ballot generals and per-country races over real turns — fast, and without paying for corporationTurn/markets/forex. Scope globally or to a country subset. Enqueues a job (mode=elections-only); the worker claims it within ~15s. Poll with sim_election_status, then read per-election vote trajectories + balance with sim_election_report. Election windows are long: in 2019-default, House generals begin accumulating votes ~turn 144 and resolve ~turn 192 (senate/governor later), so use several HUNDRED turns to see full trajectories and resolved races.",
    {
      preset: z.string().regex(SAFE_TOKEN).describe('e.g. "2019-default", "1991-default"'),
      turns: simTurnsSchema(z).describe("how many turns to advance"),
      seed: z.string().regex(SAFE_TOKEN).describe("RNG seed label — also derives the sandbox db name; same seed twice continues that world"),
      countries: z.string().optional().describe('comma-separated country ids to scope elections to (e.g. "US,UK,DE"); omit for global (the preset default roster)'),
      sourceWorktree: sourceWorktreeSchema(z),
      sourceCommit: sourceCommitSchema(z),
    },
    async ({ preset, turns, seed, countries, sourceWorktree, sourceCommit }) => {
      const runId = crypto.randomUUID();
      const dbName = `ahd_sim_${seed}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      const now = new Date();
      let pin = null;
      try {
        pin = assertSimSourcePin(sourceWorktree, sourceCommit);
      } catch (e) {
        return jsonResult({ error: e.message });
      }
      let countriesArg;
      if (countries) {
        const ids = countries.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
        if (!ids.length || ids.some((id) => !SAFE_TOKEN.test(id))) {
          return jsonResult({ error: 'countries must be comma-separated alphanumeric ids, e.g. "US,UK,DE"' });
        }
        countriesArg = ids.join(",");
      }
      await ctrlDb.collection(SIM_JOBS).insertOne({
        _id: runId, runId, preset, turns, seed, dbName,
        mode: "elections-only",
        ...(countriesArg ? { countries: countriesArg } : {}),
        ...(pin ? { sourceWorktree: pin.sourceWorktree, sourceCommit: pin.sourceCommit } : {}),
        status: "queued", currentTurn: 0, error: null,
        createdAt: now, updatedAt: now,
      });
      return jsonResult({ runId, status: "queued", mode: "elections-only", preset, turns, seed, countries: countriesArg || "global",
        sourceWorktree: pin ? pin.sourceWorktree : "(worker default)",
        sourceCommit: pin ? pin.sourceCommit : "(worker default)",
        note: "Poll with sim_election_status. The worker claims queued jobs within ~15s." });
    }
  );

  server.tool(
    "sim_election_status",
    "Poll a sim_run_election job's progress (status, current turn, mode, scope, warnings).",
    { runId: z.string() },
    async ({ runId }) => {
      const job = await ctrlDb.collection(SIM_JOBS).findOne({ _id: runId });
      if (!job) return jsonResult({ error: "no job with that runId" });
      return jsonResult({
        runId, status: job.status, mode: job.mode || "full",
        preset: job.preset, turns: job.turns, seed: job.seed, countries: job.countries || "global",
        sourceWorktree: job.sourceWorktree || "(worker default)",
        sourceCommit: job.sourceCommit || "(worker default)",
        sourceRepoDir: job.sourceRepoDir,
        sourceCommitVerified: job.sourceCommitVerified,
        currentTurn: job.currentTurn ?? 0, lastMessage: job.lastMessage, lastWarnings: job.lastWarnings,
        error: job.error, electionReportError: job.electionReportError,
        createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt,
      });
    }
  );

  server.tool(
    "sim_election_report",
    "Read the election-balance report for a completed sim_run_election job: per-election VOTE-OVER-TIME trajectories (with the 75/25 closing surge), winner + margin of victory, lead changes (dynamism), plus aggregate competitiveness (contested %, margin distribution) and per-country / per-electionType roll-ups. When more elections than maxElections exist, returns the MOST COMPETITIVE (smallest-margin) ones and says so. maxTrajectoryPoints bounds each trajectory.",
    {
      runId: z.string(),
      maxElections: z.number().int().min(1).max(2000).optional().default(150),
      maxTrajectoryPoints: z.number().int().min(2).max(500).optional().default(60),
    },
    async ({ runId, maxElections, maxTrajectoryPoints }) => {
      const report = await ctrlDb.collection(SIM_ELECTION_REPORTS).findOne({ _id: runId });
      if (!report) {
        const job = await ctrlDb.collection(SIM_JOBS).findOne({ _id: runId });
        return jsonResult({
          error: "no election report for that runId yet",
          jobStatus: job ? job.status : "not found",
          electionReportError: job ? job.electionReportError || null : null,
        });
      }
      const downsample = (arr, max) => {
        if (!Array.isArray(arr) || arr.length <= max) return arr;
        const step = arr.length / max;
        const out = [];
        for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
        return out;
      };
      const all = Array.isArray(report.elections) ? report.elections : [];
      const truncated = all.length > maxElections;
      // Rank by competitiveness (smallest final margin first) so truncation
      // keeps the interesting races, never a silent arbitrary slice.
      const chosen = (truncated ? [...all].sort((a, b) => (a.marginPct ?? 999) - (b.marginPct ?? 999)).slice(0, maxElections) : all)
        .map((e) => ({ ...e, trajectory: downsample(e.trajectory, maxTrajectoryPoints) }));
      return jsonResult({
        runId, turn: report.turn, scope: report.scope,
        emptyCandidateSupplyCountries: report.emptyCandidateSupplyCountries,
        totals: report.totals, margin: report.margin, dynamism: report.dynamism,
        byCountry: report.byCountry, byElectionType: report.byElectionType,
        electionsTotal: all.length, electionsReturned: chosen.length,
        ...(truncated ? { note: `showing the ${maxElections} most competitive of ${all.length} elections (smallest margin first)` } : {}),
        elections: chosen,
        collectedAt: report.collectedAt,
      });
    }
  );

  return server;
}

function buildWorldsimServer(deps) {
  const server = new McpServer({ name: "ops-worldsim", version: "1.0.0" });
  return registerWorldsimTools(server, deps);
}

async function main() {
  const deps = await connectWorldsim();
  createServer({
    name: "worldsim-mcp", version: "1.0.0", port: PORT, bind: "0.0.0.0",
    normalizeDuplicateJsonContentType: true,
    authorize: req => tokens.validate(deps.db, req.headers.authorization), buildServer: () => buildWorldsimServer(deps),
  });
}
function jsonResult(o) { return { content: [{ type: "text", text: JSON.stringify(o, null, 2) }] }; }
function rpcErr(code, message) { return { jsonrpc: "2.0", error: { code, message }, id: null }; }

// Run as a server when executed directly, or when loaded without a module
// system (worldsim-limits.test.js evaluates this file in a vm context).
if (typeof module === "undefined" || require.main === module) {
  main().catch((e) => { console.error("[worldsim-mcp] fatal:", e); process.exit(1); });
}

if (typeof module !== "undefined") {
  module.exports = { connectWorldsim, registerWorldsimTools, buildWorldsimServer };
}
