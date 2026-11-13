"use strict";
// Keir 9: the player's own page is re-read before anything is called fixed.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const pagecheck = require("../lib/operator/pagecheck");

const CH = "777777777777777777";
const discord = async (_m, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-123" }] : []);
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir9-page-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false };
  const calls = [], state = { fresh: { revenue: 41288610 } };
  const mcp = { servers: () => ["support", "ops-knowledge", "gamestate"], list: async () => ["support_public_update", "support_resolve", "code_search"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })),
    call: async (...a) => { calls.push(a); return a[1] === "trace_sector" ? state.fresh : { ok: true, id: "card-9", hits: [], delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-123", content: "My oil revenue looks wrong" }, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id; ledger.data.disclosed = { 123: { at: 1, posted: true } };
  ledger.data.ticketObservations = { 123: [{ key: "k", task: "old", tool: "read_tool", at: 5, input: JSON.stringify({ server: "gamestate", tool: "trace_sector", args: { region: "Norland", sector: "Oil" } }), result: JSON.stringify({ revenue: 41288610 }) }] };
  ledger.data.ruleLookupRefused = { 123: 1 };
  const posts = () => calls.filter((c) => c[1] === "support_public_update" && c[2].deliver === true).map((c) => c[2].message);
  const reads = () => calls.filter((c) => c[1] === "trace_sector").length;
  const audits = (k) => (ledger.data.audit || []).filter((a) => a.kind === k);
  const release = () => { job.releaseEvidence = { a: { main: true } }; };
  const turn = () => { clock += 3600000; job.turnChecks = [...(job.turnChecks || []), clock]; job.lastGameReadAt = clock + 1; };
  const claim = () => broker.tool(job, "channel_reply", { message: "Your oil page is now fixed." });
  return { ledger, broker, job, state, posts, reads, audits, release, turn, claim, advance: (m) => { clock += m * 60000; } };
}
const symptomPost = (f) => f.broker.tool(f.job, "channel_reply", { message: "Your oil revenue shows 41,288,610 right now." });

test("the first cited page figure is recorded as the symptom", async () => {
  const f = setup(); await symptomPost(f);
  const s = f.ledger.data.ticketSymptoms[123];
  assert.deepEqual({ tool: s.tool, field: s.field, value: s.value, server: s.server }, { tool: "trace_sector", field: "revenue", value: 41288610, server: "gamestate" });
  assert.equal(s.args.sector, "Oil");
});

test("a changed figure lets the fixed message post", async () => {
  const f = setup(); await symptomPost(f); f.release(); f.turn(); f.state.fresh = { revenue: 52000000 };
  await f.claim();
  assert.equal(f.posts().some((p) => /now fixed/.test(p)), true);
  assert.equal(f.reads(), 1);
});

test("an unchanged figure refuses it, posts the plain message once and wakes the task", async () => {
  const f = setup(); await symptomPost(f); f.release(); f.turn(); f.job.state = "waiting";
  await f.broker.pageCheckAfterTurn(f.job);
  assert.equal(f.job.state, "queued"); f.job.state = "running";
  await assert.rejects(f.claim(), /still shows the old figure/);
  assert.equal(f.reads(), 1);
  assert.equal(f.posts().filter((p) => /still shows the old figure/.test(p)).length, 1);
  assert.equal(f.posts().some((p) => /now fixed/.test(p)), false);
  assert.equal(f.job.inbox.some((m) => m.authorId === "page-check"), true);
  f.advance(40); await assert.rejects(f.claim(), /still shows the old figure/);
  assert.equal(f.posts().filter((p) => /still shows the old figure/.test(p)).length, 1);
});

test("one re-read per turn, at most three turns, then an escalation to the developers", async () => {
  const f = setup(); await symptomPost(f); f.release();
  for (let k = 1; k <= 3; k++) {
    f.turn(); await assert.rejects(f.claim(), /still shows the old figure/); await assert.rejects(f.claim(), /still shows the old figure/);
    assert.equal(f.reads(), k);
  }
  const st = f.ledger.data.pageChecks[123];
  assert.equal(st.turns, 3); assert.equal(st.escalated, true);
  assert.equal(f.job.raisedToDevelopers.length >= 1, true);
  f.turn(); await assert.rejects(f.claim());
  assert.equal(f.ledger.data.pageChecks[123].turns >= 3, true);
});

test("without a symptom the existing receipt rule applies unchanged", async () => {
  const f = setup(); f.ledger.data.ticketObservations = {}; f.release(); f.turn();
  await f.claim();
  assert.equal(f.reads(), 0);
  assert.equal(f.ledger.data.ticketSymptoms?.[123], undefined);
  assert.equal(f.posts().some((p) => /now fixed/.test(p)), true);
});

test("judge: field comparison, excerpt fallback and unreadable results", () => {
  const sym = { field: "a.b", value: 10 };
  assert.equal(pagecheck.judge(sym, { a: { b: 10 } }), "unchanged");
  assert.equal(pagecheck.judge(sym, { a: { b: "11" } }), "changed");
  assert.equal(pagecheck.judge({ excerpt: "10", value: 10 }, { x: 10 }), "unchanged");
  assert.equal(pagecheck.judge({ excerpt: "10", value: 10 }, { x: 12 }), "changed");
  assert.equal(pagecheck.judge(sym, null), "unknown");
  assert.equal(pagecheck.judge(sym, { error: "boom" }), "unknown");
});
