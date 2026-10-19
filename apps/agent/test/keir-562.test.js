"use strict";
// Keir 5.6.2: the overnight stall of 2026-10-16. Repeated reads looked like
// progress, one open question paused a ticket's other fixes, findings could
// not read game records, and unclaimed handoffs were polled all night.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { createRecovery, SPIN_ROUNDS } = require("../lib/operator/selfrecovery");
const { createDeveloperWatch, parkedOnHandoffs, ACK_MS, POLL_MS } = require("../lib/operator/developerwatch");
const { reviewWaits } = require("../lib/operator/workqueue");
const NOW = 1000000;

function fixture(t, { kind = "ticket", ticket = 1577, calls = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-562-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "owner", staffIds: [], stateDir: dir, repositories: {}, supportDeferred: () => false };
  const job = ledger.createJob(`${kind}:fixture`, { kind, role: "support", ...(kind === "ticket" ? { ticket } : {}), source: {}, deadline: NOW + 86400000 });
  job.state = "running";
  const mcp = { servers: () => ["ops-knowledge", "heal-ops"], list: async () => [], call: async (server, tool, args) => { calls.push([server, tool, args]); return { documents: [] }; } };
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox: {}, now: () => NOW });
  return { ledger, job, broker, calls };
}

test("re-reading the same record is not progress; a new read is", () => {
  const job = { id: "f", kind: "command", state: "waiting", rounds: 0, investigatedReads: 0 };
  const ledger = { data: { jobs: { f: job } }, audit() {}, save() {} };
  const r = createRecovery({ ledger, now: () => NOW });
  r.tick({});
  job.rounds += SPIN_ROUNDS; job.investigatedReads += SPIN_ROUNDS; r.tick({});
  assert.equal(ledger.data.recoveries.at(-1).action, "nudged");
  job.rounds += SPIN_ROUNDS; job.distinctReads = 1; r.tick({});
  assert.equal(ledger.data.recoveries.length, 1, "a read it has not made before resets the count");
});

test("a spinning game finding is parked for the brief, never dropped", () => {
  const job = { id: "f", kind: "finding", role: "support", state: "waiting", rounds: 0 };
  const ledger = { data: { jobs: { f: job } }, audit() {}, save() {} };
  const r = createRecovery({ ledger, now: () => NOW });
  r.tick({}); job.rounds += SPIN_ROUNDS; r.tick({}); job.rounds += SPIN_ROUNDS; r.tick({});
  assert.equal(job.state, "waiting");
  assert.equal(job.parkedForBrief, NOW);
  assert.ok(job.wakeAt >= NOW + 12 * 3600000);
  assert.match(job.summary, /morning brief/);
});

test("the broker counts distinct reads only", async (t) => {
  const f = fixture(t, { kind: "finding" });
  for (let i = 0; i < 3; i++) await f.broker.tool(f.job, "read_tool", { server: "heal-ops", tool: "heal_count", args: { collection: "indexFunds", filter: { ticker: "MNM" } } });
  await f.broker.tool(f.job, "read_tool", { server: "heal-ops", tool: "heal_count", args: { collection: "shareOrders", filter: { status: "open" } } });
  assert.equal(f.job.investigatedReads, 4);
  assert.equal(f.job.distinctReads, 2);
});

test("findings read raw game records through the support guard", async (t) => {
  const f = fixture(t, { kind: "finding" });
  await f.broker.tool(f.job, "read_tool", { server: "heal-ops", tool: "heal_query", args: { env: "dev", collection: "playerIncomeTaxAssessments", filter: { status: "unpaid" }, limit: 500 } });
  const [, tool, args] = f.calls.at(-1);
  assert.equal(tool, "heal_query"); assert.equal(args.env, "prod"); assert.equal(args.limit, 50);
  await assert.rejects(f.broker.tool(f.job, "read_tool", { server: "heal-ops", tool: "heal_query", args: { collection: "users" } }), /closed/);
  await assert.rejects(f.broker.tool(f.job, "read_tool", { server: "heal-ops", tool: "heal_apply", args: {} }), /scope/);
});

test("engineering findings may use the raw reads but still not writes", () => {
  const { engineeringGuard } = require("../lib/operator/engineering");
  const job = { operatorRole: "engineering" };
  assert.equal(engineeringGuard(job, "read_tool", { server: "heal-ops", tool: "heal_query" }), true);
  assert.throws(() => engineeringGuard(job, "read_tool", { server: "heal-ops", tool: "heal_apply" }), /cannot use/);
});

