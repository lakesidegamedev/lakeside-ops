"use strict";
// Keir 8.5: coding workers for bug and display fixes. Dispatch decisions, exact-green gate, promote freeze,
// resume from the ledger, kill switch, escalation paths.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCodingWorkers, decideDispatch, admit, exactGreen, isGreenLine, MIN_MEM_KB } = require("../lib/operator/codingworkers");
const trustLimits = require("../lib/operator/limits");

const REPO = "lakesidegamedev/AHDGame";
const GOOD_HOST = { memAvailableKb: 40 * 1048576, load1: 2, cpus: 18 };
const HEAD = "a".repeat(40), MERGED = "b".repeat(40), MAIN = "c".repeat(40), OLD = "d".repeat(40);
const run = (name, conclusion, id = 1, status = "completed") => ({ name, conclusion, status, id });
const greenRuns = [run("verify", "success", 1), run("dependency-review", "success", 2), run("custom-rules", "success", 3)];

// A small fake GitHub, systemd and ledger.
function world(over = {}) {
  const w = {
    now: 1_000_000, calls: [], launches: [], units: {}, files: {}, reports: {}, logs: {},
    prs: { 7: { number: 7, state: "open", merged: false, base: { ref: "development" }, head: { sha: HEAD }, body: "Change-class: bugfix", title: "fix(ui): show option", mergeable: true } },
    checks: { [HEAD]: greenRuns }, prFiles: ["src/components/Panel.tsx", "src/components/Panel.test.tsx"],
    promote: { staging: [], main: [] }, promoteChecks: {}, containedIn: { staging: false, main: false }, deployed: { web: MAIN, worker: MAIN },
    branchPr: [{ number: 7 }], kill: { engaged: false }, host: GOOD_HOST, ...over,
  };
  return w;
}
function build(w, { jobs = {}, data = null } = {}) {
  const ledgerData = data || { jobs, seen: {}, audit: [], outbox: {}, trust: {} };
  const ledger = { data: ledgerData, save() {}, audit: (k, d) => ledgerData.audit.push({ kind: k, ...d }), notify: (key, dest, content) => { ledgerData.outbox[key] = { dest, content }; } };
  const route = (args) => {
    const write = args[0] === "-X";
    const method = write ? args[1] : "GET", r = write ? args[2] : args[0];
    w.calls.push({ method, route: r, args });
    if (method === "PUT" && /pulls\/(\d+)\/merge$/.test(r)) {
      const n = Number(/pulls\/(\d+)\/merge/.exec(r)[1]);
      const m = /merge_method=(\w+)/.exec(args.join(" "))[1];
      w.merges = [...(w.merges || []), { n, method: m }];
      if (n === 7) { w.prs[7].merged = true; w.prs[7].merge_commit_sha = MERGED; w.prs[7].state = "closed"; return { sha: MERGED }; }
      const hop = w.promote.staging.find((p) => p.number === n) ? "staging" : "main";
      w.containedIn[hop] = true;
      return { sha: hop === "main" ? MAIN : "e".repeat(40) };
    }
    if (method === "POST" && r.endsWith("/pulls")) {
      const base = args.find((a) => a.startsWith("base=")).slice(5);
      const p = { number: base === "staging" ? 20 : 30, base: { ref: base }, head: { sha: `${base}-head` }, mergeable: true };
      w.promote[base].push(p); w.checks[p.head.sha] = w.promoteChecks[base] || greenRuns; w.prs[p.number] = p; return p;
    }
    if (r.startsWith(`repos/${REPO}/pulls?state=all&head=`)) return w.branchPr;
    let m;
    if ((m = /pulls\?state=open&base=(\w+)&head=/.exec(r))) return w.promote[m[1]].map((p) => ({ number: p.number }));
    if ((m = /pulls\/(\d+)\/files/.exec(r))) return w.prFiles.map((filename) => ({ filename }));
    if ((m = /pulls\/(\d+)$/.exec(r))) return w.prs[Number(m[1])];
    if ((m = /commits\/([\w-]+)\/check-runs/.exec(r))) return { check_runs: w.checks[m[1]] || [] };
    if (r.endsWith("/commits/main")) return { sha: MAIN };
    if ((m = /compare\/([\w.]+)\.\.\.([\w.]+)$/.exec(r))) {
      const [, base, head] = m;
      if (base === "staging" && head === "development") return { ahead_by: w.containedIn.staging ? 0 : 3, merge_base_commit: { sha: "f".repeat(40) } };
      if (base === "main" && head === "staging") return { ahead_by: w.containedIn.main ? 0 : 3, merge_base_commit: { sha: "9".repeat(40) } };
      if (head === MERGED && (base === "staging" || base === "main")) return { status: w.containedIn[base] ? "behind" : "ahead" };
      if (head === MAIN) return { status: base === OLD ? "ahead" : "behind" };
      return { status: "ahead" };
    }
    throw new Error(`unrouted ${method} ${r}`);
  };
  const api = async (args) => route(args);
  const exec = async (cmd, args) => {
    if (cmd === "systemd-run") { w.launches.push(args); const unit = /--unit=(\S+)/.exec(args[0])[1]; w.units[unit] = "active"; return { code: 0, out: "", err: "" }; }
    if (cmd === "systemctl") return { code: 0, out: w.units[/^(.*)\.service$/.exec(args[1])[1]] || "inactive", err: "" };
    throw new Error(cmd);
  };
  const killSwitch = { state: () => w.kill, assertClear(what) { if (w.kill.engaged) throw Object.assign(new Error(`kill switch: ${what}`), { code: "KILL_SWITCH" }); } };
  const mcpCalls = [];
  const mcp = { call: async (server, tool, input) => { mcpCalls.push({ tool, input }); return { detail: "The impeach panel hides the party option for a chair." }; } };
  const cw = createCodingWorkers({ ledger, api, write: api, mcp, killSwitch, exec, host: () => w.host, now: () => w.now, stateDir: "/tmp/keir-cw-test",
    readFile: (f) => { if (f in w.reports) return w.reports[f]; if (f in w.logs) return w.logs[f]; if (f.endsWith("skip-tickets")) throw new Error("none"); throw new Error("ENOENT"); },
    mkdir() {}, probe: async (s) => w.deployed[s] });
  return { cw, ledger, ledgerData, mcpCalls, api, exec, killSwitch, mcp };
}
const ticketJob = (extra = {}) => ({ id: "job1", kind: "ticket", ticket: 1783, state: "waiting", wakeAt: 9e15, raisedToDevelopers: [], ...extra });
const dispatchOne = (cw, job, over = {}) => cw.dispatch({ job, cardId: 255107, title: "Party chair sees no party option", detail: "The option is hidden for a qualifying chair.", issue: 5627, changeClass: "bugfix", kind: "bug", ...over });
const unitOf = (r) => r.unit;
const finish = (w, r, report = true) => { w.units[unitOf(r)] = "inactive"; if (report) w.reports[r.report] = "report"; };

