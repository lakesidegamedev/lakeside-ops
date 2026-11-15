"use strict";
// Keir 10 track W1: the ticket loop core. Lanes and router, the compact ticket
// profile, the case file, delta wakes, the wake cap and the sweeper's closed-ticket skip.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const lanes = require("../lib/operator/ticketlanes");
const casefile = require("../lib/operator/casefile");
const playbooks = require("../lib/operator/playbooks");
const lifecycle = require("../lib/operator/lifecycle");
const { createSweeper, supportRecordClosed } = require("../lib/operator/sweeper");
const { createAgent } = require("../lib/operator/agent");
const { createLedger } = require("../lib/operator/store");

const NOW = Date.parse("2026-11-06T17:00:00Z"), H = 3600000, MIN = 60000;
const ticket = (over = {}) => ({ id: "t1", kind: "ticket", role: "support", ticket: 9, channelId: "c", source: { content: "hello", at: new Date(NOW).toISOString() }, ...over });
const withText = (text, over = {}) => ticket({ source: { content: text, at: new Date(NOW).toISOString() }, ...over });
const staleLock = { lock: { verdict: "stale", isProcessing: true, runningMin: 95, heartbeatAgeSec: 2400, overdueMin: 42 }, turns: [{ turn: 818, success: true }] };
const healthyLock = { lock: { verdict: "idle", isProcessing: false, overdueMin: null }, turns: [{ turn: 819, success: true }] };

// ---------- router ----------
test("a how-to question routes to the question lane", () => {
  const job = withText("how do I assign generals to a conflict", { tags: { kind: "mechanics_question" } });
  const r = lanes.route(job, {}, null);
  assert.equal(r.lane, "question");
  assert.match(r.reason, /how-to/);
});

test("turn stuck with a stale lock routes to outage, and the outage playbook does not ask for the reporter's records", () => {
  const job = withText("turn stuck processing, turn 819 overdue", { tags: { kind: "bug_report", urgency: "high" } });
  const r = lanes.route(job, {}, staleLock);
  assert.equal(r.lane, "outage");
  assert.match(r.reason, /stale|overdue/);
  lanes.assign(job, r);
  const d = { jobs: { t1: job } };
  const book = playbooks.playbookFor(job, d);
  assert.equal(book.lane, "outage");
  assert.ok(!book.steps.some((s) => /reporter/i.test(s.label)), "outage never demands the reporter's corporation or sector records");
  assert.match(playbooks.finishRefusal(job, d, "done"), /live turn state/);
  job.investigatedReads = 1; job.raisedToDevelopers = [{ id: 5 }]; job.lastPlayerAt = 1; job.lastAskAt = 2;
  assert.equal(playbooks.finishRefusal(job, d, "done"), null);
});

test("a turn complaint with a healthy live check is not an outage; a failed check falls back to tags", () => {
  const job = withText("the turn is stuck for me", { tags: { kind: "bug_report", urgency: "normal" } });
  assert.equal(lanes.route(job, {}, healthyLock).lane, "bug");
  assert.equal(lanes.route(job, {}, { error: "timeout" }).lane, "bug");
  const loud = withText("the turn is stuck for me", { tags: { kind: "bug_report", urgency: "outage" } });
  assert.equal(lanes.route(loud, {}, { error: "timeout" }).lane, "outage");
  assert.equal(lanes.route(loud, {}, null).lane, "outage");
});

test("a lock verdict, an overdue turn, a stale heartbeat and a failed latest turn all count as turn trouble", () => {
  assert.match(lanes.turnTrouble({ lock: { verdict: "stuck" } }), /stuck/);
  assert.match(lanes.turnTrouble({ lock: { overdueMin: 30 } }), /overdue/);
  assert.match(lanes.turnTrouble({ lock: { isProcessing: true, heartbeatAgeSec: 900 } }), /heartbeat/);
  assert.match(lanes.turnTrouble({ lock: { verdict: "idle" }, turns: [{ turn: 3, success: false }] }), /failed/);
  assert.equal(lanes.turnTrouble(healthyLock), null);
  assert.equal(lanes.turnTrouble({ error: "x" }), null);
});

