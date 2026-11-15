"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os"), fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const { summarize, compare } = require("../bin/keir-replay-gate");

function results(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  fs.writeFileSync(path.join(dir, "results.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

test("summarize reads pass and fail per scenario, and an errored run is a fail", () => {
  const dir = results([{ scenario: "howto-drift", grade: { success: true } }, { scenario: "turn-outage", grade: { success: false } }, { scenario: "card-reuse", grade: { success: true }, error: "boom" }]);
  assert.deepEqual(summarize(dir, "abc", 5), { sha: "abc", at: 5, scenarios: { "howto-drift": true, "turn-outage": false, "card-reuse": false } });
});

test("only a scenario that passed on live and fails now is a regression", () => {
  const base = { scenarios: { a: true, b: true, c: false, d: true } };
  const cand = { scenarios: { a: true, b: false, c: true } };
  const r = compare(base, cand);
  assert.deepEqual(r.regressions, ["b", "d"]);
  assert.deepEqual(r.fixed, ["c"]);
  assert.equal(r.ok, false);
  assert.equal(compare({ scenarios: { a: false } }, { scenarios: { a: false } }).ok, true);
});

test("the cli exits 1 on a regression and 0 otherwise, and release.sh keeps the gate off by default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-")), file = (n, o) => { const f = path.join(dir, n); fs.writeFileSync(f, JSON.stringify(o)); return f; };
  const bin = path.join(__dirname, "../bin/keir-replay-gate.js");
  const run = (b, c) => cp.spawnSync(process.execPath, [bin, "compare", b, c], { encoding: "utf8" });
  const bad = run(file("b.json", { scenarios: { a: true } }), file("c.json", { scenarios: { a: false } }));
  assert.equal(bad.status, 1); assert.match(bad.stdout, /refused.*: a/);
  assert.equal(run(file("b2.json", { scenarios: { a: true } }), file("c2.json", { scenarios: { a: true } })).status, 0);
  const rel = fs.readFileSync(path.join(__dirname, "../deploy/release.sh"), "utf8");
  assert.match(rel, /replay_gate=0/);
  assert.match(rel, /if \(\( replay_gate \)\)/);
});
