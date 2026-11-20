"use strict";
// Keir 11.1: figures from a verified, properly scoped game read ground a draft in their honest forms
// (GDP read in millions written out in full, a decrease read as -1.091 written "fell 1.091%").
// Everything else keeps the original guard. Synthetic world, country and turn data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./keir10-post.helpers");
const knowledge = require("../lib/operator/knowledge");
const typed = require("../lib/operator/typedfacts");

const body = (over = {}) => ({ schemaVersion: 1, tool: "market_history", metric: "gdp_change", unit: "percent",
  scope: { country: "US", region: null, level: "national", currency: "USD", fromTurn: 2, toTurn: 3 },
  world: { worldEpochId: "w1", telemetryWorldId: "synthetic:1", startedAt: "2026-01-01T00:00:00.000Z", currentTurn: 79 }, asOfTurn: 3,
  rows: [{ turn: 3, previousTurn: 2, previousValue: 32833360.36, value: 32475164.89, changePct: -1.091 }],
  summary: { fromTurn: 2, toTurn: 3, fromValue: 32833360.36, toValue: 32475164.89, changePct: -1.091 },
  sources: [], gaps: [], ...over });
const wrap = (b) => ({ content: [{ type: "text", text: JSON.stringify(b) }] });
const GOOD = "U.S. GDP fell 1.091% from turn 2 to turn 3, from US$32,833,360.36 million to US$32,475,164.89 million.";

function fixture(result, over = {}) {
  const f = setup({ servers: ["support", "ops-knowledge", "gamestate"], listed: ["market_history", "country_fiscal"], call: async (_s, tool) => {
    if (tool === "market_history") { if (result instanceof Error) throw result; return result; }
    if (tool === "country_fiscal") return { rows: [{ turn: 3, gdp: 4 }] };
    return { ok: true, delivery: { posted: true, delivery: { status: "posted" } } };
  }, ...over });
  f.playerWrote(5);
  f.read = () => f.broker.tool(f.job, "read_tool", { server: "gamestate", tool: "market_history", args: { metric: "gdp_change", country: "US", turns: 60, toTurn: 3 } });
  return f;
}

test("the measured case: check_draft and channel_reply accept the read figures as quoted", async () => {
  const f = fixture(wrap(body()));
  await f.read();
  const c = await f.broker.tool(f.job, "check_draft", { message: GOOD });
  assert.equal(c.ok, true, JSON.stringify(c));
  await f.broker.tool(f.job, "channel_reply", { message: GOOD });
  assert.equal(f.posts().length, 1);
});

test("an earlier activation's stored read still grounds the draft", async () => {
  const f = fixture(wrap(body()));
  await f.read();
  f.job.evidence = []; f.job.typedFacts = [];
  assert.equal((await f.broker.tool(f.job, "check_draft", { message: GOOD })).ok, true);
});

test("rounded equivalents and the 'percent' wording pass", async () => {
  const f = fixture(wrap(body()));
  await f.read();
  for (const m of ["GDP dropped 1.09% to about US$32.5 trillion.", "U.S. GDP fell from 32833360.36 million USD to 32475164.89 million USD, a drop of 1.091 percent."])
    assert.equal((await f.broker.tool(f.job, "check_draft", { message: m })).ok, true, m);
});

test("the guard still refuses unrelated numbers, wrong amounts and a decrease turned into growth", async () => {
  // Fresh fixture per draft: the ticket number check gives up after two refusals by design.
  for (const m of ["U.S. GDP fell 2.5% in that window.", "GDP is now US$40,000,000.55 million.", "U.S. GDP grew 1.091% from turn 2 to turn 3.", "U.S. GDP changed by 1.091% in that window."]) {
    const f = fixture(wrap(body()));
    await f.read();
    const c = await f.broker.tool(f.job, "check_draft", { message: m });
    assert.equal(c.ok, false, m);
    await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: m }), /does not appear|do not appear/);
    assert.equal(f.posts().length, 0);
  }
});

test("a failed, empty or unscoped read creates no fact", async () => {
  assert.deepEqual(typed.fromRead({ server: "gamestate", tool: "market_history" }, { isError: true, content: [{ type: "text", text: "boom" }] }), []);
  assert.deepEqual(typed.fromRead({ server: "gamestate", tool: "market_history" }, wrap(body({ rows: [] , summary: null }))), []);
  assert.deepEqual(typed.fromRead({ server: "gamestate", tool: "market_history" }, wrap(body({ scope: { country: "", currency: "USD" } }))), []);
  const f = fixture(new Error("market_history failed"));
  await assert.rejects(f.read());
  assert.equal((await f.broker.tool(f.job, "check_draft", { message: GOOD })).ok, false);
});

test("another tool or a private reporter read creates no fact", () => {
  assert.deepEqual(typed.fromRead({ server: "gamestate", tool: "reporter_operating_results" }, wrap(body())), []);
  assert.deepEqual(typed.fromRead({ server: "support", tool: "market_history" }, wrap(body())), []);
});

test("timestamps and ids are not figures, and plain checkable numbers behave as before", () => {
  const facts = typed.fromRead({ server: "gamestate", tool: "market_history" }, wrap(body()));
  assert.equal(facts.length > 0, true);
  assert.deepEqual(knowledge.unsupportedNumbers("Ticket #9051 at 2026-11-15 on turn 3.", [], facts), []);
  assert.deepEqual(knowledge.unsupportedNumbers("It cost 55,000.", [], []), ["55,000"]);
  assert.deepEqual(knowledge.unsupportedNumbers("It cost 55,000.", [55000], facts), []);
});
