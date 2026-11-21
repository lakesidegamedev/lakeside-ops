"use strict";
// Keir 11.2 second pass, item 9: every ticket and finding job carries a closing condition, and wakes serve it.
// Fixtures from the 2026-11-21 audit, with player names and Discord ids removed:
//   - finding job 0f659677 (Ask doc conflict #15, PR 6887): woke 26 times in 72 hours to write "PR still unmerged, no
//     recorded approval" and never asked anyone;
//   - ticket 1868: plan "wake after the 21:00 turn", then the activation was aborted and the job blocked;
//   - job 7c4b0cee: waiting 117 hours, "No new failure evidence in this wake".
const test = require("node:test");
const assert = require("node:assert");
const closing = require("../lib/operator/closing");
const { wakeStep, onRunError, applyEffects } = require("../lib/operator/lifecycle");
const { ledgerIndex } = require("../lib/operator/keirprs");

const HOUR = 3600000, MIN = 60000;
const T0 = Date.parse("2026-11-19T02:40:00Z");
const CONFIG = { ...closing.DEFAULTS };

function world(now0 = T0) {
  let clock = now0;
  const data = { jobs: {}, seen: {}, channels: {}, decisions: {}, actions: {}, outbox: {}, audit: [], prTruth: { prs: {}, reasked: {} }, watch: {} };
  const ledger = { data, save() {}, audit(kind, detail) { data.audit.push({ kind, ...detail }); }, notify(key, destination, content) { data.outbox[key] ||= { destination, content }; } };
  const ctx = () => ({ now: clock, config: { taskLifetimeMs: 24 * HOUR }, claimedBy: () => null, directiveHeld: () => false, data, closing: CONFIG });
  return { data, ledger, now: () => clock, set: (t) => { clock = t; }, advance: (ms) => { clock += ms; },
    wake: (job) => applyEffects(ledger, wakeStep(job, ctx())), ctx };
}
const audits = (w, kind) => w.data.audit.filter((a) => a.kind === kind);

// What a finish does to the closing record, without the rest of the broker: fromFinish before the state is set, afterFinish once
// the state and timer are settled (the broker calls both; test/keir112-closing-broker covers the real path).
function finish(w, job, input, { acted = false } = {}) {
  const why = closing.fromFinish(w.data, job, input, w.now());
  if (why) throw new Error(why);
  job.state = input.state === "blocked" ? "waiting" : input.state;
  job.wakeAt = w.now() + (input.wakeAfterMinutes || 60) * MIN;
  job.summary = input.summary;
  job.history = [...(job.history || []), { at: new Date(w.now()).toISOString(), kind: "finish", summary: input.summary }];
  const out = closing.afterFinish(w.data, job, { acted, now: w.now(), config: CONFIG });
  if (out?.effects) applyEffects(w.ledger, out.effects);
  return out;
}

function pr6887(w, { head = "38d8af58d29f", state = "open" } = {}) {
  w.data.prTruth.prs["lakesidegamedev/AHDGame#6887"] = { number: 6887, repo: "lakesidegamedev/AHDGame", state, merged: state === "merged", head, checkedAt: w.now() };
}
function job6887(w) {
  const job = { id: "0f659677", kind: "finding", role: "support", state: "running", at: T0 - HOUR, deadline: T0 + 30 * 24 * HOUR,
    reviewItem: { source: "ask", kind: "doc_conflict", id: "15", key: "ask:doc_conflict:15" },
    pullRequests: ["https://github.com/lakesidegamedev/AHDGame/pull/6887"], effects: {}, inbox: [] };
  w.data.jobs[job.id] = job;
  return job;
}