test("dispatch decision: only a bug classed bugfix or display; rule, balance, economy and unclassed never", () => {
  assert.equal(decideDispatch({ kind: "bug", changeClass: "bugfix" }).ok, true);
  assert.equal(decideDispatch({ kind: "bug", changeClass: "display" }).ok, true);
  assert.equal(decideDispatch({ kind: "bug", changeClass: "bug_fix" }).changeClass, "bugfix");
  for (const changeClass of ["rule", "balance", "economy-behaviour", "data-heal", undefined]) assert.equal(decideDispatch({ kind: "bug", changeClass }).ok, false, String(changeClass));
  assert.equal(decideDispatch({ kind: "enhancement", changeClass: "bugfix" }).ok, false);
  assert.equal(decideDispatch({ kind: "question", changeClass: "bugfix" }).ok, false);
  assert.equal(decideDispatch({ kind: "bug", changeClass: "bugfix", requiresOwner: true }).ok, false);
});

test("host admission: memory under 16 GiB or load above 70 percent of the cpus refuses", () => {
  assert.equal(admit(GOOD_HOST).ok, true);
  assert.equal(admit({ ...GOOD_HOST, memAvailableKb: MIN_MEM_KB - 1 }).ok, false);
  assert.equal(admit({ ...GOOD_HOST, memAvailableKb: MIN_MEM_KB }).ok, true);
  assert.equal(admit({ ...GOOD_HOST, load1: 12.7 }).ok, false);
  assert.equal(admit({ ...GOOD_HOST, load1: 12.5 }).ok, true);
  assert.equal(admit({ memAvailableKb: NaN, load1: 1, cpus: 18 }).ok, false);
});

