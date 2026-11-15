"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { build, keywords, plan } = require("../lib/operator/evidencepack");

test("keywords drop filler and keep the longest content words", () => {
  assert.deepEqual(keywords("How do I assign generals to a conflict", 2), ["generals", "conflict"]);
});

test("a question gathers wiki and code, and reports a missing Ask tool", async () => {
  const calls = [];
  const pack = await build({ lane: "question", question: "How do I assign generals to a conflict",
    servers: ["lore", "ops-knowledge"], tools: [],
    read: async (server, tool, args) => { calls.push(`${server}/${tool}`); return server === "lore" ? { pages: [{ slug: "military", title: "Military", description: "Generals and fronts" }] } : { hits: 2 }; },
    tool: async () => { throw new Error("not called"); } });
  assert.deepEqual(pack.items.map((i) => i.id).sort(), ["code", "wiki"]);
  assert.equal(pack.missing.length, 1);
  assert.equal(pack.missing[0].id, "ask_health");
  assert.ok(calls.includes("lore/lore_wiki_search") && calls.includes("ops-knowledge/code_search"));
  assert.match(pack.items.find((i) => i.id === "wiki").result, /military/);
});

test("a slow or failing read is listed as missing and never throws", async () => {
  const pack = await build({ lane: "outage", question: "turn stuck", servers: [], tools: ["turn_status"], timeoutMs: 50,
    read: async () => ({}), tool: () => new Promise(() => {}) });
  assert.equal(pack.items.length, 0);
  assert.match(pack.missing.find((m) => m.id === "turn_status").reason, /no answer/);
});

test("results are clipped to the character budget", async () => {
  const pack = await build({ lane: "outage", question: "turn", tools: ["turn_status"], maxChars: 1000,
    read: async () => ({}), tool: async () => ({ blob: "x".repeat(5000) }) });
  assert.ok(pack.items[0].result.length < 1100);
});

test("every lane has a plan and unknown lanes gather nothing", () => {
  for (const lane of ["question", "idea", "advice", "bug", "data_repair", "outage", "people"]) assert.ok(plan(lane, { question: "x" }).length > 0, lane);
  assert.equal(plan("nope", { question: "x" }).length, 0);
});
