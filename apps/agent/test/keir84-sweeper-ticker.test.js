"use strict";
// Keir 8.4: stuck-ticket sweeper decisions, the sweep itself, and guarded periodic jobs.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { decideTicket, createSweeper, inActiveHours, DEFAULTS } = require("../lib/operator/sweeper");
const { createTickers } = require("../lib/operator/ticker");
const { createLedger } = require("../lib/operator/store");
const { isSubstantiveText, recordReply, trust } = require("../lib/operator/trustlog");

const MIN = 60000, H = 3600000;
const NOON = Date.parse("2026-11-06T17:00:00Z"); // 12:00 Eastern, inside active hours
const base = (o = {}) => ({ ticket: 5, open: true, held: null, running: false, pendingDecision: null, waitingOnPlayer: false, waitingOnDeveloper: false,
  lastHumanAt: NOON - 10 * H, lastReplyAt: NOON - 9 * H, lastSubstantiveAt: NOON - 1 * H, inActiveHours: true, lastActionAt: 0, lastActionKind: null, lastEscalationAt: 0, ...o });

test("a healthy, held, closed or busy ticket is left alone", () => {
  assert.equal(decideTicket(base(), NOON).action, "none");
  assert.equal(decideTicket(base({ open: false, lastSubstantiveAt: 0 }), NOON).action, "none");
  assert.equal(decideTicket(base({ held: "staff-owned", lastSubstantiveAt: 0 }), NOON).action, "none");
  assert.equal(decideTicket(base({ running: true, lastSubstantiveAt: 0 }), NOON).action, "none");
});

test("no substantive progress for 6 hours gets one fresh investigation, then one escalation, then silence", () => {
  const stale = { lastSubstantiveAt: NOON - 7 * H };
  assert.equal(decideTicket(base({ lastSubstantiveAt: NOON - 5 * H }), NOON).action, "none");
  assert.equal(decideTicket(base(stale), NOON).action, "investigate");
  // swept recently: one action per ticket per window
  assert.equal(decideTicket(base({ ...stale, lastActionAt: NOON - 1 * H, lastActionKind: "investigate" }), NOON).reason, "swept recently");
  // the investigation produced nothing substantive: escalate once
  const afterWindow = base({ ...stale, lastActionAt: NOON - 4 * H, lastActionKind: "investigate" });
  assert.equal(decideTicket(afterWindow, NOON).action, "escalate_owner");
  // already escalated: quiet for 12 hours, then again
  const escalated = { ...afterWindow, lastActionKind: "escalate_owner", lastEscalationAt: NOON - 4 * H };
  assert.equal(decideTicket(escalated, NOON).action, "none");
  assert.equal(decideTicket({ ...escalated, lastActionAt: NOON - 13 * H, lastEscalationAt: NOON - 13 * H, lastSubstantiveAt: NOON - 20 * H }, NOON).action, "escalate_owner");
  // progress after the investigation resets the ladder
  assert.equal(decideTicket(base({ lastActionAt: NOON - 4 * H, lastActionKind: "investigate", lastSubstantiveAt: NOON - 3 * H }), NOON).action, "none");
});

test("an unanswered player message waits 30 minutes, and only counts in Keir's active hours", () => {
  const msg = { lastHumanAt: NOON - 40 * MIN, lastReplyAt: NOON - 3 * H };
  assert.equal(decideTicket(base(msg), NOON).action, "investigate");
  assert.match(decideTicket(base(msg), NOON).reason, /unanswered for 40 min/);
  assert.equal(decideTicket(base({ ...msg, lastHumanAt: NOON - 20 * MIN }), NOON).action, "none");
  assert.equal(decideTicket(base({ ...msg, inActiveHours: false }), NOON).action, "none");
  // Keir spoke last and is waiting on the player: not stuck, however old
  assert.equal(decideTicket(base({ waitingOnPlayer: true, lastSubstantiveAt: NOON - 30 * H }), NOON).action, "none");
});

