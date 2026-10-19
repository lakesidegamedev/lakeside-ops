"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createConversation } = require("../lib/operator/conversation");
const { createAppChannel } = require("../lib/operator/appchannel");
const { createAppAgent } = require("../lib/operator/appagent");
const { createAppMuse, eastern } = require("../lib/operator/appmuse");
const { duePushes } = require("../lib/operator/apppush");

const config = { ownerId: "333052320252297216", botId: "1479984768194969663", staffIds: ["2"], taskLifetimeMs: 3600000 };
function setup(start = Date.parse("2026-10-15T16:00:00Z")) {
  const ledger = createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keir-muse-")), "ledger.json"));
  const conversation = createConversation({ ledger, config });
  const clock = { t: start };
  let agent = null;
  const app = createAppChannel({ ledger, config, conversation, agent: () => agent, now: () => clock.t });
  const muse = createAppMuse({ ledger, config, app, now: () => clock.t });
  ledger.data.appThread ||= { seq: 0, messages: [], status: {}, clients: {} };
  ledger.data.appThread.marks = { feedScanAt: clock.t, briefDay: null };
  agent = createAppAgent({ ledger, config, app, muse, now: () => clock.t });
  return { ledger, app, muse, agent, clock };
}

test("a new goal starts a planning task and Keir's milestones drive progress and the feed", () => {
  const { ledger, muse } = setup();
  assert.throws(() => muse.addGoal({ title: "x" }), /name the goal/);
  const g = muse.addGoal({ title: "Turn time under 60 seconds", description: "Median turn below 60s for a week", cadence: "daily" });
  const plan = ledger.data.jobs[muse.goals()[0].taskId];
  assert.equal(plan.role, "owner"); assert.equal(plan.kind, "command"); assert.equal(plan.appGoal, g.id); assert.match(plan.source.content, /goal_update/);
  assert.equal(muse.goals()[0].working, true);
  const r = muse.toolCall(plan, "goal_update", { milestones: [{ title: "Measure phase timings" }, { title: "Index metricHistory" }], note: "Phase timings first." });
  assert.equal(r.milestones.length, 2);
  const [m1, m2] = r.milestones;
  muse.toolCall(plan, "goal_update", { milestones: [{ id: m1.id, title: "Measure phase timings", done: true, evidence: "t203 phases captured" }, { id: m2.id, title: "Index metricHistory" }] });
  const goal = muse.goals()[0];
  assert.equal(goal.progress, 0.5); assert.equal(goal.milestones[0].id, m1.id); assert.ok(goal.milestones[0].doneAt);
  assert.ok(muse.feed().some((f) => /Milestone done: Measure phase timings/.test(f.title)));
  assert.equal(muse.advance(g.id).already, true);
});

test("goals advance on their cadence when no task is live", () => {
  const { ledger, muse, clock } = setup();
  const g = muse.addGoal({ title: "Ship the 1991 iteration 3 seed", cadence: "daily" });
  const first = muse.goals()[0].taskId;
  ledger.data.jobs[first].state = "done";
  clock.t += 86400000 + 1; muse.tick();
  const second = muse.goals()[0].taskId;
  assert.notEqual(second, first); assert.match(ledger.data.jobs[second].source.content, /Advance the owner goal/);
  muse.updateGoal(g.id, { status: "paused" });
  ledger.data.jobs[second].state = "done"; clock.t += 86400000 + 1; muse.tick();
  assert.equal(muse.goals()[0].taskId, second);
});

test("the morning brief runs once a day at the owner's hour in Eastern time", () => {
  const { ledger, muse, clock } = setup(Date.parse("2026-10-15T11:30:00Z")); // 07:30 EDT
  muse.tick();
  assert.equal(Object.values(ledger.data.jobs).filter((j) => j.appBrief).length, 0);
  clock.t = Date.parse("2026-10-15T12:10:00Z"); muse.tick(); muse.tick();
  const briefs = Object.values(ledger.data.jobs).filter((j) => j.appBrief);
  assert.equal(briefs.length, 1); assert.match(briefs[0].source.content, /feed_post once with kind "brief"/);
  assert.equal(eastern(clock.t).hour, 8);
  assert.equal(muse.brief("on demand").already, true);
});

