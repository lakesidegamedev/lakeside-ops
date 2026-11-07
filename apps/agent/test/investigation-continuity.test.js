"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { createAgent } = require("../lib/operator/agent");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-investigation-continuity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ledger.json"), ledger = createLedger(file);
  const config = { stateDir: dir, ownerId: "owner", staffIds: [], repositories: {}, skills: false, orientation: false, readyReads: false,
    briefFile: path.join(__dirname, "../KEIR.md"), model: "fixture", taskLifetimeMs: 60000, dynamicEffort: false };
  const job = ledger.createJob("ticket:1234", { kind: "ticket", role: "support", ticket: 1234, channelId: "channel", source: { content: "Please check the savings rate" },
    tags: { kind: "other", complexity: "simple" }, incidentChecked: true, deadline: Date.now() + 60000 });
  job.state = "running";
  const makeBroker = ledger => createBroker({ ledger, config, mcp: { servers: () => [], call: async () => ({ path: "src/savings.ts", excerpt: "SAVINGS_RATE_FINDING: the displayed rate derives from the policy rate less the savings spread." }) }, sandbox: {}, discord: async () => [] });
  return { dir, file, ledger, job, config, broker: makeBroker(ledger), makeBroker };
}
async function promptFor(f, ledger, job) {
  let prompt;
  const invokeImpl = async input => { prompt = input.prompt; job.state = "waiting"; return { subtype: "success", result: "", usage: {} }; };
  await createAgent({ ledger, config: f.config, broker: f.makeBroker(ledger), invokeImpl }).run(job, new AbortController().signal);
  return prompt;
}
test("a completed code read survives restart and reaches the next activation despite an unchecked summary", async t => {
  const f = fixture(t);
  await f.broker.tool(f.job, "read_tool", { server: "ops-knowledge", tool: "code_exact", args: { question: "savings rate" } });
  f.job.summary = "The rate is unchecked"; f.ledger.save();
  const restored = createLedger(f.file), job = restored.data.jobs[f.job.id];
  const prompt = await promptFor(f, restored, job);
  assert.match(prompt, /SAVINGS_RATE_FINDING/, "the next activation must see the actual prior read, not only the mistaken summary");
  assert.match(prompt, /historical/i);
  assert.equal(job.evidenceText.includes("SAVINGS_RATE_FINDING"), false, "historical reads must not satisfy fresh evidence guards");
});

test("observations are shared by ticket, isolated from other tickets and player roles, and bounded", async t => {
  const f = fixture(t), memory = require("../lib/operator/investigation-memory");
  for (let i = 0; i < 20; i++) memory.record(f.ledger, f.job, "read_tool", { server: "gamestate", tool: "trace_corp", args: { id: i } }, { finding: "x".repeat(4000) }, i);
  const sibling = { ...f.job, id: "sibling" };
  const context = memory.context(f.ledger, sibling);
  assert.equal(context.observations.length, 12);
  assert.ok(JSON.stringify(context).length < 30000);
  assert.equal(context.observations.at(-1).truncated, true);
  assert.equal(memory.context(f.ledger, { ...sibling, ticket: 999 }), undefined);
  assert.equal(memory.context(f.ledger, { ...sibling, role: "player" }), undefined);
  const n = context.observations.length;
  memory.record(f.ledger, f.job, "read_tools", { server: "gamestate" }, [{ name: "noise" }], 30);
  memory.record(f.ledger, f.job, "read_tool", { server: "gamestate", tool: "trace_corp" }, { error: "failed" }, 31);
  memory.record(f.ledger, { ...f.job, role: "owner" }, "read_tool", { server: "private", tool: "read" }, { secret: "owner only" }, 32);
  assert.equal(memory.context(f.ledger, sibling).observations.length, n);
  assert.doesNotMatch(JSON.stringify(memory.context(f.ledger, sibling)), /noise|owner only|failed/);
});

test("empty searches remain attempts, identical reads refresh one entry, and receipt recovery helps existing tickets", async t => {
  const f = fixture(t), memory = require("../lib/operator/investigation-memory"), crypto = require("node:crypto");
  const input = { server: "ops-knowledge", tool: "code_search", args: { question: "rate" } };
  memory.record(f.ledger, f.job, "read_tool", input, { hits: [] }, 10);
  memory.record(f.ledger, f.job, "read_tool", input, { hits: [] }, 11);
  let context = memory.context(f.ledger, f.job);
  assert.equal(context.observations.length, 1);
  assert.equal(context.observations[0].at, 11);
  assert.match(context.instruction, /attempt, not a resolved question/);
  const id = "a".repeat(24), dir = path.join(f.dir, "evidence", crypto.createHash("sha256").update(f.job.id).digest("hex").slice(0, 24));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify({ results: [{ excerpt: "LEGACY_RATE_FINDING" }] }));
  f.job.evidenceBatches = [{ id, at: 1, queries: [{ op: "read", path: "src/savings.ts" }] }];
  context = memory.context(f.ledger, f.job, f.dir);
  assert.match(JSON.stringify(context), /LEGACY_RATE_FINDING/);
  assert.equal(f.job.activationFreshRead, undefined, "historical replay must not create fresh evidence");
});

test("source searches, failed tests and historical deploy reads retain their actual outcomes", t => {
  const f = fixture(t), memory = require("../lib/operator/investigation-memory");
  memory.record(f.ledger, f.job, "shell", { command: "rg savings repo/src" }, { code: 0, output: "FOUND_SAVINGS_RULE" }, 1);
  memory.record(f.ledger, f.job, "shell", { command: "node --test savings.test.js" }, { code: 1, output: "RATE_TEST_FAILED" }, 2);
  memory.record(f.ledger, f.job, "github", { action: "where", number: 42 }, { main: false }, 3);
  const context = memory.context(f.ledger, f.job);
  assert.equal(context.observations.length, 3);
  assert.match(JSON.stringify(context), /FOUND_SAVINGS_RULE/);
  assert.match(context.observations[1].result, /"code":1/);
  assert.match(context.observations[2].result, /"main":false/);
  assert.equal(f.job.activationFreshRead, undefined);
});
