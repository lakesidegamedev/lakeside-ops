"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { normalize, clusters, briefFor } = require("../bin/keir-self-review.js");

test("refusals cluster by cause, not by the numbers, ids or names in them", () => {
  assert.equal(normalize("player history is limited to this ticket's reporter (H. Garside, id 4242)"), "player history is limited to this ticket's reporter (…)");
  assert.equal(normalize('Not posted: "Steel idle" needs github on 9a8b7c6d5e4f3a2b'), 'Not posted: "…" needs github on ID');
  const rows = [
    { tool: "read_tool", error: "player history is limited to this ticket's reporter (A, id 1)", job: "a", ticket: 1 },
    { tool: "read_tool", error: "player history is limited to this ticket's reporter (B, id 2)", job: "b", ticket: 2 },
    { tool: "read_tool", error: "player history is limited to this ticket's reporter (B, id 2)", job: "b", ticket: 2 },
    { tool: "finish", error: "Not finished: x", job: "c" },
  ];
  const c = clusters(rows);
  assert.equal(c[0].tool, "read_tool"); assert.equal(c[0].count, 3); assert.equal(c[0].jobs, 2);
  assert.doesNotMatch(c[0].key, /\b[AB]\b, id/);
});

test("the brief forbids weakening safety guards and copying player data into the public repo", () => {
  const b = briefFor({ key: "k", count: 5, jobs: 2, samples: ["s"] });
  assert.match(b, /Never weaken a safety guard/);
  assert.match(b, /never copy player or character names/);
});
