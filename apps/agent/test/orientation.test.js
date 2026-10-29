"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { orient, compactTools } = require("../lib/operator/orientation");
const { repoMap } = require("../lib/operator/repomap");

test("orientation runs the discovery reads once and compacts them", async () => {
  const calls = [];
  const tool = async (name, input) => {
    calls.push([name, input.server]);
    if (name === "read_servers") return ["gamestate", "support"];
    if (name === "read_tools") return [{ name: "trace_sector", description: "Trace one sector. Long detail follows.", schema: { properties: { sectorId: {}, turn: {} }, required: ["sectorId"] } }];
    if (name === "reporter_state") return { character: { name: "A. Player", homeState: "Ohio" } };
    if (name === "ticket_record") return {};
    if (name === "ticket_history") return [{ author: "p", bot: false, content: "second", at: "2" }, { author: "Keir", bot: true, content: "first", at: "1" }];
    throw new Error("unexpected");
  };
  const o = await orient(tool);
  assert.deepEqual(o.servers, ["gamestate", "support"]);
  assert.deepEqual(o.tools.gamestate, ["trace_sector(sectorId*, turn): Trace one sector."]);
  assert.equal(o.reporter.name, "A. Player");
  assert.deepEqual(o.recentMessages.map((m) => m.text), ["first", "second"]);
  assert.equal(o.errors, undefined);
  assert.deepEqual(calls.map((c) => c[0]).sort(), ["read_servers", "read_tools", "read_tools", "reporter_state", "ticket_history", "ticket_record"].sort());
  assert.deepEqual(Object.keys(o).filter((k) => k !== "note"), ["servers", "tools", "reporter", "recentMessages", "ticketRecordRead"]);
  assert.ok(o.timings && typeof o.timings.tools === "number");
  assert.equal(JSON.stringify(o).includes("timings"), false);
});

test("orientation reads run concurrently instead of one after another", async () => {
  let inFlight = 0, peak = 0;
  const tool = async (name) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 30));
    inFlight--;
    if (name === "read_servers") return ["gamestate", "support", "ops-knowledge"];
    if (name === "reporter_state") return { character: {} };
    return [];
  };
  const t = Date.now();
  await orient(tool);
  assert.ok(peak >= 4, `peak concurrency ${peak}`);
  assert.ok(Date.now() - t < 150, "serial would take about 210 ms");
});

test("orientation records failures without throwing", async () => {
  const o = await orient(async (name) => { if (name === "reporter_state") throw new Error("ticket has no linked character profile"); return []; });
  assert.match(o.errors.reporter, /no linked character/);
  assert.deepEqual(o.tools, {});
});

test("compactTools keeps names, required marks and one sentence", () => {
  assert.deepEqual(compactTools([{ name: "x", schema: {} }]), ["x()"]);
});

test("repoMap lists small trees fully and summarises large ones within budget", () => {
  assert.deepEqual(repoMap(["a/b.ts", "c.ts"]), { files: ["a/b.ts", "c.ts"] });
  const files = Array.from({ length: 500 }, (_, i) => `src/lib/m${i % 40}/f${i}.ts`);
  const m = repoMap(files, { maxLines: 30 });
  assert.equal(m.totalFiles, 500);
  assert.equal(m.directories.length, 30);
  assert.ok(m.directories.includes("src/ (500)"));
  assert.equal(repoMap([]), null);
});
