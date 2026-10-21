"use strict";
// Keir 5.1 regressions, replaying the 2026-10-15 audit of 5.x: one line of
// credit fault became five findings, three public issues (#4140 to #4142) and
// two drafts; it kept failing after Keir's work finished with nothing raised
// again; one broken heal detector blinded the heal sensor; and the owner was
// asked three times for one change. Ids and titles are synthetic.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createWatch, causeKey } = require("../lib/operator/watch");
const { createBroker, similarity } = require("../lib/operator/broker");
const chain = require("../lib/operator/chain");
const routing = require("../lib/operator/routing");
const train = require("../lib/operator/train");

const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function ledger() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-51-")); dirs.push(dir); return { dir, ledger: createLedger(path.join(dir, "ledger.json")) }; }

const LOC = "Unbalanced original LOC cash flows in USD";
function harness({ anomalies = [], sentry = [], defects = [], detect = {} } = {}) {
  const { dir, ledger: l } = ledger();
  let clock = 1_800_000_000_000;
  const mcp = { call: async (server, tool, args) => {
    if (tool === "turn_anomalies") return { anomalies };
    if (tool === "economy_pulse") return {};
    if (tool === "heal_list") return { defects };
    if (tool === "heal_detect") { const r = detect[args.defectId]; if (r instanceof Error) throw r; return r || { count: 0 }; }
    if (tool === "invariant_check") return { rules: [] };
    throw new Error(`unexpected ${tool}`);
  } };
  const w = createWatch({ ledger: l, mcp, now: () => clock, sentry: async () => sentry, viewPage: async () => ({ title: "A House Divided", text: "Elections" }), propose: async (p) => ({ ...p, messageId: "m1" }) });
  return { dir, l, w, advance: (ms) => { clock += ms; }, now: () => clock };
}
const locTurn = (turn) => [
  { turn, kind: "phase-failed", phase: "bankingTurn", reason: "other" },
  { turn, kind: "phase-failed", phase: "lineOfCreditTurn", reason: "other" },
  { turn, kind: "warning", detail: `bankingTurn: ${LOC}` },
  { turn, kind: "warning", detail: `lineOfCreditTurn: ${LOC}` },
];

test("the same error text from Sentry and a turn phase is one root cause", () => {
  assert.equal(causeKey(`Error: ${LOC}`), causeKey(LOC));
  assert.equal(causeKey("other"), null);
});

test("a Sentry error with a raised turn finding's cause joins it instead of raising", async () => {
  const anomalies = locTurn(195);
  const h = harness({ anomalies });
  const first = await h.w.tick({ turn: 195 });
  assert.equal(first.raised.length, 1, "both failing phases are one finding");
  h.advance(31 * 60000);
  h.w.observe({ fp: "sentry:779", sensor: "sentry", hard: true, title: `New error: Error: ${LOC}`, evidence: "8 users", cause: `Error: ${LOC}` });
  const r = h.w.promote();
  assert.equal(r.length, 0);
  const s = h.l.data.watch.findings["sentry:779"];
  assert.equal(s.state, "correlated");
  assert.equal(h.w.rootOf("sentry:779").fp, first.raised[0]);
  assert.equal(Object.values(h.l.data.jobs).filter((j) => j.kind === "finding").length, 1);
});

