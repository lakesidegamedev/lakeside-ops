"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { MAPPINGS, MAPPING_IDS, lookupEvidence, registerSupportEvidenceTools } = require("./support-evidence");

const first = (question, extra = {}) => lookupEvidence({ question, ...extra }).results[0];
const rec = (question, extra) => first(question, extra).recommendation;
const ALL = ["market_history", "commodity_market", "country_fiscal", "reporter_operating_results", "reporter_action_points"];

test("seeded questions land on their own mapping", () => {
  assert.equal(first("Why did GDP drop this drastically in a week").id, "national_gdp");
  assert.equal(first("Why is listed demand for grain higher than what was filled and funded?").id, "market_demand");
  assert.equal(first("My corporation realized revenue is high but operating profit is low").id, "corp_revenue_profit");
  assert.equal(first("How many action points were granted vs spent, and what is my balance?").id, "action_points");
});

test("every mapping has units, source references on both branches and gaps", () => {
  for (const m of MAPPINGS) {
    const r = first("x", { topic: m.id });
    for (const t of r.terms) assert.ok(t.definition && t.units && t.scope && t.field, `${m.id}:${t.term}`);
    assert.ok(r.implementation.references.every((x) => x.path.startsWith("src/") && x.symbols.length), m.id);
    assert.equal(r.implementation.verification.branches.length, 2);
    assert.equal(r.implementation.verification.deployment, "not_verified");
    assert.ok(r.gaps.length > 0, m.id);
  }
});

test("GDP level question recommends market_history at national level, not country_fiscal", () => {
  const r = rec("Why did GDP drop this drastically in a week", { availableTools: ALL, identifiers: { country: "US" } });
  assert.equal(r.tool, "market_history");
  assert.deepEqual(r.args, { metric: "gdp_change", country: "US", turns: 24 });
  assert.equal(r.callable, true);
  assert.equal(r.argsSource, "game_contract_v1");
  assert.equal(rec("How big is the national GDP level?", { availableTools: ALL, identifiers: { country: "US" } }).args.metric, "gdp_level");
});

test("GDP level with market_history unavailable is a gap, never country_fiscal", () => {
  const r = rec("Why did GDP drop this drastically in a week", { availableTools: ["country_fiscal", "commodity_market"] });
  assert.equal(r.gap, true);
  assert.equal(r.wanted, "market_history");
  assert.equal(r.tool, undefined);
});

test("explicit GDP growth rate recommends country_fiscal with the Rust arg", () => {
  const r = rec("What is the GDP growth rate for the US?", { availableTools: ALL, identifiers: { country: "US" } });
  assert.equal(r.tool, "country_fiscal");
  assert.deepEqual(r.args, { country: "US" });
  assert.equal(r.status, "existing");
  assert.equal(r.argsSource, "rust");
});

test("single commodity question reads commodity_market for the current turn, with funded, filled and source", () => {
  const r = rec("Why is demand for steel higher than what was filled and funded?", { availableTools: ALL, identifiers: { commodity: "steel", country: "FR" } });
  assert.equal(r.tool, "commodity_market");
  assert.deepEqual(r.args, { commodity: "steel", country: "FR" });
  assert.match(r.returns, /funded, filled, demandSource/);
  assert.equal(r.status, "existing");
});

test("a follow-up asking for all sectors can omit the original metric name", () => {
  const r = rec("Check all sectors like you did for freight.", { availableTools: ALL });
  assert.equal(r.tool, "commodity_market");
  assert.equal(r.args.commodity, undefined);
});

test("all-sectors question with no commodity reads commodity_market with no commodity arg", () => {
  const r = rec("Is demand unmet across all sectors, not just one commodity?", { availableTools: ALL });
  assert.equal(r.tool, "commodity_market");
  assert.deepEqual(r.args, {});
});

test("market history question uses market_history, and falls back to the current turn when it is unavailable", () => {
  const q = "Demand for grain dropped over the last turns, what was filled?";
  assert.deepEqual(rec(q, { availableTools: ALL, identifiers: { commodity: "grain" } }).args, { metric: "commodity_volume", commodity: "grain", turns: 24 });
  const fb = rec(q, { availableTools: ["commodity_market"], identifiers: { commodity: "grain" } });
  assert.equal(fb.tool, "commodity_market");
  assert.deepEqual(fb.args, { commodity: "grain" });
  assert.match(fb.note, /earlier turns were not checked/);
});

test("private reads take no identifier and never offer a cross-account fallback", () => {
  for (const [q, tool] of [["My corporation realized revenue is high but operating profit is low", "reporter_operating_results"], ["Where did my action points go, grants vs spent?", "reporter_action_points"]]) {
    const r = first(q, { availableTools: ALL, identifiers: { country: "US" } });
    assert.equal(r.recommendation.tool, tool);
    assert.deepEqual(r.recommendation.args, { turns: tool === "reporter_action_points" ? 24 : 6 });
    assert.deepEqual(r.alternatives, []);
    assert.doesNotMatch(JSON.stringify(r.recommendation.args), /character|corporation|reporter|ticket|account/i);
    const gap = rec(q, { availableTools: ["trace_corp", "trace_character"] });
    assert.equal(gap.gap, true);
  }
});

test("unrelated questions match nothing", () => {
  for (const q of ["The login page shows a blank screen on my phone", "Please rename my party"]) {
    const out = lookupEvidence({ question: q });
    assert.equal(out.matched, false);
    assert.deepEqual(out.topics.map((t) => t.id), MAPPING_IDS);
  }
});

test("only the read-only lookup tool is registered", async () => {
  const server = new McpServer({ name: "t", version: "1" });
  registerSupportEvidenceTools(server, { jsonResult: (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] }) });
  assert.deepEqual(Object.keys(server._registeredTools), ["support_evidence_lookup"]);
  const out = JSON.parse((await server._registeredTools.support_evidence_lookup.handler({ question: "gdp growth rate", availableTools: ["country_fiscal"], identifiers: { country: "US" } }, {})).content[0].text);
  assert.equal(out.results[0].recommendation.tool, "country_fiscal");
});