test("exact green: only completed success on all three required checks; REQUIRED_FAILED never counts as green", () => {
  assert.equal(exactGreen(greenRuns).verdict, "REQUIRED_GREEN");
  assert.equal(exactGreen([run("verify", "failure"), run("dependency-review", "success", 2), run("custom-rules", "success", 3)]).verdict, "REQUIRED_FAILED");
  assert.equal(exactGreen([run("verify", "success"), run("dependency-review", "success", 2)]).verdict, "REQUIRED_PENDING");
  assert.equal(exactGreen([run("verify", null, 1, "in_progress"), run("dependency-review", "success", 2), run("custom-rules", "success", 3)]).verdict, "REQUIRED_PENDING");
  for (const bad of ["neutral", "skipped", "cancelled", "timed_out", "action_required"]) assert.equal(exactGreen([run("verify", bad), run("dependency-review", "success", 2), run("custom-rules", "success", 3)]).green, false, bad);
  // A newer success supersedes an older cancelled run of the same check; the reverse does not.
  assert.equal(exactGreen([run("verify", "cancelled", 1), run("verify", "success", 4), ...greenRuns.slice(1)]).green, true);
  assert.equal(exactGreen([run("verify", "success", 1), run("verify", "cancelled", 4), ...greenRuns.slice(1)]).green, false);
  assert.equal(exactGreen([...greenRuns, run("CodeQL", "failure", 9)]).green, true, "only the required names count");
  assert.equal(isGreenLine("REQUIRED_GREEN"), true);
  for (const line of ["REQUIRED_FAILED", "REQUIRED_PENDING", "REQUIRED_GREEN_NOT", "REQUIRED_FAILED verify", "", undefined]) assert.equal(isGreenLine(line), false, String(line));
});

