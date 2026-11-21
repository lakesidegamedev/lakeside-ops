"use strict";
// Keir 11.2 item 4: promises keep themselves. Replay of ticket 1868 (20 Nov): the promise was posted at 19:45 and again
// at 20:17, the job was blocked at 20:18 by the activation time limit, the 21:00 turn passed, and nothing followed.
const test = require("node:test");
const assert = require("node:assert");
const { detect, notePost, createPromises, FALLBACK } = require("../lib/operator/promises");
const { wakeStep } = require("../lib/operator/lifecycle");

const at = (hhmm) => Date.parse(`2026-11-20T${hhmm}:00Z`);
const PROMISE = "It is on its way to the main server. Once a turn has run on it, I will compare your revenue with before and tell you what it did.";

function world() {
  const data = { jobs: {}, seen: { "ticket:1868": "j89a3" }, channels: {}, outbox: {}, audit: [], ticketPromises: {} };
  data.jobs.j89a3 = { id: "j89a3", kind: "ticket", ticket: 1868, role: "support", channelId: "c1868", state: "running" };
  let clock = at("19:45");
  const posted = [];
  const ledger = { data, save() {}, audit(kind, x) { data.audit.push({ kind, ...x }); }, notify(key, dest, content) { data.outbox[key] ||= { destination: dest, content }; } };
  let held = null;
  const keeper = createPromises({ ledger, now: () => clock, held: () => held, post: async (n, text) => { posted.push({ n, text, at: clock }); } });
  return { data, keeper, posted, set: (t) => { clock = at(t); }, now: () => clock, hold: (h) => { held = h; }, job: data.jobs.j89a3 };
}

test("the post path records the 1868 promise with a due time, once, even when repeated", () => {
  const w = world();
  const p = notePost(w.data, 1868, w.job, PROMISE, at("19:45"));
  assert.equal(p.kind, "turn");
  assert.equal(p.dueAt, at("21:15"));
  w.set("20:17");
  notePost(w.data, 1868, w.job, "Once a turn has run on it, I will compare your revenue with before and tell you what it did.", at("20:17"));
  const open = w.data.ticketPromises[1868].filter((x) => x.state === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0].dueAt, at("21:15"), "the earliest time the player was given");
});

