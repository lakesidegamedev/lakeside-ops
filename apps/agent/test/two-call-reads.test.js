"use strict";
// Keir 7 MCP overhaul (owner, 2026-11-01): a question should take about two
// calls, and failed or raw-database reads are requests for missing tools.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createReadyReads } = require("../lib/operator/readyreads");
const { createCapabilityGaps, signatureOf } = require("../lib/operator/capabilitygaps");
const { coerceArgs } = require("../lib/operator/broker");

// A deterministic stand-in for the embedding model: bag of words over a fixed vocabulary.
const VOCAB = ["players", "logged", "active", "online", "week", "steel", "price", "commodity", "market", "turn", "stuck", "lock", "war", "corporation", "money"];
const fakeEmbed = async (texts) => texts.map((t) => VOCAB.map((w) => (String(t).toLowerCase().includes(w) ? 1 : 0) + 0.01));
const CATALOG = {
  gamestate: [
    { name: "geo_aggregate", description: "Map-ready aggregation of player characters active in a recent window.", inputSchema: { type: "object", properties: { metric: { type: "string" } } } },
    { name: "commodity_market", description: "Commodity market price and balance for steel and other goods.", inputSchema: { type: "object", properties: {} } },
    { name: "heal_apply_like_write", description: "writes", inputSchema: {} },
    { name: "legislation_catalog", description: "Bills.", inputSchema: {} },
  ],
  turndiag: [{ name: "lock_status", description: "Turn lock and whether a turn is stuck.", inputSchema: {} }],
};
const mcp = { list: async (server) => CATALOG[server] || [] };

function ready(t, readable = () => true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-ready-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, rr: createReadyReads({ mcp, stateDir: dir, readable, embed: fakeEmbed }) };
}
const job = (content) => ({ id: "j", kind: "conversation", role: "owner", source: { content } });

test("the read that answers a question is loaded with its schema before the model starts", async t => {
  const { rr } = ready(t);
  assert.deepEqual(await rr.pick(job("how many players logged on this week?"), { servers: ["gamestate", "turndiag"] }), [], "a cold index never makes the activation wait");
  await rr.warm(["gamestate", "turndiag"]);
  const picks = await rr.pick(job("how many players logged on this week?"), { servers: ["gamestate", "turndiag"], k: 2 });
  assert.equal(picks[0].tool, "geo_aggregate", "learned from a seed example even though the description never says logged on");
  assert.deepEqual(picks[0].inputSchema, CATALOG.gamestate[0].inputSchema);
  const steel = await rr.pick(job("what is the steel price"), { servers: ["gamestate", "turndiag"], k: 1 });
  assert.equal(steel[0].tool, "commodity_market");
});

test("ready reads never offer a tool the task may not call, nor a write-shaped tool", async t => {
  const { rr } = ready(t, (_job, server, tool) => server === "turndiag" && tool === "lock_status");
  await rr.warm(["gamestate", "turndiag"]);
  const picks = await rr.pick(job("how many players logged on this week?"), { servers: ["gamestate", "turndiag"], k: 3 });
  assert.deepEqual(picks.map((p) => p.tool), ["lock_status"]);
});

test("a read that answered a question is remembered for the next similar question", async t => {
  const { rr, dir } = ready(t);
  const j = job("is the turn stuck right now");
  rr.learn(j, "turndiag", "lock_status");
  rr.learn(j, "turndiag", "lock_status");
  assert.equal(rr.examples().length, 1, "one example per task and tool");
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "readyreads-examples.json"), "utf8"));
  assert.equal(saved.examples[0].tool, "lock_status");
});

test("no embedder means no ready reads, never a failed activation", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-ready-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rr = createReadyReads({ mcp, stateDir: dir, embed: async () => { throw new Error("down"); } });
  assert.equal(await rr.warm(["gamestate"]), 0, "a failed warm-up is logged, not thrown");
  assert.deepEqual(await rr.pick(job("x players"), { servers: ["gamestate"] }), []);
});

test("wrong argument names are mapped to the schema's own names", () => {
  const schema = { properties: { corporation: { type: "string" }, turns: { type: "integer", minimum: 1, maximum: 50 } } };
  assert.deepEqual(coerceArgs({ corporationId: "2881", limit: "10" }, schema), { corporation: "2881", turns: 10 });
  assert.equal(coerceArgs({ unrelated: 1 }, schema), null, "nothing is guessed when there is no clear counterpart");
  assert.equal(coerceArgs({ corporation: "a", corporationId: "b" }, schema), null, "an argument already given is never overwritten");
});

test("failed and raw reads are grouped into capability requests; policy refusals are not", async () => {
  const at = Date.now();
  const audit = [
    ...["a", "b", "c"].map((job) => ({ kind: "tool_refused", tool: "read_tool", target: "gamestate/trace_corp", job, at, error: "MCP error -32602: Input validation error: Invalid arguments for tool trace_corp: unrecognized_keys corporationId" })),
    ...["a", "b", "d"].map((job) => ({ kind: "raw_read", collection: "cabinetNominations", job, at })),
    { kind: "tool_refused", tool: "channel_reply", job: "a", at, error: "Not posted: 7 sentences" },
    { kind: "tool_refused", tool: "read_tool", job: "a", at, error: "read tool is outside support scope" },
  ];
  assert.equal(signatureOf(audit[audit.length - 1]), null);
  assert.equal(signatureOf(audit[audit.length - 2]), null);
  const calls = [];
  const ledger = { data: { audit }, audit(k, v) { audit.push({ kind: k, ...v, at: Date.now() }); }, save() {} };
  const gaps = createCapabilityGaps({ ledger, mcp: { call: async (server, tool, args) => { calls.push({ tool, args }); return { id: 900 + calls.length }; } } });
  const r = await gaps.tick();
  assert.equal(r.filed, 2);
  assert.ok(calls.every((c) => c.tool === "kanban_add" && c.args.product === "lakeside-mcp" && c.args.kind === "capability"));
  assert.ok(calls.some((c) => /cabinetNominations/.test(c.args.title)));
  // A later hit updates the same card instead of filing another.
  audit.push({ kind: "raw_read", collection: "cabinetNominations", job: "e", at: Date.now() });
  ledger.data.capabilityGaps["raw:cabinetNominations"].at = 0;
  await gaps.tick();
  assert.equal(calls.filter((c) => c.tool === "kanban_add").length, 2);
  assert.ok(calls.some((c) => c.tool === "work_report" && /Now 4 hits/.test(c.args.summary)));
});
