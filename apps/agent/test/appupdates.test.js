"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createAppUpdates, COALESCE_MS, MIN_GAP_MS, URGENT_GAP_MS } = require("../lib/operator/appupdates");
const { duePushes } = require("../lib/operator/apppush");
const { createControls } = require("../lib/operator/appcontrols");
const { appendMessage } = require("../lib/operator/appchannel");

const ticketJob = (extra = {}) => ({ id: "t1", kind: "ticket", role: "support", ticket: 1574, state: "waiting", at: 1, updatedAt: 1, wakeAt: Date.now() + 3600000, effects: {}, source: { content: "New ticket intake; read support_get" }, ...extra });
function world(jobs = [ticketJob()]) {
  const data = { jobs: Object.fromEntries(jobs.map(j => [j.id, j])), channels: {}, actions: {}, decisions: {}, statusCards: {}, appThread: { seq: 0, messages: [], status: {}, clients: {} } };
  let saves = 0; const audits = [];
  return { data, ledger: { data, save() { saves++; }, audit(k, v) { audits.push([k, v]); } }, saves: () => saves, audits };
}
const card = (data, ticket, name, stage, extra = {}) => { (data.statusCards[ticket] ||= { items: [] }).items = [...(data.statusCards[ticket]?.items || []).filter(i => i.name !== name), { name, stage, note: "", ...extra }]; };

test("the first scan is a silent baseline, so a restart never replays history", () => {
  const w = world(); card(w.data, 1574, "California steel sales", "tested");
  let now = 1000; const u = createAppUpdates({ ledger: w.ledger, now: () => now });
  assert.equal(u.tick().baseline, true);
  now += COALESCE_MS * 5; u.tick();
  assert.equal(w.data.appThread.messages.length, 0);
});

test("routine progress stays on the board; only a live fix earns a chat line", () => {
  const w = world(); card(w.data, 1574, "California steel sales", "found");
  let now = 1000; const u = createAppUpdates({ ledger: w.ledger, now: () => now }); u.tick();
  card(w.data, 1574, "California steel sales", "written", { note: "Patch ready" });
  w.data.jobs.t1.pullRequests = ["https://github.com/lakesidegamedev/AHDGame/pull/4299"];
  w.data.jobs.t1.effects["merge:4299:abc"] = { state: "done", result: { number: 4299 } };
  now += COALESCE_MS; u.tick(); now += MIN_GAP_MS; u.tick();
  assert.equal(w.data.appThread.messages.length, 0, "fix written, PR opened and merged stay out of the chat");
  card(w.data, 1574, "California steel sales", "main", { note: "Sales cap fixed" });
  now += 20000; assert.equal(u.tick().posted, null, "a burst settles before posting");
  now += COALESCE_MS; const m = u.tick().posted;
  assert.equal(m.update, true); assert.equal(m.thread, "main"); assert.equal(m.role, "keir");
  assert.equal(m.text, "- Ticket 1574, California steel sales: now live on the main server. Sales cap fixed.");
  assert.equal(m.items.length, 1); assert.doesNotMatch(m.text, /[–—]/);
});

test("a live fix keeps a minimum gap, while a needed decision goes out quickly", () => {
  const w = world(); card(w.data, 1574, "Steel", "tested"); card(w.data, 1574, "Wages", "tested");
  let now = 1000; const u = createAppUpdates({ ledger: w.ledger, now: () => now }); u.tick();
  card(w.data, 1574, "Steel", "main"); now += COALESCE_MS; u.tick(); now += COALESCE_MS; u.tick();
  assert.equal(w.data.appThread.messages.length, 1);
  card(w.data, 1574, "Wages", "main"); now += 20000; u.tick(); now += COALESCE_MS; u.tick();
  assert.equal(w.data.appThread.messages.length, 1, "second routine update waits for the gap");
  w.data.decisions.x = { id: "x", jobId: "t1", state: "pending", question: "Refund the player?" };
  now += URGENT_GAP_MS; u.tick();
  assert.equal(w.data.appThread.messages.length, 2);
  const m = w.data.appThread.messages[1];
  assert.match(m.text.split("\n")[0], /needs your decision\. Refund the player\?/, "urgent lines lead");
  assert.match(m.text, /Wages: now live on the main server/, "pending live lines ride along");
  now += MIN_GAP_MS; u.tick(); assert.equal(w.data.appThread.messages.length, 2);
});