test("ticket 1868 replay: blocked job is woken when due, twice, then the player gets a plain line and staff hear once", async () => {
  const w = world();
  notePost(w.data, 1868, w.job, PROMISE, at("19:45"));
  w.job.state = "blocked"; w.job.summary = "activation aborted: no result before the 15-minute turn limit";
  w.set("21:00"); await w.keeper.tick();
  assert.equal(w.job.state, "blocked", "not due yet");
  w.set("21:16"); await w.keeper.tick();
  assert.equal(w.job.state, "queued", "a blocked job is woken");
  assert.match(w.job.inbox.at(-1).content, /You told the player at 19:45 UTC: "Once a turn has run on it, I will compare your revenue/);
  assert.match(w.job.inbox.at(-1).content, /cannot confirm it yet/);
  // The run aborts again without posting.
  w.job.state = "blocked";
  w.set("21:30"); await w.keeper.tick();
  assert.equal(w.job.state, "blocked", "no second wake before the retry interval");
  w.set("21:47"); await w.keeper.tick();
  assert.equal(w.job.state, "queued");
  assert.match(w.job.inbox.at(-1).content, /^Still owed/);
  w.job.state = "blocked";
  w.set("22:18"); await w.keeper.tick();
  assert.equal(w.posted.length, 1);
  assert.equal(w.posted[0].text, FALLBACK);
  assert.doesNotMatch(FALLBACK, /[–—]/);
  assert.equal(Object.keys(w.data.outbox).filter((k) => k.startsWith("promise-overdue:1868:")).length, 1);
  w.set("23:30"); await w.keeper.tick(); w.set("23:59"); await w.keeper.tick();
  assert.equal(w.posted.length, 1, "bounded: never repeats");
  assert.equal(w.data.audit.filter((a) => a.kind === "promise_wake").length, 2);
});

test("a follow-up after the wake keeps the promise: no second wake, no fallback", async () => {
  const w = world();
  notePost(w.data, 1868, w.job, PROMISE, at("19:45"));
  w.job.state = "blocked";
  w.set("21:16"); await w.keeper.tick();
  notePost(w.data, 1868, w.job, "Turn 96 has run: your revenue rose 11% against the turn before the change.", at("21:20"));
  w.job.state = "waiting";
  w.set("23:00"); await w.keeper.tick();
  assert.equal(w.data.ticketPromises[1868][0].state, "kept");
  assert.equal(w.posted.length, 0);
  assert.equal(w.data.audit.filter((a) => a.kind === "promise_wake").length, 1);
});

test("a reply on another subject before the due time does not keep it; one on the same subject does", () => {
  const w = world();
  notePost(w.data, 1868, w.job, PROMISE, at("19:45"));
  notePost(w.data, 1868, w.job, "The bank charter rule is described on the Banking page.", at("20:05"));
  assert.equal(w.data.ticketPromises[1868][0].state, "open");
  notePost(w.data, 1868, w.job, "Your revenue compared with the turn before is up 11%.", at("20:30"));
  assert.equal(w.data.ticketPromises[1868][0].state, "kept");
});

test("staff holding the ticket: nothing is woken or posted; a closed ticket cancels the promise", async () => {
  const w = world();
  notePost(w.data, 1868, w.job, PROMISE, at("19:45"));
  w.job.state = "deferred"; w.hold("staff-owned");
  w.set("23:00"); await w.keeper.tick();
  assert.equal(w.job.state, "deferred");
  assert.equal(w.posted.length, 0);
  w.hold(null); w.job.channelClosed = true;
  await w.keeper.tick();
  assert.equal(w.data.ticketPromises[1868][0].state, "cancelled");
});

test("detection: the follow-up promises in the audit's tickets, and things that are not promises", () => {
  const n = at("12:00");
  assert.equal(detect("I will come back with what your shop figures show.", n).kind, "plain");
  assert.equal(detect("I will confirm here once a turn has run with it.", n).kind, "turn");
  assert.equal(detect("I will come back here once the owner has answered.", n).kind, "owner");
  assert.equal(detect("I'll check again after the deploy reaches the main server.", n).kind, "release");
  assert.equal(detect("Want me to check your other shops?", n), null);
  assert.equal(detect("The fix is live from this turn.", n), null);
  assert.equal(detect("I will check, if you want.", n), null);
});

test("a woken blocked ticket stays queued through the lifecycle wake rules", async () => {
  const w = world();
  notePost(w.data, 1868, w.job, PROMISE, at("19:45"));
  Object.assign(w.job, { state: "blocked", deadline: at("23:59") });
  w.set("21:16"); await w.keeper.tick();
  const effects = wakeStep(w.job, { now: w.now(), config: { taskLifetimeMs: 86400000 }, claimedBy: () => null, directiveHeld: () => false });
  assert.equal(w.job.state, "queued");
  assert.ok(Array.isArray(effects));
});

// Keir 11.2 second pass, item 11: a turn promise comes due when the game's turn has actually advanced (the watch's turn
// clock from game_overview), and falls back to the fixed duration when that read is stale or failing.
test("ticket 1868: the turn promise comes due when the turn number advances, not at a fixed time", async () => {
  const w = world();
  w.data.watch = { turnClock: { turn: 95, nextTurn: at("21:00"), iteration: 3, at: at("19:44") } };
  const p = notePost(w.data, 1868, w.job, PROMISE, at("19:45"));
  assert.equal(p.afterTurn, 96, "the turn after the one already processed");
  assert.equal(p.dueAt, at("21:10"), "the expected time is the scheduled turn plus ten minutes");
  w.job.state = "blocked";
  // 21:20: past the expected time, but turn 96 has not been processed (late turn): not due, nothing is woken.
  w.set("21:20"); w.data.watch.turnClock = { turn: 95, nextTurn: at("21:00"), iteration: 3, at: at("21:18") };
  await w.keeper.tick();
  assert.equal(w.job.state, "blocked");
  // 21:26: turn 96 has run. Due now.
  w.set("21:26"); w.data.watch.turnClock = { turn: 96, nextTurn: at("22:00"), iteration: 3, at: at("21:25") };
  await w.keeper.tick();
  assert.equal(w.job.state, "queued");
  assert.match(w.job.inbox.at(-1).content, /You told the player at 19:45 UTC/);
});

test("a turn promise falls back to the fixed duration when the turn read fails", async () => {
  const w = world();
  w.data.watch = { turnClock: { turn: 95, iteration: 3, at: at("19:44") } };
  const p = notePost(w.data, 1868, w.job, PROMISE, at("19:45"));
  assert.equal(p.afterTurn, 96);
  w.job.state = "blocked";
  // The clock stopped updating at 19:44 (game_overview failing): the turn cannot be read, so the duration decides.
  w.set("21:10"); await w.keeper.tick();
  assert.equal(w.job.state, "blocked", "before the 90 minute fallback");
  w.set("21:16"); await w.keeper.tick();
  assert.equal(w.job.state, "queued", "the fallback duration brought it due");
  // With no clock at all, the promise is recorded exactly as before (fixed duration).
  const w2 = world();
  const q = notePost(w2.data, 1868, w2.job, PROMISE, at("19:45"));
  assert.equal(q.afterTurn, undefined);
  assert.equal(q.dueAt, at("21:15"));
});

test("a paused game still brings a turn promise due after the backstop, so the player is not left waiting", async () => {
  const { TURN_BACKSTOP_MS } = require("../lib/operator/promises");
  const w = world();
  w.data.watch = { turnClock: { turn: 95, iteration: 3, at: at("19:44") } };
  notePost(w.data, 1868, w.job, PROMISE, at("19:45"));
  w.job.state = "blocked";
  const later = at("19:45") + TURN_BACKSTOP_MS + 60000;
  w.data.watch.turnClock = { turn: 95, iteration: 3, paused: true, at: later - 60000 };
  w.set("19:45"); await w.keeper.tick();
  assert.equal(w.job.state, "blocked");
  // jump the clock past the backstop with the turn unchanged
  const promises = require("../lib/operator/promises");
  assert.equal(promises.isDue(w.data, w.data.ticketPromises[1868][0], later), true);
});
