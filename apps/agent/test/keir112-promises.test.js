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

// ---- Third pass: the review's B3, m2 and m3 ----
const { staticControls } = require("../lib/operator/controls");

test("B3: the holding line a wake asks for never re-arms a promise; \"I can't confirm yet\" ends it until the player writes", async () => {
  const w = world();
  w.job.state = "waiting";
  notePost(w.data, 1868, w.job, "I'll check the next turn and tell you what changed.", at("19:45"));
  w.set("21:16"); await w.keeper.tick();
  assert.equal(w.data.audit.filter((a) => a.kind === "promise_wake").length, 1);
  // The woken activation says what the wake prompt asks for, which itself sounds like a promise.
  notePost(w.data, 1868, w.job, "I can't confirm this yet. I'm waiting for the turn to finish and I'll update you here once it has run.", at("21:20"), { askedAt: at("19:00") });
  assert.deepEqual(w.data.ticketPromises[1868].map((p) => p.state), ["ended"], "no second promise opened");
  w.job.state = "done";
  for (const t of ["22:00", "23:00", "23:59"]) { w.set(t); await w.keeper.tick(); }
  assert.equal(w.data.audit.filter((a) => a.kind === "promise_wake").length, 1, "no wake loop");
  assert.equal(w.posted.length, 0);
  // Another holding post from any task before the player writes does not open one either.
  notePost(w.data, 1868, w.job, "I'll update you once the turn has run.", at("23:30"), { askedAt: at("19:00") });
  assert.equal(w.data.ticketPromises[1868].filter((p) => p.state === "open").length, 0);
  // The player asks again: a new promise may be recorded.
  notePost(w.data, 1868, w.job, "I'll check the next turn and tell you what changed.", at("23:45"), { askedAt: at("23:40") });
  assert.equal(w.data.ticketPromises[1868].filter((p) => p.state === "open").length, 1);
});

test("B3: a ticket gets at most four promise wakes a day, however many promises it collects", async () => {
  const w = world();
  w.job.state = "waiting";
  let t = at("01:00");
  for (let i = 0; i < 4; i++) {
    notePost(w.data, 1868, w.job, "I'll check this again later and tell you what I find.", t, { askedAt: t - 60000 });
    t += 4 * 3600000 + 60000; w.set(new Date(t).toISOString().slice(11, 16)); await w.keeper.tick();
    // The player writes, Keir answers, and a new promise follows.
    notePost(w.data, 1868, w.job, "Here is what I found: the price rose.", t + 60000, { askedAt: t + 30000 });
    t += 120000;
  }
  assert.equal(w.data.audit.filter((a) => a.kind === "promise_wake").length, 4);
  notePost(w.data, 1868, w.job, "I'll check this again later and tell you what I find.", t, { askedAt: t - 60000 });
  t += 4 * 3600000 + 60000; w.set(new Date(t).toISOString().slice(11, 16)); await w.keeper.tick();
  assert.equal(w.data.audit.filter((a) => a.kind === "promise_wake").length, 4, "the fifth is not woken");
  assert.equal(w.data.ticketPromises[1868].at(-1).state, "capped");
  assert.equal(Object.keys(w.data.outbox).filter((k) => k.startsWith("promise-capped:1868:")).length, 1);
});

test("m2: the owner hears what actually reached the player, after the post", async () => {
  const data = { jobs: { j: { id: "j", kind: "ticket", ticket: 1868, state: "blocked" } }, seen: { "ticket:1868": "j" }, channels: {}, outbox: {}, audit: [], ticketPromises: {} };
  let clock = at("19:45"), order = [];
  const ledger = { data, save() {}, audit() {}, notify(key, dest, content) { order.push("notify"); data.outbox[key] = { content }; } };
  const keeper = createPromises({ ledger, now: () => clock, post: async () => { order.push("post"); throw new Error("ticket ended (closed)"); } });
  notePost(data, 1868, data.jobs.j, PROMISE, clock);
  for (const t of ["21:16", "21:47", "22:18"]) { clock = at(t); data.jobs.j.state = "blocked"; await keeper.tick(); }
  assert.deepEqual(order, ["post", "notify"]);
  const line = Object.values(data.outbox)[0].content;
  assert.match(line, /could not be posted \(ticket ended \(closed\)\), so the player has heard nothing/);
  assert.doesNotMatch(line, /The player was told/);
});

test("m3: refusals, quoted speech and wait-and-see are not promises", () => {
  const now = at("12:00");
  assert.equal(detect("I will not check that again.", now), null);
  assert.equal(detect("I won't look at that again.", now), null);
  assert.equal(detect('You said "I\'ll check tomorrow" earlier.', now), null);
  assert.equal(detect("We'll see what the turn does.", now), null);
  assert.ok(detect("I'll check the next turn and tell you.", now));
});

test("the promise switch: off wakes nothing, preview records the wake it would make, the kill switch stops it", async () => {
  for (const [controls, expectPreview] of [[staticControls({ promiseWakes: "off" }), false], [staticControls({}, { preview: true }), true], [staticControls({}, { held: "x" }), false]]) {
    const data = { jobs: { j: { id: "j", kind: "ticket", ticket: 1868, state: "blocked" } }, seen: { "ticket:1868": "j" }, channels: {}, outbox: {}, audit: [], ticketPromises: {} };
    const ledger = { data, save() {}, audit(kind) { data.audit.push({ kind }); }, notify() {} };
    const keeper = createPromises({ ledger, now: () => at("21:16"), controls, post: async () => { throw new Error("must not post"); } });
    notePost(data, 1868, data.jobs.j, PROMISE, at("19:45"));
    await keeper.tick();
    assert.equal(data.jobs.j.state, "blocked");
    assert.equal(data.ticketPromises[1868][0].wakes, 0);
    assert.equal(Boolean(data.preview?.items?.["promises:wake:ticket 1868"]), expectPreview);
  }
});