test("a problem that outlives its finished task is raised again, once per window, with its issue", async () => {
  const anomalies = locTurn(195);
  const h = harness({ anomalies });
  const { raised: [fp] } = await h.w.tick({ turn: 195 });
  const f = h.l.data.watch.findings[fp];
  const firstJob = f.jobId;
  f.issue = 4140;
  h.l.data.jobs[firstJob].state = "done";
  for (const turn of [196, 197]) { anomalies.push(...locTurn(turn)); h.advance(3600000); await h.w.tick({ turn }); }
  assert.equal(f.state, "raised", "raised again");
  assert.notEqual(f.jobId, firstJob);
  assert.deepEqual(f.priorJobs, [firstJob]);
  const job = h.l.data.jobs[f.jobId];
  assert.match(job.source.content, /still happening after that work finished/);
  assert.match(job.source.content, /#4140/);
  assert.deepEqual(job.issues, [4140]);
  assert.ok(h.l.data.audit.some((a) => a.kind === "watch_finding_recurring"));
  assert.ok(h.l.data.alerts.some((a) => a.key.startsWith("error:watch-recurring:")));
  // Inside the window it does not churn.
  h.l.data.jobs[f.jobId].state = "done";
  for (const turn of [198, 199]) { anomalies.push(...locTurn(turn)); h.advance(3600000); await h.w.tick({ turn }); }
  assert.equal(Object.values(h.l.data.jobs).filter((j) => j.kind === "finding").length, 2);
});

test("a turn finding is verified fixed after two clean turns, with its group", async () => {
  const anomalies = locTurn(198);
  const h = harness({ anomalies });
  const { raised: [fp] } = await h.w.tick({ turn: 198 });
  h.l.data.jobs[h.l.data.watch.findings[fp].jobId].state = "done";
  h.w.observe({ fp: "sentry:779", sensor: "sentry", hard: true, title: `New error: ${LOC}`, evidence: "e", cause: LOC });
  h.w.promote();
  // The sensor keeps re-reading turn 198 while 199 and 200 run clean.
  h.advance(3600000); await h.w.tick({ turn: 199 });
  assert.equal(h.l.data.watch.findings[fp].state, "raised");
  h.advance(3600000); await h.w.tick({ turn: 200 });
  assert.equal(h.l.data.watch.findings[fp].state, "resolved");
  assert.ok(h.l.data.watch.findings[fp].verifiedAt);
  assert.equal(h.l.data.watch.findings["sentry:779"].state, "resolved");
  assert.ok(h.l.data.audit.some((a) => a.kind === "watch_fix_verified" && a.cleanThrough === 200));
  assert.match(h.l.data.watch.headline, /1 verified fixed/);
});

test("one broken heal detector neither blinds the sensor nor fails it forever", async () => {
  const defects = [{ id: "dd-financial", envs: ["prod"], severity: "P2", title: "x" }, { id: "loc-dust", envs: ["prod"], severity: "P1", title: "LOC dust is back" }];
  const h = harness({ defects, detect: { "dd-financial": { ok: false, error: "no state enterprise target for DD/financial" }, "loc-dust": { count: 3 } } });
  for (let i = 0; i < 3; i++) { await h.w.sensors.heal(); }
  assert.ok(h.l.data.watch.findings["heal:loc-dust"], "the working detector still reports");
  assert.ok(h.l.data.watch.detectors["dd-financial"].skipUntil > h.now());
  assert.ok(h.l.data.alerts.some((a) => a.key === "error:watch-detector:dd-financial"));
  assert.deepEqual(h.w.health().detectors, { "dd-financial": "no state enterprise target for DD/financial" });
  // Every detector failing still fails the sensor.
  const broken = harness({ defects: [defects[0]], detect: { "dd-financial": { ok: false, error: "down" } } });
  await assert.rejects(broken.w.sensors.heal(), /dd-financial/);
});

test("a sensor failing for an hour is a logged alert once a day, not a DM", async () => {
  const h = harness();
  h.w.sensors.sentry = async () => { throw new Error("sentry 401"); };
  await h.w.tick({ turn: 1 });
  assert.ok(!h.l.data.alerts?.some((a) => a.key.startsWith("error:watch-sensor:sentry")), "not on first failure");
  for (let i = 0; i < 14; i++) { h.advance(5 * 60000); await h.w.tick({ turn: 1 }); }
  const alerts = h.l.data.alerts.filter((a) => a.key.startsWith("error:watch-sensor:sentry"));
  assert.equal(alerts.length, 1);
  assert.equal(Object.values(h.l.data.outbox).length, 0, "no DM");
  assert.match(h.w.headline(), /Sensors down: sentry/);
});

test("the scorecard leads with caught first vs player first, lead time and dismissals", () => {
  const h = harness();
  h.w.observe({ fp: "y", sensor: "turns", title: "Failed", evidence: "e", hard: true });
  h.w.promote(); h.w.linkFinding("y", { issue: 700 });
  h.advance(45 * 60000);
  h.w.credit({ issue: 700, fromTicket: true });
  const s = h.w.score();
  assert.equal(s.caughtFirst, 1);
  assert.equal(s.leadMinutesMedian, 45);
  assert.match(h.w.headline(), /caught first 1, player first 0 \(100%\), median lead 45m/);
});

// Broker: issues and drafts share a root cause.
function brokerFixture(routes) {
  const { dir, ledger: l } = ledger();
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [],
    taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args);
    const route = args.filter((a) => !a.startsWith("-") && a !== "api" && !/^[a-z_\[\]]+=/.test(a)).at(-1);
    for (const [pattern, value] of routes) if (pattern.test(route)) return JSON.stringify(typeof value === "function" ? value(route, args) : value);
    return JSON.stringify({});
  };
  const mcp = { servers: () => [], list: async () => [], call: async (server, tool) => tool === "kanban_list" ? [] : tool === "kanban_add" ? { id: 900 } : {} };
  const b = createBroker({ ledger: l, config, mcp, discord: async () => [], sandbox: {}, now: () => 1_800_000_000_000, exec });
  const w = createWatch({ ledger: l, mcp: { call: async () => ({}) }, now: () => 1_800_000_000_000 });
  b.setWatch(w);
  return { l, b, w, calls };
}
const locIssue = (title) => ({ title, detail: "Line of credit servicing fails the banking phase every turn since 195 with unbalanced cash flows.", kind: "bug",
  issue: { summary: "Line of credit servicing aborts the banking turn phase for every world each turn.", expected: "Servicing balances to the cent.", actual: "The phase aborts with unbalanced cash flows.", impact: "Banking and credit lines stop updating for everyone." } });

