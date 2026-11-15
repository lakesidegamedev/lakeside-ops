"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os"), fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const { createCapabilityGaps, rank } = require("../lib/operator/capabilitygaps");

const NOW = Date.parse("2026-11-12T12:00:00Z");
const refusal = (job, tool) => ({ at: NOW - 3600000, kind: "tool_refused", job, tool: "read_tool", target: tool, error: "Expected string, received number invalid_type" });
function ledger() {
  const jobs = {}; for (let i = 1; i <= 6; i++) jobs[`j${i}`] = { id: `j${i}`, ticket: 600 + i };
  const audit = [refusal("j1", "gamestate/trace_corp"), refusal("j2", "gamestate/trace_corp"), refusal("j3", "gamestate/trace_corp"),
    refusal("j4", "engine/economy_pulse"), refusal("j5", "engine/economy_pulse"), refusal("j6", "engine/economy_pulse"), refusal("j6", "engine/economy_pulse")];
  return { data: { jobs, audit, ticketScores: { 601: { score: 20 }, 602: { score: 30 }, 603: { score: 95 } } }, audit() {}, save() {} };
}

test("hits from low-scored tickets count double and rank the gap first", async () => {
  const l = ledger(), added = [];
  const mcp = { call: async (server, tool, args) => { if (tool === "kanban_list") return { items: [] }; added.push(args); return { id: 700 + added.length }; } };
  await createCapabilityGaps({ ledger: l, mcp, now: () => NOW }).tick();
  const g = l.data.capabilityGaps;
  const trace = g["tool:gamestate/trace_corp:argument types"], pulse = g["tool:engine/economy_pulse:argument types"];
  assert.equal(trace.hits, 3); assert.equal(trace.weighted, 5); assert.equal(trace.lowHits, 2);
  assert.equal(pulse.hits, 4); assert.equal(pulse.weighted, 4);
  const ranked = rank(l.data);
  assert.equal(ranked[0].sig, "tool:gamestate/trace_corp:argument types");
  assert.equal(ranked[0].rank, 1);
  assert.ok(ranked[0].kanbanId >= 701);
});

test("keir-gaps prints the ranked top with ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gaps-")), file = path.join(dir, "ledger.json");
  fs.writeFileSync(file, JSON.stringify({ capabilityGaps: { a: { kanbanId: 11, hits: 5, weighted: 5, tasks: 3, title: "Alpha gap" }, b: { kanbanId: 12, hits: 3, weighted: 6, lowHits: 3, tasks: 2, title: "Beta gap" } } }));
  const out = JSON.parse(cp.execFileSync(process.execPath, [path.join(__dirname, "../bin/keir-gaps.js"), "--ledger", file, "--json", "--top", "1"], { encoding: "utf8" }));
  assert.deepEqual(out.map((r) => [r.rank, r.kanbanId, r.sig]), [[1, 12, "b"]]);
  const text = cp.execFileSync(process.execPath, [path.join(__dirname, "../bin/keir-gaps.js"), "--ledger", file], { encoding: "utf8" });
  assert.match(text, /Beta gap[\s\S]*Alpha gap/);
});
