"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createAppChannel, createAppServer } = require("../lib/operator/appchannel");
const { applyModel } = require("../lib/operator/appmodels");
const { createAppPush } = require("../lib/operator/apppush");
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-controls-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "333052320252297216", botId: "1479984768194969663", taskLifetimeMs: 3600000, model: "conversation-model", codingProvider: "codex:coding-model@low", investigatorProvider: "claude:investigator-model@medium", workerProvider: "claude:coordinator-model@high" };
  const app = createAppChannel({ ledger, config }); return { dir, ledger, config, app };
}
test("kill switch persists, cancels all roles and publications, and Start cannot resurrect them", t => {
  const { ledger, app, dir } = setup(t);
  const { jobId } = app.authenticatedPost("Investigate repository", "new");
  ledger.data.jobs[jobId].state = "running";
  const support = ledger.createJob("support", { role: "support", kind: "ticket" });
  ledger.notify("queued-publication", "owner", "a pending message");
  app.controls.update({ action: "stop" });
  const saved = createLedger(path.join(dir, "ledger.json"));
  assert.equal(saved.data.paused, true); assert.equal(saved.data.jobs[jobId].state, "cancelled");
  assert.equal(saved.data.jobs[support.id].state, "cancelled"); assert.ok(saved.data.outbox["queued-publication"].skipped);
  assert.throws(() => app.authenticatedPost("New work", "blocked"), /stopped/);
  app.authenticatedPost("/start", "start");
  assert.equal(ledger.data.paused, false); assert.equal(ledger.data.jobs[jobId].state, "cancelled");
  assert.ok(app.authenticatedPost("New work", "fresh").jobId);
});
test("role routes stay separate, reach delegated children, and task overrides are scoped", t => {
  const { ledger, app, config } = setup(t);
  app.controls.update({ action: "configure", routes: { conversation: "claude:conversation-model", coding: "codex:coding-model@low", investigation: "claude:investigator-model@medium" } });
  const root = ledger.data.jobs[app.authenticatedPost("Investigate repository").jobId];
  const child = ledger.createJob("child", { role: "owner", codingParent: root.id, kind: "coding" });
  const investigation = ledger.createJob("investigate", { role: "owner", codingParent: root.id, kind: "coding", investigation: true });
  applyModel(child, config, ledger, "worker"); applyModel(investigation, config, ledger, "worker");
  assert.equal(child.provider.model, "coding-model"); assert.equal(investigation.provider.model, "investigator-model");
  app.controls.update({ action: "configure", taskId: root.id, routes: { coding: "claude:investigator-model@medium" } });
  applyModel(child, config, ledger, "worker"); assert.equal(child.provider.runner, "claude");
  const support = ledger.createJob("support", { role: "support", kind: "ticket" });
  applyModel(support, config, ledger, "worker"); assert.equal(support.provider, undefined);
  assert.throws(() => app.controls.update({ action: "configure", taskId: support.id, routes: { coding: "auto" } }), /Unknown active owner/);
});
test("invalid preferences fail atomically and settings wake long polls", t => {
  const { app, ledger } = setup(t); const before = app.view().version;
  assert.throws(() => app.controls.update({ action: "configure", approvalMode: "yolo", skills: { coding: ["../../private"] } }), /unavailable/);
  assert.equal(app.controls.view().approvalMode, "ask");
  app.controls.update({ action: "configure", skills: { coding: [] } });
  assert.notEqual(app.view().version, before); assert.deepEqual(ledger.data.appThread.preferences.main.skills.coding, []);
  assert.throws(() => app.controls.update({ action: "configure", routes: { coding: "invented:model" } }), /not available/);
});
test("shared commands are local controls, deduplicate retries and never call a provider", t => {
  const { app, ledger } = setup(t);
  const a = app.authenticatedPost("/approval yolo", "same"), b = app.authenticatedPost("/approval yolo", "same");
  assert.equal(a.command, true); assert.equal(b.duplicate, true);
  assert.equal(app.controls.view().approvalMode, "yolo"); assert.equal(Object.keys(ledger.data.jobs).length, 0);
  assert.match(app.authenticatedPost("/model", "model").text, /conversation:/);
});
test("control writes are unavailable without owner authentication", async t => {
  const { app, dir } = setup(t);
  const server = createAppServer({ app, artifactsDir: dir, authenticate: async req => req.headers.authorization === "owner" ? "owner" : "staff" });
  await new Promise(r => server.listen(0, "127.0.0.1", r)); t.after(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/api/keir/app/controls`;
  const write = auth => fetch(url, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }) });
  assert.equal((await write("staff")).status, 403); assert.equal(app.controls.view().stopped, false);
  assert.equal((await write("owner")).status, 200); assert.equal(app.controls.view().stopped, true);
});
test("Live Activity updates use separate tokens, end on stop, and contain no task content", async t => {
  const { app, ledger } = setup(t); const calls = [];
  const push = createAppPush({ ledger, apns: { send: async (...args) => { calls.push(args); return { status: 200 }; } } });
  app.authenticatedPost("Investigate private fixture data", "fixture"); app.registerActivity("a".repeat(64), "activity-1");
  await push.tick(); assert.equal(calls[0][2].pushType, "liveactivity");
  assert.equal(calls[0][1].aps.event, "update"); assert.ok(!JSON.stringify(calls).includes("private fixture"));
  app.controls.update({ action: "stop" }); await push.tick();
  assert.equal(calls.at(-1)[1].aps.event, "end"); assert.equal(ledger.data.appThread.activities.length, 0);
});

test("app activity reports delegated providers and stopping a parent cancels its children", t => {
  const { ledger, app } = setup(t);
  const parent = ledger.data.jobs[app.authenticatedPost("Investigate repository").jobId];
  const child = ledger.createJob("delegated", { codingParent: parent.id, kind: "coding", role: "owner", provider: { runner: "codex", model: "coding-model", lane: "worker" } }); child.state = "running";
  const row = app.view(0, "main").tasks.find(j => j.id === child.id);
  assert.equal(row.provider.runner, "codex"); assert.equal(row.thread, "main");
  app.cancel(parent.id); assert.equal(child.state, "cancelled"); assert.equal(parent.state, "cancelled");
});

test("direct app control ingress rejects cross-origin JSON and form writes", async t => {
  const { app, dir } = setup(t);
  const server = createAppServer({ app, artifactsDir: dir, authenticate: async () => "owner" });
  await new Promise(r => server.listen(0, "127.0.0.1", r)); t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`, url = base + "/api/keir/app/controls";
  const body = JSON.stringify({ action: "stop" });
  assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example.com" }, body })).status, 403);
  assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body })).status, 415);
  assert.equal(app.controls.view().stopped, false);
  assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: base }, body })).status, 200);
  assert.equal(app.controls.view().stopped, true);
});

