"use strict";
// 2026-10-23 shadow: read_tool was aborted by the shared thirty second cap 24
// times across ten tasks, every one of them heal-ops/heal_collections. That
// server starts a fresh CLI per call, which measures about twelve seconds on an
// idle host, so the cap was refusing reads the server would have answered and
// the model saw only a bare Node timeout string with no next step.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createMcp, readDeadline } = require("../lib/operator/broker");

async function fixture(t, { delayMs }) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const id = JSON.parse(body || "{}").id ?? 1;
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "{\"ok\":true}" }] } }));
      }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-deadline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "mcp.json");
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { "heal-ops": { url: `http://127.0.0.1:${server.address().port}/mcp` }, support: { url: `http://127.0.0.1:${server.address().port}/mcp` } } }));
  return config;
}

test("heal-ops reads get a deadline that fits a per-call CLI; other servers stay tight", () => {
  assert.equal(readDeadline("heal-ops"), 90000);
  assert.equal(readDeadline("support"), 30000);
  assert.equal(readDeadline("ops-knowledge"), 30000);
});

test("a slow heal-ops read completes instead of aborting at the old cap", async (t) => {
  const config = await fixture(t, { delayMs: 250 });
  const mcp = createMcp(config, "read-token", { readDeadlines: { "heal-ops": 5000 } });
  assert.deepEqual(await mcp.call("heal-ops", "heal_collections", { env: "prod" }), { ok: true });
});

test("a read that times out names the tool and the next step", async (t) => {
  const config = await fixture(t, { delayMs: 400 });
  const mcp = createMcp(config, "read-token", { readDeadlines: { "heal-ops": 80 } });
  await assert.rejects(
    () => mcp.call("heal-ops", "heal_collections", { env: "prod" }),
    (error) => {
      assert.match(error.message, /heal-ops\/heal_collections timed out after \d+ seconds/);
      assert.match(error.message, /slow, not refused/);
      assert.match(error.message, /filter, a projection or a lower limit/);
      assert.match(error.message, /timed out/, "the step guard must still recognise it as an unreachable read");
      return true;
    });
});
