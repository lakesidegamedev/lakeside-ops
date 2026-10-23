"use strict";

// The sims server answers as three older servers. Each alias must show exactly
// the tools its old server had, and the merged server every one of them once.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSimsServer, aliases } = require("./sims-server");

const deps = { db: {}, ctrlDb: {} }; // registration only; no tool is called
const names = (server) => Object.keys(server._registeredTools);

test("each alias keeps its old server name and tool set", () => {
  const built = Object.fromEntries(Object.entries(aliases(deps)).map(([k, build]) => [k, build()]));
  assert.deepEqual(Object.keys(built), ["worldsim", "metroforge", "grand-century"]);
  assert.equal(built.worldsim.server._serverInfo.name, "ops-worldsim");
  assert.equal(built.metroforge.server._serverInfo.name, "metroforge");
  assert.equal(built["grand-century"].server._serverInfo.name, "grand-century");
  assert.deepEqual(names(built.metroforge), ["mf_status", "mf_cities", "mf_leaderboard", "mf_smoke", "mf_sim_run"]);
  assert.deepEqual(names(built["grand-century"]), ["gc_status", "gc_worldsim"]);
  assert.equal(names(built.worldsim).length, 13);
});

test("the merged server has every alias tool exactly once", () => {
  const all = names(buildSimsServer(deps));
  const fromAliases = Object.values(aliases(deps)).flatMap((build) => names(build()));
  assert.equal(new Set(all).size, all.length, "a tool name is registered twice");
  assert.deepEqual([...all].sort(), [...fromAliases].sort());
});

test("repository paths come from the manifest, never a constant", async () => {
  const saved = process.env.PROJECTS_MANIFEST;
  delete process.env.PROJECTS_MANIFEST;
  try {
    const gc = aliases(deps)["grand-century"]();
    await assert.rejects(gc._registeredTools.gc_status.handler({}, {}), /PROJECTS_MANIFEST is not set/);
  } finally {
    if (saved !== undefined) process.env.PROJECTS_MANIFEST = saved;
  }
});