test("PR 6887: 26 timer wakes become the configured quiet wakes, then one escalation, and no repeated note", () => {
  const w = world();
  const job = job6887(w);
  pr6887(w);
  finish(w, job, { state: "blocked", summary: "FAQ PR #6887 remains unmerged with all 25 checks green and no recorded exact-head approval.",
    closesWhen: "closes when PR 6887 merges and the FAQ fix is live, or the PR is declined", waitingOn: "the owner's approval of PR 6887", waitOn: { kind: "pr", ref: 6887 } });
  const notes = job.history.length;
  let activations = 0;
  for (let i = 0; i < 26; i++) {
    w.set(T0 + (i + 1) * 165 * MIN); // 26 wakes in about 72 hours
    pr6887(w); // the reconcile pass keeps the PR state fresh; nothing about the PR changes
    w.wake(job);
    if (job.state === "queued") { activations++; job.state = "waiting"; }
  }
  assert.equal(activations, 0, "no model activation: nothing the job waits on changed");
  assert.equal(job.history.length, notes, "zero repeated notes");
  assert.equal(audits(w, "quiet_wake").length, CONFIG.quietWakes, "at most the configured quiet wakes");
  assert.equal(audits(w, "pr_handed_to_open_pr_pass").length, 1, "one escalation");
  assert.deepEqual(job.closing.handedPrs, [6887]);
  assert.ok(job.closing.parked, "parked after the handoff");
  // The open-PR pass now treats 6887 as having no live owner, so it makes the one ask, repair or close.
  assert.equal(ledgerIndex(w.data).get(6887).live, false);
  // The handoff is visible through the open-PR pass's own ask; no separate parked line for it.
  assert.equal(Object.keys(w.data.outbox).length, 0);
});

test("a parked job wakes when what it waits on changes, and on a message", () => {
  const w = world();
  const job = job6887(w);
  pr6887(w);
  finish(w, job, { state: "waiting", summary: "Waiting on PR 6887.", closesWhen: "closes when PR 6887 merges and is live", waitingOn: "PR 6887 merging", waitOn: { kind: "pr", ref: 6887 } });
  for (let i = 1; i <= 4; i++) { w.set(T0 + i * HOUR); pr6887(w); w.wake(job); }
  assert.ok(job.closing.parked);
  // Merged on GitHub: the code check sees it and the model runs once.
  w.set(job.wakeAt); pr6887(w, { state: "merged" }); w.wake(job);
  assert.equal(job.state, "queued");
  assert.equal(job.closing.parked, undefined);
  assert.equal(audits(w, "job_unparked").length, 1);
  // A parked job with a message wakes at once, whatever its timer.
  const w2 = world(); const j2 = job6887(w2); pr6887(w2);
  finish(w2, j2, { state: "waiting", summary: "Waiting.", closesWhen: "closes when PR 6887 merges", waitingOn: "PR 6887", waitOn: { kind: "pr", ref: 6887 } });
  closing.park(w2.data, j2, w2.now(), "test");
  j2.inbox.push({ authorId: "p1", role: "user", content: "any news?" });
  w2.wake(j2);
  assert.equal(j2.state, "queued");
});

test("a wake with nothing changed starts no model activation; a turn that ran does", () => {
  const w = world();
  w.data.watch.turnClock = { turn: 96, iteration: 3, at: w.now() };
  const job = { id: "t1868", kind: "ticket", ticket: 1868, role: "support", state: "running", at: T0, deadline: T0 + 99 * HOUR, effects: {}, inbox: [] };
  w.data.jobs[job.id] = job;
  finish(w, job, { state: "waiting", summary: "Waiting for the next turn to compare revenue.", wakeAfterMinutes: 30,
    closesWhen: "closes when the player's revenue after the fix is compared with turn 95", waitingOn: "the first turn after the deploy" , waitOn: { kind: "turn" } });
  assert.equal(job.closing.on.ref, 97, "the next turn becomes its number");
  w.advance(31 * MIN); w.data.watch.turnClock = { turn: 96, iteration: 3, at: w.now() };
  const due = job.wakeAt;
  w.wake(job);
  assert.equal(job.state, "waiting", "same turn: no activation");
  assert.ok(job.wakeAt > due, "the timer is set again, in code");
  w.advance(31 * MIN); w.data.watch.turnClock = { turn: 97, iteration: 3, at: w.now() };
  w.wake(job);
  assert.equal(job.state, "queued", "the turn ran: the model runs");
});

test("a wait on a named future turn is checked in code each timer, never escalated, and wakes once when that turn runs", () => {
  const w = world();
  w.data.watch.turnClock = { turn: 90, iteration: 3, at: w.now() };
  const job = { id: "t1", kind: "ticket", ticket: 1, role: "support", state: "running", at: T0, deadline: T0 + 99 * HOUR, effects: {}, inbox: [] };
  w.data.jobs[job.id] = job;
  finish(w, job, { state: "waiting", summary: "Waiting for turn 97.", closesWhen: "closes when turn 97's election result is reported", waitingOn: "turn 97", waitOn: { kind: "turn", ref: 97 } });
  let runs = 0;
  for (let turn = 91; turn <= 97; turn++) {
    w.set(job.wakeAt); w.data.watch.turnClock = { turn, iteration: 3, at: w.now() };
    w.wake(job);
    if (job.state === "queued") { runs++; assert.equal(turn, 97); }
  }
  assert.equal(runs, 1);
  assert.equal(audits(w, "quiet_wake").length, 0);
  assert.equal(Object.keys(w.data.outbox).length, 0, "no parked line for a wait that is on track");
});

