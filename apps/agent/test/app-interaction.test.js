"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createAppChannel } = require("../lib/operator/appchannel");
const { createAppQuestions } = require("../lib/operator/appquestions");
const { createAppAgent } = require("../lib/operator/appagent");
const { createBroker } = require("../lib/operator/broker");
const { models, applyModel } = require("../lib/operator/appmodels");
const { pickForLanes, emptyLanes } = require("../lib/operator/lanes");
const { ticketDetail } = require("../lib/operator/apptickets");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-interaction-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "owner", botId: "keir", staffIds: [], taskLifetimeMs: 86400000, model: "configured-model", quickProvider: "claude", workerProvider: "codex:gpt-configured@low", stateDir: dir };
  const app = createAppChannel({ ledger, config });
  const questions = createAppQuestions({ ledger, app, config });
  const broker = createBroker({ ledger, config, appChannel: app, appQuestions: questions, sandbox: {}, mcp: { servers: () => [] }, discord: async () => [] });
  return { ledger, config, app, questions, broker };
}
test("separate owner requests can run concurrently and conversation capacity remains available", (t) => {
  const { ledger, app } = fixture(t);
  const a = app.post("Investigate ticket 1", "a", "main", { mode: "new" });
  const b = app.post("Investigate ticket 2", "b", "main", { mode: "new" });
  const c = app.post("What is the current turn?", "c", "main", { mode: "new" });
  assert.notEqual(a.jobId, b.jobId);
  const picks = pickForLanes(Object.values(ledger.data.jobs), emptyLanes());
  assert.deepEqual(new Set(picks.map((p) => p.job.id)), new Set([a.jobId, b.jobId, c.jobId]));
  assert.equal(ledger.data.jobs[a.jobId].inbox?.length || 0, 0);
});
test("steering names its task, reaches the running model before its next effect and retains receipts", async (t) => {
  const { ledger, app, broker } = fixture(t);
  const a = app.post("Investigate ticket 1", "a", "main", { mode: "new" });
  const b = app.post("Investigate ticket 2", "b", "main", { mode: "new" });
  const job = ledger.data.jobs[a.jobId]; job.state = "running"; job.effects.proof = { state: "done" };
  app.post("Only look at payroll", "correction", "main", { mode: "steer", taskId: job.id });
  await assert.rejects(broker.tool(job, "request_action", {}), /owner_updates/);
  const update = await broker.tool(job, "owner_updates", {});
  assert.equal(update.messages[0].content, "Only look at payroll");
  assert.equal(job.effects.proof.state, "done"); assert.equal(job.appSteering, undefined);
  assert.equal(ledger.data.jobs[b.jobId].inbox?.length || 0, 0);
});
test("model picker exposes studio choices and pins the selected thread", (t) => {
  const { config, ledger, app } = fixture(t);
  config.codingProvider = "ollama:deepseek-v4.1-flash,agy:gemini-3.8-flash";
  for (const id of ["auto", "claude:configured-model", "codex:gpt-configured@low", "claude:claude-sonnet-5-5", "ollama:deepseek-v4.1-flash"]) assert.ok(models(config).some(m => m.id === id));
  assert.throws(() => app.selectModel("main", "codex:made-up"), /not available/);
  app.selectModel("main", "codex:gpt-configured@low");
  const job = ledger.data.jobs[app.post("Investigate a ticket").jobId];
  applyModel(job, config, ledger, "worker");
  assert.equal(job.provider.model, "gpt-configured"); assert.equal(job.provider.ownerSelected, true);
  app.selectModel("main", "auto"); applyModel(job, config, ledger, "worker");
  assert.equal(job.provider, undefined);
});
test("a pinned model selection wakes the thread poll and does not change the running provider immediately", (t) => {
  const { app, ledger } = fixture(t);
  const job = ledger.data.jobs[app.post("Investigate a ticket").jobId];
  job.provider = { lane: "worker", model: "current", runner: "claude" };
  const before = app.view().version;
  app.selectModel("main", "codex:gpt-configured@low");
  assert.notEqual(app.view().version, before);
  assert.equal(job.provider.model, "current");
});
const question = { title: "Payroll decision", questions: [{ prompt: "How should payroll work?", options: [{ label: "Capacity", recommended: true }, { label: "Filled jobs" }] }] };
test("structured choices retain exact answers, wake their task once and never approve effects", (t) => {
  const { ledger, app, questions } = fixture(t);
  const job = ledger.data.jobs[app.post("Investigate payroll").jobId]; job.state = "running";
  const panel = questions.ask(job, question); job.state = "waiting";
  const args = { clientId: "answer-1", answers: [{ id: "1", selected: ["2"], text: "Keep the ticket open" }] };
  assert.equal(questions.answer(panel.id, args).jobId, job.id);
  assert.equal(questions.answer(panel.id, args).duplicate, true);
  assert.equal(job.inbox.length, 1); assert.equal(job.state, "queued");
  assert.match(job.inbox[0].content, /Filled jobs; Keep the ticket open/);
  assert.equal(Object.keys(ledger.data.actions).length, 0);
});
test("choices reject stale, incomplete, cross-option and multi-selected answers", (t) => {
  const { ledger, app, questions } = fixture(t);
  const job = ledger.data.jobs[app.post("Investigate payroll").jobId]; job.state = "running";
  const panel = questions.ask(job, question);
  for (const selected of [[], ["7"], ["1", "2"]]) assert.throws(() => questions.answer(panel.id, { clientId: "x", answers: [{ id: "1", selected }] }), /choose|invalid/);
  questions.ask(job, question);
  assert.throws(() => questions.answer(panel.id, { clientId: "x", answers: [{ id: "1", selected: ["1"] }] }), /no longer current/);
});
test("paused owner tasks leave execution slots available and resume independently", async (t) => {
  const f = fixture(t), agent = createAppAgent({ ...f, app: f.app });
  const job = f.ledger.data.jobs[f.app.post("Investigate payroll").jobId]; job.state = "running";
  assert.equal(agent.pause(job.id).state, "paused");
  await assert.rejects(f.broker.tool(job, "owner_updates", {}), /inactive/);
  assert.equal(agent.pause(job.id, true).state, "queued");
});
test("ticket detail leads with blockers and distinguishes an in-flight effect from completed work", () => {
  const data = { jobs: { abc: { id: "abc", ticket: 1564, kind: "ticket", state: "blocked", summary: "Need the owner's payroll ruling", at: 10, effects: { "heal:plan": { state: "started", at: 11 } }, history: [{ at: 9, summary: "Read the payroll code" }], pullRequests: ["https://github.com/example/game/pull/1"] } }, decisions: { def: { id: "def", jobId: "abc", state: "pending", question: "Use filled jobs?" } } };
  const detail = ticketDetail(data, 1564);
  assert.equal(detail.blockers[0].kind, "decision");
  assert.match(detail.current.summary, /payroll/);
  assert.equal(detail.receipts[0].state, "started");
  assert.equal(detail.history[0].text, "Read the payroll code");
  assert.equal(ticketDetail(data, 1).current, null);
});
test("support handoffs expose durable delivery and incorporation separately from completed work", () => {
  const receipt = { id: "handoff-1", directiveId: "handoff-1", ticket: 1564, sourceTaskId: "app", sourceMessageId: "owner-1", coordinatorTaskId: "support", at: 20, outcome: "held", state: "waiting", remainingBlockers: ["staff-category"], approvalReferences: [] };
  const data = { jobs: {}, supportDirectives: { "handoff-1": receipt, other: { ...receipt, id: "other", ticket: 1558 } } };
  let detail = ticketDetail(data, 1564);
  assert.equal(detail.handoffs.length, 1);
  assert.equal(detail.handoffs[0].status, "Waiting on a hold");
  assert.equal(detail.blockers[0].kind, "handoff");
  assert.match(detail.blockers[0].detail, /Staff category/);
  assert.equal(detail.receipts.length, 0);
  receipt.remainingBlockers = []; receipt.outcome = "woken";
  detail = ticketDetail(data, 1564);
  assert.equal(detail.handoffs[0].status, "Delivered to Support Keir");
  assert.equal(detail.blockers.length, 0);
  receipt.incorporatedAt = 30;
  detail = ticketDetail(data, 1564);
  assert.equal(detail.handoffs[0].status, "Incorporated by Support Keir");
  assert.equal(detail.handoffs[0].incorporatedAt, 30);
  assert.equal(detail.receipts.length, 0);
});
test("pause cannot interrupt an action whose effect still needs verification", (t) => {
  const f = fixture(t), agent = createAppAgent({ ...f, app: f.app });
  const job = f.ledger.data.jobs[f.app.post("Investigate payroll").jobId]; job.state = "running";
  job.effects.write = { state: "started", at: Date.now() };
  assert.throws(() => agent.pause(job.id), /verification/);
  assert.equal(job.state, "running"); assert.equal(job.appPaused, undefined);
  job.effects.write.state = "done";
  assert.equal(agent.pause(job.id).state, "paused");
  assert.equal(agent.task(job.id).canResume, true);
});
test("owner instructions are rejected intact instead of silently truncating decisions", (t) => {
  const { app, ledger } = fixture(t);
  assert.throws(() => app.post("x".repeat(6001)), /6000 characters/);
  assert.equal(Object.keys(ledger.data.jobs).length, 0);
});
test("owner tasks cannot report completion while questions or effects still need a result", async (t) => {
  for (const pending of ["question", "action", "decision", "effect"]) {
    const f = fixture(t);
    const job = f.ledger.data.jobs[f.app.post("Investigate payroll").jobId]; job.state = "running";
    if (pending === "question") f.questions.ask(job, question);
    if (pending === "action") f.ledger.data.actions.a = { id: "a", jobId: job.id, state: "pending" };
    if (pending === "decision") (f.ledger.data.decisions ||= {}).d = { id: "d", jobId: job.id, state: "pending" };
    if (pending === "effect") job.effects.write = { state: "started" };
    await assert.rejects(f.broker.tool(job, "finish", { state: "done", summary: "Finished everything" }), /unresolved/);
    assert.equal(job.state, "running");
    assert.equal((await f.broker.tool(job, "finish", { state: "waiting", summary: "Waiting for the recorded result" })).state, "waiting");
  }
});

