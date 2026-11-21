"use strict";
// Keir 11.2 fourth pass, review N1 (the blocker) and N8: a parked job has no model timer, so it may park only on a wait
// some wired event will end, and every parked job has a bounded safety-net re-check in code.
//
// The reviewer's reproduction: a ticket waiting for its merged fix (PR 7001) to reach the main server was parked after
// three timer wakes and nothing in the code ever woke it when the fix went live. These tests walk that case end to end
// through the GitHub reconcile pass, then prove for each wait kind that its event wakes a parked job, and check the other
// side: a parked job whose wait does not change starts no model run and posts nothing.
const test = require("node:test");
const assert = require("node:assert");
const closing = require("../lib/operator/closing");
const { wakeStep, applyEffects } = require("../lib/operator/lifecycle");
const { createPrTruth } = require("../lib/operator/prtruth");
const { ledgerIndex } = require("../lib/operator/keirprs");
const { ticketDetail } = require("../lib/operator/apptickets");

const HOUR = 3600000, MIN = 60000;
const T0 = Date.parse("2026-11-21T10:00:00Z");
const CONFIG = { ...closing.DEFAULTS };
const REPO = "lakesidegamedev/AHDGame";

function world({ config = CONFIG } = {}) {
  let clock = T0;
  const data = { jobs: {}, seen: {}, channels: {}, decisions: {}, actions: {}, outbox: {}, audit: [], prTruth: { prs: {}, reasked: {} }, watch: {}, codingWorkers: { runs: {} } };
  const ledger = { data, save() {}, audit(kind, detail) { data.audit.push({ kind, ...detail }); }, notify(key, destination, content) { data.outbox[key] ||= { destination, content }; } };
  const w = { data, ledger, config, now: () => clock, set: (t) => { clock = t; }, advance: (ms) => { clock += ms; } };
  w.wake = (job) => applyEffects(ledger, wakeStep(job, { now: clock, config: { taskLifetimeMs: 99 * 24 * HOUR }, claimedBy: () => null, directiveHeld: () => false, data, closing: w.config }));
  return w;
}
const audits = (w, kind) => w.data.audit.filter((a) => a.kind === kind);
function ticketJob(w, id, ticket, extra = {}) {
  const job = { id, kind: "ticket", ticket, role: "support", state: "running", at: T0 - HOUR, deadline: T0 + 60 * 24 * HOUR, effects: {}, inbox: [], ...extra };
  w.data.jobs[id] = job; w.data.seen[`ticket:${ticket}`] = id;
  return job;
}
function finish(w, job, input, { acted = false } = {}) {
  const why = closing.fromFinish(w.data, job, input, w.now());
  if (why) throw new Error(why);
  job.state = "waiting"; job.wakeAt = w.now() + (input.wakeAfterMinutes || 30) * MIN;
  const out = closing.afterFinish(w.data, job, { acted, now: w.now(), config: w.config });
  if (out?.effects) applyEffects(w.ledger, out.effects);
}
// Timer wakes until the job parks or slows (each wake that reaches the model finishes again with the same wait).
function quietUntilEscalated(w, job, input, refresh = () => {}) {
  let runs = 0;
  for (let i = 0; i < 12 && !job.closing.parked && !job.closing.slowed; i++) {
    w.set(job.wakeAt); refresh(); w.wake(job);
    if (job.state === "queued") { runs++; job.state = "running"; closing.onActivation(job, w.now()); job.inbox = []; finish(w, job, input); }
  }
  return runs;
}

