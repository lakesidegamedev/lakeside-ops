"use strict";
// A read service that refuses on its own account used to hand Keir the raw
// JSON-RPC envelope ("Not Authorized" inside content/isError), which reads like
// a bad argument and invited the same read 47 times across 16 tasks on
// 2026-10-22. The refusal now names the read, says the arguments are fine and
// says not to repeat it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createLedger } = require("../lib/operator/store");
const { createBroker, createMcp } = require("../lib/operator/broker");

const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

async function stubRead(reply) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: reply }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise((r) => server.close(r)) };
}

function fixture(mcp) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-read-service-")); dirs.push(dir);
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444",
    stateDir: dir, supportDeferred: () => false, repositories: {} };
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => 5000 });
  const job = ledger.createJob("fixture", { role: "owner", kind: "command", source: {}, deadline: 9999999999999 });
  job.state = "running";
  return { ledger, broker, job };
}

test("a read service refusal names the read and says repeating it cannot help", async () => {
  const stub = await stubRead({ content: [{ type: "text", text: "Not Authorized" }], isError: true });
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-read-service-cfg-")); dirs.push(configDir);
  const configFile = path.join(configDir, "mcp.json");
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { railway: { url: stub.url } } }));
  const f = fixture(createMcp(configFile, "read-token"));
  try {
    await assert.rejects(() => f.broker.tool(f.job, "read_tool", { server: "railway", tool: "railway_status", args: {} }), (error) => {
      assert.match(error.message, /railway\/railway_status could not be read: Not Authorized\./);
      assert.match(error.message, /arguments are not the problem/);
      assert.match(error.message, /Do not retry it\./);
      assert.doesNotMatch(error.message, /"isError"/);
      assert.equal(error.code, "MCP_SERVICE_REFUSED");
      return true;
    });
    // The clearer refusal is still the evidence the nightly self-review reads.
    const refused = f.ledger.data.audit.find((row) => row.kind === "tool_refused");
    assert.match(refused.error, /railway\/railway_status could not be read/);
  } finally { await stub.close(); }
});

test("an argument rejection keeps its schema message", async () => {
  const stub = await stubRead({ content: [{ type: "text", text: "MCP error -32602: Input validation error: Invalid arguments for tool railway_status: unexpected key" }], isError: true });
  const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keir-read-service-cfg-")), "mcp.json");
  dirs.push(path.dirname(configFile));
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { railway: { url: stub.url } } }));
  const f = fixture(createMcp(configFile, "read-token"));
  try {
    await assert.rejects(() => f.broker.tool(f.job, "read_tool", { server: "railway", tool: "railway_status", args: { bogus: true } }), (error) => {
      assert.match(error.message, /Input validation error/);
      assert.equal(error.code, "MCP_ARGUMENT_REJECTED");
      return true;
    });
  } finally { await stub.close(); }
});
