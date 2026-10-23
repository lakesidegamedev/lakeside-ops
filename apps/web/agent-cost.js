"use strict";

// Cached wrapper around CodeBurn (https://github.com/getagentseal/codeburn)
// for API-equivalent cost totals shown on the Code Agent screens.
//
// CodeBurn re-parses every agent transcript on each call. On this box that is
// ~20-90s and 1-2 GB of RSS per invocation, so it must never run inside a page
// request. Instead:
//   • a single serialized background refresher keeps today/week/month fresh,
//   • requests read the last good snapshot from memory and never block,
//   • snapshots survive restarts in a small JSON file next to the sessions file,
//   • refreshes only run while someone is actually using the console.
// The synchronous helpers below stay for tests and one-off tooling.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { resolveBinary } = require("./src/core/paths");

// Resolve the codeburn binary lazily on first use instead of blocking server
// boot with a spawnSync("which") at require time.
let _codeburnBin = null;
function codeburnBin() {
  if (_codeburnBin) return _codeburnBin;
  _codeburnBin = resolveBinary("codeburn");
  if (_codeburnBin === "codeburn") {
    try {
      const resolved = (spawnSync("which", ["codeburn"], { encoding: "utf8" }).stdout || "").trim();
      if (resolved) _codeburnBin = resolved;
    } catch { /* keep basename */ }
  }
  return _codeburnBin;
}

const cache = new Map();
const CACHE_MS = 60_000;

// How long a computed number stays "current" before the refresher recomputes.
const OVERVIEW_TTL = 180_000;
const BREAKDOWN_TTL = { today: 180_000, week: 900_000, month: 1_800_000 };
const SESSIONS_TTL = { today: 180_000, week: 900_000, month: 1_800_000 };
const MODELS_TTL = { today: 300_000, week: 1_800_000, month: 3_600_000 };

// Serve numbers from disk rather than showing nothing while a refresh runs.
const MAX_STALE_MS = 24 * 60 * 60_000;
// Stop refreshing when nobody has looked at a cost number for this long.
const DEMAND_WINDOW_MS = 15 * 60_000;
const TICK_MS = 30_000;

function runCodeburn(args, timeoutMs = 90_000) {
  const result = spawnSync(codeburnBin(), args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err = new Error((result.stderr || result.stdout || "codeburn failed").trim().slice(0, 400));
    err.status = result.status;
    throw err;
  }
  return result.stdout || "";
}

function runCodeburnAsync(args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(codeburnBin(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 32 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error(`codeburn stopped (${signal})`));
      if (code !== 0) {
        const error = new Error((stderr || stdout || "codeburn failed").trim().slice(0, 400));
        error.status = code;
        return reject(error);
      }
      resolve(stdout);
    });
  });
}

// ─── Last-known-good snapshots ──────────────────────────────────────────────
// overview: { at, value }            value = buildCostOverview(...)
// breakdowns: Map<period, {at,value}> value = buildCostBreakdown(...)
const state = { overview: null, breakdowns: new Map() };
const rawSessions = new Map();
const rawModels = new Map();

const demand = { at: 0, periods: new Map() };

function noteDemand(period) {
  demand.at = Date.now();
  if (period) demand.periods.set(period, demand.at);
}

function periodDemandedLately(period) {
  const at = demand.periods.get(period) || 0;
  return Date.now() - at < DEMAND_WINDOW_MS;
}

let lastRefreshErrorAt = 0;
function reportRefreshError(error) {
  if (Date.now() - lastRefreshErrorAt < 60_000) return;
  lastRefreshErrorAt = Date.now();
  console.warn("[agent-cost] background refresh failed:", error && error.message ? error.message : error);
}

function kick(promise) {
  promise.catch(reportRefreshError);
  return promise;
}

function isStale(entry, ttlMs) {
  return !entry || !Number.isFinite(entry.at) || Date.now() - entry.at >= ttlMs;
}

function usableValue(entry) {
  if (!entry) return null;
  if (Date.now() - entry.at > MAX_STALE_MS) return null;
  return entry.value;
}

