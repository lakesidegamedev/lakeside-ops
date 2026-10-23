// Unit tests for CodeBurn breakdown helpers (no live codeburn spawn).
// Run: node --test agent-cost-breakdown.test.js
const { describe, it, before, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("agent-cost breakdown", () => {
  let agentCost;
  let childProcess;
  let spawnCount = 0;

  before(() => {
    // Fresh require so we can stub spawnSync without poisoning other suites.
    delete require.cache[require.resolve("./agent-cost")];
    childProcess = require("node:child_process");
    const realSpawn = childProcess.spawnSync;
    mock.method(childProcess, "spawnSync", (cmd, args, opts) => {
      if (String(cmd).includes("codeburn") || (Array.isArray(args) && args[0] === "sessions")) {
        // Handled via CODEBURN_BIN path below — intercept by argv.
      }
      if (Array.isArray(args)) {
        if (args[0] === "sessions") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                sessionId: "s1",
                project: "alpha",
                provider: "codex",
                models: ["gpt-test"],
                cost: 10,
                calls: 5,
                turns: 2,
                inputTokens: 100,
                outputTokens: 20,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                startedAt: "2026-07-24T01:00:00.000Z",
                endedAt: "2026-07-24T01:10:00.000Z",
                durationMs: 600000,
              },
              {
                sessionId: "s2",
                project: "alpha",
                provider: "claude",
                models: ["sonnet"],
                cost: 5,
                calls: 3,
                turns: 1,
                inputTokens: 50,
                outputTokens: 10,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                startedAt: "2026-07-24T02:00:00.000Z",
                endedAt: "2026-07-24T02:05:00.000Z",
                durationMs: 300000,
              },
              {
                sessionId: "s3",
                project: "beta",
                provider: "codex",
                models: ["gpt-test"],
                cost: 1,
                calls: 1,
                turns: 1,
                inputTokens: 10,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                startedAt: "2026-07-24T03:00:00.000Z",
                endedAt: "2026-07-24T03:01:00.000Z",
                durationMs: 60000,
              },
            ]),
            stderr: "",
            error: null,
          };
        }
        if (args[0] === "models") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                provider: "codex",
                model: "gpt-test",
                modelDisplayName: "gpt-test",
                costUSD: 11,
                calls: 6,
                inputTokens: 110,
                outputTokens: 22,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 132,
              },
              {
                provider: "claude",
                model: "sonnet",
                modelDisplayName: "Sonnet",
                costUSD: 5,
                calls: 3,
                inputTokens: 50,
                outputTokens: 10,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 60,
              },
            ]),
            stderr: "",
            error: null,
          };
        }
      }
      // which codeburn
      if (cmd === "which") {
        return { status: 0, stdout: "/usr/bin/codeburn\n", stderr: "", error: null };
      }
      return realSpawn(cmd, args, opts);
    });
    mock.method(childProcess, "spawn", (cmd, args) => {
      spawnCount++;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit("close", null, "SIGTERM");
      setTimeout(() => {
        const result = childProcess.spawnSync(cmd, args, {});
        child.stdout.end(result.stdout || "");
        child.stderr.end(result.stderr || "");
        child.emit("close", result.status ?? 0, null);
      }, 10);
      return child;
    });
    process.env.CODEBURN_BIN = "/usr/bin/codeburn";
    process.env.OPS_COST_CACHE = path.join(os.tmpdir(), `lakeside-cost-cache-test-${process.pid}.json`);
    try { fs.rmSync(process.env.OPS_COST_CACHE, { force: true }); } catch {}
    agentCost = require("./agent-cost");
    agentCost.clearCostCache();
  });

  after(() => {
    mock.restoreAll();
    delete require.cache[require.resolve("./agent-cost")];
    delete process.env.CODEBURN_BIN;
    if (process.env.OPS_COST_CACHE) {
      try { fs.rmSync(process.env.OPS_COST_CACHE, { force: true }); } catch {}
      delete process.env.OPS_COST_CACHE;
    }
  });

  it("normalizeBreakdownPeriod accepts today|week|month only", () => {
    assert.equal(agentCost.normalizeBreakdownPeriod("today"), "today");
    assert.equal(agentCost.normalizeBreakdownPeriod("WEEK"), "week");
    assert.equal(agentCost.normalizeBreakdownPeriod("month"), "month");
    assert.equal(agentCost.normalizeBreakdownPeriod("year"), null);
    assert.equal(agentCost.normalizeBreakdownPeriod(""), "today");
  });

  it("formats large spend totals with readable thousands separators", () => {
    assert.equal(agentCost.money(14895.2), "$14,895");
    assert.equal(agentCost.money(1234), "$1,234");
    assert.equal(agentCost.money(10), "$10.0");
  });

  it("getCostBreakdown aggregates providers, projects, models, sessions", () => {
    const breakdown = agentCost.getCostBreakdown("today");
    assert.equal(breakdown.period, "today");
    assert.equal(breakdown.source, "codeburn");
    assert.equal(breakdown.totals.cost, 16);
    assert.equal(breakdown.totals.sessions, 3);
    assert.equal(breakdown.byProvider[0].provider, "codex");
    assert.equal(breakdown.byProvider[0].cost, 11);
    assert.equal(breakdown.byProject.find((p) => p.project === "alpha").sessions, 2);
    assert.equal(breakdown.byModel[0].model, "gpt-test");
    assert.equal(breakdown.sessions[0].sessionId, "s1");
    assert.equal(breakdown.sessions[0].label, "$10.0");
  });

  it("never blocks a request on CodeBurn: cold reads return null and warm in the background", async () => {
    agentCost.clearCostCache();
    const breakdown = await agentCost.getCostBreakdownAsync("today");
    assert.equal(breakdown, null);
    const warmed = await agentCost.refreshBreakdown("today");
    assert.equal(warmed.totals.cost, 16);
    const overview = await agentCost.getCostOverviewAsync();
    assert.equal(overview, null);
    const warmedOverview = await agentCost.refreshOverview();
    assert.equal(warmedOverview.today.cost, 16);
    const cached = await agentCost.getCostBreakdownAsync("today");
    assert.equal(cached.totals.cost, 16);
  });

  it("coalesces concurrent refreshes into a single CodeBurn run per key", async () => {
    agentCost.clearCostCache();
    const before = spawnCount;
    agentCost.refreshOverview();
    agentCost.refreshOverview();
    const overview = await agentCost.refreshOverview();
    assert.equal(overview.today.cost, 16);
    assert.equal(overview.month.cost, 16);
    // sessions today + sessions month, nothing duplicated
    assert.equal(spawnCount - before, 2);
  });

  it("persists snapshots so a restart renders usage without spawning CodeBurn", async () => {
    agentCost.clearCostCache();
    await agentCost.refreshBreakdown("today");
    agentCost.persistCostCacheNow();
    assert.ok(fs.existsSync(process.env.OPS_COST_CACHE));

    delete require.cache[require.resolve("./agent-cost")];
    const reloaded = require("./agent-cost");
    const before = spawnCount;
    const cached = await reloaded.getCostBreakdownAsync("today");
    assert.equal(cached.totals.cost, 16);
    assert.equal(spawnCount, before, "restart should serve the persisted snapshot without spawning CodeBurn");
    delete require.cache[require.resolve("./agent-cost")];
    agentCost = require("./agent-cost");
  });
});