test("waits code cannot check still run the model, and a model wake that changes nothing counts as quiet", () => {
  // Job 7c4b0cee: "No new failure evidence in this wake", every few hours for 117 hours.
  const w = world();
  const job = { id: "7c4b0cee", kind: "finding", role: "support", state: "running", at: T0, deadline: T0 + 999 * HOUR, effects: {}, inbox: [] };
  w.data.jobs[job.id] = job;
  const input = { state: "waiting", summary: "No new failure evidence in this wake.", wakeAfterMinutes: 360,
    closesWhen: "closes when the corporations page loads cleanly for a week", waitingOn: "new failure evidence from the page sensor", waitOn: { kind: "other" } };
  finish(w, job, input);
  let runs = 0;
  for (let i = 0; i < 6 && !job.closing.parked; i++) {
    w.set(job.wakeAt); w.wake(job);
    if (job.state !== "queued") break;
    runs++; job.state = "running"; closing.onActivation(job, w.now());
    finish(w, job, input); // nothing posted, nothing written, same wait
  }
  assert.equal(runs, CONFIG.quietWakes, "it runs until the quiet limit, not for 117 hours");
  assert.ok(job.closing.parked);
  assert.equal(Object.values(w.data.outbox).filter((o) => /is parked/.test(o.content)).length, 1, "one owner line saying what it is parked on");
  // Parked: later timers never start a model run.
  for (let i = 0; i < 5; i++) { w.set(job.wakeAt); w.wake(job); assert.equal(job.state, "waiting"); }
});

test("a ticket waiting on the owner with no question open gets one ask activation; if it asks nothing it parks", () => {
  const w = world();
  const job = { id: "t1860", kind: "ticket", ticket: 1860, role: "support", state: "running", at: T0, deadline: T0 + 999 * HOUR, effects: {}, inbox: [] };
  w.data.jobs[job.id] = job;
  const input = { state: "waiting", summary: "Waiting on the owner's call on the demand cap.", wakeAfterMinutes: 120,
    closesWhen: "closes when the owner decides on the traded-market demand cap and the player is told", waitingOn: "the owner's decision on the demand cap", waitOn: { kind: "owner" } };
  finish(w, job, input);
  for (let i = 0; i < CONFIG.quietWakes; i++) { w.set(job.wakeAt); w.wake(job); }
  assert.equal(job.state, "queued", "one escalation activation");
  assert.match(job.inbox.at(-1).content, /Do exactly one thing now: put the one question that would unblock it to the owner/);
  assert.equal(audits(w, "closing_escalated").length, 1);
  // The activation raises nothing: the job parks with one owner line.
  job.state = "running"; closing.onActivation(job, w.now()); job.inbox = [];
  finish(w, job, input);
  assert.ok(job.closing.parked);
  assert.equal(Object.values(w.data.outbox).filter((o) => /Ticket 1860 is parked/.test(o.content)).length, 1);
});