function costCacheFile() {
  if (process.env.OPS_COST_CACHE) return path.resolve(process.env.OPS_COST_CACHE);
  if (process.env.OPS_SESSIONS_FILE) {
    return path.join(path.dirname(path.resolve(process.env.OPS_SESSIONS_FILE)), "cost-cache.json");
  }
  return path.join(os.tmpdir(), "lakeside-ops-cost-cache.json");
}

function loadPersisted() {
  try {
    const doc = JSON.parse(fs.readFileSync(costCacheFile(), "utf8"));
    if (!doc || doc.version !== 1) return;
    if (doc.overview && doc.overview.value) {
      state.overview = { at: Number(doc.overview.at) || 0, value: doc.overview.value };
    }
    for (const [period, entry] of Object.entries(doc.breakdowns || {})) {
      if (entry && entry.value) state.breakdowns.set(period, { at: Number(entry.at) || 0, value: entry.value });
    }
  } catch { /* no cache yet */ }
}

let persistTimer = null;
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 5000);
  persistTimer.unref?.();
}

function persistNow() {
  try {
    const file = costCacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const doc = {
      version: 1,
      savedAt: new Date().toISOString(),
      overview: state.overview,
      breakdowns: Object.fromEntries(state.breakdowns),
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* persistence is best-effort */ }
}

// One CodeBurn process at a time: parallel invocations contend for CodeBurn's
// own 140 MB refresh lock and each still parse the full transcript history.
let queueTail = Promise.resolve();
function enqueue(task) {
  const run = queueTail.then(task, task);
  queueTail = run.then(() => undefined, () => undefined);
  return run;
}

const inFlight = new Map();
function refreshOnce(key, task) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = enqueue(task)
    .then((value) => value)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

async function sessionsFor(period) {
  const hit = rawSessions.get(period);
  const ttl = SESSIONS_TTL[period] || SESSIONS_TTL.today;
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = parseJsonRows(await runCodeburnAsync([
    "sessions", "--format", "json", "-p", String(period), "--provider", "all",
  ]));
  rawSessions.set(period, { at: Date.now(), value });
  return value;
}

async function modelsFor(period) {
  const hit = rawModels.get(period);
  const ttl = MODELS_TTL[period] || MODELS_TTL.today;
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = parseJsonRows(await runCodeburnAsync([
    "models", "--format", "json", "-p", String(period), "--provider", "all",
  ]));
  rawModels.set(period, { at: Date.now(), value });
  return value;
}

function refreshOverview() {
  return refreshOnce("overview", async () => {
    const todaySessions = await sessionsFor("today");
    const monthSessions = await sessionsFor("month");
    const value = buildCostOverview(todaySessions, monthSessions);
    state.overview = { at: Date.now(), value };
    persistSoon();
    return value;
  });
}

function refreshBreakdown(period) {
  const normalized = normalizeBreakdownPeriod(period) || "today";
  return refreshOnce(`breakdown:${normalized}`, async () => {
    const sessions = await sessionsFor(normalized);
    const models = await modelsFor(normalized);
    const value = buildCostBreakdown(normalized, sessions, models);
    state.breakdowns.set(normalized, { at: Date.now(), value });
    persistSoon();
    return value;
  });
}

function ensureOverview(maxAgeMs = OVERVIEW_TTL) {
  if (!isStale(state.overview, maxAgeMs)) return Promise.resolve(usableValue(state.overview));
  return refreshOverview().catch((error) => { reportRefreshError(error); return null; });
}

function ensureBreakdown(period, maxAgeMs) {
  const normalized = normalizeBreakdownPeriod(period) || "today";
  const ttl = maxAgeMs ?? BREAKDOWN_TTL[normalized];
  const entry = state.breakdowns.get(normalized);
  if (!isStale(entry, ttl)) return Promise.resolve(usableValue(entry));
  return refreshBreakdown(normalized).catch((error) => { reportRefreshError(error); return null; });
}

// Boot + idle tick: keep the numbers the console actually shows warm, and stop
// when nobody is looking so an unused dashboard costs nothing.
let refresherStarted = false;
function startCostRefresher() {
  if (refresherStarted) return;
  refresherStarted = true;
  // Only warm at boot when this install already has a snapshot (the normal
  // case). A pristine checkout should not spend a minute running CodeBurn
  // before anyone has opened a cost page.
  const hasSnapshot = state.overview !== null || state.breakdowns.size > 0;
  if (hasSnapshot) {
    // Let the page-critical warm-ups (paseo, token list, engine) go first: the
    // snapshot is already being served, so a few seconds of extra staleness
    // costs nothing and avoids competing with them for CPU and the DB tunnel.
    const warm = () => {
      ensureOverview().catch(() => {});
      ensureBreakdown("today").catch(() => {});
    };
    const timer = setTimeout(warm, 8_000);
    timer.unref?.();
  }
  const timer = setInterval(() => {
    if (Date.now() - demand.at >= DEMAND_WINDOW_MS) return;
    ensureOverview().catch(() => {});
    ensureBreakdown("today").catch(() => {});
    for (const period of ["week", "month"]) {
      if (periodDemandedLately(period)) ensureBreakdown(period).catch(() => {});
    }
  }, TICK_MS);
  timer.unref?.();
}

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function warmCostOverviewAsync() {
  return refreshOverview().catch(() => null);
}

const BREAKDOWN_PERIODS = new Set(["today", "week", "month"]);

function normalizeBreakdownPeriod(period) {
  const p = String(period || "today").toLowerCase();
  return BREAKDOWN_PERIODS.has(p) ? p : null;
}

function parseSessions(period = "today", provider = "all") {
  const key = `sessions:${period}:${provider}`;
  return cached(key, () => {
    const raw = runCodeburn(["sessions", "--format", "json", "-p", String(period), "--provider", String(provider)]);
    return parseJsonRows(raw);
  });
}

function parseJsonRows(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return [];
  try { return JSON.parse(trimmed); } catch { return []; }
}

function parseModels(period = "today", provider = "all") {
  const key = `models:${period}:${provider}`;
  return cached(key, () => {
    const raw = runCodeburn(["models", "--format", "json", "-p", String(period), "--provider", String(provider)]);
    return parseJsonRows(raw);
  });
}

function summarizeByProject(sessions) {
  const byProject = {};
  for (const session of sessions || []) {
    const project = session.project || "unknown";
    const c = Number(session.cost) || 0;
    const k = Number(session.calls) || 0;
    if (!byProject[project]) byProject[project] = { project, cost: 0, calls: 0, sessions: 0 };
    byProject[project].cost += c;
    byProject[project].calls += k;
    byProject[project].sessions += 1;
  }
  return Object.values(byProject)
    .map((row) => ({ ...row, label: money(row.cost) }))
    .sort((a, b) => b.cost - a.cost);
}

function mapSessionRow(s) {
  const inputTokens = Number(s.inputTokens) || 0;
  const outputTokens = Number(s.outputTokens) || 0;
  const cacheReadTokens = Number(s.cacheReadTokens) || 0;
  const cacheWriteTokens = Number(s.cacheWriteTokens) || 0;
  return {
    sessionId: s.sessionId,
    provider: s.provider || "unknown",
    project: s.project || "unknown",
    models: s.models || [],
    cost: Number(s.cost) || 0,
    label: money(s.cost),
    calls: Number(s.calls) || 0,
    turns: Number(s.turns) || 0,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    startedAt: s.startedAt || null,
    endedAt: s.endedAt || null,
    durationMs: Number(s.durationMs) || 0,
  };
}

function buildCostBreakdown(normalized, sessions, models) {
    const totals = summarizeSessions(sessions);
    const byModel = models
      .map((m) => ({
        provider: m.provider || "unknown",
        model: m.modelDisplayName || m.model || "unknown",
        cost: Number(m.costUSD) || 0,
        label: money(m.costUSD),
        calls: Number(m.calls) || 0,
        inputTokens: Number(m.inputTokens) || 0,
        outputTokens: Number(m.outputTokens) || 0,
        cacheReadTokens: Number(m.cacheReadTokens) || 0,
        cacheWriteTokens: Number(m.cacheWriteTokens) || 0,
        totalTokens: Number(m.totalTokens) || 0,
      }))
      .sort((a, b) => b.cost - a.cost);
    const byProvider = (totals.byProvider || []).map((p) => ({ ...p, label: money(p.cost) }));
    return {
      source: "codeburn",
      bin: codeburnBin(),
      period: normalized,
      generatedAt: new Date().toISOString(),
      totals: { ...totals, byProvider },
      byProvider,
      byModel,
      byProject: summarizeByProject(sessions),
      sessions: sessions
        .slice()
        .map(mapSessionRow)
        .sort((a, b) => b.cost - a.cost),
    };
}

function getCostBreakdown(period = "today") {
  const normalized = normalizeBreakdownPeriod(period) || "today";
  return cached(`breakdown:${normalized}`, () => {
    const sessions = parseSessions(normalized, "all") || [];
    const models = parseModels(normalized, "all") || [];
    return buildCostBreakdown(normalized, sessions, models);
  });
}

// Never blocks: returns the last good breakdown, or null while the background
// refresher builds the first one.
async function getCostBreakdownAsync(period = "today") {
  const normalized = normalizeBreakdownPeriod(period) || "today";
  noteDemand(normalized);
  const entry = state.breakdowns.get(normalized);
  const value = usableValue(entry);
  if (value) {
    if (isStale(entry, BREAKDOWN_TTL[normalized])) kick(refreshBreakdown(normalized));
    return value;
  }
  kick(refreshBreakdown(normalized));
  return null;
}

function peekCostBreakdown(period = "today") {
  const normalized = normalizeBreakdownPeriod(period) || "today";
  return usableValue(state.breakdowns.get(normalized));
}

function money(n) {
  const v = Number(n) || 0;
  let digits = 2;
  if (v >= 100) digits = 0;
  else if (v >= 10) digits = 1;
  else if (v > 0 && v < 0.01) digits = 4;
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function summarizeSessions(sessions) {
  const byProvider = {};
  let cost = 0;
  let calls = 0;
  let turns = 0;
  for (const session of sessions || []) {
    const provider = session.provider || "unknown";
    const c = Number(session.cost) || 0;
    const k = Number(session.calls) || 0;
    const t = Number(session.turns) || 0;
    cost += c;
    calls += k;
    turns += t;
    if (!byProvider[provider]) byProvider[provider] = { provider, cost: 0, calls: 0, sessions: 0 };
    byProvider[provider].cost += c;
    byProvider[provider].calls += k;
    byProvider[provider].sessions += 1;
  }
  return {
    cost,
    calls,
    turns,
    sessions: (sessions || []).length,
    label: money(cost),
    byProvider: Object.values(byProvider).sort((a, b) => b.cost - a.cost),
  };
}

function buildCostOverview(todaySessions, monthSessions) {
    const today = summarizeSessions(todaySessions);
    const month = summarizeSessions(monthSessions);
    return {
      source: "codeburn",
      bin: codeburnBin(),
      generatedAt: new Date().toISOString(),
      today,
      month,
      recent: (todaySessions || [])
        .slice()
        .sort((a, b) => String(b.endedAt || b.startedAt || "").localeCompare(String(a.endedAt || a.startedAt || "")))
        .slice(0, 12)
        .map((s) => ({
          sessionId: s.sessionId,
          provider: s.provider,
          project: s.project,
          models: s.models || [],
          cost: Number(s.cost) || 0,
          label: money(s.cost),
          calls: s.calls || 0,
          turns: s.turns || 0,
          startedAt: s.startedAt || null,
          endedAt: s.endedAt || null,
        })),
    };
}

function getCostOverview() {
  return cached("overview", () => {
    const todaySessions = parseSessions("today", "all");
    const monthSessions = parseSessions("month", "all");
    return buildCostOverview(todaySessions, monthSessions);
  });
}

async function getCostOverviewAsync() {
  noteDemand();
  const value = usableValue(state.overview);
  if (value) {
    if (isStale(state.overview, OVERVIEW_TTL)) kick(refreshOverview());
    return value;
  }
  kick(refreshOverview());
  return null;
}

function getProviderCost(provider, period = "today") {
  return summarizeSessions(parseSessions(period, provider));
}

const KIND_TO_CODEBURN = {
  cursor: "cursor-agent",
  claude: "claude",
  codex: "codex",
  kimi: "kimi",
  gemini: "gemini",
};

function codeburnProviderForKind(kind) {
  return KIND_TO_CODEBURN[kind] || kind || "all";
}

function providerRow(breakdown, provider) {
  return (breakdown?.byProvider || []).find((row) => row.provider === provider) || null;
}

function getCostForKind(kind, period = "today") {
  const provider = codeburnProviderForKind(kind);
  const normalized = normalizeBreakdownPeriod(period) || "today";
  noteDemand(normalized);
  const breakdown = usableValue(state.breakdowns.get(normalized));
  if (breakdown) {
    const hit = providerRow(breakdown, provider);
    return {
      provider,
      kind,
      cost: hit?.cost || 0,
      calls: hit?.calls || 0,
      sessions: hit?.sessions || 0,
      turns: 0,
      label: money(hit?.cost || 0),
      byProvider: hit ? [hit] : [],
    };
  }
  if (normalized === "today" || normalized === "month") {
    const overview = usableValue(state.overview);
    if (!overview) {
      kick(refreshOverview());
      return { provider, kind, cost: 0, calls: 0, sessions: 0, turns: 0, label: "…", byProvider: [], pending: true };
    }
    const bucket = normalized === "month" ? overview.month : overview.today;
    const hit = providerRow(bucket, provider);
    return {
      provider,
      kind,
      cost: hit?.cost || 0,
      calls: hit?.calls || 0,
      sessions: hit?.sessions || 0,
      turns: 0,
      label: money(hit?.cost || 0),
      byProvider: hit ? [hit] : [],
    };
  }
  kick(refreshBreakdown(normalized));
  return { provider, kind, cost: 0, calls: 0, sessions: 0, turns: 0, label: "…", byProvider: [], pending: true };
}

function latestSessionForKind(kind) {
  const provider = codeburnProviderForKind(kind);
  const overview = usableValue(state.overview);
  if (!overview) {
    kick(refreshOverview());
    return null;
  }
  const hit = (overview.recent || []).find((s) => s.provider === provider);
  return hit || null;
}

function peekCostOverview() {
  noteDemand();
  const value = usableValue(state.overview);
  if (isStale(state.overview, OVERVIEW_TTL)) kick(refreshOverview());
  return value;
}

function findSessionCost(sessionId) {
  if (!sessionId) return null;
  const needle = String(sessionId);
  for (const period of ["today", "week", "month"]) {
    const hit = (parseSessions(period, "all") || []).find((s) => String(s.sessionId) === needle);
    if (hit) {
      return {
        sessionId: hit.sessionId,
        provider: hit.provider,
        cost: Number(hit.cost) || 0,
        label: money(hit.cost),
        calls: hit.calls || 0,
        turns: hit.turns || 0,
        models: hit.models || [],
        period,
      };
    }
  }
  return null;
}

function clearCostCache() {
  cache.clear();
  rawSessions.clear();
  rawModels.clear();
  inFlight.clear();
  state.overview = null;
  state.breakdowns.clear();
  demand.at = 0;
  demand.periods.clear();
}

loadPersisted();

module.exports = {
  BREAKDOWN_PERIODS,
  clearCostCache,
  codeburnProviderForKind,
  costCacheFile,
  findSessionCost,
  getCostBreakdown,
  getCostBreakdownAsync,
  getCostForKind,
  getCostOverview,
  getCostOverviewAsync,
  getProviderCost,
  latestSessionForKind,
  money,
  normalizeBreakdownPeriod,
  parseModels,
  parseSessions,
  peekCostBreakdown,
  peekCostOverview,
  refreshBreakdown,
  refreshOverview,
  persistCostCacheNow: persistNow,
  startCostRefresher,
  warmCostOverviewAsync,
};