test("a slideshow display bug routes to the bug lane", () => {
  const job = withText("the slideshow on the home page shows the wrong picture and flickers", { tags: { kind: "bug_report" } });
  assert.equal(lanes.route(job, {}, null).lane, "bug");
  assert.equal(lanes.route(withText("x", { tags: {} }), { channels: { c: { category: "bug" } } }, null).lane, "bug");
});

test("a ban appeal routes to the people lane, from the tag, the category or the words", () => {
  assert.equal(lanes.route(withText("please review my ban, I want to appeal", { tags: { kind: "moderation" } }), {}, null).lane, "people");
  assert.equal(lanes.route(withText("please review my ban, I want to appeal", { tags: { kind: "other" } }), {}, null).lane, "people");
  assert.equal(lanes.route(withText("hi", { tags: {} }), { channels: { c: { category: "moderation" } } }, null).lane, "people");
});

test("advice, ideas, repairs and incident candidates each get their lane", () => {
  assert.equal(lanes.route(withText("where should I invest to make more profit?", { tags: { kind: "gameplay_advice" } }), {}, null).lane, "advice");
  assert.equal(lanes.route(withText("add a dark mode", { tags: { kind: "feature_request" } }), {}, null).lane, "idea");
  assert.equal(lanes.route(withText("the balance should be argued differently", { tags: { kind: "design_feedback" } }), {}, null).lane, "idea");
  assert.equal(lanes.route(withText("I lost 5m when the bond matured", { tags: { kind: "data_repair" } }), {}, null).lane, "data_repair");
  assert.equal(lanes.route(withText("nothing loads", { tags: { kind: "bug_report" }, incidentCandidates: [{ number: 4 }] }), {}, null).lane, "outage");
  const unknown = lanes.route(withText("hmm", { tags: {} }), {}, null);
  assert.equal(unknown.lane, "bug"); assert.equal(unknown.defaulted, true);
});

test("a lane changes later only with a reason, and the history is kept", () => {
  const job = withText("how does tax work", { tags: { kind: "mechanics_question" } });
  lanes.assign(job, lanes.route(job, {}, null), { at: 1 });
  assert.equal(job.lane, "question");
  assert.throws(() => lanes.change(job, "bug", ""), /needs a reason/);
  lanes.change(job, "bug", "the player showed a wrong figure", { at: 2 });
  assert.equal(job.lane, "bug");
  assert.deepEqual(job.laneHistory.map((h) => [h.from, h.to]), [[null, "question"], ["question", "bug"]]);
  assert.match(job.laneHistory[1].reason, /wrong figure/);
  assert.throws(() => lanes.assign(job, { lane: "nope", reason: "x" }), /unknown lane/);
});

test("the live check reads the lock and the recent turns, and survives slow or broken reads", async () => {
  const seen = [];
  const live = await lanes.gatherLive(async (server, tool) => { seen.push(`${server}/${tool}`); return tool === "lock_status" ? JSON.stringify(staleLock.lock) : staleLock.turns; });
  assert.deepEqual(seen.sort(), ["engine/recent_turns", "turndiag/lock_status"]);
  assert.match(lanes.turnTrouble(live), /stale/);
  const slow = await lanes.gatherLive(() => new Promise(() => {}), { timeoutMs: 20 });
  assert.ok(slow.error);
  const half = await lanes.gatherLive(async (_s, tool) => { if (tool === "recent_turns") throw new Error("down"); return staleLock.lock; });
  assert.match(lanes.turnTrouble(half), /stale/);
});

test("a first ticket activation runs the router and the live check in the agent, and a failed check falls back to tags", async (t) => {
  const f = fixture(t, { content: "turn stuck processing, turn 819 overdue", tags: { kind: "bug_report", urgency: "high", kindConfidence: 0.9 }, live: staleLock });
  await f.run();
  assert.equal(f.job.lane, "outage");
  assert.ok(f.reads.includes("turndiag/lock_status") && f.reads.includes("engine/recent_turns"));
  const g = fixture(t, { content: "turn stuck processing, turn 819 overdue", tags: { kind: "bug_report", urgency: "normal", kindConfidence: 0.9 }, live: "fail" });
  await g.run();
  assert.equal(g.job.lane, "bug");
});

