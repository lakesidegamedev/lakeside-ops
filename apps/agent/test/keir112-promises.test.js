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
  assert.match(Object.entries(w.data.outbox).find(([k]) => k.startsWith("promise-overdue:1868:"))[1].content, /and two wakes did not produce it/, "an unchained promise had two wakes");
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

test("B3 and N2: a promise made in the wake reply is recorded, chained to the woken one, and the chain stays bounded", async () => {
  const w = world();
  w.job.state = "waiting";
  notePost(w.data, 1868, w.job, "I'll check the next turn and tell you what changed.", at("19:45"));
  w.set("21:16"); await w.keeper.tick();
  assert.equal(w.data.audit.filter((a) => a.kind === "promise_wake").length, 1);
  // The woken activation says it cannot confirm yet and promises to come back: a real promise the player now holds.
  notePost(w.data, 1868, w.job, "I can't confirm this yet. I'm waiting for the turn to finish and I'll update you here once it has run.", at("21:20"), { askedAt: at("19:00") });
  const rows = w.data.ticketPromises[1868];
  assert.deepEqual(rows.map((p) => p.state), ["ended", "open"], "review N2: the new promise is tracked, not dropped");
  assert.equal(rows[1].chainedFrom, rows[0].id);
  assert.equal(rows[1].wakes, 1, "it inherits the wake already spent");
  // B3's side: the chain cannot feed itself. One more wake, then the plain line, then nothing.
  w.job.state = "done";
  for (const t of ["22:00", "23:00", "23:40", "23:59"]) { w.set(t); await w.keeper.tick(); w.job.state = "done"; }
  assert.equal(w.data.audit.filter((a) => a.kind === "promise_wake").length, 2, "two wakes in all, no loop");
  assert.equal(w.posted.length, 1, "then the one plain line");
  assert.equal(rows[1].state, "failed");
  // The player asks again: a fresh promise starts with its own two wakes.
  notePost(w.data, 1868, w.job, "I'll check the next turn and tell you what changed.", at("23:59"), { askedAt: at("23:58") });
  assert.equal(w.data.ticketPromises[1868].at(-1).wakes, 0);
});

test("N2: a holding line after a wake with no promise in it records nothing; an unrelated reply no longer keeps a promise", () => {
  const w = world();
  notePost(w.data, 1868, w.job, "I'll check the bond yields tomorrow and tell you why the price fell.", at("08:00"));
  // Twelve hours later (past half way), Keir answers something else on the ticket: the promise stays open.
  notePost(w.data, 1868, w.job, "Your factory license was renewed on its own.", at("20:00"), { askedAt: at("19:59") });
  assert.equal(w.data.ticketPromises[1868][0].state, "open");
  // A reply on the same subject keeps it.
  notePost(w.data, 1868, w.job, "The bond yields rose and the price fell because the central bank raised rates.", at("21:00"), { askedAt: at("19:59") });
  assert.equal(w.data.ticketPromises[1868][0].state, "kept");
  // After a wake, a plain "can't confirm" with no new promise records nothing new.
  const w2 = world();
  w2.data.ticketPromises = { 1868: [{ id: "1868-a", at: at("08:00"), jobId: w2.job.id, state: "open", wakes: 1, wokenAt: at("12:00"), kind: "plain", text: "I'll check this.", dueAt: at("12:00") }] };
  assert.equal(notePost(w2.data, 1868, w2.job, "I can't confirm this yet; the fix is not on the main server.", at("12:05"), { askedAt: at("07:00") }), null);
  assert.deepEqual(w2.data.ticketPromises[1868].map((p) => p.state), ["ended"]);
});

