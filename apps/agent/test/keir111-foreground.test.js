"use strict";
// Keir 11.1: the interrupting foreground turn has a bounded read path (evidence dictionary and vetted game reads only),
// enforced in the broker, and a topic hint that survives an elliptical follow-up. Synthetic ids and names only.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const turn = require("../lib/operator/conversationturn");
const lookup = require("../lib/operator/evidencelookup");

const CH = "777777777777777777";
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir111fg-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntake: 5, readyReads: false };
  const calls = [];
  const names = ["market_history", "commodity_market", "country_fiscal", "reporter_operating_results", "reporter_action_points", "trace_corp"];
  const mcp = { servers: () => ["support", "gamestate", "ops-knowledge", "heal-ops"],
    list: async (server) => (server === "gamestate" ? names.map((name) => ({ name })) : []),
    call: async (server, tool, args) => {
      calls.push([server, tool, args]);
      if (tool === "support_get") return { number: 123, title: "Synthetic", reporter: { characterName: "Test Reporter", username: "testreporter", profileUrl: "https://x/character/42" }, intake: { cardMessageId: "555555555555555555" } };
      if (tool === "support_evidence_lookup") return { matched: true, results: [{ id: "action_points", recommendation: { tool: "reporter_action_points", args: {}, callable: true }, alternatives: [] }] };
      return { schemaVersion: 1, metric: "m", rows: [{ turn: 1, value: 9 }], gaps: [] };
    } };
  const broker = createBroker({ ledger, config, mcp, discord: async () => ({}), sandbox: { run: async () => ({ code: 0, output: "" }) }, notebook: null, now: () => 10 * 3600000 });
  const job = ledger.createJob("fg" + Math.random(), { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, deadline: 9e15 });
  job.state = "running";
  turn.foreground.add(job);
  return { broker, calls, job, ledger, mcp };
}
const read = (f, job, server, tool, args = {}) => f.broker.tool(job, "read_tool", { server, tool, args });
const row = (id, content, authorId = "p1", extra = {}) => ({ messageId: id, authorId, channelId: CH, role: "player", content, ...extra });

test("a foreground turn reads the dictionary and the vetted game reads through the normal broker", async () => {
  const f = setup();
  const r = await read(f, f.job, "ops-knowledge", "support_evidence_lookup", { question: "Did my action points go missing?" });
  assert.equal(r.results[0].id, "action_points");
  for (const tool of ["market_history", "commodity_market", "country_fiscal"]) await read(f, f.job, "gamestate", tool, {});
  for (const tool of ["reporter_operating_results", "reporter_action_points"]) {
    await read(f, f.job, "gamestate", tool, { turns: 3 });
    assert.deepEqual(f.calls.filter((c) => c[1] === tool).at(-1)[2], { turns: 3, character: "42", ticket: 123 }, "identity comes from the broker");
    await assert.rejects(read(f, f.job, "gamestate", tool, { character: "99" }), /verified reporter/);
  }
});

test("everything wider stays with the worker, and nothing reaches the server when refused", async () => {
  const f = setup();
  const before = f.calls.length;
  for (const [server, tool, args] of [["gamestate", "trace_corp", {}], ["gamestate", "trace_character", {}], ["ops-knowledge", "code_search", { question: "x" }],
    ["ops-knowledge", "knowledge_query", { text: "x" }], ["heal-ops", "heal_query", { collection: "characters" }], ["support", "support_get", { number: 123 }], ["gamestate", "market_history_extra", {}]]) {
    await assert.rejects(read(f, f.job, server, tool, args), /may read only the evidence dictionary/, `${server}/${tool}`);
  }
  await assert.rejects(f.broker.tool(f.job, "evidence_batch", { queries: [{ op: "list" }] }), /worker owns this investigation/);
  await assert.rejects(f.broker.tool(f.job, "read_tools", { server: "gamestate" }), /worker owns this investigation/);
  assert.equal(f.calls.length, before);
  // The same call outside a foreground turn is unchanged.
  turn.foreground.delete(f.job);
  await read(f, f.job, "gamestate", "trace_corp", {});
});

test("only a verified Discord conversation context may use the foreground reads", async () => {
  const f = setup();
  f.job.replyChannel = "app"; f.job.channelId = "app";
  await assert.rejects(read(f, f.job, "gamestate", "market_history", {}), /may read only the evidence dictionary/);
  const g = setup(); g.job.codingParent = "parent";
  await assert.rejects(read(g, g.job, "gamestate", "market_history", {}), /may read only|worker owns/);
  const h = setup(); h.job.replyChannel = "888888888888888888";
  await assert.rejects(read(h, h.job, "gamestate", "market_history", {}), /may read only/);
});

test("a foreground turn with no ticket cannot read a reporter, and present_evidence is allowed through the foreground gate", async () => {
  const f = setup();
  Object.assign(f.job, { kind: "conversation", ticket: null, actorId: "p1" });
  await assert.rejects(read(f, f.job, "gamestate", "reporter_action_points", { character: "7" }), /no assigned ticket/);
  assert.ok(turn.foregroundTools.has("present_evidence") && turn.foregroundTools.has("read_tool"));
  assert.equal(turn.foregroundTools.has("github"), false);
});

test("hints: the latest message first, then an elliptical follow-up borrows the same person's previous question", () => {
  const ap = row("100000000000000001", "I'm supposed to get 9 action points each turn");
  const hint = lookup.foregroundHint([ap, row("100000000000000002", "But I don't think I did")]);
  assert.equal(hint.args.topic, "action_points");
  assert.match(hint.basis, /previous question/);
  assert.match(hint.instruction, /Try before you hedge/);
  assert.equal(lookup.foregroundHint([ap]).args.topic, "action_points");
  // sectors sweep routes to the market dictionary
  assert.equal(lookup.foregroundHint([row("1", "check all sectors like you did for freight")]).args.topic, "market_demand");
  // another person's question is not borrowed
  assert.equal(lookup.foregroundHint([ap, row("100000000000000002", "But I don't think I did", "p2")]), null);
  // navigation, refund, stop and thanks never resurrect the earlier topic
  for (const m of ["thanks", "ok stop updating me", "where do I find the parties page", "I want a refund for that", "and how do I cancel this?"]) {
    assert.equal(lookup.foregroundHint([ap, row("100000000000000002", m)]), null, m);
  }
  // a latest message that names its own measure wins over the earlier one
  assert.equal(lookup.foregroundHint([ap, row("100000000000000002", "why is my shop revenue 10k but operating profit negative")]).args.topic, "corp_revenue_profit");
  assert.equal(lookup.foregroundHint([ap], { available: false }), null);
  assert.doesNotMatch(JSON.stringify(lookup.foregroundHint([row("1", "Test Reporter <@123456789012345678> lost action points https://x.test/a")]).args), /123456789012345678|https/);
});
