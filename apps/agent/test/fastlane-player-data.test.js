"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { plan } = require("../lib/operator/fastlane");

const job = (q, images = 0) => ({ kind: "ticket", ticket: 1, role: "support", source: { content: q }, inbox: [], history: [], contextImages: images });
const tags = { kind: "mechanics_question", kindConfidence: 0.9 };

test("a report about the player's own numbers goes to the agent, not the rules lane (tickets 1838, 1841)", () => {
  assert.equal(plan(job("Why did GDP drop this drastically in a week"), {}, tags).skip, "player data report");
  assert.equal(plan(job("why is my cash so low"), {}, tags).skip, "player data report");
  assert.ok(plan(job("Why does 1 depot cost 22 million dollars"), {}, tags).skip);
  assert.equal(plan(job("what happened to turn 4"), {}, tags).skip, "player data report");
});

test("a screenshot always goes to the agent", () => {
  assert.equal(plan(job("How does the filibuster work", 1), {}, tags).skip, "screenshot");
});

test("a pure rules question still gets the fast answer", () => {
  assert.equal(plan(job("How do primaries work?"), {}, tags).kind, "answer");
  assert.equal(plan(job("What is cloture?"), {}, tags).kind, "answer");
});