test("dispatch launches a detached systemd unit with the proven recipe, and records it durably", async () => {
  const w = world(), s = build(w), job = ticketJob();
  s.ledgerData.jobs.job1 = job;
  const out = await dispatchOne(s.cw, job);
  assert.equal(out.skipped, false);
  const r = out.run;
  assert.equal(r.state, "running");
  const args = w.launches[0].join(" ");
  assert.match(args, /--unit=keir-worker-1783-/); assert.match(args, /--collect/); assert.match(args, /RuntimeMaxSec=7200/); assert.match(args, /MemoryMax=8G/);
  assert.match(args, /IS_SANDBOX=1/); assert.match(args, /--model claude-sonnet-5-5|claude-sonnet-5-5/); assert.match(args, /--dangerously-skip-permissions/);
  const brief = w.launches[0].find((a) => a.includes("headless Sonnet worker"));
  assert.match(brief, /Change-class: <bugfix\|display>/); assert.match(brief, /engine, frontend, fullstack, backend/); assert.match(brief, /FOREGROUND/);
  assert.match(brief, /\/root\/projects\/AHDGame\/worktrees\/keir-/); assert.match(brief, /Fixes #5627/);
  assert.doesNotMatch(r.branch + r.worktree, /1783/, "ticket numbers stay out of public branch names");
  assert.doesNotMatch(brief, /[–—]/);
  assert.equal(s.ledgerData.codingWorkers.runs[r.id].unit, r.unit);
  assert.ok(s.ledgerData.trust.counters.worker.length === 1, "counts against the daily launch cap");
  assert.ok(s.mcpCalls.some((c) => c.tool === "work_report" && c.input.id === 255107 && /coding worker/.test(c.input.summary)), "the card gets the worker id as a receipt");
});

test("one worker per ticket, two at once, daily launch cap, and admission", async () => {
  const w = world(), s = build(w);
  const mk = (n) => { const j = ticketJob({ id: `j${n}`, ticket: n }); s.ledgerData.jobs[j.id] = j; return j; };
  const a = await dispatchOne(s.cw, mk(1)), dup = await dispatchOne(s.cw, s.ledgerData.jobs.j1, { cardId: 999 });
  assert.equal(dup.skipped, true); assert.match(dup.reason, /already has run/);
  const b = await dispatchOne(s.cw, mk(2)), c = await dispatchOne(s.cw, mk(3));
  assert.equal(a.run.state, "running"); assert.equal(b.run.state, "running");
  assert.equal(c.run.state, "queued", "third waits for a slot"); assert.match(c.run.waiting, /two workers/);
  assert.equal(w.launches.length, 2);
  // a slot frees, the queued run launches on the next tick
  finish(w, a.run, false); w.reports[a.run.report] = "r"; w.branchPr = [{ number: 7 }];
  w.prs[7].merged = false;
  await s.cw.tick();
  assert.equal(c.run.state, "running");
  // admission refuses a launch on a busy host
  const w2 = world({ host: { ...GOOD_HOST, load1: 15 } }), s2 = build(w2); const j = ticketJob(); s2.ledgerData.jobs.job1 = j;
  const d2 = await dispatchOne(s2.cw, j);
  assert.equal(d2.run.state, "queued"); assert.match(d2.run.waiting, /load/); assert.equal(w2.launches.length, 0);
  w2.host = GOOD_HOST; await s2.cw.tick(); assert.equal(d2.run.state, "running");
  // daily cap of 6
  const w3 = world(), s3 = build(w3);
  const limits = { get: () => ({ ...trustLimits.DEFAULTS, workerLaunchesPerDay: 1 }) };
  const cw3 = createCodingWorkers({ ledger: s3.ledger, api: s3.api, write: s3.api, mcp: s3.mcp, killSwitch: s3.killSwitch, limits, exec: s3.exec, host: () => w3.host, now: () => w3.now, mkdir() {}, readFile() { throw new Error("x"); } });
  const j1 = ticketJob({ id: "k1", ticket: 11 }), j2 = ticketJob({ id: "k2", ticket: 12 });
  s3.ledgerData.jobs.k1 = j1; s3.ledgerData.jobs.k2 = j2;
  assert.equal((await dispatchOne(cw3, j1)).run.state, "running");
  const capped = await dispatchOne(cw3, j2);
  assert.equal(capped.run.state, "queued"); assert.match(capped.run.waiting, /coding worker launches/);
  assert.equal(trustLimits.DEFAULTS.workerLaunchesPerDay, 6);
});

test("owner-gated or undeclared classes never start a worker", async () => {
  const w = world(), s = build(w), job = ticketJob(); s.ledgerData.jobs.job1 = job;
  for (const changeClass of ["rule", "balance", "economy-behaviour"]) {
    const out = await dispatchOne(s.cw, job, { changeClass }); assert.equal(out.skipped, true, changeClass);
  }
  assert.equal((await dispatchOne(s.cw, job, { kind: "decision" })).skipped, true);
  assert.equal(w.launches.length, 0);
});

test("full run: worker PR, exact green, squash merge, merge-commit promotions, deploy verified, then the ticket is told it is live", async () => {
  const w = world(), s = build(w), job = ticketJob(); s.ledgerData.jobs.job1 = job;
  const r = (await dispatchOne(s.cw, job)).run;
  await s.cw.tick(); assert.equal(r.state, "running", "worker still active");
  finish(w, r);
  await s.cw.tick(); assert.equal(r.state, "checks"); assert.equal(r.pr, 7);
  await s.cw.tick(); assert.equal(r.state, "merge_ready");
  await s.cw.tick(); assert.equal(r.state, "to_staging");
  assert.deepEqual(w.merges[0], { n: 7, method: "squash" });
  await s.cw.tick(); assert.equal(r.state, "to_main");
  await s.cw.tick(); assert.equal(r.state, "verifying");
  assert.deepEqual(w.merges.slice(1), [{ n: 20, method: "merge" }, { n: 30, method: "merge" }], "promotions are merge commits, staging before main");
  assert.equal(job.releaseEvidence, undefined, "not live yet: no evidence, no claim");
  w.deployed.worker = OLD; await s.cw.tick(); assert.equal(r.state, "verifying", "web on main but the worker still old");
  w.deployed.worker = MAIN; await s.cw.tick();
  assert.equal(r.state, "done");
  assert.ok(Object.values(job.releaseEvidence).some((e) => e.main && e.staging && e.development && e.source === "coding-workers"));
  assert.match(job.inbox.at(-1).content, /is live/); assert.equal(job.state, "queued");
  assert.ok(s.mcpCalls.some((c) => c.input.event === "completed" && /pull\/7/.test(c.input.evidence_url)));
  assert.ok((s.ledgerData.trust.counters.deploy || []).length === 1, "the promotion counts against the daily cap");
});

test("REQUIRED_FAILED never merges: one fix attempt with the failing output, then escalation", async () => {
  const w = world(), s = build(w), job = ticketJob(); s.ledgerData.jobs.job1 = job;
  w.checks[HEAD] = [{ ...run("verify", "failure", 1), output: { title: "tsc failed", summary: "src/x.ts(3,1): error TS2322" } }, run("dependency-review", "success", 2), run("custom-rules", "success", 3)];
  const r = (await dispatchOne(s.cw, job)).run; finish(w, r);
  await s.cw.tick(); await s.cw.tick();
  assert.equal(r.state, "queued"); assert.equal(r.mode, "fix"); assert.match(r.fixNote, /TS2322/);
  await s.cw.tick(); assert.equal(r.state, "running");
  assert.match(w.launches[1].find((a) => a.includes("headless Sonnet worker")), /TS2322/);
  assert.match(w.launches[1].find((a) => a.includes("headless Sonnet worker")), /Existing PR #7/);
  finish(w, r, false); await s.cw.tick(); assert.equal(r.state, "checks");
  await s.cw.tick(); assert.equal(r.state, "escalated"); assert.match(r.reason, /failed again/);
  assert.equal((w.merges || []).length, 0, "nothing was ever merged");
  assert.ok(Object.values(s.ledgerData.outbox).some((o) => /needs a person/.test(o.content)));
});

test("pending or missing required checks wait and never merge; stuck past three hours escalates", async () => {
  const w = world(), s = build(w), job = ticketJob(); s.ledgerData.jobs.job1 = job;
  w.checks[HEAD] = [run("verify", "success", 1), run("dependency-review", null, 2, "in_progress")];
  const r = (await dispatchOne(s.cw, job)).run; finish(w, r);
  await s.cw.tick(); await s.cw.tick(); await s.cw.tick();
  assert.equal(r.state, "checks"); assert.equal((w.merges || []).length, 0);
  w.now += 3 * 3600000 + 1; await s.cw.tick();
  assert.equal(r.state, "escalated"); assert.match(r.reason, /3 hours/);
});

test("promote freeze: no feature merge while a development to staging PR is open; merges when it lands", async () => {
  const w = world(), s = build(w), job = ticketJob(); s.ledgerData.jobs.job1 = job;
  w.promote.staging.push({ number: 20, base: { ref: "staging" }, head: { sha: "x" } });
  const r = (await dispatchOne(s.cw, job)).run; finish(w, r);
  await s.cw.tick(); await s.cw.tick(); assert.equal(r.state, "merge_ready");
  await s.cw.tick(); await s.cw.tick();
  assert.equal(r.state, "merge_ready"); assert.equal((w.merges || []).length, 0); assert.ok(r.history.some((h) => /freeze/.test(h.text)));
  w.promote.staging.length = 0;
  await s.cw.tick(); assert.equal(r.state, "to_staging"); assert.deepEqual(w.merges[0], { n: 7, method: "squash" });
});

test("a red promote PR does not merge and escalates; an open promote PR is reused", async () => {
  const w = world(), s = build(w), job = ticketJob(); s.ledgerData.jobs.job1 = job;
  const r = (await dispatchOne(s.cw, job)).run; finish(w, r);
  for (let i = 0; i < 3; i++) await s.cw.tick();
  assert.equal(r.state, "to_staging");
  w.promote.staging.push({ number: 99, base: { ref: "staging" }, head: { sha: "pre" }, mergeable: true }); w.prs[99] = w.promote.staging[0]; w.checks.pre = [run("verify", "failure", 1), run("dependency-review", "success", 2), run("custom-rules", "success", 3)];
  await s.cw.tick();
  assert.equal(r.state, "escalated"); assert.equal(r.hopPr, 99, "reused the open promote PR");
  assert.ok(!w.calls.some((c) => c.method === "POST"), "no second promote PR was opened");
  assert.equal(w.merges.length, 1, "only the feature squash merge happened");
});

test("economy paths or a gated class on the worker PR go to the owner instead of auto-merge", async () => {
  for (const [files, body] of [[["src/lib/market/pricing.ts"], "Change-class: bugfix"], [["src/components/A.tsx"], "Change-class: balance"]]) {
    const w = world({ prFiles: files }); w.prs[7].body = body;
    const s = build(w), job = ticketJob(); s.ledgerData.jobs.job1 = job;
    const r = (await dispatchOne(s.cw, job)).run; finish(w, r);
    await s.cw.tick(); await s.cw.tick();
    assert.equal(r.state, "needs_owner", files[0]); assert.equal((w.merges || []).length, 0);
    assert.match(job.inbox.at(-1).content, /Do not tell the player/);
  }
  const w = world({ prFiles: ["src/lib/foo.ts"] }); w.prs[7].title = "fix: rebalance the thing";
  const s = build(w), job = ticketJob(); s.ledgerData.jobs.job1 = job;
  const r = (await dispatchOne(s.cw, job)).run; finish(w, r); await s.cw.tick(); await s.cw.tick();
  assert.equal(r.state, "needs_owner", "a bugfix declaration on a rebalance title is gated");
});

test("a worker that exits without a PR or report gets one retry with its log tail, then escalates", async () => {
  const w = world({ branchPr: [] }), s = build(w), job = ticketJob(); s.ledgerData.jobs.job1 = job;
  const r = (await dispatchOne(s.cw, job)).run;
  w.logs[r.log] = "boom: could not create worktree";
  finish(w, r, false);
  await s.cw.tick(); assert.equal(r.state, "queued"); assert.equal(r.attempt, 2); assert.match(r.retryNote, /could not create worktree/);
  await s.cw.tick(); assert.equal(r.state, "running");
  assert.match(w.launches[1].find((a) => a.includes("headless Sonnet worker")), /could not create worktree/);
  finish(w, r, false);
  await s.cw.tick(); assert.equal(r.state, "escalated"); assert.match(r.reason, /twice/);
  // a report without a PR is an owner question, not a retry
  const w2 = world({ branchPr: [] }), s2 = build(w2), j2 = ticketJob(); s2.ledgerData.jobs.job1 = j2;
  const r2 = (await dispatchOne(s2.cw, j2)).run; finish(w2, r2, true);
  await s2.cw.tick(); assert.equal(r2.state, "escalated"); assert.equal(r2.attempt, 1);
});

test("resume after a restart: a fresh module on the persisted ledger carries the run to live", async () => {
  const w = world(), s = build(w), job = ticketJob(); s.ledgerData.jobs.job1 = job;
  const r = (await dispatchOne(s.cw, job)).run; finish(w, r);
  await s.cw.tick(); await s.cw.tick();
  assert.equal(r.state, "merge_ready");
  const reloaded = JSON.parse(JSON.stringify(s.ledgerData));
  const s2 = build(w, { data: reloaded });
  const r2 = reloaded.codingWorkers.runs[r.id];
  for (let i = 0; i < 3; i++) await s2.cw.tick();
  assert.equal(r2.state, "verifying");
  await s2.cw.tick(); assert.equal(r2.state, "done");
  assert.equal(w.launches.length, 1, "no second worker after the restart");
  // a restart while the worker is still running keeps waiting on the same unit
  const w3 = world(), s3 = build(w3), j3 = ticketJob(); s3.ledgerData.jobs.job1 = j3;
  const r3 = (await dispatchOne(s3.cw, j3)).run;
  const s4 = build(w3, { data: JSON.parse(JSON.stringify(s3.ledgerData)) });
  await s4.cw.tick(); assert.equal(s4.ledgerData.codingWorkers.runs[r3.id].state, "running"); assert.equal(w3.launches.length, 1);
});

test("kill switch: no launch, no merge, no promote; a running worker is left to finish", async () => {
  const w = world(), s = build(w), job = ticketJob(); s.ledgerData.jobs.job1 = job;
  w.kill = { engaged: true, reason: "owner" };
  const queued = (await dispatchOne(s.cw, job)).run;
  assert.equal(queued.state, "queued"); assert.equal(w.launches.length, 0);
  await s.cw.tick(); assert.equal(queued.state, "queued"); assert.equal(w.launches.length, 0);
  w.kill = { engaged: false }; await s.cw.tick(); assert.equal(queued.state, "running");
  finish(w, queued); await s.cw.tick(); await s.cw.tick();
  assert.equal(queued.state, "merge_ready");
  w.kill = { engaged: true, reason: "owner" };
  await s.cw.tick(); await s.cw.tick();
  assert.equal(queued.state, "merge_ready"); assert.equal((w.merges || []).length, 0, "nothing merged while engaged");
  w.kill = { engaged: false }; await s.cw.tick(); assert.equal(queued.state, "to_staging");
  w.kill = { engaged: true, reason: "owner" }; await s.cw.tick(); await s.cw.tick();
  assert.equal(queued.state, "to_staging"); assert.equal(w.merges.length, 1, "no promotion while engaged");
});

test("deploy not reached within 60 minutes escalates and never tells the player it is live", async () => {
  const w = world(), s = build(w), job = ticketJob(); s.ledgerData.jobs.job1 = job;
  const r = (await dispatchOne(s.cw, job)).run; finish(w, r);
  for (let i = 0; i < 5; i++) await s.cw.tick();
  assert.equal(r.state, "verifying");
  w.deployed.web = OLD; w.now += 61 * 60000; await s.cw.tick();
  assert.equal(r.state, "escalated"); assert.equal(job.releaseEvidence, undefined); assert.ok(!(job.inbox || []).some((m) => /is live/.test(m.content)));
});

test("adoption: an item raised before the release (ticket 1783 shape) gets a worker, unless skipped or already owned", async () => {
  const w = world(), s = build(w);
  const job = ticketJob({ raisedToDevelopers: [{ id: 255107, title: "Party chair sees no party legislator option when filing impeachment articles", at: 1, kind: "bug", blocking: false, changeClass: "bugfix", requiresOwner: false }] });
  s.ledgerData.jobs.job1 = job;
  await s.cw.tick();
  const runs = s.cw.runs(); assert.equal(runs.length, 1); assert.equal(runs[0].card, 255107); assert.equal(runs[0].state, "running");
  assert.match(w.launches[0].find((a) => a.includes("headless Sonnet worker")), /impeach panel hides the party option/, "the card detail goes into the brief");
  await s.cw.tick(); assert.equal(s.cw.runs().length, 1, "adopted once");
  // owner-gated items and a skip list are respected
  const w2 = world(), s2 = build(w2);
  s2.ledgerData.jobs.a = ticketJob({ id: "a", ticket: 5, raisedToDevelopers: [{ id: 1, title: "x", at: 1, kind: "bug", changeClass: "rule", requiresOwner: true }] });
  s2.ledgerData.jobs.b = ticketJob({ id: "b", ticket: 6, raisedToDevelopers: [{ id: 2, title: "y", at: 1, kind: "question", changeClass: "bugfix" }] });
  await s2.cw.tick(); assert.equal(s2.cw.runs().length, 0);
  const w3 = world(), s3 = build(w3);
  const cwSkip = createCodingWorkers({ ledger: s3.ledger, api: s3.api, write: s3.api, mcp: s3.mcp, killSwitch: s3.killSwitch, exec: s3.exec, host: () => w3.host, now: () => w3.now, mkdir() {}, readFile: (f) => { if (f.endsWith("skip-tickets")) return "1783\n"; throw new Error("x"); } });
  s3.ledgerData.jobs.job1 = ticketJob({ raisedToDevelopers: [{ id: 3, title: "z", at: 1, kind: "bug", changeClass: "bugfix" }] });
  await cwSkip.tick(); assert.equal(cwSkip.runs().length, 0); assert.equal(w3.launches.length, 0);
});

test("switched off: nothing dispatches or ticks", async () => {
  const w = world(), s = build(w), job = ticketJob(); s.ledgerData.jobs.job1 = job;
  const off = createCodingWorkers({ ledger: s.ledger, api: s.api, write: s.api, exec: s.exec, enabled: false, host: () => w.host });
  assert.equal((await dispatchOne(off, job)).skipped, true); await off.tick(); assert.equal(w.launches.length, 0);
});

// ---- broker wiring ----
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
function brokerFixture(t, codingWorkers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir85-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: [], botId: "333333333333333333", guildId: "4", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const mcp = { servers: () => ["support", "ops-knowledge"], list: async () => [], call: async (s, tool) => (tool === "support_get" ? { number: 9, reporter: { characterName: "Fixture" } } : tool === "kanban_list" ? { items: [] } : tool === "kanban_add" ? { id: 77 } : { ok: true }) };
  const exec = async (cmd, args) => {
    const a = args.slice(1), route = a[0] === "-X" ? a[2] : a[0];
    if (route.startsWith("search/issues")) return JSON.stringify({ items: [] });
    if (route === "repos/lakesidegamedev/AHDGame/issues") return JSON.stringify({ number: 501, html_url: "https://github.com/lakesidegamedev/AHDGame/issues/501" });
    return JSON.stringify({ ok: true });
  };
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox: {}, now: () => 5000, exec, codingWorkers: () => codingWorkers });
  const job = ledger.createJob("t", { kind: "ticket", role: "support", ticket: 9, repository: "AHDGame", source: { author: "fixtureuser" }, deadline: 9e15 }); job.state = "running";
  return { broker, job, ledger };
}
const issue = { summary: "After a sector retool, the factory output panel shows zero output for the next turn although production continued.", steps: ["Own a corporation with a factory", "Retool its sector", "Open the output panel on the next turn"], expected: "The panel shows the turn's real output.", actual: "The panel shows 0 until the turn after.", where: ["src/components/corporations/OutputPanel.tsx", "corporation page, Output tab"], impact: "Every player who retools sees a false zero for one turn; no money is lost.", areas: ["ui"] };
const detailText = "Output panel reads last turn's cached zero after retool; see OutputPanel.tsx and the retool command.";

