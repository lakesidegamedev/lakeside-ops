"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createW3Tools, TOOL_DEFS, createVisible } = require("../lib/operator/w3tools");
const { TOOLS } = require("../lib/operator/agent");

test("the new tools are in the agent tool list with schemas", () => {
  for (const name of ["ask", "player_trail", "resolve_reporter", "turn_status", "request_log", "sector_builds", "team_activity"]) {
    const t = TOOLS.find((x) => x.name === name); assert.ok(t, name); assert.equal(t.input_schema.type, "object");
  }
  assert.equal(TOOL_DEFS.length, 7);
  const gh = TOOLS.find((t) => t.name === "github").input_schema.properties.action.enum;
  for (const a of ["pr_diff", "pr_comment", "rerun_check"]) assert.ok(gh.includes(a), a);
  assert.ok(TOOLS.find((t) => t.name === "request_action").input_schema.properties.kind.enum.includes("turn_lock_reset"));
  assert.ok(TOOLS.find((t) => t.name === "view_page").input_schema.properties.device);
});

test("players never see them and ticket tools need a ticket", () => {
  assert.equal(createVisible({ role: "player", ticket: 1 }, "ask"), false);
  assert.equal(createVisible({ role: "support" }, "player_trail"), false);
  assert.equal(createVisible({ role: "support", ticket: 1 }, "player_trail"), true);
  assert.equal(createVisible({ role: "owner" }, "turn_status"), true);
  assert.equal(createVisible({ role: "player" }, "read_tool"), true, "other tools are untouched");
});

test("turnLockReset is a dry run unless asked, and refuses a healthy lock", async () => {
  const mcp = { call: async (server, tool) => server === "turndiag" ? JSON.stringify({ verdict: "STUCK: no heartbeat", isProcessing: true, heartbeatAgeSec: 4000, currentTurn: 9, processingPhase: "p" }) : server === "heal-ops" ? { docs: [{ processingTargetTurn: 10, processingPhase: "p" }] } : "{}" };
  const w3 = createW3Tools({ config: {}, mcp });
  const dry = await w3.turnLockReset({ role: "support", ticket: 1 }, { args: {} }, null, async () => { throw new Error("must not file"); });
  assert.equal(dry.dryRun, true); assert.equal(dry.filed, false);
  let filed;
  const real = await w3.turnLockReset({ role: "support", ticket: 1 }, { args: { dryRun: false }, reason: "stale lock" }, null, async (spec) => { filed = spec; return { action: "a1", state: "pending" }; });
  assert.equal(real.filed, true); assert.equal(filed.collection, "gameState");
  const healthy = createW3Tools({ config: {}, mcp: { call: async () => JSON.stringify({ verdict: "ok", isProcessing: true, heartbeatAgeSec: 5 }) } });
  assert.equal((await healthy.turnLockReset({ role: "support" }, { args: {} }, null, async () => ({}))).eligible, false);
  await assert.rejects(w3.turnLockReset({ role: "player" }, { args: {} }, null, async () => ({})), /players cannot/);
});
