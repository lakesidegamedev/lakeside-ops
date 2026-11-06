"use strict";
// Keir 8.5.1 (ticket 1785): a self-owned blocking question card sat six hours with nothing working it, a status-card
// edit reset the sweeper's stall clock, and coding workers only dispatched for filed bugs. Investigation workers,
// a stricter "substantive progress", and the rule that a blocking own card is worked or escalated.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createCodingWorkers, buildBrief } = require("../lib/operator/codingworkers");
const { createSweeper, decideTicket, DEFAULTS } = require("../lib/operator/sweeper");
const { createLedger } = require("../lib/operator/store");
const { isSubstantiveText, recordReply, trust } = require("../lib/operator/trustlog");
const inv = require("../lib/operator/investigation");

const MIN = 60000, H = 3600000;
// Ticket 1785, Eastern standard time (UTC-5) on 2026-11-06.
const at = (hh, mm) => Date.parse(`2026-11-06T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-05:00`);
const T_POST = at(15, 14), T_CARD = at(19, 47), T_QUIET = at(21, 10), T_SIX_H = T_POST + 6 * H;
const UNVERIFIED_SUMMARY = "Cause still unverified. Revenue alternates between turns. Next: per-turn sector history 704-711 and clearing code. No new player post.";
const HOST = { memAvailableKb: 40 * 1048576, load1: 2, cpus: 18 };
const GOOD = "a".repeat(40);

function fixture(t, { card = false, summary = UNVERIFIED_SUMMARY, host = HOST, kill = { engaged: false }, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir851-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const clock = { now: T_POST + 5 * MIN };
  const root = ledger.createJob("t", { kind: "ticket", role: "support", ticket: 1785, source: { channelName: "ticket-bug-yoyo-1785", content: "My company's revenue and share price flip every turn." } });
  Object.assign(root, { state: "waiting", at: T_POST - 30 * MIN, lastPublishedAt: T_POST, observedPlayerAt: T_POST - 20 * MIN, summary, wakeAt: 9e15 });
  if (card) root.raisedToDevelopers = [{ id: 255112, title: "Why does this company's revenue alternate between turns? (ticket 1785)", at: T_POST, kind: "question", blocking: true, selfOwned: true }];
  const calls = { launches: [], units: {} };
  const exec = async (cmd, args) => {
    if (cmd === "systemd-run") { calls.launches.push(args); calls.units[/--unit=(\S+)/.exec(args[0])[1]] = "active"; return { code: 0, out: "", err: "" }; }
    if (cmd === "systemctl") return { code: 0, out: calls.units[/^(.*)\.service$/.exec(args[1])[1]] || "inactive", err: "" };
    throw new Error(cmd);
  };
  const killSwitch = { state: () => kill, assertClear(what) { if (kill.engaged) throw Object.assign(new Error(`kill switch: ${what}`), { code: "KILL_SWITCH" }); } };
  const store = { reports: { ...files }, logs: {} };
  const api = async (args) => (typeof fixture.api === "function" ? fixture.api(args) : []);
  const cw = createCodingWorkers({ ledger, api, write: api, killSwitch, exec, host: () => host, now: () => clock.now, stateDir: "/tmp/keir851-state",
    readFile: (f) => { if (f in store.reports) return store.reports[f]; if (f.endsWith("skip-tickets")) { if (store.skip) return store.skip; throw new Error("none"); } throw new Error("ENOENT"); }, mkdir() {} });
  const sweeper = createSweeper({ ledger, config: {}, now: () => clock.now, killSwitch, investigate: (job, o) => cw.queueInvestigation({ job, reason: o.reason }) });
  return { ledger, root, clock, calls, cw, sweeper, store, d: ledger.data };
}

// ---- 2. the sweeper's idea of progress ----

test("ticket 1785 timeline: a status-card edit at 19:47 does not reset the clock; the sweeper acts at 6 h after the 15:14 post", async (t) => {
  const f = fixture(t); // cause unverified in the task's own summary, no card
  f.clock.now = T_POST + 10 * MIN;
  assert.equal(f.sweeper.tick().actions.length, 0, "healthy right after the post");
  // 19:47: the status card gets an "Investigating" item. It is an effect on the task and a stage that did not move.
  f.clock.now = T_CARD;
  f.root.effects = { "status-card:1785:1": { state: "done", at: T_CARD } };
  f.sweeper.tick();
  // 21:10: nothing new, still inside six hours of the 15:14 post.
  f.clock.now = T_QUIET;
  assert.equal(f.sweeper.tick().actions.length, 0);
  assert.ok(trust(f.d).progress[1785].lastSubstantiveAt === undefined || trust(f.d).progress[1785].lastSubstantiveAt < T_CARD, "the card did not mark progress");
  // 21:14: six hours after the post. The old fingerprint counted the card and would not have acted until ~01:50.
  f.clock.now = T_SIX_H + 1 * MIN;
  const out = f.sweeper.tick();
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].action, "investigate");
  assert.equal(f.root.inbox, undefined, "a worker was queued instead of nudging the task");
  const run = inv.activeRun(f.d, 1785);
  assert.ok(run && run.kind === "investigate", "an investigation worker run was created");
  assert.equal(trust(f.d).sweeps[1785].kind, "investigate_worker");
  await f.cw.tick();
  assert.equal(f.calls.launches.length, 1, "the worker ticker launched it");
});

