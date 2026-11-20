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

test("queue distinguishes support reply receipts from a fresh coordinator wait", async (t) => {
  const { dir, configPath } = fixture(t, {});
  const now = 1795160000000;
  const ledgerPath = path.join(dir, "ledger.json");
  const ledger = { heartbeat: now, seen: { "ticket:10": "a" }, jobs: {
    a: { ticket: 10, kind: "ticket", state: "waiting", waitingFor: { kind: "player_reply" }, messages: ["private"] },
  } };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  const evidence = createStudioEvidence({ configPath, ledgerPath, now: () => now, mcpCall: async (server, tool, args) => {
    assert.equal(server, "support");
    assert.equal(tool, "support_list");
    assert.deepEqual(args, { kind: "ticket", openOnly: true, includeReplyState: true, limit: 60 });
    return { count: 1, items: [{ number: 10, title: "Test ticket", status: "open", replyState: { state: "delivered" } }] };
  } });
  const result = await evidence.queue();
  assert.deepEqual(result.items, [{ number: 10, title: "Test ticket", status: "open", reply: "delivered", work: "waiting", waitingFor: "player_reply" }]);
  ledger.heartbeat -= 130000;
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  assert.equal((await evidence.queue()).items[0].waitingFor, null);
});