test("each voice turn needs its own final reply even when an earlier question has the same wording", async t => {
  const { ledger, app, broker } = fixture(t);
  const old = app.authenticatedPost("What's the story with the fund?", "voice-old", "main", { voice: true });
  app.deliver("channel-reply:old", { content: "An earlier answer." }, ledger.data.jobs[old.jobId]);
  const current = app.authenticatedPost("What's the story with the fund?", "voice-new", "main", { voice: true });
  const root = ledger.data.jobs[current.jobId]; root.state = "running";
  const handoff = await broker.tool(root, "handoff", {});
  const child = ledger.data.jobs[handoff.taskId]; child.state = "running";
  await assert.rejects(broker.tool(child, "finish", { state: "done", summary: "Already answered the other turn; no duplicate reply." }), /this voice turn needs its own reply/i);
  assert.equal(child.state, "running");
  await broker.tool(child, "channel_reply", { message: "The current evidence is still incomplete." });
  await broker.tool(child, "finish", { state: "done", summary: "Replied to this request." });
  assert.equal(child.state, "done");
});
test("a voice handoff leaves a provisional answer the worker revises, never a final one", async t => {
  const { ledger, app, broker } = fixture(t);
  app.view(0, "main", true); // the app build asks for answer revisions
  const current = app.authenticatedPost("Explain the current investigation", "voice-progress", "main", { voice: true });
  const root = ledger.data.jobs[current.jobId]; root.state = "running";
  const handoff = await broker.tool(root, "handoff", { answer: "Short answer: nothing looks broken yet." });
  const provisional = app.view().messages.find(m => m.role === "keir" && m.jobId === root.id);
  assert.ok(provisional); assert.equal(provisional.voice, true); assert.equal(provisional.provisional, true);
  assert.equal(provisional.taskId, handoff.taskId); assert.match(provisional.text, /nothing looks broken yet/);
  assert.equal(provisional.voiceProgress, undefined);
  const child = ledger.data.jobs[handoff.taskId]; child.state = "running";
  await assert.rejects(broker.tool(child, "finish", { state: "done", summary: "Done." }), /this voice turn needs its own reply/i);
  await broker.tool(child, "channel_reply", { message: "The investigation finished: one drifted account." });
  // The outbox is the real delivery hop; the fixture drains it by hand.
  for (const [key, entry] of Object.entries(ledger.data.outbox)) if (key.startsWith(`channel-reply:${child.id}`)) app.deliver(key, entry, child);
  const revised = app.view().messages.filter(m => m.role === "keir" && m.jobId === root.id);
  assert.equal(revised.length, 1, "the deeper answer edits the provisional message");
  assert.equal(revised[0].id, provisional.id); assert.match(revised[0].text, /one drifted account/); assert.ok(revised[0].editedAt > 0);
  assert.equal(revised[0].provisional, undefined);
});