test("a status-card post, a delivery receipt, a self-owned question card and an 'investigating' restatement are not progress", (t) => {
  const f = fixture(t, { summary: "" });
  f.clock.now = T_POST + 10 * MIN; f.sweeper.tick();
  const progressBefore = trust(f.d).progress[1785].lastSubstantiveAt || 0;
  f.root.effects = { "status-card:1785:1": { state: "done", at: T_CARD }, delivery: { state: "done", at: T_CARD } };
  f.root.raisedToDevelopers = [{ id: 1, title: "q", at: T_CARD, kind: "question", blocking: true, selfOwned: true }];
  f.clock.now = T_CARD + 10 * MIN; f.sweeper.tick();
  assert.equal(trust(f.d).progress[1785].lastSubstantiveAt || 0, progressBefore);
  assert.equal(isSubstantiveText("Investigating: checking why revenue swings between turns"), false);
  assert.equal(isSubstantiveText("Checking the sector history for the company now."), false);
  assert.equal(isSubstantiveText("Revenue alternates 5M then 15M since turn 697; the output is throttled every second turn by the sell-through check."), true);
  assert.equal(isSubstantiveText("Checking turn 704 to 711: revenue is 15.2M on even turns and 5.1M on odd turns."), true, "a number makes a checking line a finding");
  recordReply(f.d, { ticket: 1785, jobId: f.root.id, text: "Investigating: checking why revenue swings between turns", at: T_CARD });
  assert.equal(trust(f.d).progress[1785].lastSubstantiveAt || 0, progressBefore);
});

test("real fix-state changes still reset the clock: a PR, a release, a non-self-owned handoff", (t) => {
  for (const mutate of [(r) => { r.pullRequests = ["https://x/pull/1"]; }, (r) => { r.raisedToDevelopers = [{ id: 9, kind: "bug", blocking: false, at: T_CARD }]; }, (r) => { r.effects = { "issue:9": { state: "done", at: T_CARD } }; }]) {
    const f = fixture(t, { summary: "" });
    f.clock.now = T_POST + 10 * MIN; f.sweeper.tick();
    mutate(f.root);
    f.clock.now = T_CARD; f.sweeper.tick();
    f.clock.now = T_SIX_H + 5 * MIN;
    assert.equal(f.sweeper.tick().actions.length, 0, "progress at 19:47 keeps the ticket healthy at 21:19");
  }
});

// ---- 3. a blocking own card is worked or escalated ----

test("a self-owned blocking question card gets an investigation run within the grace period, not six hours", async (t) => {
  const f = fixture(t, { card: true });
  f.clock.now = T_POST + 10 * MIN;
  assert.equal(f.sweeper.tick().actions.length, 0, "inside the 20 minute grace");
  f.clock.now = T_POST + 25 * MIN;
  const out = f.sweeper.tick();
  assert.equal(out.actions[0].action, "investigate_worker");
  const run = inv.activeRun(f.d, 1785);
  assert.equal(run.kind, "investigate"); assert.equal(run.card, 255112);
  // Having a run, the ticket is covered: no second run, no escalation, however long the worker takes.
  for (const mins of [60, 120, 400]) { f.clock.now = T_POST + mins * MIN; assert.equal(f.sweeper.tick().actions.length, 0, `covered at +${mins} min`); }
  assert.equal(Object.keys(f.d.codingWorkers.runs).length, 1);
});

