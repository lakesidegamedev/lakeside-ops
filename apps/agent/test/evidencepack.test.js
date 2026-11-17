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
    servers: ["lore", "ops-knowledge"], tools: ["team_activity"],
    read: async (server, tool, args) => { calls.push(`${server}/${tool}`); return server === "lore" ? { pages: [{ slug: "military", title: "Military", description: "Generals and fronts" }] } : { hits: 2 }; },
    tool: async () => ({ covered: false, report: "team activity for ticket 1\n1. staff messages since Keir's last post: none" }) });
  assert.deepEqual(pack.items.map((i) => i.id).sort(), ["code", "wiki"], "an empty team_activity result adds nothing to the pack");
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

test("team_activity joins the pack only when a section has content (ticket 1852)", async () => {
  const report = "team activity for ticket 1852\n1. staff messages since Keir's last post:\n- owner: I'm fixing it\n2. kanban cards (now/next/blocked):\n- #255428 [now] Tech tree R&D prices | claude:coord | 1h old";
  let asked;
  const pack = await build({ lane: "bug", question: "Tech tree research prices are unreachable at my research income", servers: [], tools: ["team_activity"],
    read: async () => ({}), tool: async (name, input) => { asked = { name, input }; return { covered: true, report, instruction: "on it" }; } });
  assert.equal(asked.name, "team_activity");
  assert.match(asked.input.topic, /research|prices|unreachable/);
  const item = pack.items.find((i) => i.id === "team_activity");
  assert.ok(item); assert.match(item.result, /I'm fixing it/); assert.match(item.result, /"covered":true/);
  for (const lane of ["question", "idea", "bug", "data_repair", "outage", "people"]) assert.ok(plan(lane, { question: "x" }).some((s) => s.id === "team_activity"), lane);
});