test("coding children of a voice request report to their parent without needing an impossible spoken reply", async t => {
 const {ledger,app,broker}=fixture(t);
 const a=app.authenticatedPost("Investigate this issue", "voice-coding", "main", {voice:true});
 const root=ledger.data.jobs[a.jobId];root.state="running";
 const handoff=await broker.tool(root,"handoff",{}),parent=ledger.data.jobs[handoff.taskId];parent.state="waiting";
 const child=ledger.createJob("voice-coder",{kind:"coding",role:"owner",actorId:parent.actorId,codingParent:parent.id,source:parent.source,deadline:parent.deadline});
 require("../lib/operator/ownermuse-policy").inherit(ledger,parent,child);child.state="running";
 await broker.tool(child,"finish",{state:"done",summary:"Prepared the isolated evidence."});
 assert.equal(child.state,"done");assert.equal(parent.inbox.at(-1).codingResult,child.id);
 parent.state="running";parent.inbox=[];
 await assert.rejects(broker.tool(parent,"finish",{state:"done",summary:"No owner reply yet."}),/this voice turn needs its own reply/i);
});

test("a pending question whose task is gone expires instead of asking the owner forever", () => {
  const { createAppQuestions } = require("../lib/operator/appquestions");
  const data = { jobs: {}, appThread: { questions: { q1: { id: "q1", jobId: "missing", thread: "main", title: "Checking", questions: [], state: "pending", at: 1 } } } };
  const ledger = { data, audit() {}, save() {} };
  const q = createAppQuestions({ ledger, app: {}, config: {}, now: () => 5 });
  const listed = q.list("main");
  assert.equal(listed[0].state, "expired");
});

