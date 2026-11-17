"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker, outsideScopeMessage, SUPPORT_READS } = require("../lib/operator/broker");

test("a refusal names the call to make instead", () => {
  const m = (server, tool) => outsideScopeMessage(SUPPORT_READS, server, tool);
  assert.match(m("turndiag", "turn_status"), /Keir's own tools.*Call turn_status directly/);
  assert.match(m("github", "deployed"), /github is not a read_tool server.*action "deployed"/);
  assert.match(m("turndiag", "nonsense"), /Available on turndiag: turn_phase_timings/);
  assert.match(m("nowhere", "x"), /not a readable server here.*Readable servers: support/);
  for (const t of ["reporter_state", "check_draft", "sector_builds"]) assert.match(m("support", t), /Keir's own tools/);
  assert.match(m("sentry", "sentry_detail"), /outside support scope/);
});

test("read_tool turndiag/turn_status runs turn_status for a ticket task instead of refusing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-scope-"));
  try {
    const ledger = createLedger(path.join(dir, "ledger.json"));
    const config = { ownerId: "owner", staffIds: [], stateDir: dir, repositories: {}, scanChannels: [], supportDeferred: () => false };
    const calls = [];
    const mcp = { servers: () => [], list: async () => [], call: async (server, tool, args) => { calls.push(`${server}/${tool}`); return JSON.stringify({ verdict: "ok", isProcessing: false, currentTurn: 12 }); } };
    const broker = createBroker({ ledger, config, mcp, discord: async () => { throw new Error("unexpected"); }, sandbox: {}, now: () => 5000 });
    const job = ledger.createJob("fixture", { kind: "ticket", role: "support", ticket: 1845, repository: "AHDGame", source: {}, deadline: 9e15 }); job.state = "running";
    const out = await broker.tool(job, "read_tool", { server: "turndiag", tool: "turn_status", args: {} });
    assert.ok(out && typeof out === "object");
    assert.ok(calls.some((c) => c.startsWith("turndiag/")), "turn_status reads the turn diagnostics");
    await assert.rejects(broker.tool(job, "read_tool", { server: "github", tool: "deployed", args: {} }), /github is not a read_tool server/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