test("the brief names unclaimed handoffs whose tasks are parked (5.6.2)", () => {
  const { ledger, muse } = setup();
  const job = ledger.createJob("finding:mnm", { kind: "finding", role: "support", source: {}, deadline: Date.now() + 86400000 });
  job.state = "waiting";
  job.raisedToDevelopers = [{ id: 254392, title: "Read the MNM settlement queues", blocking: true, at: 1, watch: { parkedAt: 2 } },
    { id: 254400, title: "Accepted already", blocking: true, at: 1, watch: { parkedAt: 2, acceptedAt: 3 } }];
  const { taskId } = muse.brief("on demand");
  const content = ledger.data.jobs[taskId].source.content;
  assert.match(content, /#254392 Read the MNM settlement queues \(game finding\)/);
  assert.doesNotMatch(content, /254400/);
});

test("Keir's tools write plans, feed, files and ideas only on owner tasks", () => {
  const { ledger, app, muse, agent } = setup();
  const { jobId } = app.post("Investigate the bond market spread");
  const job = ledger.data.jobs[jobId];
  muse.toolCall(job, "task_plan", { steps: [{ title: "Read spreads", status: "running" }, { title: "Compare to last week" }] });
  assert.equal(agent.task(jobId).plan.length, 2);
  assert.equal(agent.tasks()[0].plan.current, "Read spreads");
  muse.noteTool(job, "read_tool", { server: "gamestate", tool: "fx_quote" }, true, 120);
  assert.equal(agent.task(jobId).live[0].source, "Game state");
  assert.equal(agent.task(jobId).live[0].operation, "fx_quote");
  assert.throws(() => muse.toolCall(job, "artifact_save", { title: "x", markdown: "short" }), /markdown content/);
  const saved = muse.toolCall(job, "artifact_save", { title: "Spread report", kind: "report", markdown: "# Spreads\n\nFed funds is 4.2% and the 10y is 5.1%." });
  assert.equal(muse.artifacts()[0].title, "Spread report");
  assert.match(muse.route ? JSON.stringify(muse.artifacts()) : "", /Spread report/);
  muse.toolCall(job, "feed_post", { kind: "insight", title: "Spread widened", body: "10y-2y up 40bp this week", links: [{ title: "x", url: "javascript:alert(1)" }] });
  assert.deepEqual(muse.feed()[0].links, []);
  const idea = muse.toolCall(job, "idea_suggest", { title: "Cap bond issuance per turn", reason: "Three states issued 40% of supply", prompt: "Draft a per-turn bond issuance cap" });
  const listed = agent.ideas().find((i) => i.id === `s-${idea.suggested}`);
  assert.equal(listed.kind, "suggestion");
  const started = agent.decideIdea ? muse.decideSuggestion(idea.suggested, "accept") : null;
  assert.equal(ledger.data.jobs[started.taskId].role, "owner");
  const player = ledger.createJob("p", { kind: "conversation", role: "player", source: {} });
  assert.throws(() => muse.toolCall(player, "feed_post", { title: "x", body: "y" }), /owner tasks/);
  assert.ok(saved.saved);
});

test("approvals, upcoming and identity", () => {
  const { ledger, muse, agent, clock } = setup();
  const { jobId } = { jobId: ledger.createJob("k", { kind: "command", role: "owner", source: { content: "Promote to main" } }).id };
  ledger.data.actions = { a1: { id: "a1", jobId, kind: "github", args: { action: "merge", number: 4184 }, state: "pending", expiresAt: clock.t + 3600000 } };
  ledger.data.decisions = { d1: { id: "d1", jobId, actionId: "a1", question: "Merge PR 4184?", state: "pending", at: clock.t } };
  const ap = muse.approvals();
  assert.equal(ap[0].action.summary, "merge #4184"); assert.equal(ap[0].taskTitle, "Promote to main");
  agent.addWatch({ condition: "PR 4184 is merged", every: "hourly" });
  muse.addGoal({ title: "Close every bug ticket within a day" });
  const kinds = muse.upcoming().map((u) => u.kind);
  assert.ok(kinds.includes("watch") && kinds.includes("goal") && kinds.includes("brief"));
  assert.throws(() => muse.identity({ tone: "rude" }), /tone/);
  assert.equal(muse.identity({ tone: "warm", briefHour: 7 }).briefHour, 7);
  assert.equal(muse.context(ledger.data.jobs[jobId]).ownerPreferences.tone, "warm");
});

test("the feed records Keir's merges and resolved tickets once", () => {
  const { ledger, muse, clock } = setup();
  clock.t += 1000;
  ledger.createJob("m", { kind: "command", role: "owner", summary: "Merged the bond fix.", updatedAt: clock.t, effects: { "merge:x": { state: "done", at: clock.t, result: { number: 4184 } } } });
  ledger.createJob("t", { kind: "ticket", role: "support", ticket: 1561, resolved: true, updatedAt: clock.t, summary: "Explained funding." });
  muse.tick(); muse.tick();
  const titles = muse.feed().map((f) => f.title);
  assert.equal(titles.filter((t) => t === "Merged PR #4184").length, 1);
  assert.ok(titles.includes("Ticket #1561 resolved"));
});

test("the brief and goal wins are pushed", () => {
  const { ledger, muse, app, clock } = setup();
  duePushes(ledger.data, { now: clock.t }).forEach((p) => p.mark());
  const { jobId } = app.post("Brief me");
  clock.t += 1000;
  muse.toolCall(ledger.data.jobs[jobId], "feed_post", { kind: "brief", title: "Morning brief", body: "- Turn 203 ran 41s" });
  const due = duePushes(ledger.data, { now: clock.t });
  assert.ok(due.some((p) => p.pref === "feed" && p.payload.aps.alert.title === "Morning brief"));
});

test("routes cover the new surfaces", async () => {
  const { muse, agent } = setup();
  const q = new URLSearchParams();
  for (const p of ["/feed", "/goals", "/approvals", "/upcoming", "/files", "/identity"]) assert.ok(await agent.route(p, "GET", {}, q), p);
  const g = await agent.route("/goals", "POST", { title: "Lower churn in week one" }, q);
  assert.equal((await agent.route(`/goals/${g.id}`, "GET", {}, q)).title, "Lower churn in week one");
  assert.equal((await agent.route(`/goals/${g.id}/advance`, "POST", { note: "now" }, q)).already, true);
  assert.ok(muse);
});
test("goal work retains authenticated origin across its scheduled activations",()=>{
 const {ledger,muse,clock}=setup();const g=muse.addGoal({title:"Reduce reply latency over time"});const first=ledger.data.jobs[g.taskId];const policy=require("../lib/operator/ownermuse-policy");assert.equal(policy.origin(ledger.data,first).valid,true);
 first.state="done";clock.t+=86400001;muse.tick();const next=ledger.data.jobs[g.taskId];assert.notEqual(next.id,first.id);assert.equal(policy.origin(ledger.data,next).root,first.id);
});
test("automated brief can publish private findings but cannot mint external action authority",()=>{
 const {ledger,muse}=setup();const job=ledger.data.jobs[muse.brief().taskId],policy=require("../lib/operator/ownermuse-policy");
 assert.doesNotThrow(()=>policy.guard(ledger,config,job,"idea_suggest",{title:"Improve reply latency",prompt:"Investigate delay"}));
 assert.throws(()=>policy.guard(ledger,config,job,"open_ticket",{title:"Create an incident"}),/authenticated origin|authenticated app/i);
});
test("repeated suggestions stay deduplicated and a dismissed idea stays dismissed",()=>{
 const {ledger,muse,app}=setup();const job=ledger.data.jobs[app.authenticatedPost("Review improvements").jobId];const args={title:"Improve reply latency",prompt:"Measure response time",reason:"Repeated slow replies"};const first=muse.toolCall(job,"idea_suggest",args);muse.decideSuggestion(first.suggested,"dismiss");assert.equal(muse.toolCall(job,"idea_suggest",args).duplicate,true);assert.equal(muse.suggestedIdeas().length,0);
});
test("stopped automation cannot recreate work or leave a ghost goal",()=>{
 const {ledger,muse,agent,clock}=setup();const goal=muse.addGoal({title:"Keep response time low"});ledger.data.jobs[goal.taskId].state="cancelled";agent.addWatch({condition:"Response time below five seconds"});ledger.data.paused=true;const before=Object.keys(ledger.data.jobs).length;clock.t+=86400001;
 muse.tick();agent.tickWatches();assert.equal(Object.keys(ledger.data.jobs).length,before);assert.throws(()=>muse.addGoal({title:"Another goal"}),/stopped/);assert.equal(muse.goals().length,1);assert.throws(()=>muse.brief(),/stopped/);
});

test("tool starts change the live chat version and completed activity stays attached to its reply", () => {
  const { ledger, app, muse } = setup();
  const { jobId } = app.authenticatedPost("Inspect the current game turn", "activity-fixture");
  const job = ledger.data.jobs[jobId]; job.state = "running";
  const before = app.view().version;
  const id = muse.startTool(job, "read_tool", { server: "gamestate", tool: "game_overview" });
  const started = app.view();
  assert.notEqual(started.version, before);
  assert.equal(started.tasks[0].live[0].id, id); assert.equal(started.tasks[0].live[0].state, "running");
  muse.noteTool(job, "read_tool", { server: "gamestate", tool: "game_overview" }, true, 120, id);
  app.deliver("channel-reply:activity", { content: "The game is running." }, job);
  const reply = app.view().messages.at(-1);
  assert.equal(reply.activity[0].id, id); assert.equal(reply.activity[0].title, "Check game status");
  assert.ok(job.firstReplyAt); assert.ok(ledger.data.audit.some(row => row.kind === "chat_delivery" && row.job === job.id));
  assert.equal(app.view().tasks[0].live.length, 0, "completed calls appear in the reply only");
  app.deliver("channel-reply:activity-followup", { content: "Anything else?" }, job);
  assert.equal(app.view().messages.at(-1).activity, undefined);
});
