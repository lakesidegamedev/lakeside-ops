"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createServer } = require("./index");

test("shared MCP server authenticates requests and exposes loopback metrics", async () => {
  let connected = 0;
  let handled = 0;
  const { app } = createServer({
    name: "example", version: "4.0.0", listen: false,
    auth: { tokenEnv: "TEST_MCP_TOKEN" },
    buildServer: () => ({ connect: async () => { connected++; }, close: () => {} }),
    transportFactory: () => ({ close: () => {}, handleRequest: async (_req, res) => { handled++; res.json({ ok: true }); } }),
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise(resolve => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${listener.address().port}`;
  process.env.TEST_MCP_TOKEN = "test-only-token";
  try {
    const denied = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer test-only-token", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(allowed.status, 200);
    assert.equal(connected, 1);
    assert.equal(handled, 1);
    assert.equal((await (await fetch(`${base}/healthz`)).json()).version, "4.0.0");
    const metrics = await (await fetch(`${base}/metrics`)).text();
    assert.match(metrics, /mcp_server_requests_total\{server="example",status="401"\} 1/);
  } finally {
    delete process.env.TEST_MCP_TOKEN;
    await new Promise(resolve => listener.close(resolve));
  }
});

test("duplicate JSON content types from the Rust proxy are normalized by default", async () => {
  const seen = [];
  const { app } = createServer({
    name: "proxy-test", listen: false,
    authorize: async () => true,
    buildServer: () => ({ connect: async () => {}, close: () => {} }),
    transportFactory: () => ({ close: () => {}, handleRequest: async (req, res) => {
      seen.push({ type: req.headers["content-type"], body: req.body,
        rawTypes: req.rawHeaders.filter((_, i) => i % 2 === 0).filter(value => value.toLowerCase() === "content-type").length });
      res.json({ ok: true });
    } }),
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise(resolve => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${listener.address().port}`;
  try {
    for (const type of ["application/json", "application/json, application/json"]) {
      const response = await fetch(`${base}/mcp`, {
        method: "POST", headers: { "Content-Type": type }, body: JSON.stringify({ jsonrpc: "2.0" }),
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(seen, [
      { type: "application/json", body: { jsonrpc: "2.0" }, rawTypes: 1 },
      { type: "application/json", body: { jsonrpc: "2.0" }, rawTypes: 1 },
    ]);
    const duplicateStatus = await new Promise((resolve, reject) => {
      const request = http.request(`${base}/mcp`, { method: "POST", headers: {
        "Content-Type": ["application/json", "application/json"],
        "Content-Length": "2",
      } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject);
      request.end("{}");
    });
    assert.equal(duplicateStatus, 200);
    assert.equal(seen[2].rawTypes, 1);
    assert.equal(seen[2].type, "application/json");
    const other = await fetch(`${base}/mcp`, {
      method: "POST", headers: { "Content-Type": "text/plain, application/json" }, body: "{}",
    });
    assert.equal(other.status, 200);
    assert.equal(seen[3].type, "text/plain, application/json");
  } finally {
    await new Promise(resolve => listener.close(resolve));
  }
});

test("an alias answers at /mcp/<name> with its own server and the same auth", async () => {
  const built = [];
  const { app } = createServer({
    name: "merged", listen: false,
    auth: { tokenEnv: "TEST_ALIAS_TOKEN" },
    buildServer: () => { built.push("merged"); return { connect: async () => {}, close: () => {} }; },
    aliases: { old: () => { built.push("old"); return { connect: async () => {}, close: () => {} }; } },
    transportFactory: () => ({ close: () => {}, handleRequest: async (_req, res) => res.json({ ok: true }) }),
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise(resolve => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${listener.address().port}`;
  process.env.TEST_ALIAS_TOKEN = "alias-token";
  try {
    const post = (path, auth) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer alias-token" } : {}) }, body: "{}" });
    assert.equal((await post("/mcp/old", false)).status, 401);
    assert.equal((await post("/mcp/old", true)).status, 200);
    assert.equal((await post("/mcp", true)).status, 200);
    assert.equal((await post("/mcp/unknown", true)).status, 404);
    assert.deepEqual(built, ["old", "merged"]);
  } finally {
    delete process.env.TEST_ALIAS_TOKEN;
    await new Promise(resolve => listener.close(resolve));
  }
});

test("an alias name must be a plain path segment", () => {
  assert.throws(() => createServer({ name: "x", listen: false, authorize: async () => true, buildServer: () => ({}), aliases: { "../x": () => ({}) } }), /invalid alias/);
});
