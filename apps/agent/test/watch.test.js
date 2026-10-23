"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createWatch, finiteIssues } = require("../lib/operator/watch");
const { createBroker } = require("../lib/operator/broker");

const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function ledger() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-watch-")); dirs.push(dir); return { dir, ledger: createLedger(path.join(dir, "ledger.json")) }; }

function harness({ anomalies = [], pulse = {}, defects = [], detect = {}, sentry = [], pages = {}, invariants = null } = {}) {
  const { ledger: l } = ledger();
  let clock = 1_000_000_000;
  const proposals = [];
  const mcp = { call: async (server, tool, args) => {
    if (tool === "turn_anomalies") return { anomalies };
    if (tool === "economy_pulse") return pulse;
    if (tool === "heal_list") return { defects };
    if (tool === "heal_detect") return detect[args.defectId] || { count: 0 };
    if (tool === "invariant_check") { if (!invariants) throw new Error("unknown tool invariant_check"); return invariants.shift() || { rules: [] }; }
    throw new Error(`unexpected ${tool}`);
  } };
  const w = createWatch({ ledger: l, mcp, now: () => clock, sentry: async () => sentry, viewPage: async (url) => pages[new URL(url).pathname] || { title: "A House Divided", text: "Elections and parties" }, propose: async (p) => { proposals.push(p); return { ...p, messageId: "proposal1" }; } });
  return { l, w, proposals, advance: (ms) => { clock += ms; } };
}

test("finiteIssues finds NaN and Infinity anywhere", () => {
  assert.deepEqual(finiteIssues({ a: 1, b: { c: NaN, d: [1, Infinity] }, e: "NaN" }), ["b.c", "b.d.1", "e"]);
  assert.deepEqual(finiteIssues({ a: 1, b: "fine" }), []);
});

test("a failed turn is a hard, severe finding: one task and one incident proposal", async () => {
  const h = harness({ anomalies: [{ turn: 193, kind: "turn-failed" }, { turn: 194, kind: "phase-running", phase: "markets" }, { turn: 193, kind: "slow-turn" }] });
  const r = await h.w.tick({ turnProcessed: true });
  assert.deepEqual(r.raised, ["turn:193:failed"]);
  const job = Object.values(h.l.data.jobs).find((j) => j.kind === "finding");
  assert.equal(job.role, "support");
  assert.match(job.source.content, /before any player reported it/);
  assert.equal(job.source.role, "system");
  assert.equal(h.proposals.length, 1);
  assert.equal(h.proposals[0].source, "watch");
  // Seen again: no second task, no second proposal.
  h.advance(10 * 60000);
  await h.w.tick({ turnProcessed: true });
  assert.equal(Object.values(h.l.data.jobs).filter((j) => j.kind === "finding").length, 1);
  assert.equal(h.proposals.length, 1);
});

test("a soft signal waits for a second sighting; per-turn sensors skip between turns", async () => {
  const h = harness({ anomalies: [{ turn: 10, kind: "warning", detail: "Market clearing skipped 3 commodities" }] });
  await h.w.tick({ turnProcessed: true });
  assert.equal(Object.values(h.l.data.jobs).length, 0, "one sighting is not enough");
  await h.w.tick({ turnProcessed: false });
  assert.equal(h.l.data.watch.findings["turn:warning:market clearing skipped # commodities"].seen, 1, "no turn, no re-run");
  h.w.observe({ fp: "turn:warning:market clearing skipped # commodities", sensor: "turns", title: "Recurring", event: "turn:11" });
  await h.w.tick({ turnProcessed: true });
  assert.equal(Object.values(h.l.data.jobs).filter((j) => j.kind === "finding").length, 1);
  assert.equal(h.proposals.length, 0, "soft findings are not incidents");
});

test("finding tasks are capped per hour and the rest wait", async () => {
  const anomalies = [1, 2, 3, 4, 5].map((t) => ({ turn: t, kind: "phase-failed", phase: `p${t}` }));
  const h = harness({ anomalies });
  await h.w.tick({ turnProcessed: true });
  assert.equal(Object.values(h.l.data.jobs).filter((j) => j.kind === "finding").length, 3);
  h.advance(61 * 60000);
  await h.w.tick({ turnProcessed: true });
  assert.equal(Object.values(h.l.data.jobs).filter((j) => j.kind === "finding").length, 5);
});