test("authenticated voice turns use Cursor Auto on the conversation lane and keep coding separate", t => {
  const { app, ledger, config } = setup(t);
  config.voiceProvider = "cursor:auto";
  const typed = app.authenticatedPost("Hello", "typed");
  const voiced = app.authenticatedPost("Implement a change", "voiced", "main", { voice: true });
  assert.notEqual(typed.jobId, voiced.jobId);
  const job = ledger.data.jobs[voiced.jobId];
  assert.equal(job.kind, "conversation"); assert.equal(job.voiceMode, true);
  applyModel(job, config, ledger, "quick");
  assert.equal(job.provider.runner, "cursor"); assert.equal(job.provider.model, "auto"); assert.equal(job.provider.effort, undefined);
  const child = ledger.createJob("voice-child", { kind: "coding", codingParent: job.id, role: "owner" });
  applyModel(child, config, ledger, "worker");
  assert.equal(child.voiceMode, undefined);
  const untrusted = app.post("Implement a change", "untrusted", "main", { voice: true });
  assert.equal(ledger.data.jobs[untrusted.jobId].voiceMode, undefined);
});

test("speech remains owner-authenticated, rejects browser forgery, and stops with Keir", async t => {
  const { app, dir } = setup(t); let calls = 0;
  const server = createAppServer({ app, artifactsDir: dir, authenticate: async req => req.headers.authorization === "owner" ? "owner" : false,
    speech: { status: () => ({ provider: "Microsoft online speech" }), synthesize: async text => { calls++; assert.equal(text, "Hello"); return Buffer.from("ID3fixture"); } } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/keir/app/voice/speech`;
  const request = headers => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ text: "Hello" }) });
  assert.equal((await request({})).status, 401);
  assert.equal((await request({ authorization: "owner", origin: "https://other.example" })).status, 403);
  const response = await request({ authorization: "owner" }); assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "audio/mpeg"); assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(await response.text(), "ID3fixture");
  app.controls.update({ action: "stop" }); assert.equal((await request({ authorization: "owner" })).status, 409); assert.equal(calls, 1);
});

test("voice turns keep their route durably despite text overrides and retries, with no route mutation in flight", t => {
  const { app, ledger, config, dir } = setup(t);
  config.voiceProvider = "cursor:auto";
  app.selectModel("main", "codex:gpt-6.1-sol");
  app.controls.update({ action: "configure", routes: { conversation: "codex:gpt-6-luna" } });
  const first = app.authenticatedPost("Hello from voice", "voice-1", "main", { voice: true });
  const a = ledger.data.jobs[first.jobId]; a.state = "running";
  applyModel(a, config, ledger, "quick");
  const retry = app.authenticatedPost("Hello from voice", "voice-1", "main", { voice: true });
  assert.equal(retry.jobId, a.id);
  const second = app.authenticatedPost("What did I just say?", "voice-2", "main", { voice: true });
  const b = ledger.data.jobs[second.jobId];
  assert.notEqual(a.id, b.id); applyModel(b, config, ledger, "quick");
  assert.equal(a.provider.model, "auto"); assert.equal(b.provider.model, "auto");
  applyModel(a, config, ledger, "quick"); assert.equal(a.provider.runner, "cursor");
  assert.equal(createLedger(path.join(dir, "ledger.json")).data.jobs[b.id].voiceRoute, "cursor:auto");
  assert.equal(ledger.data.appThread.modelSelections.main, "codex:gpt-6.1-sol");
  assert.equal(ledger.data.appThread.preferences.main.routes.conversation, "codex:gpt-6-luna");
  assert.equal(first.message.selectedRoute, a.voiceRoute);
  const typed = ledger.data.jobs[app.authenticatedPost("Hello typed", "text").jobId];
  applyModel(typed, config, ledger, "quick"); assert.equal(typed.provider.model, "gpt-6-luna");
  app.controls.update({ action: "configure", routes: { voice: "cursor:auto" } });
  const c = ledger.data.jobs[app.authenticatedPost("Explicit voice choice", "voice-3", "main", { voice: true }).jobId];
  applyModel(c, config, ledger, "quick"); assert.equal(c.provider.model, "auto");
  assert.equal(ledger.data.appThread.voiceSequence.main, 2);
});
test("studio picker contains all proven routes without enabling blocked work lanes or unconfigured standalone models", t => {
  const { config } = setup(t), { models, PROVEN, voiceRoute } = require("../lib/operator/appmodels");
  for (const id of PROVEN) assert.ok(models(config, "conversation").find(m => m.id === id && m.available));
  for (const lane of ["coding", "investigation", "coordination"]) {
    assert.equal(models(config, lane).find(m => m.id === "ollama:deepseek-v4.1-flash").available, false);
  }
  const standalone = { standalone: true, defaultRoute: "codex:my-model" };
  assert.ok(!models(standalone).some(m => m.id === "claude:claude-opus-5-5"));
  assert.throws(() => voiceRoute(standalone, { appThread: {} }, "main"), /needs Claude Sonnet 5.5/);
});

test("voice Auto is unavailable without its route and readiness is never invented", () => {
  const { models } = require("../lib/operator/appmodels");
  const config = { standalone: true, quickProvider: "agy:gemini-3.8-flash", availableRoutes: ["opencode:fixture"] };
  const options = models(config, "voice");
  assert.equal(options[0].available, false);
  assert.match(options[0].reason, /Claude Sonnet/);
  const route = options.find(r => r.id === "opencode:fixture");
  assert.equal(route.configured, true); assert.equal(route.readiness.state, "unverified"); assert.equal(route.readiness.checkedAt, null);
  config.availableRoutes.push("claude:claude-sonnet-5-5");
  assert.equal(models(config, "voice")[0].available, true);
});

test("owner model controls refuse a saved direct Muse route and offer only explicit Go Muse", t => {
  const { app, config } = setup(t);
  config.availableRoutes = ["muse:muse-spark-1.3"];
  assert.throws(() => app.controls.update({ action: "configure", routes: { coding: "muse:muse-spark-1.3" } }), /billing is disabled/);
  const rows = require("../lib/operator/appmodels").models(config, "coding");
  assert.equal(rows.find(row => row.id === "muse:muse-spark-1.3").available, false);
  assert.ok(rows.some(row => row.id === "opencode:opencode-go/muse-spark-1.3-contributor"));
});

test("voice activations skip the effort classifier and run low", async () => {
  const { activationEffort } = require("../lib/operator/effort");
  const chooseEffort = () => { throw new Error("classifier must not run for voice"); };
  assert.deepEqual(await activationEffort({ voiceMode: true }, { config: { chooseEffort }, quick: true, runner: "claude" }), { effort: "low", via: "voice" });
  await assert.rejects(activationEffort({ voiceMode: true, codingParent: "p" }, { config: { chooseEffort }, quick: false, runner: "claude" }), /classifier/);
});

test("authenticated /audit preview runs locally, preserves preview and deduplicates send retries", async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"keir-audit-command-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const ledger=createLedger(path.join(dir,"ledger.json"));let calls=0, options;
  const config={ownerId:"owner",botId:"bot",taskLifetimeMs:3600000,runAccountAudit:async value=>{calls++;options=value;return{dryRun:true,candidates:2,review:1,opened:[],existing:[],uncertain:[],deferred:0,truncated:false};}};
  let drains=0;const app=createAppChannel({ledger,config,drain:()=>drains++});
  const sent=app.post("/audit preview","audit-send","main",{},true);app.post("/audit preview","audit-send","main",{},true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.deepEqual(options,{dryRun:true});assert.equal(drains,0);assert.equal(ledger.data.jobs[sent.jobId].state,"done");assert.match(ledger.data.jobs[sent.jobId].summary,/2 subjects flagged/);
  app.post("/audit preview","untrusted-send","main",{},false);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
});

test("Cursor Auto is selectable through authenticated app settings and reaches chat and coding activations", async t => {
  const { app, ledger, config, dir } = setup(t);
  config.quickProvider = "cursor:auto";
  const server = createAppServer({ app, artifactsDir: dir, authenticate: async req => req.headers.authorization === "owner" ? "owner" : false });
  await new Promise(r => server.listen(0, "127.0.0.1", r)); t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/keir/app`;
  const headers = { authorization: "owner", "content-type": "application/json" };
  const controls = await (await fetch(`${base}/controls`, { headers })).json();
  for (const lane of ["conversation", "voice", "coding", "investigation", "coordination"]) {
    const cursor = controls.options[lane].find(r => r.id === "cursor:auto");
    assert.equal(cursor.provider, "Cursor"); assert.equal(cursor.label, "Cursor Auto");
    assert.equal(cursor.effortMode, "provider-managed"); assert.equal(cursor.available, true);
  }
  const selected = await fetch(`${base}/controls`, { method: "POST", headers, body: JSON.stringify({ action: "configure", routes: { conversation: "cursor:auto", coding: "cursor:auto" } }) });
  assert.equal(selected.status, 200);
  const chat = ledger.data.jobs[app.authenticatedPost("What is the current status?", "cursor-chat").jobId];
  applyModel(chat, config, ledger, "quick"); assert.equal(chat.provider.runner, "cursor"); assert.equal(chat.provider.model, "auto"); assert.equal(chat.provider.effort, undefined);
  const child = ledger.createJob("cursor-coding", { role: "owner", kind: "coding", codingParent: chat.id });
  applyModel(child, config, ledger, "worker"); assert.equal(child.provider.runner, "cursor"); assert.equal(child.provider.model, "auto"); assert.equal(child.effortPin, undefined);
  const saved = createLedger(path.join(dir, "ledger.json"));
  assert.equal(saved.data.appThread.preferences.main.routes.conversation, "cursor:auto");
});

test("Cursor Auto cannot acquire a legacy pinned effort through app model selection", t => {
  const { app, config } = setup(t); config.quickProvider = "cursor:auto";
  assert.throws(() => app.controls.update({ action: "configure", routes: { conversation: "cursor:auto@high" } }), /manages its own/);
});
