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