test("a structural heal detector firing on prod becomes a finding; restitution defects are skipped", async () => {
  const defects = [{ id: "AHD-dup", title: "Duplicate rows", severity: "P1", envs: ["prod"], mintsMoney: false }, { id: "AHD-pay", title: "Restitution", severity: "P1", envs: ["prod"], mintsMoney: true }];
  const h = harness({ defects, detect: { "AHD-dup": { ok: true, detect: { affected: 12, sample: [{ _id: "x" }], notes: ["12 rows"] } }, "AHD-pay": { ok: true, detect: { affected: 99 } } } });
  await h.w.tick();
  const f = h.l.data.watch.findings["heal:AHD-dup"];
  assert.equal(f.defectId, "AHD-dup");
  assert.match(f.title, /Known defect is back on prod/);
  assert.equal(h.l.data.watch.findings["heal:AHD-pay"], undefined);
});

test("noisy Sentry errors and broken pages are observed; quiet ones are not", async () => {
  const h = harness({ sentry: [{ id: "1", title: "TypeError", count: 40, users: 6 }, { id: "2", title: "rare", count: 1, users: 1 }],
    pages: { "/market": { title: "Market", text: "Price NaN for oil" }, "/parties": { error: "timeout" } } });
  await h.w.tick();
  const f = h.l.data.watch.findings;
  assert.ok(f["sentry:1"].hard);
  assert.equal(f["sentry:2"], undefined);
  assert.ok(Object.keys(f).some((k) => k.startsWith("page:/market:nan")));
  assert.ok(Object.keys(f).some((k) => k.startsWith("page:/parties:could not load")));
});

test("a finding clears after six quiet hours and the scorecard credits a later ticket", async () => {
  const h = harness();
  h.w.observe({ fp: "x", sensor: "pages", title: "Broken", evidence: "e" });
  h.advance(7 * 3600000); await h.w.tick();
  assert.equal(h.l.data.watch.findings.x.state, "resolved");
  h.w.observe({ fp: "y", sensor: "turns", title: "Failed", evidence: "e", hard: true });
  h.w.promote(); h.w.linkFinding("y", { issue: 700 });
  h.w.credit({ issue: 700, fromTicket: true });
  h.w.credit({ issue: 701, fromTicket: true });
  const { caughtFirst, playerFirst, share } = h.w.score();
  assert.deepEqual({ caughtFirst, playerFirst, share }, { caughtFirst: 1, playerFirst: 1, share: 50 });
});

