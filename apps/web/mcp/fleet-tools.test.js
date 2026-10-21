"use strict";

// The fleet self-description tool: it must report what the servers really
// expose, and it must say so plainly when a server is unreachable.

const test = require("node:test");
const assert = require("node:assert");

const { describeServer } = require("./fleet-tools.js");

function sse(result) {
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`;
}

const originalFetch = global.fetch;

function stubFetch(routes) {
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const route = routes[url];
    if (!route) return { ok: false, status: 502, text: async () => "no route" };
    const reply = route[body.method];
    if (!reply) return { ok: false, status: 404, text: async () => "no method" };
    if (reply.error) return { ok: false, status: reply.status || 500, text: async () => reply.error };
    return { ok: true, status: 200, text: async () => sse(reply.result) };
  };
}

test.afterEach(() => {
  global.fetch = originalFetch;
});

test("a reachable server is described with its tools, prompts and resources", async () => {
  stubFetch({
    "http://127.0.0.1:9999/mcp": {
      initialize: { result: { serverInfo: { name: "ops-test", version: "1.0.0" } } },
      "tools/list": { result: { tools: [{ name: "one" }, { name: "two" }] } },
      "prompts/list": { result: { prompts: [{ name: "brief" }] } },
      "resources/list": { result: { resources: [{ uri: "x://1" }] } },
      "resources/templates/list": { result: { resourceTemplates: [{ uriTemplate: "x://{id}" }] } },
    },
  });

  const described = await describeServer({ key: "test", name: "Test", path: "/test/mcp", health: 9999 }, "tok");
  assert.strictEqual(described.reachable, true);
  assert.strictEqual(described.toolCount, 2);
  assert.deepStrictEqual(described.tools, ["one", "two"]);
  assert.strictEqual(described.promptCount, 1);
  assert.strictEqual(described.resourceCount, 1);
  assert.strictEqual(described.resourceTemplateCount, 1);
  assert.strictEqual(described.serverInfo.name, "ops-test");
});

test("an unreachable server is reported, not hidden", async () => {
  stubFetch({
    "http://127.0.0.1:9998/mcp": {
      initialize: { error: "upstream is down", status: 502 },
    },
  });

  const described = await describeServer({ key: "dead", name: "Dead", path: "/dead/mcp", health: 9998 }, "tok");
  assert.strictEqual(described.reachable, false);
  assert.match(described.error, /502/);
  assert.strictEqual(described.toolCount, undefined);
});
