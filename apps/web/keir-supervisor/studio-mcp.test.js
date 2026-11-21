"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStudioMcp } = require("./studio-mcp");
const { createStudioEvidence } = require("./studio-evidence");

function fixture(t, registrations) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-studio-mcp-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const configPath = path.join(dir, "mcp.json");
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: registrations }));
  return { dir, configPath };
}

test("catalogue and call paths enforce the same policy and keep connection details on the host", async (t) => {
  const { configPath } = fixture(t, {
    support: { url: "http://localhost:4000/mcp", headers: { Authorization: "private-key" } },
    external: { url: "http://localhost.example.test:4000/mcp" },
  });
  const calls = [];
  const mcp = createStudioMcp({ configPath, connect: async (entry, operation) => {
    assert.equal(entry.headers.Authorization, "private-key");
    return operation({
      async listTools({ cursor }) {
        return cursor ? { tools: [{ name: "support_search" }] } :
          { tools: [{ name: "support_list" }, { name: "support_resolve" }], nextCursor: "second" };
      },
      async callTool(call) { calls.push(call); return { content: [{ type: "text", text: "ok" }] }; },
    });
  } });
  assert.deepEqual(mcp.catalogue().servers, [{ server: "support", readsConfigured: true }]);
  assert.deepEqual((await mcp.tools("support")).tools.map((tool) => tool.name), ["support_list", "support_search"]);
  await assert.rejects(mcp.read("support", "support_resolve"), /outside/);
  await assert.rejects(mcp.read("__proto__", "support_list"), /outside/);
  assert.deepEqual(calls, []);
  assert.equal((await mcp.read("support", "support_search", { query: "crisis" })).state, "read");
  assert.deepEqual(calls, [{ name: "support_search", arguments: { query: "crisis" } }]);
});

test("owner supervisor can read share ownership through gamestate and the game alias", async (t) => {
  const { configPath } = fixture(t, {
    gamestate: { url: "http://localhost:4001/mcp" },
    game: { url: "http://localhost:4002/mcp" },
  });
  const calls = [];
  const mcp = createStudioMcp({ configPath, connect: async (entry, operation) => operation({
    async listTools() { return { tools: [{ name: "character_holdings" }, { name: "admin_adjust_balance" }] }; },
    async callTool(call) { calls.push(call); return { content: [{ type: "text", text: "ok" }] }; },
  }) });
  for (const server of ["gamestate", "game"]) {
    assert.deepEqual((await mcp.tools(server)).tools.map((tool) => tool.name), ["character_holdings"]);
    assert.equal((await mcp.read(server, "character_holdings", { character: "19" })).state, "read");
    await assert.rejects(mcp.read(server, "admin_adjust_balance"), /outside/);
  }
  assert.deepEqual(calls.map((call) => call.name), ["character_holdings", "character_holdings"]);
});

test("owner supervisor reads at least every tool the ticket desk can read, and still no writes", async (t) => {
  const desk = {
    support: ["support_get", "support_search", "support_list"],
    gamestate: ["trace_character", "trace_account", "trace_corp", "trace_ledger", "trace_bonds", "trace_actions", "character_wealth_history", "wars", "military_roster", "nomination_records", "trace_race", "trace_election", "trace_approval", "invariant_check"],
    sentry: ["sentry_event_lookup", "sentry_player_errors"],
    "heal-ops": ["heal_query", "heal_count", "heal_collections"],
  };
  const writes = { support: ["support_resolve", "support_merge", "support_public_update", "support_create_ticket"], gamestate: ["lean_patch"],
    "heal-ops": ["heal_apply", "heal_plan", "heal_rollback"], worldsim: ["sim_snapshot", "sim_run_world"], masscomm: ["comm_send", "comm_audience"],
    paseo: ["send_agent_prompt", "capture_terminal", "respond_to_permission"], "ops-knowledge": ["knowledge_save", "kanban_update", "restart_dashboard"] };
  const servers = [...new Set([...Object.keys(desk), ...Object.keys(writes)])];
  const { configPath } = fixture(t, Object.fromEntries(servers.map((s, i) => [s, { url: `http://localhost:${5000 + i}/mcp` }])));
  const mcp = createStudioMcp({ configPath, connect: async (entry, operation) => operation({
    async callTool() { return { content: [{ type: "text", text: "{}" }] }; },
  }) });
  for (const [server, tools] of Object.entries(desk)) for (const tool of tools)
    assert.equal((await mcp.read(server, tool, { collection: "corporations" })).state, "read", `${server}/${tool}`);
  for (const [server, tools] of Object.entries(writes)) for (const tool of tools)
    await assert.rejects(mcp.read(server, tool), /outside/, `${server}/${tool}`);
});

