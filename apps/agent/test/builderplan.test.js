"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os"), fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const { planBuilder, repoFor } = require("../lib/operator/builderplan");

const gaps = {
  "tool:gamestate/trace_corp:argument types": { kanbanId: 31, hits: 9, weighted: 14, lowHits: 5, tasks: 6, title: "gamestate/trace_corp: argument types" },
  "raw:corporations": { kanbanId: 32, hits: 6, weighted: 6, tasks: 4, title: "A read for corporations without raw database queries" },
  "tool:heal-ops/heal_query:raw": { kanbanId: 33, hits: 4, weighted: 4, tasks: 3, title: "Keir is not allowed to read heal_query as support: outside support scope" },
  "tool:engine/economy_pulse:tool timed out": { kanbanId: 34, hits: 3, weighted: 3, tasks: 2, title: "engine/economy_pulse: tool timed out" },
};

test("the plan takes the top gaps for the repository with the most of them and says what it left out", () => {
  const plan = planBuilder({ capabilityGaps: gaps }, { top: 5, date: "2026-11-16" });
  assert.equal(plan.repo, "lakeside-code");
  assert.deepEqual(plan.gaps.map((g) => g.kanbanId), [31, 32, 34]);
  assert.deepEqual(plan.deferred.map((g) => g.kanbanId), [33]);
  assert.equal(plan.cardId, 31);
  assert.match(plan.prompt, /board card 31/);
  assert.match(plan.prompt, /Never add a write/);
  assert.match(plan.prompt, /Not in this run \(other repository\)/);
  assert.ok(!/[–—]/.test(plan.prompt + plan.digest), "no dashes");
  assert.match(plan.digest, /3 gaps sent to a worker in lakeside-code, 1 left/);
});

test("no gaps means no plan, and the allowlist repo is chosen when most gaps are about access", () => {
  assert.equal(planBuilder({}), null);
  const only = { a: { kanbanId: 1, hits: 5, weighted: 5, title: "x: outside support scope" }, b: { kanbanId: 2, hits: 4, weighted: 4, title: "y: closed to support reads" }, c: { kanbanId: 3, hits: 3, weighted: 3, title: "z: argument types" } };
  assert.equal(planBuilder({ capabilityGaps: only }).repo, "lakeside-ops");
  assert.equal(repoFor({ title: "z", sig: "tool:z:argument types" }), "lakeside-code");
});

test("the wrapper dry run writes the brief and launches nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-")), state = path.join(dir, "state"); fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "ledger.json"), JSON.stringify({ capabilityGaps: gaps }));
  const out = cp.execFileSync(path.join(__dirname, "../deploy/keir-builder.sh"), ["--dry-run"], { encoding: "utf8",
    env: { ...process.env, KEIR_APP_DIR: path.join(__dirname, ".."), KEIR_OPERATOR_STATE_DIR: state, KEIR_BUILDER_OUT: path.join(dir, "out"), KEIR_BUILDER_LAUNCHER: "/bin/false" } });
  assert.match(out, /^dry run: Keir builder/);
  assert.match(fs.readFileSync(path.join(dir, "out/prompt.md"), "utf8"), /Keir weekly builder/);
});