test("a finding task cannot apply a heal or ship a non-display fix", async () => {
  const { dir, ledger: l } = ledger();
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [],
    taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const exec = async (cmd, args) => {
    const route = args[1];
    if (/pulls\/10\/files/.test(route)) return JSON.stringify([{ filename: "src/lib/market/governor.ts" }]);
    if (/pulls\/11\/files/.test(route)) return JSON.stringify([{ filename: "src/components/Shop.tsx", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-  <p>Loading</p>\n+  <p>Ready</p>" }]);
    if (/pulls\/1[01]$/.test(route)) return JSON.stringify({ number: 10, state: "open", head: { sha: "abc" }, base: { ref: "development" }, mergeable: true });
    if (/check-runs/.test(route)) return JSON.stringify({ check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });
    return JSON.stringify({});
  };
  const b = createBroker({ ledger: l, config, mcp: { servers: () => [], list: async () => [], call: async () => ({}) }, discord: async () => [], sandbox: {}, now: () => 5000, exec });
  const job = l.createJob("finding:test", { kind: "finding", role: "support", repository: "AHDGame", finding: "x", deadline: 9e15, source: {}, pullRequests: ["https://github.com/Egg3901/AHDGame/pull/10", "https://github.com/Egg3901/AHDGame/pull/11"] });
  job.state = "running";
  await assert.rejects(b.tool(job, "github", { action: "merge", number: 10 }), /only display-only changes/);
  const ok = await b.tool(job, "github", { action: "merge", number: 11 }).catch((e) => e);
  assert.doesNotMatch(String(ok?.message || ""), /only display-only/, "a display-only fix may ship");
  await assert.rejects(b.tool(job, "request_action", { kind: "mcp_write", args: { server: "x", tool: "y", args: {} }, reason: "r" }), /prepare heals and draft PRs/);
});

test("invariant breaches are findings; a pool residual fires only when it grows; a missing tool is quiet", async () => {
  const pool = (residual) => ({ rules: [{ id: "equity_pool_residual", source: "src/lib/equities/poolConservation.ts", checked: 1, breaches: 0, sample: [], measurements: [{ key: "equity_pool_residual:USD", pool: "USD", residual, cashLocal: 1e9 }] }] });
  const shares = { rules: [{ id: "share_accounting", source: "src/lib/corporations/shareInvariant.ts", checked: 10, breaches: 1, sample: [{ corporationId: "c1", name: "Acme", drift: 200 }] }] };
  const h = harness({ invariants: [pool(500), pool(500), pool(900), shares] });
  await h.w.tick({ turnProcessed: true });
  await h.w.tick({ turnProcessed: true });
  assert.equal(Object.keys(h.l.data.watch.findings).filter((k) => k.startsWith("invariant:")).length, 0, "stable history is not a finding");
  await h.w.tick({ turnProcessed: true });
  assert.ok(h.l.data.watch.findings["invariant:equity_pool_residual:USD:grew"]);
  await h.w.tick({ turnProcessed: true });
  assert.match(h.l.data.watch.findings["invariant:share_accounting"].title, /share accounting/);
  const quiet = harness();
  await quiet.w.tick({ turnProcessed: true });
  assert.ok(quiet.l.data.watch.invariantsUnavailable);
  assert.ok(!quiet.l.data.audit.some((a) => a.kind === "watch_sensor_failed" && a.sensor === "invariants"));
});

test("startup repairs partial persisted state and polls failed turns without a processed counter", async () => {
  const h = harness({ anomalies: [{ turn: 10, kind: "turn-failed" }] });
  h.l.data.watch = { lastTurn: 9 };
  const r = await h.w.tick({ turn: 9 });
  assert.deepEqual(r.raised, ["turn:10:failed"]);
  assert.ok(h.l.data.watch.ran.heal);
  assert.equal(h.w.score().raised, 1);
});

test("a historical warning never counts twice, but a new turn does", async () => {
  const anomalies = [{ turn: 10, kind: "warning", detail: "Market skipped 3 commodities" }];
  const h = harness({ anomalies });
  await h.w.tick({ turn: 10 });
  h.advance(5 * 60000);
  await h.w.tick({ turn: 10 });
  assert.equal(Object.values(h.l.data.jobs).length, 0);
  anomalies.push({ ...anomalies[0] });
  h.advance(5 * 60000);
  await h.w.tick({ turn: 11 });
  assert.equal(Object.values(h.l.data.jobs).length, 0, "duplicate rows from one turn are one event");
  anomalies.push({ ...anomalies[0], turn: 12 });
  await h.w.tick({ turn: 12 });
  assert.equal(Object.values(h.l.data.jobs).length, 1);
});

test("a completed finding rearms after healthy sweeps, then detects a recurrence", async () => {
  const anomalies = [{ turn: 10, kind: "phase-failed", phase: "market" }];
  const h = harness({ anomalies });
  await h.w.tick({ turn: 10 });
  const f = Object.values(h.l.data.watch.findings)[0];
  h.l.data.jobs[f.jobId].state = "done";
  anomalies.length = 0;
  h.advance(7 * 3600000);
  await h.w.tick({ turn: 11 });
  assert.equal(f.state, "resolved");
  // Re-reading the old turn is not a recurrence (5.1: two clean turns since).
  anomalies.push({ turn: 10, kind: "phase-failed", phase: "market" });
  await h.w.tick({ turn: 12 });
  assert.equal(f.state, "resolved");
  assert.equal(Object.values(h.l.data.jobs).length, 1);
  anomalies.push({ turn: 13, kind: "phase-failed", phase: "market" });
  await h.w.tick({ turn: 13 });
  assert.equal(f.state, "raised");
  assert.equal(Object.values(h.l.data.jobs).length, 2);
});

test("a sensor outage does not clear findings and a failed staff proposal retries", async () => {
  const h = harness();
  h.w.observe({ fp: "x", sensor: "unavailable", title: "Broken", hard: true });
  h.advance(7 * 3600000);
  await h.w.tick();
  assert.equal(h.l.data.watch.findings.x.state, "raised");
  let attempts = 0;
  const w = createWatch({ ledger: h.l, mcp: { call: async () => ({}) }, now: () => 9e9,
    propose: async () => { attempts++; return attempts === 1 ? { postError: "offline" } : { messageId: "staff1" }; } });
  w.observe({ fp: "severe", sensor: "turns", title: "Failed", hard: true, severe: true });
  await w.tick(); await w.tick(); await w.tick();
  assert.equal(attempts, 2);
});

test("all structural detectors run and score retries are deduplicated", async () => {
  const defects = Array.from({ length: 15 }, (_, i) => ({ id: `d${i}`, title: "Duplicate", severity: "P1", envs: ["prod"], mintsMoney: false }));
  const h = harness({ defects, detect: { d14: { count: 2 } } });
  await h.w.tick();
  assert.ok(h.l.data.watch.findings["heal:d14"]);
  h.w.credit({ issue: 5, fromTicket: true }); h.w.credit({ issue: 5, fromTicket: true });
  assert.equal(h.w.score().playerFirst, 1);
});

test("Sentry watch is scoped to the game's production project", () => {
  const { sentryWatchQuery } = require("../lib/operator/watch");
  assert.equal(sentryWatchQuery("is:unresolved"), "is:unresolved project:a-house-divided environment:production");
  assert.equal(sentryWatchQuery("is:unresolved", { project: "fixture", environment: "prod" }), "is:unresolved project:fixture environment:prod");
  assert.throws(() => sentryWatchQuery("is:unresolved", { project: "fixture OR project:other" }), /invalid/);
});

test("failed heal detection does not retire a previously raised finding", async () => {
  const { ledger: l } = ledger();
  let clock = 1e9, failed = false;
  const w = createWatch({ ledger: l, now: () => clock, mcp: { call: async (_, tool) => {
    if (tool === "heal_list") return { defects: [{ id: "x", envs: ["prod"], mintsMoney: false, severity: "P1" }] };
    if (tool === "heal_detect") { if (failed) throw new Error("database offline"); return { count: 1 }; }
    return {};
  } } });
  await w.tick();
  l.data.jobs[l.data.watch.findings["heal:x"].jobId].state = "done";
  clock += 7 * 3600000; failed = true;
  await w.tick();
  assert.equal(l.data.watch.findings["heal:x"].state, "raised");
});

test("shadow report mode records grouped invariant evidence without jobs or staff writes", async () => {
  const { ledger: l } = ledger();
  const w = createWatch({ ledger: l, config: { mode: "report" }, now: () => 1e9,
    propose: async () => { throw new Error("report mode must not page staff"); },
    mcp: { call: async (_, tool) => tool === "invariant_check" ? { rules: [{ id: "share_accounting", source: "src/lib/share.ts", breaches: 100, checked: 100,
      sample: Array.from({ length: 100 }, (_, i) => ({ corporationId: `c${i}` })) }] } : {} } });
  const out = await w.tick({ turn: 1 });
  assert.equal(out.mode, "report");
  assert.deepEqual(out.raised, []);
  assert.equal(Object.keys(l.data.watch.findings).length, 1);
  assert.equal(Object.keys(l.data.jobs).length, 0);
  assert.match(l.data.watch.findings["invariant:share_accounting"].evidence, /100 breach/);
});

test("a browser that cannot start degrades the page sensor instead of reporting broken pages", async () => {
  const h = harness({ pages: { "/market": { error: "page did not render: browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium_headless_shell-1248" } } });
  await h.w.tick();
  const f = h.l.data.watch.findings || {};
  assert.equal(Object.keys(f).filter((k) => k.startsWith("page:")).length, 0);
  assert.match(h.l.data.watch.errors.pages.error, /page sensor browser unavailable/);
});

test("startup does not open incidents for failures behind the completed turn", async () => {
  const h = harness({ anomalies: [
    { turn: 384, kind: "turn-failed" },
    { turn: 384, kind: "phase-failed", phase: "bondTurn" },
  ] });
  const r = await h.w.tick({ turn: 386 });
  assert.deepEqual(r.raised, []);
  assert.equal(h.proposals.length, 0);
  assert.equal(Object.values(h.l.data.jobs).length, 0);
  h.advance(5 * 60000);
  await h.w.tick();
  assert.equal(h.proposals.length, 0, "cadence polls use the last completed turn too");
});

test("a failed turn is one event and old persisted failure state clears after clean turns", async () => {
  const h = harness({ anomalies: [{ turn: 384, kind: "turn-failed" }] });
  await h.w.tick({ turn: 383 });
  const f = h.l.data.watch.findings["turn:384:failed"];
  assert.equal(f.lastTurnSeen, 384);
  h.l.data.jobs[f.jobId].state = "done";
  h.advance(5 * 60000); await h.w.tick({ turn: 383 });
  assert.equal(f.afterJob || 0, 0, "polling the same attempt is not a recurrence");
  delete f.lastTurnSeen; // Upgrade a finding created before the turn event was recorded.
  await h.w.tick({ turn: 386 });
  assert.equal(f.state, "resolved");
  assert.equal(h.proposals.length, 1);
});
