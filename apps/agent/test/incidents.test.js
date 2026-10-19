"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { matchIncident, mergeIntoIncident, openIncidents, resetIncidentCache } = require("../lib/operator/incidents");
const { ticketCategory } = require("../lib/operator/ticketCategory");
const { createLedger } = require("../lib/operator/store");

const ledger = () => createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keir-inc-")), "ledger.json"));
const inc = [{ number: 1539, title: "Turn processing stalled", description: "Turn 180 has not processed." }, { number: 1541, title: "Login page down", description: "Sign in returns 502." }];
const ask = (p) => async (spec) => ({ answers: Object.fromEntries(Object.keys(spec.questions).map((k) => [k, { noul: p[k] ?? 0.05 }])) });

test("the intake card category recognises incidents", () => {
  const rows = [{ author: { id: "bot" }, embeds: [{ title: "🚨 Incident - #1539", fields: [{ name: "Category", value: "Incident" }] }] }];
  assert.equal(ticketCategory(rows, "bot"), "incident");
});

test("one clear match merges; two likely incidents or a weak match only become candidates", async () => {
  const job = { ticket: 1540, source: { content: "the turn is stuck again" } };
  assert.deepEqual((await matchIncident({ job, incidents: inc, ask: ask({ i1539: 0.93 }) })).best, { number: 1539, p: 0.93 });
  const two = await matchIncident({ job, incidents: inc, ask: ask({ i1539: 0.9, i1541: 0.6 }) });
  assert.equal(two.best, null); assert.deepEqual(two.candidates.map((c) => c.number), [1539, 1541]);
  const weak = await matchIncident({ job, incidents: inc, ask: ask({ i1539: 0.7 }) });
  assert.equal(weak.best, null); assert.equal(weak.candidates[0].number, 1539);
  assert.deepEqual(await matchIncident({ job, incidents: [], ask: ask({}) }), { best: null, candidates: [] });
  assert.equal((await matchIncident({ job, incidents: inc, ask: async () => null })).best, null, "no verdict fails open");
});

test("merging calls support_merge as a write, closes the task and audits it", async () => {
  const L = ledger(); const job = L.createJob("ticket:1540", { kind: "ticket", role: "support", ticket: 1540, source: {} });
  const calls = []; const mcp = { call: async (...a) => { calls.push(a); return { ok: true, steps: ["access", "linked"] }; } };
  await mergeIntoIncident({ mcp, ledger: L, job, target: 1539, reason: "same stalled turn" });
  assert.deepEqual(calls[0].slice(0, 2), ["support", "support_merge"]); assert.equal(calls[0][3], true, "write");
  assert.deepEqual(calls[0][2], { source_number: 1540, target_number: 1539, reason: "same stalled turn", merged_by: "keir", require_incident: true });
  assert.equal(job.state, "done"); assert.equal(job.mergedInto, 1539); assert.equal(job.channelClosed, true);
  assert.equal(L.data.audit.at(-1).kind, "merged_into_incident");
});

test("open incidents are read from the support MCP and cached for a minute", async () => {
  resetIncidentCache(); let n = 0;
  const mcp = { call: async (s, tool, args) => { n++; if (tool === "support_list") { assert.equal(args.category, "incident"); return { items: [{ number: 1539, title: "Turn stalled", status: "open", category: "incident" }, { number: 1500, title: "Old", status: "resolved", category: "incident" }] }; } return { description: "Turn 180", mergedTickets: [{}, {}] }; } };
  const a = await openIncidents(mcp, { now: 1000 }); assert.deepEqual(a.map((x) => [x.number, x.merged]), [[1539, 2]]);
  await openIncidents(mcp, { now: 2000 }); assert.equal(n, 2, "cached");
  await openIncidents(mcp, { now: 70000 }); assert.equal(n, 4, "refreshed after a minute");
});

test("investigation cards are staff-owned and held from ordinary support",()=>{
 const {STAFF_OWNED,isModerationChannel}=require("../lib/operator/ticketCategory");
 assert.equal(ticketCategory([{author:{id:"bot"},embeds:[{fields:[{name:"Category",value:"Investigation"}]}]}],"bot"),"investigation");
 assert.equal(STAFF_OWNED.has("investigation"),true);
 assert.equal(isModerationChannel({data:{channels:{private:{category:"investigation"}}}},"private"),true);
});
