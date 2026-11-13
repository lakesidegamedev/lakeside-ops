"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { chooseEffort, clamp } = require("../lib/operator/effort");

const job = (extra = {}) => ({ kind: "ticket", role: "support", source: { content: "My corp lost money" }, history: [], ...extra });

test("Jev's confident pick is used and clamped to what the runner accepts", async () => {
  const r = await chooseEffort(job(), { quick: false, runner: "agy", jev: async () => ({ choice: "xhigh", confidence: 0.9 }) });
  assert.deepEqual([r.effort, r.via], ["high", "jev"]);
  assert.equal(clamp("xhigh", "claude"), "xhigh");
});

test("unsure, failing or absent Jev means medium", async () => {
  for (const jev of [async () => ({ choice: "low", confidence: 0.2 }), async () => null, async () => { throw new Error("down"); }]) {
    const r = await chooseEffort(job(), { quick: true, runner: "claude", jev });
    assert.deepEqual([r.effort, r.via], ["medium", "default"]);
  }
});

test("a task that ran out of turns or was refused never drops below high", async () => {
  const r = await chooseEffort(job({ history: [{ kind: "turn-limit" }] }), { quick: false, runner: "muse", jev: async () => ({ choice: "low", confidence: 0.95 }) });
  assert.deepEqual([r.effort, r.via], ["high", "jev+floor"]);
});

test("the conversation lane is never offered xhigh", async () => {
  let offered;
  await chooseEffort(job(), { quick: true, runner: "claude", jev: async (spec) => { offered = Object.keys(spec.criteria); return null; } });
  assert.deepEqual(offered, ["low", "medium", "high"]);
});

test("Gemini in the conversation lane is capped at medium", async () => {
  const r = await chooseEffort(job(), { quick: true, runner: "agy", jev: async () => ({ choice: "high", confidence: 0.9 }) });
  assert.equal(r.effort, "medium");
});

test("route effort is a ceiling on dynamic effort, one level higher after a struggle", async () => {
  const { activationEffort } = require("../lib/operator/effort");
  const high = async () => ({ effort: "high", via: "tags", confidence: null });
  const low = async () => ({ effort: "low", via: "tags", confidence: null });
  const job = { provider: { routeEffort: "low" }, history: [] };
  assert.deepEqual(await activationEffort(job, { config: { chooseEffort: high }, runner: "opencode" }), { effort: "low", via: "tags+route-cap", confidence: null });
  assert.equal((await activationEffort(job, { config: { chooseEffort: low }, runner: "opencode" })).effort, "low");
  const struggled = { provider: { routeEffort: "low" }, history: [{ kind: "turn-limit" }] };
  assert.equal((await activationEffort(struggled, { config: { chooseEffort: high }, runner: "opencode" })).effort, "medium");
  assert.equal((await activationEffort({ effortPin: "medium", history: [] }, { config: { chooseEffort: high }, runner: "ollama" })).effort, "medium");
  assert.equal((await activationEffort(job, { config: { chooseEffort: high, routeEffortCeiling: false }, runner: "opencode" })).effort, "high");
  assert.equal((await activationEffort({ history: [] }, { config: { chooseEffort: high }, runner: "opencode" })).effort, "high");
});

test("an operator effort override applies to every lane including voice and old low-effort routes", async () => {
  const { activationEffort } = require("../lib/operator/effort");
  for (const quick of [false, true]) {
    const r = await activationEffort({ voiceMode: true, provider: { routeEffort: "low" }, tags: { complexity: "trivial" } }, { quick, runner: "claude", config: { effortOverride: "high", dynamicEffort: false } });
    assert.equal(r.effort, "high");
  }
});

test("with an operator override, a ticket's effort is picked per activation and capped by the override", async () => {
  const { activationEffort } = require("../lib/operator/effort");
  const run = (j, ceiling = "high") => activationEffort({ ticket: 7, history: [], ...j }, { config: { effortOverride: ceiling }, runner: "claude" });
  const q = { source: { content: "How does the party leader vote work?" }, tags: { kind: "mechanics_question", complexity: "simple" } };
  const lowered = await run(q);
  assert.equal(lowered.effort, "medium");
  assert.match(lowered.via, /^operator-override:lowered:first-time rules question/);
  for (const [name, j] of Object.entries({
    bug: { ...q, tags: { kind: "bug_report" } },
    money: { ...q, source: { content: "How do I get back the $50,000 I lost?" } },
    outage: { ...q, source: { content: "Why is the turn stuck?" } },
    complex: { ...q, tags: { kind: "mechanics_question", complexity: "hard" } },
    laterActivation: { ...q, history: [{ kind: "note" }] },
    refused: { ...q, history: [{ kind: "refused" }] },
    outOfSteps: { ...q, history: [{ kind: "turn-limit" }] },
  })) { const r = await run(j); assert.equal(r.effort, "high", name); assert.match(r.via, /:ceiling:/, name); }
});

test("a disputed answer goes back to high, and a ceiling below medium is respected", async () => {
  const { activationEffort } = require("../lib/operator/effort");
  const base = { ticket: 7, history: [], source: { content: "How does the vote work?" }, tags: { kind: "mechanics_question" } };
  const disputed = await activationEffort({ ...base, inbox: [{ content: "That's wrong, it works differently" }] }, { config: { effortOverride: "high" }, runner: "claude" });
  assert.equal(disputed.effort, "high");
  assert.match(disputed.via, /player disputed/);
  assert.equal((await activationEffort(base, { config: { effortOverride: "low" }, runner: "claude" })).effort, "low");
});

test("non-ticket tasks keep the fixed operator override", async () => {
  const { activationEffort } = require("../lib/operator/effort");
  const r = await activationEffort({ history: [], source: { content: "How does the vote work?" } }, { config: { effortOverride: "high" }, runner: "claude" });
  assert.deepEqual(r, { effort: "high", via: "operator-override" });
});
