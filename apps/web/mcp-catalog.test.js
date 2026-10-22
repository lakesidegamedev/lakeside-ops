"use strict";

// The catalogue is what the fleet check compares the live fleet against, and
// what the agents page shows. A malformed entry is a server nobody is
// watching, or a connect snippet that points nowhere.

const test = require("node:test");
const assert = require("node:assert");

const { MCP_DEFS, getMcpCatalog, localMcpUrl } = require("./mcp-catalog.js");

test("every catalogued server is well formed", () => {
  const keys = new Set();
  for (const def of MCP_DEFS) {
    assert.ok(def.key, "a catalogue entry has no key");
    assert.ok(!keys.has(def.key), `duplicate catalogue key: ${def.key}`);
    keys.add(def.key);
    assert.ok(def.name, `${def.key} has no name`);
    assert.ok(def.desc, `${def.key} has no description`);
    assert.ok(["http", "local", "stdio"].includes(def.connect), `${def.key} has an unknown connect mode: ${def.connect}`);
    assert.ok(Array.isArray(def.tools), `${def.key} has no tools array`);
    if (def.connect === "http") {
      assert.ok(def.path, `${def.key} is public but has no path`);
      assert.ok(def.health, `${def.key} is public but has no health port`);
    }
    if (def.connect === "local") {
      assert.ok(def.health, `${def.key} is on-box but has no health port`);
      assert.match(localMcpUrl(def), /^http:\/\/127\.0\.0\.1:\d+\//, `${def.key} has no usable local URL`);
    }
  }
});

test("the directory hands every server a URL an agent can use", () => {
  for (const entry of getMcpCatalog()) {
    if (entry.connect === "http") assert.match(entry.url, /^https?:\/\//, `${entry.key} has no public URL`);
    if (entry.connect === "local") assert.match(entry.localUrl, /^http:\/\/127\.0\.0\.1:/, `${entry.key} has no local URL`);
    if (entry.connect === "stdio") assert.match(entry.url, /^[a-z@]/, `${entry.key} has no launch command`);
  }
});

test("the catalogue names every hosted server", () => {
  // The fleet the box runs. A server that is not in the catalogue is a server
  // the drift check never looks at.
  const hosted = ["ops-knowledge", "community", "gamestate", "engine", "turndiag", "seed-audit", "worldsim", "security", "railway", "support", "discord", "reports", "lore", "tracker", "lean-lab", "heal-ops", "masscomm", "company-knowledge", "lakeside-hub", "metroforge", "grand-century", "paseo", "glitchtip"];
  const keys = new Set(MCP_DEFS.map((d) => d.key));
  for (const key of hosted) assert.ok(keys.has(key), `${key} is hosted but not in the catalogue`);
});

test("an alias is answered by the server it names, on that server's port", () => {
  const byKey = new Map(MCP_DEFS.map((d) => [d.key, d]));
  for (const def of MCP_DEFS.filter((d) => d.aliasOf)) {
    const target = byKey.get(def.aliasOf);
    assert.ok(target, `${def.key} is an alias of ${def.aliasOf}, which is not catalogued`);
    assert.strictEqual(def.health, target.health, `${def.key} must be reached on ${def.aliasOf}'s port`);
    assert.strictEqual(localMcpUrl(def), `http://127.0.0.1:${target.health}/mcp/${def.key === "reports" ? "report-publish" : def.key}`);
    for (const tool of def.tools) assert.ok(target.tools.includes(tool), `${def.aliasOf} does not list ${def.key}'s tool ${tool}`);
  }
});