test("N1 reproduction: a deploy wait on merged PR 7001 parks, and the fix reaching main wakes it with a receipt", async () => {
  const w = world();
  let onMain = false;
  const reads = [];
  const api = async ([route]) => {
    reads.push(route);
    if (/pulls\/7001$/.test(route)) return { number: 7001, state: "closed", merged: true, merged_at: "2026-11-21T09:30:00Z", merge_commit_sha: "abc1234def5678", head: { sha: "h7001" } };
    if (/compare\/abc1234def5678\.\.\.main$/.test(route)) return { status: onMain ? "ahead" : "behind" };
    throw new Error(`unrouted ${route}`);
  };
  const truth = createPrTruth({ ledger: w.ledger, api, now: w.now });
  const job = ticketJob(w, "j1900", 1900, { pullRequests: [`https://github.com/${REPO}/pull/7001`] });
  // The player was told "I'll let you know once it's live" (a release promise).
  w.data.ticketPromises = { 1900: [{ id: "1900-a", at: T0 - 10 * MIN, jobId: job.id, state: "open", wakes: 0, kind: "release", text: "I'll let you know once it's live.", dueAt: T0 + 4 * HOUR }] };
  const input = { state: "waiting", summary: "Merged; waiting for it to reach the main server.", closesWhen: "closes when the player is told the fix is live and confirms it", waitingOn: "PR 7001 reaching the main server" };
  finish(w, job, input);
  assert.deepEqual(job.closing.on, { kind: "deploy", ref: 7001 });
  // Until the reconcile pass has read whether the merge is on main, code cannot tell, so the wake would reach the model.
  assert.equal(closing.observe(w.data, job, w.now()).checkable, false);
  await truth.tick(); // runs every minute: reads the PR, then compare merge...main
  job.closing.mark = closing.observe(w.data, job, w.now()).mark;
  // The merge alone does not end a deploy wait: the mark carries whether the merge is on main.
  assert.match(closing.observe(w.data, job, w.now()).mark, /:not-main$/);
  const runs = quietUntilEscalated(w, job, input, () => { w.data.prTruth.prs[`${REPO}#7001`].checkedAt = w.now(); });
  assert.equal(runs, 0, "nothing changed: no model run");
  assert.ok(job.closing.parked, "it may park: the main-server read is its event");
  // The player is owed something, so parking it is never silent, and the app shows it.
  const line = Object.values(w.data.outbox).find((o) => /Ticket 1900 is parked/.test(o.content));
  assert.ok(line);
  assert.match(line.content, /The player is owed a follow-up Keir promised \("I'll let you know once it's live\."\)/);
  assert.match(line.content, /It wakes when the fix reaches the main server/);
  assert.match(line.content, /Every 2 hours Keir also re-reads the wait in code/);
  const view = ticketDetail(w.data, 1900, w.now());
  assert.ok(view.blockers.some((b) => b.kind === "parked" && /owed/.test(b.detail)));
  // Hours later the auto-promote lands it on main. The reconcile pass reads it and wakes the job, parked or not.
  onMain = true;
  w.advance(5 * HOUR);
  await truth.tick();
  assert.equal(job.state, "queued");
  assert.match(job.inbox.at(-1).content, /PR #7001 is now on the main server/);
  assert.equal(job.releaseEvidence.abc1234def.main, true, "a receipt the live rules accept");
  assert.equal(audits(w, "deploy_wait_reached_main").length, 1);
  // Read once on main, never again.
  const compares = reads.filter((r) => /compare/.test(r)).length;
  w.advance(HOUR); await truth.tick();
  assert.equal(reads.filter((r) => /compare/.test(r)).length, compares);
});

test("N1: a missed event costs a delay, not silence: the parked check alone sees the merge on main", () => {
  const w = world();
  const job = ticketJob(w, "j1901", 1901, { pullRequests: [`https://github.com/${REPO}/pull/7002`] });
  const rec = { number: 7002, repo: REPO, state: "merged", merged: true, head: "h", mergeSha: "def", onMain: false, checkedAt: T0 };
  w.data.prTruth.prs[`${REPO}#7002`] = rec;
  const input = { state: "waiting", summary: "s", closesWhen: "closes when the fix is live", waitingOn: "PR 7002 going live on the main server", waitOn: { kind: "deploy", ref: 7002 } };
  finish(w, job, input);
  quietUntilEscalated(w, job, input, () => { rec.checkedAt = w.now(); });
  assert.ok(job.closing.parked);
  // The record shows main (written by any path); no inbox line arrives. The next step, not the safety net, wakes it.
  w.advance(MIN); rec.onMain = true; rec.checkedAt = w.now();
  assert.ok(job.wakeAt > w.now() + HOUR, "the safety net is not due");
  w.wake(job);
  assert.equal(job.state, "queued");
  assert.equal(job.closing.parked, undefined);
});

test("N1 parking table: every kind that may park is woken by its event; kind other never parks", () => {
  const cases = [
    // An unnamed turn wait (no clock when it was set, so no turn number): every turn changes it.
    { kind: "turn", after: (w) => { w.data.watch.turnClock = { turn: 50, iteration: 3, at: w.now() }; }, refresh: (w) => { w.data.watch.turnClock.at = w.now(); }, event: (w) => { w.data.watch.turnClock = { turn: 51, iteration: 3, at: w.now() }; }, waitOn: null, waitingOn: "the next turn" },
    { kind: "pr", setup: (w) => { w.data.prTruth.prs[`${REPO}#7003`] = { number: 7003, state: "open", head: "a", checkedAt: w.now() }; }, refresh: (w) => { w.data.prTruth.prs[`${REPO}#7003`].checkedAt = w.now(); }, event: (w) => { Object.assign(w.data.prTruth.prs[`${REPO}#7003`], { state: "merged", merged: true, checkedAt: w.now() }); }, waitOn: { kind: "pr", ref: 7003 }, waitingOn: "PR 7003" },
    { kind: "decision", setup: (w, job) => { w.data.decisions.q = { id: "q", jobId: job.id, state: "pending" }; }, event: (w) => { w.data.decisions.q.state = "selected"; }, waitOn: { kind: "decision" }, waitingOn: "the owner's choice" },
    { kind: "player", event: (w, job) => { job.inbox.push({ role: "user", authorId: "p", content: "any news?", at: new Date(w.now()).toISOString() }); }, waitOn: { kind: "player" }, waitingOn: "the player's reply" },
    { kind: "developer", event: (w, job) => { job.inbox.push({ role: "developer", authorId: "d", content: "it is the cap", at: new Date(w.now()).toISOString() }); }, waitOn: { kind: "developer" }, waitingOn: "a developer's answer" },
    { kind: "staff", event: (w, job) => { job.inbox.push({ role: "staff", authorId: "s", content: "done", at: new Date(w.now()).toISOString() }); }, waitOn: { kind: "staff" }, waitingOn: "staff" },
    { kind: "worker", setup: (w, job) => { w.data.codingWorkers.runs.r = { id: "r", jobId: job.id, state: "running" }; }, event: (w) => { w.data.codingWorkers.runs.r.state = "merge_ready"; }, waitOn: { kind: "worker" }, waitingOn: "the coding worker" },
  ];
  for (const c of cases) {
    const w = world();
    const job = ticketJob(w, `j-${c.kind}`, 1950);
    c.setup?.(w, job);
    const input = { state: "waiting", summary: "s", closesWhen: "closes when it is done", waitingOn: c.waitingOn, ...(c.waitOn ? { waitOn: c.waitOn } : {}) };
    finish(w, job, input);
    c.after?.(w);
    quietUntilEscalated(w, job, input, () => c.refresh?.(w));
    assert.ok(job.closing.parked, `${c.kind} may park`);
    assert.equal(typeof closing.PARKABLE[c.kind], "function");
    w.advance(5 * MIN); c.refresh?.(w); c.event(w, job); w.wake(job);
    assert.equal(job.state, "queued", `${c.kind}: its event wakes the parked job before the safety net`);
  }
  // The one kind no event ends.
  const w = world();
  const job = ticketJob(w, "j-other", 1951);
  const input = { state: "waiting", summary: "s", closesWhen: "closes when it is done", waitingOn: "something", waitOn: { kind: "other" } };
  finish(w, job, input);
  quietUntilEscalated(w, job, input);
  assert.equal(job.closing.parked, undefined);
  assert.ok(job.closing.slowed);
  assert.equal(closing.parkable(w.data, job, w.now()).ok, false);
});

test("N1 safety net: an unchanged parked wait is re-checked in code on the configured interval with no model run and no post", () => {
  for (const [kind, hours] of [["ticket", 2], ["finding", 6]]) {
    const w = world();
    const job = kind === "ticket" ? ticketJob(w, "jt", 1960) : (w.data.jobs.jf = { id: "jf", kind: "finding", role: "support", state: "running", at: T0, deadline: T0 + 99 * 24 * HOUR, effects: {}, inbox: [] });
    const input = { state: "waiting", summary: "s", closesWhen: "closes when the turn runs", waitingOn: "the next turn" };
    finish(w, job, input); // an unnamed turn wait (no clock yet), so quiet wakes count
    w.data.watch.turnClock = { turn: 50, iteration: 3, at: w.now() };
    quietUntilEscalated(w, job, input, () => { w.data.watch.turnClock.at = w.now(); });
    assert.ok(job.closing.parked);
    assert.equal(job.wakeAt - w.now(), hours * HOUR, `${kind}: re-check every ${hours} hours`);
    const outbox = Object.keys(w.data.outbox).length, auditRows = w.data.audit.length;
    // 24 hours of steps every 10 minutes, the clock fresh and the turn unchanged (a paused game).
    for (let i = 0; i < 144; i++) { w.advance(10 * MIN); w.data.watch.turnClock.at = w.now(); w.wake(job); assert.equal(job.state, "waiting"); }
    assert.equal(Object.keys(w.data.outbox).length, outbox, "no post or owner line");
    assert.equal(w.data.audit.length, auditRows, "no audit noise");
    assert.ok(job.closing.parked.checkedAt > T0, "the safety net ran");
    // The wait cannot be read any more (the clock went stale): the safety net hands it to the model, since unknown is not
    // the same as nothing changed.
    w.advance(hours * HOUR + MIN); w.wake(job);
    assert.equal(job.state, "queued");
    assert.equal(audits(w, "job_unparked").at(-1).by, "safety net");
  }
});

test("N1: an owner wait with no question open, or a deploy wait with no PR named, is never parked", () => {
  const w = world();
  const job = ticketJob(w, "jo", 1970);
  job.closing = { closesWhen: "x", waitingOn: "the owner", on: { kind: "owner" }, quietWakes: 3, mark: "m", escalation: { how: "ask", settled: true } };
  assert.equal(closing.parkable(w.data, job, w.now()).ok, false);
  const out = closing.escalate(w.data, job, w.now(), CONFIG);
  assert.equal(out.slowed, true);
  const j2 = ticketJob(w, "jd", 1971);
  j2.closing = { closesWhen: "x", waitingOn: "the deploy", on: { kind: "deploy", ref: null }, quietWakes: 3 };
  assert.equal(closing.parkable(w.data, j2, w.now()).ok, false);
});

test("N8: the PR handoff happens only when the open-PR pass can act; otherwise the job keeps its PR and parks with a line", () => {
  const setupJob = (config) => {
    const w = world({ config });
    const job = { id: "f6887", kind: "finding", role: "support", state: "running", at: T0, deadline: T0 + 99 * 24 * HOUR, effects: {}, inbox: [], pullRequests: [`https://github.com/${REPO}/pull/6887`] };
    w.data.jobs[job.id] = job;
    const pr = { number: 6887, repo: REPO, state: "open", head: "h", checkedAt: w.now() };
    w.data.prTruth.prs[`${REPO}#6887`] = pr;
    const input = { state: "waiting", summary: "s", closesWhen: "closes when 6887 merges", waitingOn: "PR 6887", waitOn: { kind: "pr", ref: 6887 } };
    finish(w, job, input);
    quietUntilEscalated(w, job, input, () => { pr.checkedAt = w.now(); });
    return { w, job };
  };
  // Pass off, in preview, or without Keir's token: handoffReady is false.
  const off = setupJob({ ...CONFIG, handoffReady: () => false });
  assert.ok(off.job.closing.parked);
  assert.equal(off.job.closing.handedPrs, undefined);
  assert.equal(ledgerIndex(off.w.data).get(6887).live, true, "the job still owns the PR");
  assert.equal(Object.values(off.w.data.outbox).filter((o) => /is parked/.test(o.content)).length, 1, "the owner hears it is parked");
  // Pass on and able: handed over, no separate line (the pass's own ask is the line).
  const on = setupJob({ ...CONFIG, handoffReady: () => true });
  assert.deepEqual(on.job.closing.handedPrs, [6887]);
  assert.equal(ledgerIndex(on.w.data).get(6887).live, false);
  assert.equal(Object.keys(on.w.data.outbox).length, 0);
  // The job wakes (a message): the PR is the job's again, so the pass never sees its own revision as a person's push.
  on.job.state = "running"; closing.onActivation(on.job, on.w.now(), { human: true });
  assert.equal(on.job.closing.handedPrs, undefined);
  assert.equal(ledgerIndex(on.w.data).get(6887).live, true);
});

test("N8 and N1: a handed-off ticket that owes the player something still gets the owner line", () => {
  const w = world({ config: { ...CONFIG, handoffReady: () => true } });
  const job = ticketJob(w, "j1980", 1980, { pullRequests: [`https://github.com/${REPO}/pull/7010`] });
  w.data.ticketCases = { 1980: { asked: [{ at: T0 - HOUR, text: "Why did my factory produce nothing?", answeredAt: null }] } };
  const pr = { number: 7010, repo: REPO, state: "open", head: "h", checkedAt: w.now() };
  w.data.prTruth.prs[`${REPO}#7010`] = pr;
  const input = { state: "waiting", summary: "s", closesWhen: "closes when the fix merges and the player is told", waitingOn: "PR 7010", waitOn: { kind: "pr", ref: 7010 } };
  finish(w, job, input);
  quietUntilEscalated(w, job, input, () => { pr.checkedAt = w.now(); });
  assert.deepEqual(job.closing.handedPrs, [7010]);
  const line = Object.values(w.data.outbox).find((o) => /Ticket 1980 is parked/.test(o.content));
  assert.ok(line, "never silent while the player is owed an answer");
  assert.match(line.content, /owed an answer to "Why did my factory produce nothing\?"/);
});

// Review 3 F3 (the reviewer's park.js): a readable wait that can no longer change never parks. It slows down to a model
// run every two hours, and the owner is never told it will wake on an event that cannot come.
test("F3 reproduction: a reached turn, and a worker wait with no worker, slow down instead of parking", () => {
  const cases = [
    { label: "turn 97 after turn 97 ran", waitOn: { kind: "turn", ref: 97 }, waitingOn: "turn 97", setup: (w) => { w.data.watch.turnClock = { turn: 97, iteration: 3, at: w.now() }; } },
    { label: "the turn worker to pick up the deploy", waitOn: null, waitingOn: "the turn worker to pick up the deploy", setup: (w) => { w.data.watch.turnClock = { turn: 97, iteration: 3, at: w.now() }; } },
  ];
  for (const c of cases) {
    const w = world();
    const job = ticketJob(w, "jf3", 1990);
    c.setup(w);
    const input = { state: "waiting", summary: "s", closesWhen: "closes when the figures settle", waitingOn: c.waitingOn, ...(c.waitOn ? { waitOn: c.waitOn } : {}) };
    finish(w, job, input);
    // The turn moves on while the job waits; its mark stays the same.
    let turn = 97;
    const runs = quietUntilEscalated(w, job, input, () => { w.data.watch.turnClock = { turn: ++turn, iteration: 3, at: w.now() }; });
    assert.equal(job.closing.parked, undefined, `${c.label}: not parked`);
    assert.ok(job.closing.slowed, `${c.label}: slowed`);
    assert.equal(runs, 0);
    assert.equal(job.wakeAt - w.now(), 2 * HOUR, "a model run every two hours");
    assert.equal(Object.values(w.data.outbox).filter((o) => /is parked/.test(o.content)).length, 0, "no parked line promising a wake");
    assert.match(audits(w, "job_slowed")[0].why, /already run|no coding worker/);
  }
});

test("F3: a pr wait on a merged or closed PR, and a deploy wait already on main or closed unmerged, may not park", () => {
  const w = world();
  const job = ticketJob(w, "jp", 1991, { pullRequests: [`https://github.com/${REPO}/pull/7010`] });
  const rec = { number: 7010, repo: REPO, state: "merged", merged: true, head: "h", mergeSha: "m", onMain: true, checkedAt: T0 };
  w.data.prTruth.prs[`${REPO}#7010`] = rec;
  job.closing = { closesWhen: "x", waitingOn: "PR 7010", on: { kind: "pr", ref: 7010 } };
  assert.equal(closing.parkable(w.data, job, w.now()).ok, false);
  job.closing.on = { kind: "deploy", ref: 7010 };
  assert.match(closing.parkable(w.data, job, w.now()).why, /already on the main server/);
  Object.assign(rec, { state: "closed", merged: false, onMain: undefined });
  assert.match(closing.parkable(w.data, job, w.now()).why, /closed without merging/);
  job.closing.on = { kind: "pr", ref: 7010 };
  assert.equal(closing.parkable(w.data, job, w.now()).ok, false);
  // The opposite: an open PR, and a merged PR not yet on main, may park, each with its true event.
  Object.assign(rec, { state: "open", merged: false });
  assert.match(closing.parkable(w.data, job, w.now()).source, /merged, closed or changes/);
  Object.assign(rec, { state: "merged", merged: true, onMain: false });
  job.closing.on = { kind: "deploy", ref: 7010 };
  assert.match(closing.parkable(w.data, job, w.now()).source, /reaches the main server/);
  // A worker wait parks only while a run or a coding child is live.
  job.closing.on = { kind: "worker", ref: null };
  assert.equal(closing.parkable(w.data, job, w.now()).ok, false);
  w.data.codingWorkers.runs.r = { id: "r", jobId: job.id, state: "done" };
  assert.equal(closing.parkable(w.data, job, w.now()).ok, false, "a finished run changes nothing");
  w.data.jobs.kid = { id: "kid", codingParent: job.id, state: "running" };
  assert.equal(closing.parkable(w.data, job, w.now()).ok, true);
});

test("F3: the parking list is closed: only the listed kinds can park, and an unknown or new kind never does", () => {
  assert.deepEqual(Object.keys(closing.PARKABLE).sort(), ["decision", "deploy", "developer", "owner", "player", "pr", "staff", "turn", "worker"]);
  assert.ok(Object.isFrozen(closing.PARKABLE));
  const w = world();
  for (const kind of ["other", "weather", "toString", "__proto__", "constructor"]) {
    const job = ticketJob(w, `jk-${kind}`, 1992, { closing: { closesWhen: "x", waitingOn: "y", on: { kind, ref: null } } });
    assert.equal(closing.parkable(w.data, job, w.now()).ok, false, kind);
  }
});

test("F3: a parked wait that can no longer change is handed back by the safety net, not re-armed forever", () => {
  const w = world();
  const job = ticketJob(w, "jsn", 1993);
  w.data.watch.turnClock = { turn: 97, iteration: 3, at: w.now() };
  // Parked by an earlier release on turn 97 before it ran; the turn ran and the mark was taken after (nothing woke it).
  job.state = "waiting"; job.wakeAt = w.now() + MIN;
  job.closing = { closesWhen: "x", waitingOn: "turn 97", on: { kind: "turn", ref: 97 }, mark: "turn:3:reached", parked: { at: w.now() - HOUR }, timerAt: job.wakeAt, timerMs: 2 * HOUR };
  w.advance(2 * MIN); w.data.watch.turnClock.at = w.now(); w.wake(job);
  assert.equal(job.state, "queued");
  assert.equal(job.closing.parked, undefined);
  assert.match(audits(w, "job_unparked").at(-1).why, /already run/);
  // The opposite: a live parked wait (an unnamed turn) is re-armed quietly at the safety net.
  const w2 = world();
  const j2 = ticketJob(w2, "jsn2", 1994);
  w2.data.watch.turnClock = { turn: 50, iteration: 3, at: w2.now() };
  j2.state = "waiting"; j2.wakeAt = w2.now() + MIN;
  j2.closing = { closesWhen: "x", waitingOn: "the next turn", on: { kind: "turn", ref: null }, mark: "turn:3:50", parked: { at: w2.now() - HOUR }, timerAt: j2.wakeAt, timerMs: 2 * HOUR };
  w2.advance(2 * MIN); w2.data.watch.turnClock.at = w2.now(); w2.wake(j2);
  assert.equal(j2.state, "waiting");
  assert.ok(j2.closing.parked);
});

// Review 4 N1 (the reviewer's handoff.js): the PR handoff parks, so it passes the closed parking list, and a handed-off
// job wakes when its handed PR is merged or closed.
test("review 4 N1 reproduction: a reached turn wait holding open PR 7001 is not handed off to park; it slows down", () => {
  const w = world({ config: { ...CONFIG, handoffReady: () => true } });
  const job = ticketJob(w, "j1900", 1900, { pullRequests: [`https://github.com/${REPO}/pull/7001`] });
  const pr = { number: 7001, repo: REPO, state: "open", head: "abc", checkedAt: w.now() };
  w.data.prTruth.prs[`${REPO}#7001`] = pr;
  w.data.watch.turnClock = { turn: 97, iteration: 3, at: w.now() };
  const input = { state: "waiting", summary: "s", closesWhen: "closes when the revenue is compared with turn 96", waitingOn: "turn 97 figures", waitOn: { kind: "turn", ref: 97 } };
  finish(w, job, input);
  let turn = 97;
  quietUntilEscalated(w, job, input, () => { pr.checkedAt = w.now(); w.data.watch.turnClock = { turn: ++turn, iteration: 3, at: w.now() }; });
  assert.equal(job.closing.parked, undefined, "never parked");
  assert.equal(job.closing.handedPrs, undefined, "the job keeps its PR");
  assert.equal(audits(w, "pr_handed_to_open_pr_pass").length, 0);
  assert.ok(job.closing.slowed, "slowed: the model still runs every two hours and sees the merge");
});

test("review 4 N1: a handed-off job whose PR merges or closes wakes at once, and is re-checked at the safety net", () => {
  for (const [label, end] of [["merged", { state: "merged", merged: true }], ["closed", { state: "closed", merged: false }]]) {
    const w = world({ config: { ...CONFIG, handoffReady: () => true } });
    const job = ticketJob(w, `jh-${label}`, 1901, { pullRequests: [`https://github.com/${REPO}/pull/7002`] });
    const pr = { number: 7002, repo: REPO, state: "open", head: "h", checkedAt: w.now() };
    w.data.prTruth.prs[`${REPO}#7002`] = pr;
    // A player wait held with an own open PR: parkable (the player writing ends it), so the handoff happens.
    const input = { state: "waiting", summary: "s", closesWhen: "closes when the player confirms the fix", waitingOn: "the player to confirm", waitOn: { kind: "player", ref: null } };
    finish(w, job, input);
    quietUntilEscalated(w, job, input, () => { pr.checkedAt = w.now(); });
    assert.deepEqual(job.closing.handedPrs, [7002], label);
    assert.ok(job.closing.parked, label);
    // Nothing about the PR changed: the next step does nothing.
    w.advance(10 * MIN); pr.checkedAt = w.now(); w.wake(job);
    assert.equal(job.state, "waiting");
    // The open-PR pass merges or closes it: the very next step wakes the job (well before the safety net).
    Object.assign(pr, end, { checkedAt: w.now() }); w.advance(MIN); w.wake(job);
    assert.equal(job.state, "queued", `${label}: woken`);
    assert.equal(job.closing.parked, undefined);
    assert.equal(job.closing.handedPrs, undefined, "the PR is the job's again");
    assert.equal(audits(w, "job_unparked").at(-1).by, "handed PR");
  }
  // The safety net re-checks a handed job too: a handed PR that can no longer be read hands the job back.
  const w = world({ config: { ...CONFIG, handoffReady: () => true } });
  const job = ticketJob(w, "jh-stale", 1902, { pullRequests: [`https://github.com/${REPO}/pull/7003`] });
  const pr = { number: 7003, repo: REPO, state: "open", head: "h", checkedAt: w.now() };
  w.data.prTruth.prs[`${REPO}#7003`] = pr;
  const input = { state: "waiting", summary: "s", closesWhen: "closes when the player confirms", waitingOn: "the player to confirm", waitOn: { kind: "player", ref: null } };
  finish(w, job, input);
  quietUntilEscalated(w, job, input, () => { pr.checkedAt = w.now(); });
  assert.deepEqual(job.closing.handedPrs, [7003]);
  w.set(job.wakeAt + MIN); w.wake(job); // the PR read is now older than the freshness window
  assert.equal(job.state, "queued");
  assert.match(audits(w, "job_unparked").at(-1).why, /PR 7003 state not read recently/);
});

test("review 4 N1, the opposite: the PR 6887 handoff still stops the repeated quiet wakes (no model run, no note)", () => {
  const w = world({ config: { ...CONFIG, handoffReady: () => true } });
  const job = { id: "f6887b", kind: "finding", role: "support", state: "running", at: T0, deadline: T0 + 99 * 24 * HOUR, effects: {}, inbox: [], pullRequests: [`https://github.com/${REPO}/pull/6887`] };
  w.data.jobs[job.id] = job;
  const pr = { number: 6887, repo: REPO, state: "open", head: "38d8af58d29f", checkedAt: w.now() };
  w.data.prTruth.prs[`${REPO}#6887`] = pr;
  const input = { state: "blocked", summary: "PR 6887 remains unmerged with all checks green.", closesWhen: "closes when PR 6887 merges", waitingOn: "the owner's approval of PR 6887", waitOn: { kind: "pr", ref: 6887 } };
  finish(w, job, input);
  const runs = quietUntilEscalated(w, job, input, () => { pr.checkedAt = w.now(); });
  assert.equal(runs, 0);
  assert.deepEqual(job.closing.handedPrs, [6887]);
  // 72 hours of steps with the PR unchanged and kept fresh: no model run, no note, no repeated handoff.
  for (let i = 0; i < 72 * 4; i++) { w.advance(15 * MIN); pr.checkedAt = w.now(); w.wake(job); assert.equal(job.state, "waiting"); }
  assert.equal(Object.keys(w.data.outbox).length, 0);
  assert.equal(audits(w, "pr_handed_to_open_pr_pass").length, 1);
  assert.ok(job.closing.parked);
});