test("later stages of the same fix replace earlier ones in one line", () => {
  const w = world([]);
  let now = 1000; const u = createAppUpdates({ ledger: w.ledger, now: () => now }); u.tick();
  w.data.jobs.t1 = ticketJob({ updatedAt: now }); card(w.data, 1574, "Steel", "sandbox");
  now += 20000; u.tick(); card(w.data, 1574, "Steel", "main"); now += 20000; u.tick(); card(w.data, 1574, "Steel", "confirmed"); now += 20000; u.tick();
  now += COALESCE_MS; const m = u.tick().posted;
  assert.equal(m.items.length, 1); assert.match(m.text, /now live and confirmed in game/);
});

test("app-started work, quick conversations and probes are not repeated as updates", () => {
  const w = world([]);
  let now = 1000; const u = createAppUpdates({ ledger: w.ledger, now: () => now }); u.tick();
  w.data.jobs.a = { id: "a", kind: "command", role: "owner", state: "running", replyChannel: "app", source: { channelId: "app", content: "Do X" }, effects: {} };
  w.data.jobs.c = { id: "c", kind: "conversation", role: "owner", state: "running", source: { content: "hi" }, effects: {} };
  w.data.jobs.p = { id: "p", kind: "command", internalProbe: true, state: "running", source: { content: "probe" }, effects: {} };
  now += 20000; u.tick(); now += MIN_GAP_MS; u.tick();
  assert.equal(w.data.appThread.messages.length, 0); assert.equal(u.board().open, 0);
});

test("started and finished work stay out of the chat, and the owner can turn updates off", () => {
  const w = world([ticketJob({ state: "running" })]);
  let now = 1000; const u = createAppUpdates({ ledger: w.ledger, now: () => now }); u.tick();
  w.data.jobs.t2 = ticketJob({ id: "t2", ticket: 1580, state: "running", rounds: 1 }); now += 20000; u.tick();
  w.data.jobs.t1.state = "done"; w.data.jobs.t1.summary = "Explained the sales cap to the player.";
  now += MIN_GAP_MS; u.tick(); now += MIN_GAP_MS; u.tick();
  assert.equal(w.data.appThread.messages.length, 0);
  w.data.appThread.preferences = { main: { updates: false } };
  w.data.decisions.x = { id: "x", jobId: "t2", state: "pending", question: "Refund?" };
  now += MIN_GAP_MS; u.tick(); now += MIN_GAP_MS; u.tick();
  assert.equal(w.data.appThread.messages.length, 0);
  assert.deepEqual(w.data.appThread.updates.pending, []);
});

test("the working-now board ranks what needs the owner first and shows one row per ticket", () => {
  const w = world([ticketJob({ id: "a", state: "running" }), ticketJob({ id: "b", state: "waiting" }), ticketJob({ id: "c", ticket: 1580, state: "running" })]);
  w.data.decisions.x = { id: "x", jobId: "b", state: "pending", question: "Which fix?" };
  const u = createAppUpdates({ ledger: w.ledger, now: () => 5000 }); u.tick();
  const b = u.board();
  assert.equal(b.open, 3); assert.equal(b.needsYou, 1); assert.equal(b.working, 2);
  assert.deepEqual(b.items.map(i => [i.ticket, i.state]), [[1574, "needs-you"], [1580, "working"]]);
});

test("update pushes are quiet and collapse into one notice", () => {
  const d = { appThread: { seq: 2, messages: [{ seq: 1, role: "keir", text: "Reply", thread: "main" }, { seq: 2, role: "keir", text: "- Ticket 1574: finished.", thread: "main", update: true }], push: { seq: 0, decisions: {}, alerts: {}, since: 0 } }, decisions: {}, alerts: [] };
  const [reply, update] = duePushes(d, { now: 10 });
  assert.equal(reply.payload.aps["interruption-level"], "active");
  assert.equal(update.collapseId, "keir-updates");
  assert.equal(update.payload.aps["interruption-level"], "passive");
  assert.equal(update.payload.aps.sound, undefined);
  assert.equal(update.payload.aps.alert.body, "Ticket 1574: finished.");
});

test("progress updates are a main conversation preference", () => {
  const data = { jobs: {}, appThread: { seq: 0, messages: [], status: {}, clients: {}, threads: { side: { id: "side" } } } };
  const controls = createControls({ ledger: { data, save() {}, audit() {} }, config: {} });
  assert.equal(controls.view().updates, true);
  controls.update({ action: "configure", updates: false });
  assert.equal(controls.view().updates, false);
  assert.throws(() => controls.update({ action: "configure", thread: "side", updates: true }), /main conversation/);
  assert.throws(() => controls.update({ action: "configure", updates: "no" }), /main conversation/);
});