test("raw database reads keep account collections and private fields closed", async (t) => {
  const { configPath } = fixture(t, { "heal-ops": { url: "http://localhost:4003/mcp" } });
  const calls = [];
  const mcp = createStudioMcp({ configPath, connect: async (entry, operation) => operation({
    async callTool(call) {
      calls.push(call);
      return { content: [{ type: "text", text: JSON.stringify({ count: 1, docs: [{ name: "Nutrien", cash: 5, owner: { email: "a@b.c", sessionToken: "x" } }] }) }] };
    },
  }) });
  for (const collection of ["users", "sessions", "apiKeys", "payments"])
    await assert.rejects(mcp.read("heal-ops", "heal_query", { env: "prod", collection }), /closed/);
  await assert.rejects(mcp.read("heal-ops", "heal_count", { env: "prod", collection: "characters", filter: { "owner.email": "a@b.c" } }), /email/);
  assert.deepEqual(calls, []);
  const out = await mcp.read("heal-ops", "heal_query", { env: "prod", collection: "shareholdings", filter: { corporation: "Nutrien" } });
  assert.equal(out.state, "read");
  assert.doesNotMatch(out.data, /a@b\.c|sessionToken"\s*:\s*"x/);
  assert.match(out.data, /Nutrien/);
  assert.match(out.data, /withheldFields/);
});

test("queue distinguishes support reply receipts from a fresh coordinator wait", async (t) => {
  const { dir, configPath } = fixture(t, {});
  const now = 1795160000000;
  const ledgerPath = path.join(dir, "ledger.json");
  const ledger = { heartbeat: now, seen: { "ticket:10": "a" }, jobs: {
    a: { ticket: 10, kind: "ticket", state: "waiting", waitingFor: { kind: "player_reply" }, wakeAt: now + 60000, activationCount: 3, messages: ["private"] },
  } };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  const evidence = createStudioEvidence({ configPath, ledgerPath, now: () => now, mcpCall: async (server, tool, args) => {
    assert.equal(server, "support");
    assert.equal(tool, "support_list");
    assert.deepEqual(args, { kind: "ticket", openOnly: true, includeReplyState: true, limit: 60 });
    return { count: 1, items: [{ number: 10, title: "Test ticket", status: "open", replyState: { state: "delivered" } }] };
  } });
  const result = await evidence.queue();
  assert.deepEqual(result.items, [{ number: 10, title: "Test ticket", status: "Open", reply: "delivered", work: "waiting", waitingFor: "player_reply", nextCheckAt: new Date(now + 60000).toISOString(), priorActivations: 3, implementationHeld: false, ownerDecisionPending: false }]);
  delete ledger.jobs.a.waitingFor;
  ledger.supportOwner = { tickets: { 10: "owner" } };
  ledger.decisions = { "decision-fixture": { jobId: "a", ticket: 10, state: "pending" } };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  const scheduled = (await evidence.queue()).items[0];
  assert.equal(scheduled.waitingFor, null);
  assert.equal(scheduled.nextCheckAt, new Date(now + 60000).toISOString());
  assert.equal(scheduled.implementationHeld, true);
  assert.equal(scheduled.ownerDecisionPending, true);
  ledger.heartbeat -= 130000;
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  const stale = (await evidence.queue()).items[0];
  assert.equal(stale.waitingFor, null);
  assert.equal(stale.nextCheckAt, null);
  assert.equal(stale.implementationHeld, null);
});