test("asking permission to explain cannot create a Needs you panel", async t => {
  const { ledger, app, broker } = fixture(t);
  const receipt = app.authenticatedPost("Explain the ticket finding", undefined, "main", { mode: "new" });
  const job = ledger.data.jobs[receipt.jobId]; job.state = "running";
  await assert.rejects(broker.tool(job, "present_choices", { title: "Explain?", questions: [{ prompt: "Would you like me to explain the result?", options: [{ label: "Yes" }, { label: "Later" }] }] }), /No owner decision/);
  assert.equal(Object.values(ledger.data.appThread.questions || {}).filter(q => q.state === "pending").length, 0);
});

test("Discord owner questions use named choices without an app-only tool error", async t => {
  const {ledger, broker} = fixture(t);
  const job=ledger.createJob("discord-choices",{kind:"command", role:"owner", actorId:"owner", source:{authorId:"owner",channelId:"discord-channel"}, deadline:Date.now()+86400000}); job.state="running";
  const asked=await broker.tool(job,"present_choices", {questions:[{prompt:"Which display policy?",options:[{label:"Round totals"},{label:"Show decimals"}]}]});
  const x=ledger.data.decisions[asked.id];
  assert.equal(x.type,"choice"); assert.equal(x.options[1].label,"Show decimals");
  assert.equal(job.ownerDecisionPending,true);
  assert.equal(Object.values(ledger.data.actions).length,0);
  await broker.tool(job,"finish",{state:"blocked", needsOwner:true, summary:"Waiting for the named display policy choice."});
  assert.equal(Object.values(ledger.data.decisions).length,1);
  assert.equal(Object.values(ledger.data.outbox).filter(e=>e.decision).length,1);
});