test("each board row and update line says where the app can open it", () => {
  const w = world([ticketJob({ state: "running" }), { id: "o", kind: "command", role: "owner", state: "running", source: { channelId: "dm", content: "Audit CI" }, effects: {} }, { id: "f", kind: "finding", role: "support", state: "running", source: { content: "Turn warning" }, effects: {} }]);
  let now = 1000; const u = createAppUpdates({ ledger: w.ledger, now: () => now }); u.tick();
  assert.deepEqual(Object.fromEntries(u.board().items.map(i => [i.id, i.link])), { t1: "ticket", o: "task", f: "activity" });
  w.data.decisions.x = { id: "x", jobId: "o", state: "pending", question: "Fix the flaky job?" }; now += URGENT_GAP_MS; u.tick(); now += URGENT_GAP_MS; u.tick();
  assert.equal(w.data.appThread.messages[0].items[0].link, "task");
  assert.match(w.data.appThread.messages[0].text, /Audit CI: needs your decision\. Fix the flaky job\?/);
});

test("starting work is never announced in the chat, however often it wakes", () => {
  const w = world([]);
  let now = 1000; const u = createAppUpdates({ ledger: w.ledger, now: () => now }); u.tick();
  w.data.jobs.q = { id: "q", kind: "command", role: "support", state: "queued", rounds: 0, source: { content: "please report the top 5 ticket submitters" }, effects: {} };
  now += 20000; u.tick();
  for (const state of ["running", "waiting", "queued", "running", "waiting", "running"]) { w.data.jobs.q.state = state; w.data.jobs.q.rounds++; now += MIN_GAP_MS; u.tick(); }
  assert.equal(w.data.appThread.messages.length, 0);
  assert.equal(u.board().items[0].title, "Please report the top 5 ticket submitters", "the board still shows it");
});

test("titles drop arrival boilerplate, merges name their PR and decisions use their short summary", () => {
  const finding = { id: "f", kind: "finding", role: "support", operatorRole: "engineering", state: "running", rounds: 0, engineeringTitle: "Read-only engineering triage of game evidence",
    source: { content: "Keir watch found this before any player reported it.\n\nTurn warning: Player income tax has 1 unpaid assessment.\n\nTurn 231: …" }, effects: {} };
  const review = { id: "r", kind: "finding", role: "support", operatorRole: "watchkeeper", state: "running", rounds: 3, source: { content: "You are Watchkeeper Keir" }, effects: {} };
  const w = world([ticketJob({ state: "running", rounds: 2 }), finding, review]);
  card(w.data, 1574, "Steel", "found"); card(w.data, 1574, "Demand", "tested");
  let now = 1000; const u = createAppUpdates({ ledger: w.ledger, now: () => now }); u.tick();
  assert.deepEqual(u.board().items.map(i => i.title).sort(), ["Player income tax has 1 unpaid assessment.", "Steel and 1 more"], "two fixes: the ticket line is the number alone; watchkeeper reviews are hidden");
  w.data.jobs.t1.effects["merge:4286:abc"] = { state: "done", result: { merged: true } };
  w.data.decisions.d = { id: "d", jobId: "t1", state: "pending", at: 5, tldr: "Approve shipping two fixes to the live server. This rejects invalid caps.", question: "Ship to the live server for ticket 1574. This promotion carries 2 changes: …" };
  now += 20000; u.tick(); now += URGENT_GAP_MS; u.tick();
  const text = w.data.appThread.messages[0].text;
  assert.equal(text, "- Ticket 1574: needs your decision. Approve shipping two fixes to the live server.", "the merge stays off the chat");
  assert.doesNotMatch(text, /Watchkeeper|This rejects/);
});

test("work digests never push the owner's conversation out of the thread", () => {
  const data = { appThread: { seq: 0, messages: [], status: {}, clients: {} } };
  appendMessage(data, { role: "owner", text: "Is Railway down?", thread: "main" }, 1);
  appendMessage(data, { role: "keir", text: "Railway is up.", thread: "main" }, 2);
  for (let i = 0; i < 500; i++) appendMessage(data, { role: "keir", text: `- Ticket ${i}: live.`, thread: "main", update: true }, 3 + i);
  const messages = data.appThread.messages;
  assert.deepEqual(messages.slice(0, 2).map(m => m.text), ["Is Railway down?", "Railway is up."]);
  assert.equal(messages.filter(m => m.update).length, 30);
  assert.equal(messages.at(-1).text, "- Ticket 499: live.");
});
