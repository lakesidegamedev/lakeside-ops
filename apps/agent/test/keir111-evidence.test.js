"use strict";
// Keir 11.1: evidence reads (market_history, reporter_operating_results, reporter_action_points), reporter binding,
// and evidence-gap learning that cannot confirm itself.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker, SUPPORT_READS, FINDING_READS, PLAYER_PRIVATE } = require("../lib/operator/broker");
const { createNotebook } = require("../lib/operator/knowledge");
const gap = require("../lib/operator/evidencegap");
const { SEEDS } = require("../lib/operator/readyreads");

const ok = (metric, rows = [{ turn: 10, value: 5 }], gaps = []) => ({ schemaVersion: 1, metric, unit: "x", scope: {}, world: "w", asOfTurn: 10, rows, sources: ["s"], gaps });
function setup({ withNotebook = false, list = async () => [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir111-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { screenOutgoing: async () => ({ labels: [], refuse: null }), ownerId: "111111111111111111", staffIds: [], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const calls = [];
  const mcp = { servers: () => ["support", "gamestate"], list, call: async (server, tool, args) => {
    calls.push([server, tool, args]);
    if (tool === "support_get") return { number: 123, title: "Shops", reporter: { characterName: "Ada Reed", profileUrl: "https://x/character/42" }, intake: { cardMessageId: "555555555555555555" } };
    if (server === "gamestate") return ok(tool === "market_history" ? "national_gdp_level" : "operating_profit");
    return { ok: true, delivery: { posted: true, status: "posted" } };
  } };
  const notebook = withNotebook ? createNotebook({ file: path.join(dir, "nb.json"), exec: (_c, a) => { if (a.includes("rev-parse")) return "a".repeat(40) + "\n"; throw new Error("git"); } }) : null;
  const broker = createBroker({ ledger, config, mcp, discord: async () => ({}), sandbox: { run: async () => ({ code: 0, output: "" }) }, notebook, now: () => 10 * 3600000 });
  const mk = (extra = {}) => { const job = ledger.createJob("k" + Math.random(), { role: "support", kind: "ticket", ticket: 123, channelId: "777777777777777777", deadline: 9e15, ...extra }); job.state = "running"; return job; };
  return { ledger, broker, calls, mk, notebook, d: ledger.data };
}
const read = (f, job, tool, args = {}) => f.broker.tool(job, "read_tool", { server: "gamestate", tool, args });
const last = (f) => f.calls.filter((c) => c[0] === "gamestate").at(-1)[2];

test("the three reads are in support scope; the private two are reporter-bound and absent from findings", () => {
  for (const t of ["market_history", "reporter_operating_results", "reporter_action_points"]) assert.ok(SUPPORT_READS.gamestate.includes(t), t);
  assert.ok(!PLAYER_PRIVATE.has("market_history"));
  for (const t of ["reporter_operating_results", "reporter_action_points"]) { assert.ok(PLAYER_PRIVATE.has(t)); assert.ok(!FINDING_READS.gamestate.includes(t)); }
  assert.ok(FINDING_READS.gamestate.includes("market_history"));
});

test("reporter reads inject the ticket reporter and drop a matching identity argument", async () => {
  const f = setup(), job = f.mk();
  await read(f, job, "reporter_operating_results", { from: 1 });
  assert.deepEqual(last(f), { from: 1, character: "42", ticket: 123 });
  await read(f, job, "reporter_action_points", { characterId: "42", name: "ada reed", ticket: 123 });
  assert.deepEqual(last(f), { character: "42", ticket: 123 });
});

test("private read narrows a later reply through the broker and an older support service cannot receive it", async () => {
  for (const advertised of [true, false]) {
    const list = async () => advertised ? [{ name: "support_public_update", inputSchema: { properties: { ticket_only: { type: "boolean" } } } }] : [];
    const f = setup({ list }), j = f.mk();
    await read(f, j, "reporter_action_points");
    assert.equal(f.d.privateEvidenceTickets[123], true);
    const reply = f.mk({ replyChannel: j.channelId, source: { channelId: j.channelId, channelName: "ticket-question-123" } });
    f.d.disclosed = { 123: { posted: true, at: 1 } };
    const send = f.broker.tool(reply, "channel_reply", { message: "Your balance is recorded in your ticket." });
    if (advertised) await send;
    else await assert.rejects(send, /cannot keep this answer off the public receipt/);
    const writes = f.calls.filter(([,name]) => name === "support_public_update");
    assert.equal(writes.length, advertised ? 1 : 0);
    if (advertised) assert.equal(writes[0][2].ticket_only, true);
  }
});

test("another person's identity is refused under every argument name, and nothing is sent", async () => {
  const f = setup(), job = f.mk();
  const before = f.calls.length;
  for (const k of ["character", "characterId", "sequentialId", "id", "name", "player", "username", "account", "reporter"]) {
    await assert.rejects(read(f, job, "reporter_operating_results", { [k]: "99" }), /verified reporter/, k);
  }
  await assert.rejects(read(f, job, "reporter_action_points", { ticket: 456 }), /verified reporter/);
  assert.equal(f.calls.slice(before).filter((c) => c[0] === "gamestate").length, 0);
});

test("an inherited investigation reads the parent ticket's reporter, never a chosen one", async () => {
  const f = setup(), parent = f.mk();
  const child = f.ledger.createJob("k" + Math.random(), { role: "support", kind: "coding", investigation: true, codingParent: parent.id, deadline: 9e15 }); child.state = "running";
  await read(f, child, "reporter_action_points", {});
  assert.equal(last(f).character, "42");
  await assert.rejects(read(f, child, "reporter_action_points", { character: "7" }), /verified reporter/);
});

test("no private read without a ticket or a linked character", async () => {
  const f = setup();
  const loose = f.ledger.createJob("k" + Math.random(), { role: "support", kind: "ticket", deadline: 9e15 }); loose.state = "running";
  await assert.rejects(read(f, loose, "reporter_operating_results", {}), /assigned ticket/);
  const job = f.mk(); job.reporterCharacter = { id: null, name: null };
  await assert.rejects(read(f, job, "reporter_action_points", {}), /linked character/);
});

test("market_history is public: arguments pass through untouched", async () => {
  const f = setup(), job = f.mk();
  await read(f, job, "market_history", { metric: "national_gdp_level", country: "UK" });
  assert.deepEqual(last(f), { metric: "national_gdp_level", country: "UK" });
});

test("routing seeds cover level versus growth, sold versus offered, shops and action points", () => {
  const to = (tool) => SEEDS.filter((s) => s[2] === tool).map((s) => s[0]).join(" | ");
  assert.match(to("market_history"), /GDP/); assert.match(to("market_history"), /sold versus offered/);
  assert.match(to("reporter_operating_results"), /operating profit/);
  assert.match(to("reporter_action_points"), /action points/);
});

test("judge: served, gap-declared and empty results", () => {
  assert.deepEqual(gap.judge(ok("m")), { metric: "m", served: true, missing: false });
  assert.equal(gap.judge(ok("m", [{ v: 1 }], [{ field: "fees" }])).missing, true);
  assert.equal(gap.judge(ok("m", [{ v: null }])).missing, true);
  assert.equal(gap.judge(ok("m", [{ turn: 3, siteId: "a", profit: null }])).missing, true, "identity columns are not measurements");
  assert.equal(gap.judge(ok("m", [{ turn: 3, profit: 2 }], [{ code: "other_world_rows_excluded" }])).served, true);
  assert.equal(gap.judge({ error: "x" }), null);
});

test("each gap reason is recorded from its own signal", () => {
  const d = {}, job = { ticket: 1, role: "support" }, rd = (tool) => ({ server: "gamestate", tool });
  gap.noteRead(d, job, rd("market_history"), null, "read tool is outside support scope: market_history is not a gamestate read available to this task");
  gap.noteRead(d, job, rd("reporter_operating_results"), ok("operating_profit", [{ v: null }]));
  gap.notePost(d, 1, "National GDP is 4.2 trillion", false);
  gap.noteRead(d, job, rd("market_history"), ok("national_gdp_level"));
  gap.notePost(d, 1, "Correction: that was the level, growth is 2 percent", true);
  gap.noteFeedback(d, 2, "wrong_or_misleading"); // no sourced read on ticket 2: not an explanation gap
  gap.noteRead(d, { ticket: 3 }, rd("reporter_action_points"), ok("action_point_balance"));
  gap.noteFeedback(d, 3, "wrong_or_misleading");
  const s = gap.summary(d);
  assert.deepEqual(s.byReason, { wrong_metric: 1, tool_discovery: 1, missing_data: 1, unclear_explanation: 1 });
});

test("a lesson holds only fixed wording, appears after two independent gaps, and is confirmed only by an independent recalled clean case the reporter voted helpful on", () => {
  const f = setup({ withNotebook: true }), d = f.d, nb = f.notebook;
  nb.recallLog = path.join(os.tmpdir(), `rl-${process.pid}-${Date.now()}.jsonl`);
  const rd = { server: "gamestate", tool: "market_history" };
  const origin = (t) => { const j = { ticket: t, role: "support" }; gap.notePost(d, t, "GDP is 4.2 trillion for Ada Reed", false); gap.noteRead(d, j, rd, ok("national_gdp_level")); gap.notePost(d, t, "Correction: wrong measure", true); };
  // One gap is a candidate only: nothing reaches the notebook, so nothing reaches automatic recall.
  origin(10);
  assert.equal(gap.settle({ d, notebook: nb, ticket: 10, reporter: "42" }).lessons.length, 0);
  assert.equal(nb.all().filter((n) => n.by === gap.BY).length, 0);
  origin(9); // same reporter again does not count as independent
  assert.equal(gap.settle({ d, notebook: nb, ticket: 9, reporter: "42" }).lessons.length, 0);
  origin(8);
  const out = gap.settle({ d, notebook: nb, ticket: 8, reporter: "41" });
  assert.equal(out.lessons.length, 1);
  const lesson = nb.all().find((n) => n.id === out.lessons[0]);
  assert.match(lesson.text, /^\[lane:question\] Evidence gap, wrong metric: .*market_history \(national_gdp_level\)/);
  assert.doesNotMatch(lesson.text, /Ada|4\.2|trillion|Correction: wrong measure/);
  assert.equal(lesson.verified, false);
  const sig = d.evidenceGaps.signatures["wrong_metric:market_history:national_gdp_level"];
  const clean = (t) => { gap.noteRead(d, { ticket: t, role: "support" }, rd, ok("national_gdp_level")); };
  const recall = (t) => fs.appendFileSync(nb.recallLog, JSON.stringify({ ticket: t, ids: [lesson.id] }) + "\n");
  // Origin ticket again, same reporter elsewhere, and recall absent: none confirm.
  clean(10); gap.noteFeedback(d, 10, "helpful"); gap.settle({ d, notebook: nb, ticket: 10, reporter: "42" });
  clean(11); recall(11); gap.noteFeedback(d, 11, "helpful"); assert.equal(gap.settle({ d, notebook: nb, ticket: 11, reporter: "42" }).confirmed.length, 0, "same reporter as an origin");
  clean(12); gap.noteFeedback(d, 12, "helpful"); assert.equal(gap.settle({ d, notebook: nb, ticket: 12, reporter: "77" }).confirmed.length, 0, "not recalled");
  // Independent, recalled, clean, but closed with no reporter outcome: recalled quietly, never confirmed (not even by thanks text).
  clean(15); recall(15); gap.notePost(d, 15, "Thanks, that is what I needed", false);
  const quiet = gap.settle({ d, notebook: nb, ticket: 15, reporter: "80" });
  assert.equal(quiet.confirmed.length, 0); assert.equal(quiet.quiet.length, 1);
  assert.equal(sig.cases.length, 0); assert.equal(sig.quiet.length, 1);
  // Independent, recalled, clean and the reporter's own helpful vote: confirmed.
  clean(13); recall(13); gap.noteFeedback(d, 13, "helpful"); assert.equal(gap.settle({ d, notebook: nb, ticket: 13, reporter: "78" }).confirmed.length, 1);
  assert.equal(sig.cases.length, 1);
  // A vote that lands after settling upgrades only that ticket's quiet case.
  gap.noteFeedback(d, 15, "helpful");
  assert.equal(sig.cases.length, 2); assert.equal(sig.quiet.length, 0);
  // A corrected case does not confirm, and a ticket settles once.
  clean(14); recall(14); gap.noteFeedback(d, 14, "helpful"); gap.notePost(d, 14, "It is 3", false); gap.notePost(d, 14, "Correction: no", true);
  assert.equal(gap.settle({ d, notebook: nb, ticket: 14, reporter: "79" }).confirmed.length, 0);
  assert.equal(gap.settle({ d, notebook: nb, ticket: 13, reporter: "78" }).confirmed.length, 0);
  assert.equal(gap.summary(d).confirmed, 1);
  fs.rmSync(nb.recallLog, { force: true });
});

test("a standing caveat is not a failed answer, and an undeployed tool is not a discovery failure", () => {
  const d = {}, job = { ticket: 5, role: "support" }, rd = (tool) => ({ server: "gamestate", tool });
  for (const code of ["one_off_fees_not_in_operating_results", "grant_log_window", "other_world_rows_excluded"]) {
    assert.equal(gap.judge(ok("m", [{ turn: 1, profit: 2 }], [{ code, message: "x" }])).served, true, code);
  }
  assert.equal(gap.judge(ok("m", [{ turn: 1, profit: 2 }], [{ code: "no_national_growth_history", message: "x" }])).missing, true);
  gap.noteRead(d, job, rd("market_history"), null, "outside support scope: not a gamestate read available to this task", 1, { callable: new Set(["trace_corp"]) });
  assert.equal(gap.summary(d).byReason.tool_discovery, 0);
  gap.noteRead(d, job, rd("market_history"), null, "outside support scope: not a gamestate read available to this task", 1, { callable: new Set(["market_history"]) });
  assert.equal(gap.summary(d).byReason.tool_discovery, 1);
});

test("learning grants nothing: read scope is unchanged by settling lessons", () => {
  const before = JSON.stringify(SUPPORT_READS), d = {};
  gap.noteRead(d, { ticket: 1, role: "support" }, { server: "gamestate", tool: "market_history" }, null, "outside support scope");
  gap.settle({ d, notebook: null, ticket: 1, reporter: "1" });
  assert.equal(JSON.stringify(SUPPORT_READS), before);
});