test("one open question does not pause a ticket's other fixes", async (t) => {
  const f = fixture(t);
  f.ledger.data.statusCards = { 1577: { items: [
    { name: "Dropdowns", stage: "main", blocked: false, note: "" },
    { name: "Gain tooltips", stage: "found", blocked: true, note: "" },
    { name: "Logo spacing", stage: "found", blocked: true, note: "Waiting on which page." },
  ] } };
  await assert.rejects(f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "player_reply", summary: "Waiting for the logo page." }), /Gain tooltips[\s\S]*does not pause the others/);
  assert.equal(f.job.state, "running");
  // Asked once per card state: a genuine wait still finishes.
  const done = await f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "player_reply", summary: "Waiting for the logo page." });
  assert.equal(done.state, "waiting");
});

test("annotating an idle fix as the prompt asks does not re-arm it; a newly idle fix asks again", async (t) => {
  const f = fixture(t);
  f.ledger.data.statusCards = { 1577: { items: [{ name: "Steelworks idle", stage: "found", blocked: false, note: "" }] } };
  const finish = () => f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "player_reply", summary: "Answered; waiting on the player." });
  await assert.rejects(finish(), /not moving/);
  f.ledger.data.statusCards[1577].items = [{ name: "Steelworks idle", stage: "found", blocked: true, note: "Waiting on your reply about renewal." }];
  assert.equal((await finish()).state, "waiting");
  f.job.state = "running";
  f.ledger.data.statusCards[1577].items.push({ name: "Coal price display", stage: "found", blocked: false, note: "" });
  await assert.rejects(finish(), /Coal price display/);
});

test("a card with every fix live or moving finishes waiting without a prompt", async (t) => {
  const f = fixture(t);
  f.ledger.data.statusCards = { 1577: { items: [{ name: "Dropdowns", stage: "main", blocked: false, note: "" }] } };
  const done = await f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "player_reply", summary: "Waiting for the player to confirm." });
  assert.equal(done.state, "waiting");
});

function watching(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-562-watch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const job = ledger.createJob("finding:watch", { kind: "finding", role: "support", source: {}, deadline: NOW + 86400000 });
  job.state = "waiting";
  job.raisedToDevelopers = [{ id: 77, title: "Read the MNM settlement queues", at: NOW, blocking: true }];
  let time = NOW, item = { id: 77, lane: "next", assigned_to: null, last_progress_at: null, progress_summary: "", events: [] };
  const watch = createDeveloperWatch({ ledger, mcp: { call: async () => item }, now: () => time });
  return { ledger, job, watch, at: (x) => { time = x; }, set: (x) => { item = { ...item, ...x }; } };
}

test("Keir's own card notes never wake the task", async (t) => {
  const w = watching(t);
  await w.watch.tick();
  w.at(NOW + POLL_MS); w.set({ progress_summary: "Still unassigned, re-checked.", last_progress_at: new Date(NOW + POLL_MS).toISOString(), events: [{ actor: "keir", event_type: "progress" }] });
  await w.watch.tick();
  assert.equal(w.job.inbox, undefined);
  w.at(NOW + 2 * POLL_MS); w.set({ progress_summary: "Ran the four queries.", events: [{ actor: "claude", event_type: "progress" }] });
  await w.watch.tick();
  assert.match(w.job.inbox.at(-1).content, /new progress/);
});

test("an unclaimed handoff gets one overdue wake, then parks for the brief", async (t) => {
  const w = watching(t);
  await w.watch.tick();
  w.at(NOW + ACK_MS); await w.watch.tick();
  assert.match(w.job.inbox.at(-1).content, /parked for the owner's morning brief/);
  assert.equal(parkedOnHandoffs(w.job), true);
  // The hourly wait review leaves a parked task asleep.
  w.job.state = "waiting"; w.job.inbox = []; w.job.waitReview = { since: NOW, reviewAt: NOW, progress: "x" };
  reviewWaits(w.ledger, {}, NOW + ACK_MS + 3600000);
  assert.equal(w.job.inbox.length, 0);
  // Acceptance by a developer unparks it.
  w.at(NOW + ACK_MS + POLL_MS); w.set({ lane: "now", assigned_to: "claude", last_progress_at: new Date(NOW + ACK_MS + POLL_MS).toISOString(), events: [{ actor: "claude" }] });
  await w.watch.tick();
  assert.equal(parkedOnHandoffs(w.job), false);
  assert.match(w.job.inbox.at(-1).content, /accepted by claude/);
});