test("waiting on a developer past 6 hours goes straight to the owner, not to another investigation", () => {
  assert.equal(decideTicket(base({ waitingOnDeveloper: true, lastSubstantiveAt: NOON - 8 * H }), NOON).action, "escalate_owner");
});

test("a pending owner decision: tell the player once, re-ping the owner every 12 hours, never investigate", () => {
  const p = (o = {}) => ({ id: "d1", at: NOON - 20 * H, lastPingAt: 0, playerNotified: true, question: "ship it?", ...o });
  assert.equal(decideTicket(base({ pendingDecision: p({ playerNotified: false }), lastSubstantiveAt: NOON - 30 * H }), NOON).action, "notice_player_once");
  assert.equal(decideTicket(base({ pendingDecision: p(), lastSubstantiveAt: NOON - 30 * H }), NOON).action, "reping_owner");
  assert.equal(decideTicket(base({ pendingDecision: p({ lastPingAt: NOON - 3 * H }), lastSubstantiveAt: NOON - 30 * H, lastHumanAt: NOON - 2 * H, lastReplyAt: 0 }), NOON).action, "none");
  assert.equal(decideTicket(base({ pendingDecision: p({ lastPingAt: NOON - 13 * H }) }), NOON).action, "reping_owner");
});

test("active hours are Eastern", () => {
  assert.equal(inActiveHours(Date.parse("2026-11-06T17:00:00Z")), true);
  assert.equal(inActiveHours(Date.parse("2026-11-06T07:00:00Z")), false); // 02:00 ET
  assert.equal(inActiveHours(Date.parse("2026-11-07T04:30:00Z")), false); // 23:30 ET
});

test("\"still checking\" and repeats are not substantive; a finding is", () => {
  assert.equal(isSubstantiveText("I am still checking this and will update you."), false);
  assert.equal(isSubstantiveText("Still investigating."), false);
  assert.equal(isSubstantiveText("Your holdings page counts the bonds twice, once under each issuer, which is why the total is high."), true);
  const earlier = "Your holdings page counts the bonds twice, once under each issuer, which is why the total is high.";
  assert.equal(isSubstantiveText("Your holdings page counts the bonds twice under each issuer, which is why the total is high.", [earlier]), false);
});

function sweeperSetup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  let clock = NOON;
  const root = ledger.createJob("t", { kind: "ticket", role: "support", ticket: 7, source: { channelName: "ticket-bug-x-7", content: "bonds wrong" }, ...over });
  root.state = "waiting"; root.at = NOON - 10 * H; root.lastPublishedAt = NOON - 9 * H; root.observedPlayerAt = NOON - 10 * H;
  const sweeper = createSweeper({ ledger, config: {}, now: () => clock, killSwitch: over.killSwitch });
  return { ledger, root, sweeper, advance: (ms) => { clock += ms; } };
}

test("the sweep wakes a stale ticket with a system note once, then escalates in one owner DM", () => {
  const f = sweeperSetup();
  const first = f.sweeper.tick();
  assert.equal(first.actions.length, 1);
  assert.equal(first.actions[0].action, "investigate");
  assert.equal(f.root.state, "queued");
  assert.match(f.root.inbox.at(-1).content, /Stuck-ticket sweep/);
  assert.equal(f.root.inbox.at(-1).authorId, "sweeper");
  // Immediately again: nothing (it is queued, then inside the window)
  assert.equal(f.sweeper.tick().actions.length, 0);
  f.root.state = "waiting";
  f.advance(1 * H);
  assert.equal(f.sweeper.tick().actions.length, 0, "one action per ticket per window");
  f.advance(3 * H);
  const second = f.sweeper.tick();
  assert.equal(second.actions[0].action, "escalate_owner");
  const dm = Object.entries(f.ledger.data.outbox).filter(([k]) => k.startsWith("sweeper-owner:"));
  assert.equal(dm.length, 1);
  assert.match(dm[0][1].content, /Ticket 7 needs a person/);
  f.advance(3 * H);
  assert.equal(f.sweeper.tick().actions.length, 0, "no second escalation inside 12 hours");
});

