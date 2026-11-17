"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createMcp } = require("../lib/operator/broker");

function mcpWith(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-mcp-retry-")); const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { gamestate: { url: "http://127.0.0.1:9730/mcp", headers: { Authorization: "Bearer t" } } } }));
  return { mcp: createMcp(file, "r", opts), dir };
}
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
const ok = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ fine: true }) }] } }), { headers: { "content-type": "application/json" } });

test("a read rides out a service restart with backoff, then succeeds", async () => {
  const real = globalThis.fetch, { mcp, dir } = mcpWith({ retryDelays: [0, 0, 0] });
  try {
    let n = 0; globalThis.fetch = async () => { if (++n <= 3) throw refused(); return ok(); };
    assert.deepEqual(await mcp.call("gamestate", "game_overview", {}, false), { fine: true });
    assert.equal(n, 4);
  } finally { globalThis.fetch = real; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a longer outage fails after the bounded retries and names the cause", async () => {
  const real = globalThis.fetch, { mcp, dir } = mcpWith({ retryDelays: [0, 0, 0] });
  try {
    let n = 0; globalThis.fetch = async () => { n++; throw refused(); };
    await assert.rejects(mcp.call("gamestate", "game_overview", {}, false), (e) => /fetch failed \(ECONNREFUSED reaching the gamestate MCP server/.test(e.message) && /nothing about the data/.test(e.message) && e.code === "MCP_CONNECT_REFUSED");
    assert.equal(n, 4, "one try plus three retries");
  } finally { globalThis.fetch = real; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("writes are never retried", async () => {
  const real = globalThis.fetch, { mcp, dir } = mcpWith({ retryDelays: [0, 0, 0] });
  try {
    let n = 0; globalThis.fetch = async () => { n++; throw refused(); };
    await assert.rejects(mcp.call("gamestate", "x", {}, true), (e) => e.code === "MCP_CONNECT_REFUSED");
    assert.equal(n, 1);
  } finally { globalThis.fetch = real; fs.rmSync(dir, { recursive: true, force: true }); }
});
