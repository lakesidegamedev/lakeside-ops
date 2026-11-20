"use strict";
// Keir 11.1: the evidence dictionary through the broker (public player scope, broker-built arguments, live availability),
// reporter identity in every role, quick-turn routing, and the lesson report's confirmed-versus-recalled columns.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const lookup = require("../lib/operator/evidencelookup");
const gap = require("../lib/operator/evidencegap");
const { buildReport } = require("../lib/operator/lessonreport");
const { SEEDS } = require("../lib/operator/readyreads");

const OWNER = "111111111111111111", DEV = "222222222222222222";
function setup({ listed = ["market_history", "reporter_operating_results", "reporter_action_points", "trace_corp"], listFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir111l-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { screenOutgoing: async () => ({ labels: [], refuse: null }), ownerId: OWNER, staffIds: [DEV], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntake: 5, readyReads: false };
  const calls = [];
  const mcp = { servers: () => ["support", "gamestate", "ops-knowledge"],
    list: async (server) => { if (listFails) throw new Error("down"); return server === "gamestate" ? listed.map((name) => ({ name })) : []; },
    call: async (server, tool, args) => {
      calls.push([server, tool, args]);
      if (tool === "support_get") return { number: 123, title: "Shops", reporter: { characterName: "Ada Reed", username: "adareed", profileUrl: "https://x/character/42" }, intake: { cardMessageId: "555555555555555555" } };
      if (tool === "support_evidence_lookup") return { matched: true, results: [{ id: "national_gdp", recommendation: { tool: "market_history", args: { metric: "gdp_level" }, status: "planned", callable: true }, alternatives: [] }] };
      return { schemaVersion: 1, metric: "m", rows: [{ turn: 1, value: 1 }], gaps: [] };
    } };
  const broker = createBroker({ ledger, config, mcp, discord: async () => ({}), sandbox: { run: async () => ({ code: 0, output: "" }) }, notebook: null, now: () => 10 * 3600000 });
  const mk = (extra = {}) => { const job = ledger.createJob("k" + Math.random(), { role: "support", kind: "ticket", ticket: 123, channelId: "777777777777777777", deadline: 9e15, ...extra }); job.state = "running"; return job; };
  return { ledger, broker, calls, mk, d: ledger.data };
}
const lk = (f, job, args) => f.broker.tool(job, "read_tool", { server: "ops-knowledge", tool: "support_evidence_lookup", args });
const sent = (f, tool) => f.calls.filter((c) => c[1] === tool).at(-1)?.[2];

test("a public player ping may call the dictionary and no other ops-knowledge read", async () => {
  const f = setup(), job = f.mk({ role: "player" });
  const r = await lk(f, job, { question: "Did GDP fall or did growth slow?" });
  assert.equal(r.results[0].id, "national_gdp");
  for (const tool of ["code_search", "knowledge_query", "kanban_get", "knowledge_get"]) {
    await assert.rejects(f.broker.tool(job, "read_tool", { server: "ops-knowledge", tool, args: { query: "x" } }), /player conversation reads are limited/, tool);
  }
  const listed = await f.broker.tool(job, "read_tools", { server: "ops-knowledge" }).catch((e) => e);
  assert.ok(!(listed instanceof Error) || !/limited/.test(listed.message));
});

test("the broker builds the lookup arguments: scrubbed wording, public identifiers only, the live tool list", async () => {
  const f = setup(), job = f.mk();
  await lk(f, job, { question: "Ada Reed (adareed, <@123456789012345678>, /character/42) says GDP dropped, see https://x.test/a", topic: "national_gdp",
    availableTools: ["everything"], identifiers: { country: "us", commodity: "steel", characterId: "42", corporationId: "abc", turn: 5, name: "Ada Reed" } });
  const a = sent(f, "support_evidence_lookup");
  assert.deepEqual(Object.keys(a).sort(), ["availableTools", "identifiers", "question", "topic"]);
  assert.deepEqual(a.identifiers, { country: "US", commodity: "steel" });
  assert.doesNotMatch(a.question, /Ada|Reed|adareed|42|https|123456789012345678/);
  assert.match(a.question, /GDP dropped/);
  assert.ok(!a.availableTools.includes("everything"), "the model's availability hint is not trusted");
  assert.deepEqual([...a.availableTools].sort(), ["market_history", "reporter_action_points", "reporter_operating_results", "trace_corp"]);
  await assert.rejects(lk(f, job, { question: "ab" }), /question in the reporter's words/);
});

test("live hours: an unlisted read comes back as a stated gap, a dead tool list as unknown", async () => {
  let f = setup({ listed: ["trace_corp"] });
  let r = await lk(f, f.mk(), { question: "did national GDP fall this week" });
  assert.equal(r.results[0].recommendation.gap, true); assert.equal(r.results[0].recommendation.wanted, "market_history");
  assert.match(r.results[0].recommendation.note, /not checked/);
  f = setup({ listFails: true });
  r = await lk(f, f.mk(), { question: "did national GDP fall this week" });
  assert.equal(f.calls.find((c) => c[1] === "support_evidence_lookup")[2].availableTools, undefined);
  assert.equal(r.results[0].recommendation.callable, "unknown");
  // The reporter reads are not offered to a task with no ticket.
  f = setup();
  const loose = f.ledger.createJob("k" + Math.random(), { role: "owner", kind: "command", deadline: 9e15 }); loose.state = "running";
  await lk(f, loose, { question: "where did my action points go" });
  assert.ok(!sent(f, "support_evidence_lookup").availableTools.includes("reporter_action_points"));
});

const rr = (f, job, tool, args = {}) => f.broker.tool(job, "read_tool", { server: "gamestate", tool, args });
test("reporter identity is broker-injected for an owner, a developer in a public room, a player and an inherited child", async () => {
  const f = setup();
  const roles = [
    ["owner", f.mk({ role: "owner", kind: "command", actorId: OWNER, source: { authorId: OWNER } })],
    ["developer", f.mk({ role: "support", kind: "command", actorId: DEV, source: { authorId: DEV } })],
    ["player", f.mk({ role: "player" })],
    ["support", f.mk()],
  ];
  const parent = f.mk();
  roles.push(["child", f.ledger.createJob("k" + Math.random(), { role: "support", kind: "coding", investigation: true, codingParent: parent.id, deadline: 9e15 })]);
  roles.push(["grandchild", f.ledger.createJob("k" + Math.random(), { role: "support", kind: "coding", investigation: true, codingParent: roles.at(-1)[1].id, deadline: 9e15 })]);
  for (const [name, job] of roles) {
    job.state = "running";
    for (const tool of ["reporter_operating_results", "reporter_action_points"]) {
      await rr(f, job, tool, { turns: 4 });
      assert.deepEqual(sent(f, tool), { turns: 4, character: "42", ticket: 123 }, `${name} ${tool}`);
      const before = f.calls.length;
      for (const k of ["character", "characterId", "name", "username", "account"]) await assert.rejects(rr(f, job, tool, { [k]: "99" }), /verified reporter/, `${name} ${k}`);
      await assert.rejects(rr(f, job, tool, { ticket: 999 }), /verified reporter/, `${name} ticket`);
      assert.equal(f.calls.length, before, `${name}: nothing sent`);
    }
  }
});

test("a role with no ticket anywhere cannot read a reporter, even an owner naming one", async () => {
  const f = setup();
  const owner = f.ledger.createJob("k" + Math.random(), { role: "owner", kind: "command", actorId: OWNER, source: { authorId: OWNER }, deadline: 9e15 }); owner.state = "running";
  await assert.rejects(rr(f, owner, "reporter_action_points", { character: "7", ticket: 5 }), /no assigned ticket/);
  assert.equal(f.calls.filter((c) => c[1] === "reporter_action_points").length, 0);
});

test("quick-turn routing points at the dictionary for confusable measures and stays quiet for simple replies", () => {
  for (const q of ["Did the US GDP drop 5% this week? I thought it grew.", "why is the demand for steel listed higher than what was filled", "my shop revenue is 10k but operating profit is negative, why", "where did my action points go last turn"]) {
    assert.ok(lookup.hintFor(q), q);
  }
  for (const q of ["thanks!", "ok stop updating me", "where do I find the parties page", "hello", "how do I join a party"]) assert.equal(lookup.hintFor(q), null, q);
  assert.equal(lookup.hintFor("did GDP drop this week", { available: false }), null);
  const to = SEEDS.filter((s) => s[1] === "ops-knowledge" && s[2] === "support_evidence_lookup").map((s) => s[0]).join(" | ");
  for (const w of [/GDP/, /demand/, /operating profit/, /action points/]) assert.match(to, w);
});

test("lesson report: reporter-confirmed outcomes are shown apart from independent recalls that only closed", () => {
  const notes = [{ id: "n1", kind: "lesson", text: "lesson one", at: 1 }, { id: "n2", kind: "lesson", text: "lesson two", at: 1 }];
  const evidenceGaps = { signatures: { a: { lesson: "n1", cases: [{ ticket: 1 }, { ticket: 2 }], quiet: [{ ticket: 3 }] }, b: { lesson: "n2", cases: [], quiet: [{ ticket: 4 }, { ticket: 5 }] } } };
  const r = buildReport({ notes, recalls: [{ at: 5, ids: ["n1"], ticket: 1 }], evidenceGaps, now: 10 });
  const [a, b] = r.lessons;
  assert.deepEqual(a.evidence, { outcomeConfirmed: 2, recalledQuiet: 1 }); assert.ok(!a.flags.includes("no_reporter_outcome"));
  assert.deepEqual(b.evidence, { outcomeConfirmed: 0, recalledQuiet: 2 }); assert.ok(b.flags.includes("no_reporter_outcome"));
  assert.equal(r.summary.outcomeConfirmed, 1); assert.equal(r.summary.recalledQuietOnly, 1);
});

test("a helpful vote arriving through feedback.js counts as the reporter's outcome", () => {
  const d = {};
  gap.noteFeedback(d, 7, "helpful");
  assert.ok(d.evidenceGaps.tickets["7"].reporterConfirmed);
  gap.noteFeedback(d, 7, "wrong_or_misleading");
  assert.equal(d.evidenceGaps.tickets["7"].reporterConfirmed, undefined);
});
