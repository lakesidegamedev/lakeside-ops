"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { calculate, calculateBatch } = require("../lib/operator/knowledge");

// Made-up fixed instant (2025-01-01T00:00:00Z) so the arithmetic stays readable.
const READ_AT = 1735689600000;

test("elapsed time can use the clock instead of a copied timestamp", () => {
  const before = Date.now();
  const elapsed = calculate("now - 1735689600000", [READ_AT]);
  const after = Date.now();
  assert.ok(elapsed >= before - READ_AT, "elapsed time is at least the clock at the start");
  assert.ok(elapsed <= after - READ_AT, "elapsed time is at most the clock at the end");
  assert.equal(typeof calculate("now() - 1735689600000", [READ_AT]), "number");
});

test("a batch step can carry the clock into a later ratio", () => {
  const rows = calculateBatch([{ id: "minutes", expression: "(now - 1735689600000)/60000" }], [READ_AT]);
  assert.equal(rows[0].id, "minutes");
  assert.ok(rows[0].value > 0);
});

test("a step named now still shadows the clock for later steps", () => {
  const rows = calculateBatch([{ id: "now", expression: "5" }, { id: "double", expression: "$now*2" }], []);
  assert.deepEqual(rows.map((row) => row.value), [5, 10]);
});

test("the clock does not admit a copied or invented timestamp", () => {
  assert.throws(() => calculate("1700000000 + 1", [READ_AT]), /not in anything you read/);
  assert.throws(() => calculate("999999999", []), /use now/);
});