test("the sweep respects the kill switch, a pending decision and the player-update cap flag", () => {
  const f = sweeperSetup({ killSwitch: { state: () => ({ engaged: true }) } });
  assert.equal(f.sweeper.tick().skipped, true);
  assert.equal(f.root.inbox, undefined);
  const g = sweeperSetup();
  const decisionJob = g.root;
  g.ledger.data.decisions = { x1: { id: "x1", state: "pending", jobId: decisionJob.id, at: NOON - 20 * H, question: "Approve the rate change?" } };
  const run = g.sweeper.tick();
  assert.equal(run.actions[0].action, "notice_player_once");
  assert.match(g.root.inbox.at(-1).content, /Do not decide it/);
  assert.equal(Object.keys(g.ledger.data.outbox).filter((k) => k.startsWith("sweeper-owner:")).length, 0);
  g.advance(11 * MIN);
  g.ledger.data.trust.sweeps[7].playerNoticedFor = "x1";
  const again = g.sweeper.tick();
  assert.equal(again.actions[0].action, "reping_owner");
  assert.match(Object.values(g.ledger.data.outbox).find((e) => /sweep/.test(e.content)).content, /still waiting on your decision/);
  g.advance(1 * H);
  assert.equal(g.sweeper.tick().actions.length, 0, "re-ping only every 12 hours");
  g.ledger.data.trust.capHits = { 9: { at: NOON, count: 4 } };
  g.sweeper.tick();
  assert.ok(Object.values(g.ledger.data.outbox).some((e) => /reached the limit of player updates/.test(e.content)));
});

test("a substantive reply resets the stale clock; a restated one does not", () => {
  const f = sweeperSetup();
  f.sweeper.tick();
  f.root.state = "waiting";
  f.advance(4 * H);
  recordReply(f.ledger.data, { ticket: 7, jobId: f.root.id, text: "I am still checking this, no update yet.", at: NOON + 4 * H });
  assert.equal(f.sweeper.tick().actions[0].action, "escalate_owner");
  const g = sweeperSetup();
  g.sweeper.tick(); g.root.state = "waiting"; g.advance(4 * H);
  recordReply(g.ledger.data, { ticket: 7, jobId: g.root.id, text: "The bond total counts both issuers twice, so the total is double what you hold.", at: NOON + 4 * H });
  assert.equal(g.sweeper.tick().actions.length, 0);
});

test("guarded tickers: a hung job is abandoned, counted and run again; errors are recorded", async () => {
  let t = 0, runs = 0;
  const timers = [];
  const tickers = createTickers({ now: () => t, setIntervalImpl: () => ({ unref() {} }), setTimeoutImpl: (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; }, clearTimeoutImpl: (h) => { h.cleared = true; } });
  let hang = true;
  const entry = tickers.every("hung", 60000, () => { runs++; return hang ? new Promise(() => {}) : Promise.resolve(); }, { maxMs: 300000 });
  const first = tickers.fire(entry);
  await Promise.resolve();
  t += 1000;
  assert.equal(await tickers.fire(entry), "skipped", "a run in flight inside its deadline is skipped");
  timers.find((h) => h.ms === 300000).fn();
  assert.equal(await first, "overrun");
  assert.equal(entry.overruns, 1);
  hang = false; t += 61000;
  assert.equal(await tickers.fire(entry), "ok");
  assert.equal(runs, 2, "the job ran again after the overrun");
  assert.equal(entry.running, false);
  const bad = tickers.every("bad", 1000, () => { throw new Error("boom"); });
  assert.equal(await tickers.fire(bad), "error");
  assert.equal(bad.lastError, "boom");
  t += 10 * 60000;
  assert.ok(tickers.stale().some((s) => s.name === "bad"), "a job that never succeeds is reported stale");
});