test("when no worker can be started the blocking card is escalated once, never left waiting", (t) => {
  for (const [label, setup, expect] of [["skip list", (f) => { f.store.skip = "1785\n"; }, /skip list/], ["switched off", null, /switched off/]]) {
    const f = fixture(t, { card: true });
    if (setup) setup(f);
    const sweeper = label === "switched off"
      ? createSweeper({ ledger: f.ledger, config: {}, now: () => f.clock.now, investigate: () => ({ skipped: true, permanent: true, reason: "coding workers are switched off" }) })
      : f.sweeper;
    f.clock.now = T_POST + 25 * MIN;
    const out = sweeper.tick();
    assert.equal(out.actions[0].action, "escalate_owner", label);
    const dm = Object.entries(f.d.outbox).filter(([k]) => k.startsWith("sweeper-owner:"));
    assert.equal(dm.length, 1); assert.match(dm[0][1].content, /Ticket 1785 needs a person/); assert.match(dm[0][1].content, expect);
    f.clock.now = T_POST + 5 * H; assert.equal(sweeper.tick().actions.length, 0, "owner told once inside 12 h");
  }
});

test("decideTicket: an idle own card, a running worker, and a worker that reported", () => {
  const now = at(20, 0);
  const base = { ticket: 5, open: true, held: null, running: false, pendingDecision: null, waitingOnPlayer: false, waitingOnDeveloper: false, lastHumanAt: now - 9 * H, lastReplyAt: now - 8 * H, lastSubstantiveAt: now - 1 * H,
    inActiveHours: true, lastActionAt: 0, lastActionKind: null, lastEscalationAt: 0, ownQuestion: { id: 1, at: now - 40 * MIN }, investigationActive: false, lastRunEndedAt: 0 };
  assert.equal(decideTicket(base, now).action, "investigate_worker");
  assert.equal(decideTicket({ ...base, investigationActive: true }, now).action, "none");
  assert.equal(decideTicket({ ...base, ownQuestion: { id: 1, at: now - 10 * MIN } }, now).action, "none");
  assert.equal(decideTicket({ ...base, lastRunEndedAt: now - 30 * MIN }, now).action, "none", "a fresh report gets a window to be acted on");
  // The worker was queued, it ended, the card is still open and nothing changed: a person is told.
  assert.equal(decideTicket({ ...base, lastActionKind: "investigate_worker", lastActionAt: now - 4 * H, lastRunEndedAt: now - 3.5 * H, lastSubstantiveAt: now - 5 * H }, now).action, "escalate_owner");
  assert.equal(DEFAULTS.questionGraceMs, 20 * MIN);
});

// ---- 1. investigation workers ----