test("a finding whose root cause already has an issue joins it; no second public issue", async () => {
  const f = brokerFixture([]);
  f.w.observe({ fp: "turn:loc", sensor: "turns", hard: true, title: "LOC", evidence: "e", cause: LOC });
  f.w.observe({ fp: "sentry:779", sensor: "sentry", hard: true, title: "LOC", evidence: "e", cause: `Error: ${LOC}` });
  f.w.promote();
  const root = f.l.data.watch.findings["turn:loc"];
  root.issue = 4140;
  f.l.data.keirIssues = { 4140: { number: 4140, url: "https://github.com/lakesidegamedev/AHDGame/issues/4140", title: "Line of credit servicing fails the whole turn phase", state: "open", at: 1_800_000_000_000, jobId: root.jobId } };
  // A second finding job in the same group (an older raise) files.
  f.l.data.watch.findings["sentry:779"].priorJobs = ["j2"];
  const job = f.l.createJob("finding:sentry", { kind: "finding", role: "support", repository: "AHDGame", finding: "sentry:779", deadline: 9e15, source: {} }); job.state = "running";
  const r = await f.b.tool(job, "raise_to_developers", locIssue("Fractional wallet balance makes line of credit servicing unbalanced"));
  assert.equal(r.issue, 4140);
  assert.equal(r.sameRootCause, true);
  assert.ok(!f.calls.some((a) => a.includes("repos/lakesidegamedev/AHDGame/issues") && a.includes("POST")), "no new issue");
});

test("force does not skip Keir's own recent issues; distinctFrom does, after reading them", async () => {
  const f = brokerFixture([[/search\/issues/, { items: [] }], [/repos\/lakesidegamedev\/AHDGame\/issues$/, { number: 4141, html_url: "https://github.com/lakesidegamedev/AHDGame/issues/4141" }]]);
  f.l.data.keirIssues = { 4140: { number: 4140, url: "u", title: "Line of credit servicing fails the whole turn phase when a borrower's balance has sub-cent fractions", state: "open", at: 1_800_000_000_000 - 60000 } };
  const job = f.l.createJob("cmd:x", { kind: "command", role: "owner", actorId: "111111111111111111", repository: "AHDGame", deadline: 9e15, source: {} }); job.state = "running";
  const title = "Line of credit servicing emits unbalanced cash flows and aborts the LOC and banking turn phases";
  assert.ok(similarity(title, f.l.data.keirIssues[4140].title) >= 0.2, "the 2026-10-14 pair is caught");
  const r = await f.b.tool(job, "raise_to_developers", { ...locIssue(title), force: true });
  assert.equal(r.raised, false);
  assert.deepEqual(r.issueCandidates.map((x) => x.number), [4140]);
  const filed = await f.b.tool(job, "raise_to_developers", { ...locIssue(title), force: true, distinctFrom: [4140] });
  assert.equal(filed.issue, 4141);
});

