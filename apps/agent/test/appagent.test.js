"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createConversation } = require("../lib/operator/conversation");
const { createAppChannel } = require("../lib/operator/appchannel");
const { createAppAgent, receiptOf } = require("../lib/operator/appagent");
const { createNotebook } = require("../lib/operator/knowledge");

const config = { ownerId: "333052320252297216", botId: "1479984768194969663", staffIds: ["2"], taskLifetimeMs: 3600000 };
function setup({ time = 1_000_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-agent-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const conversation = createConversation({ ledger, config });
  const clock = { t: time };
  let agent = null;
  const app = createAppChannel({ ledger, config, conversation, agent: () => agent, now: () => clock.t });
  const notebook = createNotebook({ file: path.join(dir, "notebook.json"), exec: () => "", now: () => clock.t });
  agent = createAppAgent({ ledger, config, app, notebook, now: () => clock.t });
  return { ledger, app, agent, notebook, clock };
}

test("threads keep their own live task and messages", () => {
  const { ledger, app, agent } = setup();
  const side = agent.createThread("Bond market");
  const a = app.post("Investigate the bond market spread", null, side.id);
  const b = app.post("Investigate the turn time regression");
  assert.notEqual(a.jobId, b.jobId);
  assert.equal(ledger.data.jobs[a.jobId].appThread, side.id);
  assert.equal(app.view(0, side.id).messages.length, 1);
  assert.equal(app.view(0, "main").messages.length, 1);
  assert.throws(() => app.post("hello there", null, "watches"), /unknown thread/);
  assert.throws(() => app.post("hello there", null, "nope00"), /unknown thread/);
  assert.deepEqual(agent.threads().map((t) => t.id).slice(0, 1), ["main"]);
  agent.updateThread(side.id, { archived: true });
  assert.ok(!agent.threads().some((t) => t.id === side.id));
});

test("retrying a model-created side chat preserves the same chat and its deletion", async () => {
  const { agent } = setup();
  const creationKey = "sup:j_1234567890abcdef:1234567890abcdef";
  const first = await agent.route("/threads", "POST", { title: "Payroll review", creationKey });
  const retry = await agent.route("/threads", "POST", { title: "Payroll review", creationKey });
  assert.equal(first.id, retry.id);
  assert.equal(agent.threads().filter((thread) => thread.id === first.id).length, 1);
  agent.updateThread(first.id, { archived: true });
  assert.equal((await agent.route("/threads", "POST", { title: "Payroll review", creationKey })).archived, true);
  assert.ok(!agent.threads().some((thread) => thread.id === first.id));
});

test("activity shows owner tasks with receipts, and retry and stop work", () => {
  const { ledger, app, agent } = setup();
  const { jobId } = app.authenticatedPost("Merge the green dev PR for the bond fix");
  const job = ledger.data.jobs[jobId];
  job.effects = { "merge:abc": { state: "done", at: 5, result: { number: 4184 } } };
  job.history = [{ at: "2026-10-15T03:00:00Z", kind: "finish", state: "done", summary: "Merged #4184." }];
  job.pullRequests = ["https://github.com/lakesidegamedev/AHDGame/pull/4184"];
  job.state = "done";
  const list = agent.tasks();
  assert.equal(list[0].id, jobId); assert.equal(list[0].receipts, 1); assert.equal(list[0].surface, "app");
  const detail = agent.task(jobId);
  assert.equal(detail.receipts[0].label, "Merged PR #4184");
  assert.deepEqual(detail.cards[0], { type: "pr", repository: "lakesidegamedev/AHDGame", number: 4184, url: "https://github.com/lakesidegamedev/AHDGame/pull/4184" });
  assert.equal(detail.canRetry, true);
  assert.equal(agent.retry(jobId, "Check CI first").state, "queued");
  assert.match(job.inbox.at(-1).content, /retry.*Check CI first/);
  assert.equal(agent.stop(jobId).state, "cancelled");
  const player = ledger.createJob("p", { kind: "conversation", role: "player", source: {} });
  assert.throws(() => agent.task(player.id), /unknown task/);
});

test("receipts name what was done", () => {
  assert.equal(receiptOf("issue:x", { state: "done", result: { number: 9 } }).label, "Filed issue #9");
  assert.equal(receiptOf("a".repeat(64), { state: "done" }).label, "External action");
});

test("ideas come from Keir's open issues; accept starts an owner task once", () => {
  const { ledger, agent } = setup();
  ledger.data.jobs.j1 = { id: "j1", summary: "Scout found CI rerunning the full matrix on empty back-merges." };
  ledger.data.keirIssues = { 4185: { number: 4185, url: "https://github.com/lakesidegamedev/AHDGame/issues/4185", jobId: "j1", at: 1, state: "open", title: "CI runs the full matrix" },
    4100: { number: 4100, url: "u", at: 1, state: "closed", title: "old" } };
  assert.equal(agent.ideas().length, 1); assert.match(agent.ideas()[0].evidence, /Scout found/);
  const first = agent.decideIdea("4185", "accept"), again = agent.decideIdea("4185", "accept");
  assert.equal(first.taskId, again.taskId);
  assert.equal(ledger.data.jobs[first.taskId].role, "owner"); assert.match(ledger.data.jobs[first.taskId].source.content, /issues\/4185/);
  agent.decideIdea("4185", "dismiss");
  assert.equal(agent.ideas().length, 0);
});

test("watches run read-only checks on schedule and speak only when met", () => {
  const { ledger, app, agent, clock } = setup();
  assert.throws(() => agent.addWatch({ condition: "x" }), /say what/);
  const w = agent.addWatch({ condition: "PR 4184 on AHDGame is merged", every: "hourly" });
  agent.tickWatches();
  const job = ledger.data.jobs[agent.watches()[0].jobId];
  assert.equal(job.kind, "conversation"); assert.equal(job.appThread, "watches"); assert.equal(job.appWatch, w.id);
  assert.match(job.source.content, /NO CHANGE/);
  agent.tickWatches(); assert.equal(agent.watches()[0].runs, 1);
  app.deliver(`channel-reply:${job.id}:a`, { content: "NO CHANGE" }, job);
  assert.equal(app.view(0, "watches").messages.length, 0); assert.equal(agent.watches()[0].lastResult, "no change");
  job.state = "done"; clock.t += 3600001; agent.tickWatches();
  const second = ledger.data.jobs[agent.watches()[0].jobId];
  assert.notEqual(second.id, job.id);
  app.deliver(`channel-reply:${second.id}:b`, { content: "PR 4184 merged at 03:10." }, second);
  const shown = app.view(0, "watches").messages;
  assert.equal(shown.length, 1); assert.equal(shown[0].watch, w.id);
  assert.equal(agent.watches()[0].active, false); assert.equal(agent.watches()[0].hits, 1);
  assert.deepEqual(agent.updateWatch(w.id, { remove: true }), { removed: true });
});

test("memory lists Keir's notes and keeps the owner's own lessons", () => {
  const { agent } = setup();
  const saved = agent.remember("Never promote economy changes while a turn is running.");
  assert.equal(saved.kind, "lesson");
  const mem = agent.memory({ q: "promote" });
  assert.equal(mem.total, 1); assert.equal(mem.notes[0].owner, true);
  assert.throws(() => agent.remember("short"), /full sentence/);
  assert.deepEqual(agent.forget(saved.id), { forgotten: true });
  assert.equal(agent.memory().total, 0);
});

test("routes map to the agent and ignore unknown paths", async () => {
  const { agent } = setup();
  assert.ok((await agent.route("/threads", "GET", {}, new URLSearchParams())).threads.length >= 1);
  assert.equal(await agent.route("/nope", "GET", {}, new URLSearchParams()), undefined);
  const w = await agent.route("/watches", "POST", { condition: "Lakeside Ask is degraded", every: "15m" }, new URLSearchParams());
  assert.equal(w.every, "15m");
});

test("all decision surfaces expose the same exact action scope", () => {
  const { ledger, app, agent, clock } = setup();
  const posted = app.authenticatedPost("Prepare the exact operation");
  const job = ledger.data.jobs[posted.jobId]; job.ticket = 1577;
  ledger.data.actions.action1 = { id: "action1", jobId: job.id, state: "pending", kind: "github", args: { repository: "example/repo", number: 42 }, digest: "sealed", expiresAt: clock.t + 60000 };
  ledger.data.decisions ||= {};
  ledger.data.decisions.d1 = { id: "d1", jobId: job.id, actionId: "action1", state: "pending", question: "Review this operation", at: clock.t };
  const chat = app.pendingDecisions()[0], task = agent.task(job.id).decisions[0];
  const ticket = require("../lib/operator/apptickets").ticketDetail(ledger.data, 1577, clock.t).decisions[0];
  assert.deepEqual(chat, task); assert.deepEqual(task, ticket);
  assert.equal(chat.args.number, 42); assert.equal(chat.digest, "sealed");
  ledger.data.actions.action1.expiresAt = clock.t - 1;
  assert.equal(app.pendingDecisions()[0].canApprove, false);
});