// ---------- profile sizes ----------
function fixture(t, { content = "how do I assign generals to a conflict", tags = { kind: "mechanics_question", complexity: "simple", kindConfidence: 0.9 }, live = null, history = 0, inboxBulk = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir10-loop-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { stateDir: dir, briefFile: path.join(__dirname, "../KEIR.md"), coreBriefFile: path.join(__dirname, "../KEIR-CORE.md"), model: "fixture", provider: "claude:fixture", taskLifetimeMs: 60000, skills: false, tagIntake: async () => tags, dynamicEffort: false, ownerId: "owner", repositories: {}, orientation: true, maxRounds: 20, ticketMaxRounds: 16, quickMaxRounds: 6, maxTurnMs: 60000, quickMaxTurnMs: 30000 };
  const job = ledger.createJob("ticket:9", { kind: "ticket", role: "support", ticket: 9, channelId: "c1", replyChannel: "c1", source: { channelId: "c1", channelName: "ticket-9", content, at: new Date().toISOString() } });
  ledger.data.channels["c1"] = { category: "mechanics" };
  job.history = Array.from({ length: history }, (_, i) => ({ at: new Date().toISOString(), kind: "checkpoint", summary: `earlier step ${i} `.repeat(30) }));
  const reads = [];
  const broker = {
    servers: () => ["gamestate", "support", "ops-knowledge"],
    tool: async (j, name, input) => {
      if (name === "finish") { j.state = "waiting"; return { state: j.state }; }
      if (name === "read_servers") return ["gamestate", "support", "ops-knowledge"];
      if (name === "read_tools") return [{ name: "game_overview", description: "Overview of the game.", schema: { properties: {} } }];
      if (name === "ticket_history") return [];
      if (name === "ticket_record") return {};
      if (name === "reporter_state") return { character: {} };
      if (name === "read_tool") {
        reads.push(`${input.server}/${input.tool}`);
        if (live === "fail") throw new Error("down");
        return input.tool === "lock_status" ? live?.lock : live?.turns;
      }
      return {};
    },
  };
  let seen;
  const spawnImpl = (_cmd, args) => {
    const child = new EventEmitter(); child.pid = 999999; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = (prompt) => {
      seen = { brief: args[args.indexOf("--system-prompt") + 1], prompt: String(prompt) };
      setImmediate(() => { child.stdout.emit("data", JSON.stringify({ type: "result", subtype: "success", result: "ok", usage: {} }) + "\n"); child.emit("close", 0); });
    };
    return child;
  };
  const agent = createAgent({ ledger, config, broker, spawnImpl });
  return { ledger, job, reads, get seen() { return seen; }, run: async () => { job.state = "queued"; await agent.run(job, new AbortController().signal); } };
}

test("question lane: the first activation stays under 40k characters and runs the compact ticket profile", async (t) => {
  const f = fixture(t, { history: 10 });
  await f.run();
  assert.equal(f.job.lane, "question");
  assert.equal(f.job.contextBudget.profile, "ticket");
  const total = f.seen.brief.length + f.seen.prompt.length;
  t.diagnostic(`question first activation: brief ${f.seen.brief.length} + context ${f.seen.prompt.length} = ${total}`);
  assert.ok(total < 40000, `question first activation is ${total} characters`);
  const ctx = JSON.parse(f.seen.prompt);
  assert.equal(ctx.lane.id, "question");
  assert.ok(ctx.caseFile, "the case file replaces the scattered blobs");
  assert.equal(ctx.previousActivations, undefined);
  assert.equal(ctx.priorInvestigation, undefined);
  assert.equal(ctx.ticketRecord, undefined);
  assert.equal(ctx.statusCard, undefined, "a question needs no progress card");
  assert.match(f.seen.brief, /## Lane: question/);
  assert.ok(ctx.playbook.steps.some((s) => /spin it out/i.test(s)));
});

test("bug lane: the first activation is full, then a wake is compact and under 25k", async (t) => {
  const f = fixture(t, { content: "my holdings page shows the wrong total", tags: { kind: "bug_report", complexity: "moderate", kindConfidence: 0.9 }, history: 10 });
  await f.run();
  assert.equal(f.job.lane, "bug");
  assert.equal(f.job.contextBudget.profile, "full");
  assert.ok(f.seen.brief.length > 40000, "the full brief still loads for a bug's first look");
  f.job.inbox = [{ role: "player", authorId: "p1", messageId: "m2", at: new Date(Date.now() + 5).toISOString(), content: "any news? it still looks wrong" }];
  await f.run();
  assert.equal(f.job.contextBudget.profile, "ticket");
  assert.equal(f.job.contextBudget.wake, true);
  const total = f.seen.brief.length + f.seen.prompt.length;
  t.diagnostic(`bug wake: brief ${f.seen.brief.length} + context ${f.seen.prompt.length} = ${total}`);
  assert.ok(total < 25000, `a wake is ${total} characters`);
  const ctx = JSON.parse(f.seen.prompt);
  assert.ok(Object.keys(ctx)[0] === "whatChanged", "the delta leads the prompt");
  assert.equal(ctx.whatChanged.newMessages, 1);
  assert.equal(ctx.orientation, undefined, "no orientation discovery on a wake");
  assert.equal(ctx.readyReads, undefined);
});

test("a lane change into the outage lane gives the next run the full context once", async (t) => {
  const f = fixture(t, { content: "turn stuck processing, turn 819 overdue", tags: { kind: "mechanics_question", complexity: "simple", kindConfidence: 0.9 }, live: healthyLock });
  await f.run();
  assert.equal(f.job.lane, "question", "a healthy live check leaves the tag's lane");
  assert.equal(f.job.contextBudget.profile, "ticket");
});

// ---------- case file ----------
test("the case file gathers record, posts, promises, open questions, fixes and the post budget", () => {
  const job = ticket({ ticket: 9, lane: "bug", laneReason: "intake tagged it a bug", lastAskAt: NOW - 3 * H, lastPlayerAt: NOW - H,
    raisedToDevelopers: [{ id: 41, title: "Holdings total double counts bonds", kind: "bug" }], pullRequests: [{ number: 77, state: "open" }],
    source: { content: "Why is my total wrong? And when will it be fixed?", at: new Date(NOW - H).toISOString() }, requestInbox: [] });
  const posts = Array.from({ length: 10 }, (_, i) => ({ at: NOW - (10 - i) * H, text: `Post number ${i} about the bond total.` }));
  const ledger = { data: {
    jobs: { t1: job }, decisions: { x: { jobId: "t1", state: "approved", question: "Repair the total?", answer: "yes" } },
    ticketPosts: { 9: [...posts, { at: NOW, text: "Card text", kind: "status_card" }] },
    statusCards: { 9: { items: [{ name: "Bond total", stage: "written" }, { name: "Display", stage: "found", blocked: true, note: "waits on a developer" }] } },
    ticketRecords: { 9: { facts: [{ text: "The bond total counts issuer and holder rows", source: "trace_account" }, { text: "closed fact", closedAt: "x" }], ruledOut: [{ text: "Not a rounding issue" }], promises: [{ text: "Update the player after the next turn" }], questions: [{ text: "Which screen?" }] } },
    ticketObservations: { 9: [{ tool: "read_tool", at: NOW - 5 * H, input: "{\"server\":\"gamestate\"}" }] },
  } };
  const cf = casefile.caseFile(ledger, job, { broker: { postBudget: () => 2 }, now: NOW });
  assert.equal(cf.ticket, 9); assert.equal(cf.lane, "bug");
  assert.equal(cf.toldPlayer.length, 8, "the last eight posts, card posts excluded");
  assert.match(cf.toldPlayer.at(-1).text, /Post number 9/); assert.match(cf.toldPlayer[0].at, /^2026-11-06/);
  assert.deepEqual(cf.know.map((k) => k.text), ["The bond total counts issuer and holder rows"]);
  assert.deepEqual(cf.promises, ["Update the player after the next turn"]);
  assert.deepEqual(cf.openQuestions.fromPlayer, ["Why is my total wrong?", "And when will it be fixed?"]);
  assert.deepEqual(cf.openQuestions.recorded, ["Which screen?"]);
  assert.deepEqual(cf.fixes.map((x) => [x.name, x.stage]), [["Bond total", "written"], ["Display", "found"]]);
  assert.equal(cf.fixes[1].blocked, "waits on a developer");
  assert.equal(cf.raised[0].id, 41); assert.equal(cf.pullRequests[0].number, 77);
  assert.equal(cf.decisions[0].answer, "yes");
  assert.equal(cf.postsLeft, 2);
  assert.equal(cf.readsDone.length, 1);
  assert.ok(JSON.stringify(cf).length < 5000, "the case file stays short");
  // Without W2's budget the key is simply absent; answered questions are not open.
  job.lastAskAt = NOW;
  const later = casefile.caseFile(ledger, job, { now: NOW });
  assert.equal(later.postsLeft, undefined);
  assert.deepEqual(later.openQuestions.fromPlayer, []);
});

test("the case file of a ticket with nothing recorded is nearly empty, not an error", () => {
  const job = ticket();
  const cf = casefile.caseFile({ data: { jobs: {} } }, job);
  assert.deepEqual(Object.keys(cf), ["ticket", "lastPlayerAt"].filter((k) => k in cf));
  assert.equal(cf.toldPlayer, undefined);
  assert.equal(cf.fixes, undefined);
});

// ---------- delta wake ----------
test("a wake reports only what changed since the last activation, and a first activation has no delta", () => {
  const since = NOW - 2 * H;
  const job = ticket({ activationCount: 2, prevActivationAt: since, lane: "bug",
    requestInbox: [{ role: "player", messageId: "old", at: new Date(since - H).toISOString(), content: "old message" }],
    inbox: [
      { role: "player", authorId: "p1", messageId: "new", at: new Date(since + MIN).toISOString(), content: "it is still wrong" },
      { role: "system", investigationResult: true, at: new Date(since + 2 * MIN).toISOString(), content: "worker found the double count" },
      { role: "system", authorId: "turn-watch", at: new Date(since + 3 * MIN).toISOString(), content: "turn 820 processed" },
    ],
    history: [{ at: new Date(since + MIN).toISOString(), kind: "refused", summary: "Refused: unverified claim" }, { at: new Date(since - MIN).toISOString(), kind: "refused", summary: "older refusal" }] });
  const ledger = { data: { jobs: {}, decisions: { d1: { jobId: "t1", state: "approved", answer: "yes", question: "Run the repair?", answeredAt: since + 5 * MIN } }, statusCards: { 9: { at: since + MIN, items: [{ name: "Fix", stage: "tested" }] } } } };
  const delta = casefile.whatChanged(ledger, job, { now: NOW });
  assert.deepEqual(delta.messages.map((m) => m.text), ["it is still wrong"]);
  assert.equal(delta.results[0].kind, "investigation");
  assert.match(delta.events[0].text, /turn 820/);
  assert.equal(delta.decisionAnswers[0].answer, "yes");
  assert.deepEqual(delta.refusals, ["Refused: unverified claim"]);
  assert.deepEqual(delta.cardNow, ["Fix: tested"]);
  assert.equal(casefile.whatChanged(ledger, { ...job, activationCount: 1 }), null);
});

test("a wake with nothing new says so instead of replaying the ticket", () => {
  const job = ticket({ activationCount: 3, prevActivationAt: NOW - H, requestInbox: [], inbox: [] });
  const delta = casefile.whatChanged({ data: { jobs: {} } }, job);
  assert.equal(delta.messages, undefined);
  assert.ok(delta.since);
});

test("the question lane counts the player's questions and tells the model to close after eight or a day", () => {
  const job = withText("q0?", { lane: "question", at: NOW });
  casefile.observe(job);
  assert.equal(lanes.questionLimit(job, NOW + MIN), null);
  for (let i = 1; i <= 8; i++) { job.inbox = [{ role: "player", messageId: `m${i}`, at: new Date(NOW + i).toISOString(), content: `question ${i}?` }]; casefile.observe(job); }
  assert.equal(job.playerMessageCount, 9);
  const limit = lanes.questionLimit(job, NOW + MIN);
  assert.ok(limit); assert.match(limit.instruction, /fresh ticket|open_ticket/);
  const old = withText("q?", { lane: "question", at: NOW - 25 * H }); old.source.at = new Date(NOW - 25 * H).toISOString();
  assert.ok(lanes.questionLimit(old, NOW));
  assert.equal(lanes.questionLimit({ ...old, lane: "bug" }, NOW), null);
});

// ---------- wake cap ----------
const wakeCtx = (now = NOW) => ({ now, config: { taskLifetimeMs: 6 * H }, claimedBy: () => null, directiveHeld: () => false });
const runner = (over = {}) => ({ id: "j1", kind: "ticket", role: "support", ticket: 5, channelId: "c1", state: "blocked", inbox: [], effects: {}, rounds: 2, deadline: NOW + 6 * H, ...over });

test("a ticket job cannot be requeued more than six times an hour without a human message", () => {
  const runs = Array.from({ length: 6 }, (_, i) => NOW - (50 - i * 8) * MIN);
  const j = runner({ runStarts: runs, inbox: [{ role: "system", authorId: "developer-watch", content: "ci finished" }] });
  const effects = lifecycle.wakeStep(j, wakeCtx());
  assert.equal(j.state, "waiting");
  assert.ok(j.wakeAt > NOW);
  assert.equal(effects.filter((e) => e.kind === "wake_capped").length, 1);
  // Again on the next drain: still held, and the audit row does not repeat.
  const again = lifecycle.wakeStep(j, wakeCtx(NOW + MIN));
  assert.equal(again.filter((e) => e.kind === "wake_capped").length, 0);
  assert.equal(j.state, "waiting");
  // A timer wake while capped is parked again.
  j.wakeAt = NOW; j.inbox = [];
  lifecycle.wakeStep(j, wakeCtx(NOW + 2 * MIN));
  assert.equal(j.state, "waiting");
  // A player message always passes.
  j.inbox = [{ role: "player", authorId: "p1", content: "hello?" }];
  lifecycle.wakeStep(j, wakeCtx(NOW + 3 * MIN));
  assert.equal(j.state, "queued");
  assert.equal(j.wakeCappedAt, undefined);
});

test("the cap lifts when the oldest run ages out, and the daily cap holds at forty", () => {
  const j = runner({ state: "waiting", wakeAt: 0, runStarts: Array.from({ length: 6 }, (_, i) => NOW - 30 * MIN - i * MIN) });
  lifecycle.wakeStep(j, wakeCtx());
  assert.equal(j.state, "waiting");
  const later = NOW + 40 * MIN;
  j.wakeAt = later;
  lifecycle.wakeStep(j, wakeCtx(later));
  assert.equal(j.state, "queued", "five runs in the last hour is under the cap");
  const day = runner({ state: "queued", runStarts: Array.from({ length: 40 }, (_, i) => NOW - 2 * H - i * 20 * MIN) });
  const eff = lifecycle.wakeStep(day, wakeCtx());
  assert.equal(day.state, "waiting");
  assert.equal(eff.find((e) => e.kind === "wake_capped").detail.window, "day");
  assert.equal(lifecycle.wakeCapped(runner({ runStarts: [] }), NOW), null);
});

test("the cap does not touch owner work, coding children or jobs that never ran", () => {
  const runs = Array.from({ length: 9 }, (_, i) => NOW - i * MIN);
  for (const over of [{ role: "owner" }, { codingParent: "p1" }, { kind: "conversation", ticket: undefined }]) {
    const j = runner({ state: "queued", runStarts: runs, ...over });
    lifecycle.wakeStep(j, wakeCtx());
    assert.equal(j.state, "queued", JSON.stringify(over));
  }
  const fresh = runner({ state: "queued" });
  lifecycle.wakeStep(fresh, wakeCtx());
  assert.equal(fresh.state, "queued");
});

// ---------- sweeper ----------
function sweeperSetup(t, over = {}, hooks = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir10-sweep-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const root = ledger.createJob("t", { kind: "ticket", role: "support", ticket: 7, source: { channelName: "ticket-bug-x-7", content: "bonds wrong" }, ...over });
  root.state = "waiting"; root.at = NOW - 30 * H; root.lastPublishedAt = NOW - 29 * H; root.observedPlayerAt = NOW - 30 * H;
  return { ledger, root, sweeper: createSweeper({ ledger, config: {}, now: () => NOW, ...hooks }) };
}

test("the sweeper skips a ticket whose support record is closed, resolved or merged", (t) => {
  const open = sweeperSetup(t);
  assert.equal(open.sweeper.tick().actions.length, 1, "control: an open stale ticket is swept");
  for (const status of ["closed", "resolved", "merged"]) {
    const f = sweeperSetup(t);
    f.ledger.data.ticketOutcomes = { "7:c": { ticket: 7, status, superseded: false } };
    assert.equal(f.sweeper.tick().actions.length, 0, status);
    assert.equal(f.root.state, "waiting");
    assert.equal(Object.keys(f.ledger.data.outbox || {}).filter((k) => k.startsWith("sweeper-owner")).length, 0);
  }
  const reopened = sweeperSetup(t);
  reopened.ledger.data.ticketOutcomes = { "7:c": { ticket: 7, status: "closed", superseded: true } };
  assert.equal(reopened.sweeper.tick().actions.length, 1, "a reopened ticket is swept again");
  const hooked = sweeperSetup(t, {}, { supportClosed: (root) => root.ticket === 7 });
  assert.equal(hooked.sweeper.tick().actions.length, 0);
  assert.equal(supportRecordClosed({ ticketOutcomes: { a: { ticket: 7, status: "open" } } }, 7, {}, null), false);
});

// ---------- profiles and lane tables ----------
test("every lane defines a playbook, a round budget, tool groups and an exit test", () => {
  for (const id of lanes.LANE_IDS) {
    const lane = lanes.LANES[id];
    assert.ok(playbooks.PLAYBOOKS[lane.playbook], `${id} has a playbook`);
    assert.ok(lane.maxRounds > 0 && lane.exit.length > 20, id);
    assert.ok(Array.isArray(lane.directTools), id);
    assert.equal(playbooks.LANE_PLAYBOOK[id], lane.playbook);
  }
  assert.equal(lanes.LANES.question.fullFirst, false);
  assert.ok(lanes.LANES.bug.fullFirst && lanes.LANES.data_repair.fullFirst && lanes.LANES.outage.fullFirst);
  assert.equal(lanes.LANES.question.skills, false);
  assert.ok(lanes.LANES.bug.skills);
});

test("the question lane exit has no card and no owner decision, and a spin-out step", () => {
  const job = withText("how does tax work", { lane: "question" });
  const book = playbooks.playbookFor(job, { jobs: {} });
  assert.deepEqual(book.steps.map((s) => s.id), ["check_rule", "answer", "spin_out"]);
  assert.equal(book.steps.find((s) => s.id === "spin_out").required, false);
  assert.match(lanes.LANES.question.exit, /No progress card and no owner decision/);
});

test("the chat profile follows lane and wake, not tagger confidence", () => {
  const cc = require("../lib/operator/chatcontext");
  const q = ticket({ lane: "question", tags: { kind: "mechanics_question", kindConfidence: 0.2 } });
  assert.equal(cc.profile(q), "ticket");
  const bug = ticket({ lane: "bug" });
  assert.equal(cc.profile(bug), "full");
  assert.equal(cc.profile({ ...bug, activationCount: 3 }), "ticket");
  assert.equal(cc.profile({ ...bug, activationCount: 3, fullContextNext: true }), "full");
  assert.equal(cc.profile(ticket()), "full", "an unrouted ticket stays full");
  assert.equal(cc.profile({ ...q, role: "owner" }), "full");
});