test("duplicate Keir issues of one root cause close into the lowest number", async () => {
  const state = { 4140: "open", 4141: "open", 4142: "open" };
  const f = brokerFixture([[/issues\/(\d+)$/, (route, args) => { const n = /(\d+)$/.exec(route)[1]; if (args.includes("PATCH")) state[n] = "closed"; return { number: Number(n), state: state[n] }; }], [/comments$/, {}]]);
  f.w.observe({ fp: "turn:loc", sensor: "turns", hard: true, title: "LOC", evidence: "e", cause: LOC });
  f.w.observe({ fp: "turn:loc2", sensor: "turns", hard: true, title: "LOC2", evidence: "e" });
  f.w.promote();
  const a = f.l.data.watch.findings["turn:loc"], b = f.l.data.watch.findings["turn:loc2"];
  b.correlatedWith = "turn:loc"; b.priorJobs = ["jb"];
  f.l.data.keirIssues = { 4140: { number: 4140, state: "open", jobId: "jb" }, 4142: { number: 4142, state: "open", jobId: a.jobId }, 4151: { number: 4151, state: "open", jobId: "unrelated" } };
  const job = f.l.createJob("dedupe", { kind: "command", role: "support", internalProbe: true, repository: "AHDGame", deadline: 9e15, source: {} }); job.state = "running";
  const closed = await f.b.closeDuplicateIssues(job);
  assert.deepEqual(closed, [4142]);
  assert.equal(f.l.data.keirIssues[4142].duplicateOf, 4140);
  assert.equal(f.l.data.keirIssues[4151].state, "open");
  assert.ok(f.calls.some((x) => x.some((v) => /Same root cause as #4140/.test(v))));
  assert.equal(a.issue, 4140);
});

test("chain consent covers only approved heads, owner approvals and PR commits", () => {
  const now = 10 * 86400000;
  const actions = {
    m10: { id: "m10", kind: "github", state: "approved", approvedBy: "o", approvalMessage: "x", approvedAt: now - 3600000, args: { action: "merge", number: 10, head: "abc" } },
    old: { id: "old", kind: "github", state: "approved", approvedBy: "o", approvalMessage: "x", approvedAt: now - 2 * 86400000, args: { action: "merge", number: 11, head: "def" } },
    set: { id: "set", kind: "github", state: "approved", approvedBy: "o", approvalMessage: "x", approvedAt: now - 7200000, args: { action: "merge-set", prs: [{ number: 13, head: "ghi" }] } },
    staff: { id: "staff", kind: "github", state: "approved", approvedBy: "s", approvalMessage: "x", approvedAt: now, args: { action: "merge", number: 14, head: "jkl" } },
  };
  const approvals = chain.approvedMerges(actions, "o", now);
  const ok = chain.cover({ approvals, entries: [{ sha: "c1", prs: [{ number: 10, head: "abc", huge: true }] }, { sha: "c2", prs: [{ number: 12, head: "x", huge: false }] }, { sha: "c3", prs: [{ number: 13, head: "ghi", huge: true }] }] });
  assert.equal(ok.covered, true);
  assert.equal(ok.oldestApprovedAt, now - 7200000);
  for (const entries of [
    [{ sha: "c1", prs: [{ number: 10, head: "changed", huge: true }] }],
    [{ sha: "c1", prs: [{ number: 11, head: "def", huge: true }] }],
    [{ sha: "c1", prs: [{ number: 14, head: "jkl", huge: true }] }],
    [{ sha: "c1", prs: [{ number: 10, head: "abc", huge: true }] }, { sha: "push", prs: [] }],
  ]) assert.equal(chain.cover({ approvals, entries }).covered, false);
});

test("lanes refuse models that failed them unless a trial is allowed", () => {
  const config = { codingProvider: "ollama:deepseek-v4.1-flash@medium", investigatorProvider: "codex:gpt-6.1-sol@low", workerProvider: "claude:claude-opus-5-5@medium" };
  const changed = routing.enforce(config);
  assert.deepEqual(changed.map((c) => c.lane), ["coding"]);
  assert.equal(config.codingProvider, routing.FALLBACK.coding);
  const trial = { codingProvider: "ollama:deepseek-v4.1-flash@medium" };
  assert.deepEqual(routing.enforce(trial, { allowBlocked: true }), []);
  assert.equal(routing.check("worker", "agy:gemini-3.8-flash@medium").ok, false);
  assert.equal(routing.check("coding", "muse:muse-spark-1.3-contributor@xhigh").ok, false);
  assert.equal(routing.check("coding", "opencode:opencode-go/muse-spark-1.3-contributor@xhigh").ok, true);
  // The direct DeepSeek API route is a different deployment to the measured
  // Ollama one and is not caught by the lock.
  assert.equal(routing.check("worker", "deepseek:deepseek-flash@low").ok, true);
  assert.equal(routing.check("coding", "ollama:deepseek-v4.1-flash@low").ok, false);
  assert.equal(routing.check("coding", "openai:deepseek-v4.1-flash@low").ok, false);
});

test("the release train: weekly, soaked a day, hotfix only with a reason", () => {
  const day = 86400000, now = 100 * day;
  assert.equal(train.decide({ now, committedAt: now - 2 * day }).allowed, true, "first train");
  assert.equal(train.decide({ now, committedAt: now - 3600000 }).allowed, false, "unsoaked");
  const log = [{ at: now - 2 * day, kind: "train" }, { at: now - 3600000, kind: "hotfix" }];
  assert.equal(train.decide({ log, now, committedAt: now - 2 * day }).allowed, false, "train left two days ago");
  assert.equal(train.decide({ log: [{ at: now - 7 * day, kind: "train" }], now, committedAt: now - 2 * day }).allowed, true);
  assert.equal(train.decide({ log, now, hotfix: "fix" }).allowed, false, "a hotfix needs a reason");
  const hot = train.decide({ log, now, hotfix: "players cannot open tickets at all" });
  assert.equal(hot.allowed, true); assert.equal(hot.kind, "hotfix");
});

// 5.1.1: ticket 1559's promotions asked three times because they carried #4153,
// whose merge was approved through a freeform "merge PR 4153?" DM that no
// exact approval recorded.
const { openDecision, createDecisions } = require("../lib/operator/decisions");
test("a freeform merge yes binds to the PR head the question named, and chains", () => {
  const OWNER = "333052320252297216";
  const data = { jobs: { j1: { id: "j1", state: "blocked", kind: "finding" } }, actions: {}, outbox: {}, audit: [], decisions: {} };
  const l = { data, save() {}, audit(kind, x) { data.audit.push({ kind, ...x }); }, notify(key, dest, content, extra = {}) { data.outbox[key] ||= { destination: dest, content, ...extra }; } };
  const config = { ownerId: OWNER, staffIds: ["565289871799746593"], botId: "1479984768194969663" };
  const x = openDecision(l, config, { jobId: "j1", question: "All checks on PR #4153 pass; merging is your call.", binds: { number: 4153, head: "aaa111" } });
  x.sent[OWNER] = { channelId: "dm", messageId: "900000000000000001" };
  const decisions = createDecisions({ ledger: l, config, discord: async () => null, now: () => 5000 });
  decisions.apply(x, "approve", OWNER);
  const a = data.actions[x.actionId];
  assert.deepEqual(a.args, { action: "merge", number: 4153, head: "aaa111" });
  assert.equal(a.approvedBy, OWNER);
  const approvals = chain.approvedMerges(data.actions, OWNER, 6000);
  assert.equal(chain.cover({ approvals, entries: [{ sha: "c", prs: [{ number: 4153, head: "aaa111", huge: true }] }] }).covered, true);
  assert.equal(chain.cover({ approvals, entries: [{ sha: "c", prs: [{ number: 4153, head: "bbb222", huge: true }] }] }).covered, false, "a later head asks again");
  // A rejection binds nothing.
  const y = openDecision(l, config, { jobId: "j1", question: "PR #4154?", binds: { number: 4154, head: "ccc" } });
  y.sent[OWNER] = { channelId: "dm", messageId: "900000000000000002" };
  decisions.apply(y, "reject", OWNER);
  assert.equal(y.actionId, null);
});

test("a blocked task asking about its own PR opens a decision bound to that head", async () => {
  const f = brokerFixture([[/pulls\/4153$/, { number: 4153, state: "open", head: { sha: "aaa111bbb222" } }]]);
  const job = f.l.createJob("finding:mnm", { kind: "finding", role: "support", repository: "AHDGame", finding: "x", deadline: 9e15, source: {}, pullRequests: ["https://github.com/lakesidegamedev/AHDGame/pull/4153"] }); job.state = "running";
  await f.b.tool(job, "finish", { state: "blocked", needsOwner: true, summary: "All 24 checks on PR #4153 pass. I haven't merged it because it's turn-engine code, so merging is your call." });
  const x = Object.values(f.l.data.decisions)[0];
  assert.deepEqual(x.binds, { number: 4153, head: "aaa111bbb222" });
  assert.match(x.question, /Approving covers PR 4153 at aaa111bbb2/);
});

test("the issue sweep follows merged PRs from any author that reference a Keir issue", async () => {
  const f = brokerFixture([[/issues\/4151\/timeline/, [{ event: "cross-referenced", source: { issue: { number: 4153, pull_request: { merged_at: "2026-10-14T23:00:00Z" }, repository: { full_name: "lakesidegamedev/AHDGame" } } } },
    { event: "cross-referenced", source: { issue: { number: 4999, pull_request: { merged_at: null } } } }]], [/pulls\/4153$/, { number: 4153, merged: false, head: { ref: "fix/x", sha: "s" }, base: { ref: "development" } }]]);
  f.l.data.keirIssues = { 4151: { number: 4151, state: "open", at: 1 } };
  await f.b.issueSweep();
  assert.ok(f.calls.some((a) => a.some((v) => /pulls\/4153$/.test(v))), "the referencing PR was checked");
  assert.ok(!f.calls.some((a) => a.some((v) => /pulls\/4999/.test(v))), "unmerged references are not");
});
