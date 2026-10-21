import test from "node:test";
import assert from "node:assert/strict";
import { sceneCells, toRuns } from "./tui/scene.mjs";

test("the scene has a fixed shape and only known palette keys", () => {
  const rows = sceneCells(0, { width: 44 });
  assert.equal(rows.length, 11);
  for (const row of rows) assert.equal(row.length, 44);
  const keys = new Set(rows.flat().map(cell => cell.c));
  for (const key of keys) assert.ok(["muted", "dim", "text", "primary", "blue"].includes(key), key);
  assert.ok(rows.slice(1, 7).flat().some(cell => cell.c === "text"), "text on the tallest peaks");
});

test("mountains stay still while the water moves", () => {
  const a = sceneCells(0), b = sceneCells(1.3);
  assert.deepEqual(a.slice(1, 7), b.slice(1, 7));
  assert.notDeepEqual(a.slice(7), b.slice(7));
});

test("large scenes keep exactly the requested width", () => {
  const rows = sceneCells(0.7, { width: 120, mountain: 18, lake: 4, sky: 1 });
  assert.equal(rows.length, 24);
  for (const row of rows) assert.equal(row.length, 120);
});

test("runs merge neighbors without losing characters", () => {
  const rows = sceneCells(0.4);
  const runs = toRuns(rows);
  rows.forEach((row, i) => assert.equal(runs[i].map(r => r.text).join(""), row.map(c => c.ch).join("")));
});