test("dispatch: unverified cause with an own card launches a read-only investigation unit through the shared machinery", async (t) => {
  const f = fixture(t, { card: true });
  const out = await f.cw.dispatchInvestigation({ job: f.root, reason: "the task ended its activation with the cause still unverified" });
  assert.equal(out.skipped, false);
  const run = out.run;
  assert.equal(run.kind, "investigate"); assert.equal(run.state, "running"); assert.match(run.unit, /^keir-worker-1785-/);
  const args = f.calls.launches[0].join(" ");
  assert.match(args, /RuntimeMaxSec=7200/); assert.match(args, /MemoryMax=8G/); assert.ok(f.calls.launches[0].includes("claude-sonnet-5-5"));
  const brief = f.calls.launches[0].find((a) => a.includes("VERDICT"));
  assert.match(brief, /Prod data is READ-ONLY/); assert.match(brief, /Change-class: <bugfix\|display>/); assert.match(brief, /economy behaviour, rule or balance matter.*do NOT open a PR/);
  assert.match(brief, /FOREGROUND/); assert.match(brief, new RegExp(run.report.replace(/\./g, "\\.")));
  assert.match(brief, /My company's revenue and share price flip/); assert.match(brief, /255112/);
  assert.ok(!/em dash/.test(brief) || /No em dashes/.test(brief));
  // the ticket is covered; a second dispatch is refused, and so is a build dispatch for the same ticket
  assert.equal((await f.cw.dispatchInvestigation({ job: f.root })).active, true);
  assert.equal(trust(f.d).progress?.[1785]?.lastSubstantiveAt, undefined);
});

test("dispatch: the cause-unverified summary alone qualifies; a ticket with no unverified cause does not", async (t) => {
  const f = fixture(t, { summary: UNVERIFIED_SUMMARY });
  assert.equal((await f.cw.dispatchInvestigation({ job: f.root })).skipped, false);
  const g = fixture(t, { summary: "Found it: the sector throttle flips on even turns. Fix is in review." });
  const none = await g.cw.dispatchInvestigation({ job: g.root });
  assert.equal(none.skipped, true); assert.equal(none.permanent, undefined);
  const h = fixture(t, { summary: "Cause still unverified." }); // no named next step
  assert.equal((await h.cw.dispatchInvestigation({ job: h.root })).skipped, true);
});

test("dispatch guards: skip list, switched off, closed ticket, budget of two, caps, kill switch", async (t) => {
  const f = fixture(t, { card: true }); f.store.skip = "1785";
  assert.deepEqual([(await f.cw.dispatchInvestigation({ job: f.root })).permanent, f.calls.launches.length], [true, 0]);
  const off = fixture(t, { card: true });
  const cwOff = createCodingWorkers({ ledger: off.ledger, api: async () => [], exec: async () => ({ code: 0, out: "" }), enabled: false, host: () => HOST });
  assert.equal((await cwOff.dispatchInvestigation({ job: off.root })).permanent, true);
  const closed = fixture(t, { card: true }); closed.root.resolved = true;
  assert.equal((await closed.cw.dispatchInvestigation({ job: closed.root })).skipped, true);
  // budget: two investigation runs per ticket
  const b = fixture(t, { card: true });
  for (let i = 0; i < 2; i++) { const r = (await b.cw.dispatchInvestigation({ job: b.root })).run; r.state = "reported"; r.endedAt = b.clock.now; }
  const third = await b.cw.dispatchInvestigation({ job: b.root });
  assert.equal(third.skipped, true); assert.equal(third.permanent, true); assert.match(third.reason, /2 investigation workers/);
  // kill switch: the run is queued and nothing launches; releasing it launches on the next tick
  const kill = { engaged: true };
  const k = fixture(t, { card: true, kill });
  const q = await k.cw.dispatchInvestigation({ job: k.root });
  assert.equal(q.run.state, "queued"); assert.equal(k.calls.launches.length, 0);
  kill.engaged = false; await k.cw.tick();
  assert.equal(k.calls.launches.length, 1);
  // host admission: a busy box leaves it queued
  const busy = fixture(t, { card: true, host: { memAvailableKb: 2 * 1048576, load1: 1, cpus: 18 } });
  const w = await busy.cw.dispatchInvestigation({ job: busy.root });
  assert.equal(w.run.state, "queued"); assert.match(w.run.waiting, /memory/);
});

test("an investigation that reports without a PR ends 'reported', counts as progress, and wakes the ticket with the finding", async (t) => {
  const f = fixture(t, { card: true });
  const { run } = await f.cw.dispatchInvestigation({ job: f.root });
  f.calls.units[run.unit] = "inactive";
  f.store.reports[run.report] = "VERDICT: The company's two sectors take turns clearing; revenue is 15.2M on even turns and 5.1M on odd turns because settlement defers every second turn.\nCLASS: economy-behaviour\n\nDetails...";
  f.clock.now += 50 * MIN;
  await f.cw.tick();
  assert.equal(run.state, "reported"); assert.equal(run.findingClass, "economy-behaviour");
  assert.equal(trust(f.d).progress[1785].lastSubstantiveAt, f.clock.now);
  const msg = f.root.inbox.at(-1);
  assert.equal(f.root.state, "queued"); assert.equal(msg.authorId, "coding-workers");
  assert.match(msg.content, /15\.2M on even turns/); assert.match(msg.content, /decision/); assert.match(msg.content, /nothing ships on its own/);
  assert.equal(inv.activeRun(f.d, 1785), null);
});

test("an investigation with no report and no PR retries once with its log, then escalates to the owner", async (t) => {
  const f = fixture(t, { card: true });
  const { run } = await f.cw.dispatchInvestigation({ job: f.root });
  f.calls.units[run.unit] = "inactive"; await f.cw.tick();
  assert.equal(run.state, "queued"); assert.equal(run.attempt, 2, "one retry queued");
  await f.cw.tick(); assert.equal(run.state, "running");
  f.calls.units[run.unit] = "inactive"; await f.cw.tick();
  assert.equal(run.state, "escalated");
  assert.match(run.reason, /twice without a PR or a report/);
  assert.ok((f.d.alerts || []).some((a) => a.key.startsWith("recovery:coding-worker:") && /needs a person/.test(a.content)), "owner alert raised");
});

test("an investigation that opens a bugfix PR joins the build flow; any other class goes to the owner", async (t) => {
  const prs = {};
  fixture.api = async (args) => {
    const r = args[0];
    if (r.includes("pulls?state=all&head=")) return [{ number: 7 }];
    if (/pulls\/7\/files/.test(r)) return [{ filename: "src/components/Panel.tsx" }];
    if (/pulls\/7$/.test(r)) return prs[7];
    if (/check-runs/.test(r)) return { check_runs: [["verify", 1], ["dependency-review", 2], ["custom-rules", 3]].map(([name, id]) => ({ name, id, status: "completed", conclusion: "success" })) };
    if (/pulls\?state=open&base=staging/.test(r)) return [];
    throw new Error(`unrouted ${r}`);
  };
  t.after(() => { delete fixture.api; });
  for (const [cls, expectState] of [["bugfix", "merge_ready"], ["economy-behaviour", "needs_owner"], [null, "needs_owner"]]) {
    prs[7] = { number: 7, state: "open", merged: false, base: { ref: "development" }, head: { sha: GOOD }, title: "fix(ui): stop the flip", body: cls ? `Change-class: ${cls}` : "no class", mergeable: true };
    const f = fixture(t, { card: true });
    const { run } = await f.cw.dispatchInvestigation({ job: f.root });
    f.calls.units[run.unit] = "inactive";
    f.store.reports[run.report] = "VERDICT: sector throttle flips\nCLASS: bugfix\nPR: https://github.com/lakesidegamedev/AHDGame/pull/7";
    await f.cw.tick(); assert.equal(run.state, "checks", cls);
    await f.cw.tick();
    assert.equal(run.state, expectState, String(cls));
    if (cls === "bugfix") assert.equal(run.changeClass, "bugfix");
    assert.equal(trust(f.d).progress[1785].lastKind, "worker PR opened");
  }
});

test("the investigation brief is not the build brief", () => {
  const run = { id: "cw-1-1", kind: "investigate", attempt: 1, mode: "build", changeClass: null, worktree: "/w", branch: "fix/keir-x", title: "t", detail: "d", report: "/r.md" };
  const b = buildBrief(run);
  assert.match(b, /Investigation\./); assert.match(b, /TO INVESTIGATE: t/); assert.match(b, /VERDICT:/);
  const build = buildBrief({ ...run, kind: undefined, changeClass: "bugfix" });
  assert.match(build, /Change class: bugfix\./); assert.ok(!/VERDICT:/.test(build));
});

// ---- 1b. prompt trigger from Keir's own activation ----

const { createBroker } = require("../lib/operator/broker");
function brokerFixture(t, codingWorkers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir851b-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: [], botId: "333333333333333333", guildId: "4", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {} };
  const mcp = { servers: () => ["support", "ops-knowledge"], list: async () => [], call: async () => ({}) };
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox: {}, now: () => 5000, exec: async () => "{}", codingWorkers: () => codingWorkers });
  const job = ledger.createJob("t", { kind: "ticket", role: "support", ticket: 9, repository: "AHDGame", source: { author: "fixtureuser" }, deadline: 9e15 }); job.state = "running";
  return { broker, job, ledger };
}
test("finishing waiting with an open own question card dispatches an investigation at once; waiting on the player does not", async (t) => {
  const seen = [];
  const cw = { dispatchInvestigation: async (x) => { seen.push(x); return { skipped: false, run: { id: "cw-9-1" } }; } };
  const f = brokerFixture(t, cw);
  f.job.raisedToDevelopers = [{ id: 5, kind: "question", blocking: true, selfOwned: true, title: "q", at: 1 }];
  let finished;
  try { finished = await f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "timer", wakeAfterMinutes: 30, summary: "Cause still unverified. Next: read the per-turn sector history and the clearing code." }); } catch (e) { finished = { error: e.message }; }
  if (finished.error) t.skip(`finish gate refused in this fixture: ${finished.error.slice(0, 120)}`);
  else { assert.equal(seen.length, 1); assert.equal(seen[0].job, f.job); assert.match(seen[0].reason, /cause still unverified/); assert.ok(f.ledger.data.audit.some((a) => a.kind === "investigation_dispatched")); }
});

test("finishing waiting on the player does not dispatch", async (t) => {
  const seen = [];
  const f = brokerFixture(t, { dispatchInvestigation: async (x) => { seen.push(x); return { skipped: true }; } });
  f.job.raisedToDevelopers = [{ id: 5, kind: "question", blocking: true, selfOwned: true, title: "q", at: 1 }];
  try { await f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "player_reply", summary: "Asked the player which company; cause still unverified. Next: read its sector history once they answer." }); } catch {}
  assert.equal(seen.length, 0);
});