test("ticket 1868: the closing condition survives the blocked activation and is in front of the promise wake", async () => {
  const w = world(Date.parse("2026-11-20T20:18:00Z"));
  w.data.watch.turnClock = { turn: 95, iteration: 3, at: w.now() };
  const job = { id: "89a3d158", kind: "ticket", ticket: 1868, role: "support", state: "running", at: Date.parse("2026-11-20T10:19:00Z"), deadline: Date.parse("2026-11-22T00:00:00Z"), effects: {}, inbox: [], lastPublishedAt: Date.parse("2026-11-20T20:17:00Z") };
  w.data.jobs[job.id] = job; w.data.seen["ticket:1868"] = job.id;
  // The plan set at the 20:18 finish attempt (recorded before the abort).
  assert.equal(closing.fromFinish(w.data, job, { state: "waiting", summary: "Wake after the 21:00 turn.", closesWhen: "closes when the player's revenue after the fix is compared with before and they are told what it did", waitingOn: "the first turn after the deploy", waitOn: { kind: "turn" } }, w.now()), null);
  const before = JSON.stringify({ closesWhen: job.closing.closesWhen, waitingOn: job.closing.waitingOn, on: job.closing.on });
  // The activation is aborted by the 15-minute limit after a post: the job is blocked.
  onRunError(job, new Error("activation aborted: no result before the 15-minute turn limit"), { now: w.now(), startedAt: w.now() - 15 * MIN, aborted: false, timedOut: true, stopping: false, paused: false, supportDeferred: () => false, staffHeld: () => false, claimedBy: () => null, pauseFor: () => null, staffActiveUntil: () => 0, redact: (x) => x });
  assert.equal(job.state, "blocked");
  assert.equal(JSON.stringify({ closesWhen: job.closing.closesWhen, waitingOn: job.closing.waitingOn, on: job.closing.on }), before, "the goal is kept");
  // The promise the post path recorded comes due when the turn has run, and the wake carries the goal.
  const { notePost, createPromises } = require("../lib/operator/promises");
  w.data.ticketPromises = {};
  notePost(w.data, 1868, job, "Once a turn has run on it, I will compare your revenue with before and tell you what it did.", Date.parse("2026-11-20T20:17:00Z"));
  const keeper = createPromises({ ledger: w.ledger, now: w.now, held: () => null });
  w.set(Date.parse("2026-11-20T21:06:00Z")); w.data.watch.turnClock = { turn: 96, iteration: 3, at: w.now() };
  await keeper.tick();
  assert.equal(job.state, "queued");
  assert.match(job.inbox.at(-1).content, /closes when the player's revenue after the fix is compared with before/);
  assert.equal(job.closing.on.ref, 96);
});

test("finding expiry: the five old-world findings close once with a record; live work is kept", () => {
  // The previous world's turns 736 to 769 (7 to 9 Nov); the current world is at turn 99.
  const w = world(Date.parse("2026-11-21T02:00:00Z"));
  w.data.watch.turnClock = { turn: 99, iteration: 3, at: w.now() };
  const old = [["a9dbf9ed", "Turn 736 is not advancing: Game turn processing is stalled", "2026-11-07T16:11:00Z"],
    ["e03b9619", "Recurring turn phase failure: corporationTurn", "2026-11-07T18:34:00Z", "Turn 737 phase corporationTurn failed"],
    ["c5f376f0", "Turn 739 is not advancing: Game turn processing is stalled", "2026-11-07T19:10:00Z"],
    ["33a33e61", "Turn 740 is not advancing: Game turn processing is stalled", "2026-11-07T20:11:00Z"],
    ["24027ba7", "Turn 769 failed", "2026-11-09T06:09:00Z"]];
  for (const [id, title, at, evidence] of old) w.data.jobs[id] = { id, kind: "finding", state: "blocked", at: Date.parse(at), stateAt: Date.parse("2026-11-16T01:52:00Z"), engineeringTitle: title, source: { content: `${title}\n\n${evidence || title}` }, summary: "Task ran out of time twice; owner needs to choose the next move.", effects: {} };
  // A current-world finding that is blocked but has an owner question open, and one blocked only an hour.
  w.data.jobs.keep1 = { id: "keep1", kind: "finding", state: "blocked", at: w.now() - 100 * HOUR, stateAt: w.now() - 100 * HOUR, engineeringTitle: "Turn 97 phase partyGOTV failed", source: { content: "Turn 97" }, effects: {} };
  w.data.decisions.q1 = { id: "q1", jobId: "keep1", state: "pending" };
  w.data.jobs.keep2 = { id: "keep2", kind: "finding", state: "blocked", at: w.now() - HOUR, stateAt: w.now() - HOUR, engineeringTitle: "Turn 98 failed", source: { content: "Turn 98" }, effects: {} };
  const closed = closing.expireFindings(w.ledger, { now: w.now(), config: CONFIG });
  assert.deepEqual(closed.sort(), old.map((o) => o[0]).sort());
  for (const [id] of old) { assert.equal(w.data.jobs[id].state, "dismissed"); assert.match(w.data.jobs[id].summary, /^Closed automatically: it belongs to a world that no longer exists\. Was: Task ran out of time twice/); }
  assert.equal(audits(w, "finding_expired").length, 5);
  assert.equal(w.data.jobs.keep1.state, "blocked", "a pending owner question keeps it");
  assert.equal(w.data.jobs.keep2.state, "blocked", "blocked an hour: not yet");
  // Once: a second pass closes nothing more and writes no new record.
  assert.deepEqual(closing.expireFindings(w.ledger, { now: w.now() + HOUR, config: CONFIG }), []);
  assert.equal(audits(w, "finding_expired").length, 5);
  assert.equal(Object.keys(w.data.outbox).length, 0, "a record, not an owner message");
});

test("finding expiry falls out of the quiet-wake rule: a parked finding closes after the configured period", () => {
  const w = world();
  const job = job6887(w);
  pr6887(w);
  finish(w, job, { state: "waiting", summary: "Waiting.", closesWhen: "closes when PR 6887 merges", waitingOn: "PR 6887", waitOn: { kind: "pr", ref: 6887 } });
  for (let i = 1; i <= 4; i++) { w.set(T0 + i * HOUR); pr6887(w); w.wake(job); }
  assert.ok(job.closing.parked);
  const since = job.closing.parked.at;
  assert.deepEqual(closing.expireFindings(w.ledger, { now: since + 71 * HOUR, config: CONFIG }), []);
  assert.deepEqual(closing.expireFindings(w.ledger, { now: since + 73 * HOUR, config: CONFIG }), [job.id]);
  assert.match(job.summary, /parked 73 hours with nothing changing/);
});

test("closing conditions: inference, refusal limit and the plain settings", () => {
  assert.deepEqual(closing.infer("the owner's answer on PR 6887"), { kind: "pr", ref: 6887 });
  assert.deepEqual(closing.infer("PR 7001 reaching the main server"), { kind: "deploy", ref: 7001 });
  assert.deepEqual(closing.infer("turn 77 results"), { kind: "turn", ref: 77 });
  assert.equal(closing.infer("the player's reply", { waitFor: "player_reply" }).kind, "player");
  assert.equal(closing.infer("something else entirely").kind, "other");
  const s = closing.settings({ KEIR_QUIET_WAKES: "5", KEIR_STEPBACK_POSTS: "12" });
  assert.equal(s.quietWakes, 5); assert.equal(s.stepBackPosts, 12); assert.equal(s.stepBackHours, 24); assert.equal(s.findingExpiryHours, 72);
  assert.deepEqual(closing.DEFAULTS, { quietWakes: 3, stepBackPosts: 10, stepBackHours: 24, stepBackCorrections: 3, findingExpiryHours: 72 });
  // Twice refused per activation, then derived from the summary so a finish never loops.
  const w = world();
  const job = { id: "x", kind: "ticket", ticket: 5, state: "running", lastRunStartedAt: 1, effects: {} };
  const input = { state: "waiting", summary: "Waiting for the player to confirm." };
  assert.equal(closing.fromFinish(w.data, job, input, w.now()), closing.MISSING);
  assert.equal(closing.fromFinish(w.data, job, input, w.now()), closing.MISSING);
  assert.equal(closing.fromFinish(w.data, job, input, w.now()), null);
  assert.equal(job.closing.derived, true);
  assert.match(job.closing.closesWhen, /^derived: Waiting for the player/);
  // "The next turn" restated on a later finish keeps its turn; it does not re-arm to the following turn.
  w.data.watch.turnClock = { turn: 50, iteration: 3, at: w.now() };
  const k = { id: "k", kind: "ticket", ticket: 6, state: "running", effects: {} };
  closing.fromFinish(w.data, k, { state: "waiting", summary: "s", closesWhen: "closes when the plant runs", waitingOn: "the next turn" }, w.now());
  assert.equal(k.closing.on.ref, 51);
  w.data.watch.turnClock = { turn: 52, iteration: 3, at: w.now() };
  closing.fromFinish(w.data, k, { state: "waiting", summary: "s", closesWhen: "closes when the plant runs", waitingOn: "the next turn" }, w.now());
  assert.equal(k.closing.on.ref, 51);
  // Commands, conversations and coding children are not held to it.
  assert.equal(closing.fromFinish(w.data, { kind: "command", effects: {} }, input, w.now()), null);
  assert.equal(closing.fromFinish(w.data, { kind: "ticket", codingParent: "p", effects: {} }, input, w.now()), null);
});
