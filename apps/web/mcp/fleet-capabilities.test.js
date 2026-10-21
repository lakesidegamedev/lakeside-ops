"use strict";

// The fleet's own capability board: an agent asking "what does the MCP fleet
// still need?" must be able to read the answers, not just assert there are
// none.

const test = require("node:test");
const assert = require("node:assert");

const { callTool } = require("./fleet-tools.js");

function sse(result) {
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`;
}

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test("callTool parses the JSON result of a tool call on another server", async () => {
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.strictEqual(body.method, "tools/call");
    assert.strictEqual(body.params.name, "kanban_list");
    return {
      ok: true,
      status: 200,
      text: async () => sse({ content: [{ type: "text", text: JSON.stringify({ items: [{ id: 1 }] }) }] }),
    };
  };

  const reply = await callTool("http://127.0.0.1:9725/mcp", "kanban_list", { product: "lakeside-mcp" }, "tok");
  assert.strictEqual(reply.error, undefined);
  assert.deepStrictEqual(reply.result.items, [{ id: 1 }]);
});

test("callTool reports an rpc error instead of throwing", async () => {
  global.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "invalid or missing bearer token" } }),
  });

  const reply = await callTool("http://127.0.0.1:9725/mcp", "kanban_list", {}, "bad");
  assert.match(reply.error, /bearer token/);
});