test("N2: a negation counts only inside the promise clause", () => {
  const now = at("12:00");
  assert.ok(detect("I will check after the next turn, it won't take long.", now));
  assert.ok(detect("I'll let you know once it's live so you won't need to ask again.", now));
  assert.equal(detect("I will not check that again.", now), null);
  assert.equal(detect("We will never update this ticket again.", now), null);
  assert.equal(detect("I won't look at that again.", now), null);
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

test("m1: a promise never requeues a job held for a person, but the player still gets the plain line after two wakes", async () => {
  const w = world();
  notePost(w.data, 1868, w.job, PROMISE, at("19:45"));
  w.job.state = "blocked"; w.job.deadlineBlockedAt = at("19:50"); // the owner must choose the next move
  for (const t of ["21:16", "21:47", "22:18"]) { w.set(t); await w.keeper.tick(); assert.equal(w.job.state, "blocked"); }
  assert.equal(w.data.audit.filter((a) => a.kind === "promise_wake").length, 2);
  assert.equal(w.posted.length, 1, "not silent: the plain line went out");
  // The other side (ticket 1868): blocked by the activation time limit is not held for a person, so it is woken.
  const v = world();
  notePost(v.data, 1868, v.job, PROMISE, at("19:45"));
  v.job.state = "blocked"; v.job.summary = "activation aborted: no result before the 15-minute turn limit";
  v.set("21:16"); await v.keeper.tick();
  assert.equal(v.job.state, "queued");
});

// Review 3 F2 (the reviewer's chain.js): a promise made in a wake reply keeps its own due time. Turn 51 ran at 21:00, Keir
// was woken at 21:05, said it could not confirm yet and promised to check after the next turn (52, due 23:00). Nothing may
// wake it, and no code holding line may go out, before turn 52 runs.
function chainWorld() {
  const w = world();
  w.data.watch = { turnClock: { turn: 50, iteration: 3, at: at("19:45"), nextTurn: at("21:00") } };
  const turn = (n, t, next) => { w.set(t); w.data.watch.turnClock = { turn: n, iteration: 3, at: at(t), nextTurn: at(next) }; };
  const fresh = (t) => { w.set(t); w.data.watch.turnClock.at = at(t); };
  return { ...w, turn, fresh };
}
const wakes = (w) => w.data.audit.filter((a) => a.kind === "promise_wake");

test("F2: a promise made in a wake reply is woken once, after the turn it named runs, then at most one holding line", async () => {
  const w = chainWorld();
  w.job.state = "waiting";
  notePost(w.data, 1868, w.job, "I'll check the next turn and tell you what changed.", at("19:45"));
  w.turn(51, "21:05", "23:00"); await w.keeper.tick();
  assert.equal(wakes(w).length, 1);
  w.fresh("21:10");
  notePost(w.data, 1868, w.job, "I can't confirm this yet: the market had not settled. I'll check after the next turn and tell you what changed.", at("21:10"), { askedAt: at("19:00") });
  const chained = w.data.ticketPromises[1868].at(-1);
  assert.equal(chained.afterTurn, 52);
  assert.equal(chained.wakes, 1);
  // The reviewer's ticks, and every five minutes until 22:55: turn 52 has not run.
  for (let m = at("21:11"); m <= at("22:55"); m += 5 * 60000) { w.fresh(new Date(m).toISOString().slice(11, 16)); w.job.state = "waiting"; await w.keeper.tick(); }
  assert.equal(wakes(w).length, 1, "not woken before turn 52");
  assert.equal(w.posted.length, 0, "no code holding line before the promise is due");
  assert.deepEqual(Object.keys(w.data.outbox), [], "the owner is not told a promise failed");
  assert.equal(chained.state, "open");
  // Turn 52 runs: one wake.
  w.turn(52, "23:02", "01:00"); await w.keeper.tick();
  assert.equal(wakes(w).length, 2);
  assert.equal(wakes(w)[1].promise, chained.id);
  // No follow-up: the one holding line after the retry, and nothing more.
  for (const t of ["23:10", "23:33", "23:40", "23:55"]) { w.fresh(t); w.job.state = "waiting"; await w.keeper.tick(); }
  assert.equal(w.posted.length, 1);
  assert.equal(w.posted[0].text, FALLBACK);
  assert.equal(chained.state, "failed");
  assert.equal(wakes(w).length, 2);
  // Review 4 m3: the owner line is true for a chained promise, which had one wake of its own.
  const line = Object.entries(w.data.outbox).find(([k]) => k === `promise-overdue:1868:${chained.id}`)[1].content;
  assert.match(line, /and its wake did not produce it/);
  assert.doesNotMatch(line, /two wakes/);
});

test("F2: the same chain where Keir answers after turn 52 keeps the promise and posts nothing from code", async () => {
  const w = chainWorld();
  w.job.state = "waiting";
  notePost(w.data, 1868, w.job, "I'll check the next turn and tell you what changed.", at("19:45"));
  w.turn(51, "21:05", "23:00"); await w.keeper.tick();
  notePost(w.data, 1868, w.job, "I can't confirm this yet: the market had not settled. I'll check after the next turn and tell you what changed.", at("21:10"), { askedAt: at("19:00") });
  w.turn(52, "23:02", "01:00"); await w.keeper.tick();
  notePost(w.data, 1868, w.job, "Turn 52 has run: your revenue rose by 4 percent after the fix.", at("23:08"), { askedAt: at("19:00") });
  for (const t of ["23:40", "23:59"]) { w.fresh(t); w.job.state = "waiting"; await w.keeper.tick(); }
  assert.equal(w.data.ticketPromises[1868].at(-1).state, "kept");
  assert.equal(w.posted.length, 0);
});

test("F2 and B3: a wake reply that promises again every turn never loops; wakes follow real turns and stop at the day cap", async () => {
  const w = chainWorld();
  w.job.state = "waiting";
  notePost(w.data, 1868, w.job, "I'll check the next turn and tell you what changed.", at("00:00"));
  w.data.watch.turnClock = { turn: 50, iteration: 3, at: at("00:00"), nextTurn: at("02:00") };
  const wakeTimes = [];
  let turn = 50;
  // A day of five-minute ticks, a turn every two hours. Every wake is answered with "can't confirm, next turn".
  for (let m = at("00:05"); m < at("23:59"); m += 5 * 60000) {
    const hh = new Date(m).toISOString().slice(11, 16);
    if (new Date(m).getUTCMinutes() === 5 && new Date(m).getUTCHours() % 2 === 0 && m > at("01:00")) turn++;
    w.set(hh); w.data.watch.turnClock = { turn, iteration: 3, at: m, nextTurn: m + 2 * 3600000 - 5 * 60000 };
    const before = wakes(w).length;
    w.job.state = "waiting"; await w.keeper.tick();
    if (wakes(w).length > before) {
      wakeTimes.push({ hh, turn });
      notePost(w.data, 1868, w.job, "I can't confirm this yet. I'll check after the next turn and tell you what changed.", m + 60000, { askedAt: at("00:00") - 60000 });
    }
  }
  assert.ok(wakeTimes.length <= 4, `at most four wakes a day, got ${wakeTimes.length}`);
  // Each wake follows a different turn: never two wakes for the same turn, never a wake minutes after the last one.
  assert.equal(new Set(wakeTimes.map((x) => x.turn)).size, wakeTimes.length);
  assert.ok(w.posted.length <= 1, "at most one code holding line");
});