test("raise_to_developers kind bug with a shippable class dispatches a worker and keeps the card as the receipt", async (t) => {
  const seen = [];
  const f = brokerFixture(t, { dispatch: async (x) => { seen.push(x); return { skipped: false, run: { id: "cw-9-1" } }; } });
  const r = await f.broker.tool(f.job, "raise_to_developers", { title: "Factory output panel shows zero after a retool", detail: detailText, kind: "bug", issue, changeClass: "display" });
  assert.equal(r.raised, true); assert.equal(r.id, 77); assert.equal(r.codingWorker, "cw-9-1");
  assert.match(r.instruction, /not that it is live/);
  assert.equal(seen[0].cardId, 77); assert.equal(seen[0].issue, 501); assert.equal(seen[0].changeClass, "display");
  const rec = f.job.raisedToDevelopers[0]; assert.equal(rec.workerRun, "cw-9-1"); assert.equal(rec.issue, 501);
});

test("raise_to_developers with a gated class or a worker that skips falls back to the plain developer handoff", async (t) => {
  const seen = [];
  const f = brokerFixture(t, { dispatch: async (x) => { seen.push(x); return { skipped: true, reason: "gated" }; } });
  const r = await f.broker.tool(f.job, "raise_to_developers", { title: "Factory output panel shows zero after a retool", detail: detailText, kind: "bug", issue, changeClass: "rule" });
  assert.equal(r.raised, true); assert.equal(r.codingWorker, undefined);
  const f2 = brokerFixture(t, null);
  const r2 = await f2.broker.tool(f2.job, "raise_to_developers", { title: "Factory output panel shows zero after a retool", detail: detailText, kind: "bug", issue });
  assert.equal(r2.raised, true); assert.equal(r2.codingWorker, undefined);
});
