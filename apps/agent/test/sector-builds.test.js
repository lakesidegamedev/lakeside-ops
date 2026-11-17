"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createSectorBuilds, SITE_PROJECTION } = require("../lib/operator/sectorbuilds");

const corp = { _id: { $oid: "a".repeat(24) }, name: "Pfizer", sequentialId: 496 };
function mcpWith(sites, corps = [corp]) {
  const calls = [];
  return { calls, call: async (server, tool, args) => { calls.push({ server, tool, args }); return args.collection === "corporations" ? { docs: corps } : { docs: sites }; } };
}

test("resolves the corporation and reads its sites through a fixed projection", async () => {
  const mcp = mcpWith([{ stateId: "NY", sectorType: "chemicals", buildQueue: [], constructionFinancing: { status: "active" }, forSale: false }]);
  const out = await createSectorBuilds({ mcp }).call({ role: "support", ticket: 1 }, { corporation: "496", state: "ny" });
  assert.equal(out.found, true); assert.equal(out.corporation.name, "Pfizer");
  assert.deepEqual(mcp.calls[0].args.filter, { sequentialId: 496 });
  const sites = mcp.calls[1].args;
  assert.equal(sites.collection, "corporateSectors"); assert.equal(sites.env, "prod");
  assert.equal(sites.filter.stateId, "NY"); assert.deepEqual(sites.projection, SITE_PROJECTION);
  assert.ok(!/email|token|discord|password/i.test(JSON.stringify(sites.projection)));
  assert.equal(out.sites[0].buildQueueLength, 0); assert.equal(out.sites[0].constructionFinancing.status, "active");
});

test("names, ids and ambiguity", async () => {
  const byName = mcpWith([]); await createSectorBuilds({ mcp: byName }).call({}, { corporation: "Pfizer" });
  assert.deepEqual(byName.calls[0].args.filter, { name: "Pfizer" });
  const byId = mcpWith([]); await createSectorBuilds({ mcp: byId }).call({}, { corporation: "A".repeat(24) });
  assert.ok(byId.calls[0].args.filter.$expr);
  const two = mcpWith([], [corp, { ...corp, sequentialId: 497 }]);
  const out = await createSectorBuilds({ mcp: two }).call({}, { corporation: "Pfizer" });
  assert.equal(out.found, false); assert.match(out.note, /several corporations/); assert.equal(two.calls.length, 1);
  const none = await createSectorBuilds({ mcp: mcpWith([], []) }).call({}, { corporation: "Nope" });
  assert.match(none.note, /no corporation matches/);
  assert.equal((await createSectorBuilds({ mcp: mcpWith([]) }).call({}, {})).found, false);
});
