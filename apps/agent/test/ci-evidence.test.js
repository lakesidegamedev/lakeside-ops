"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { readCiEvidence } = require("../lib/operator/ciEvidence");
const sha = "a".repeat(40), base = "b".repeat(40), merge = "c".repeat(40);
function fixture() {
  const calls = [], run = { id: 11, name: "CI", event: "pull_request", run_attempt: 2, head_sha: sha, pull_requests: [{ number: 7 }], created_at: "2026-10-15T00:00:00Z", run_started_at: "2026-10-15T00:00:05Z", status: "completed", conclusion: "success" };
  const api = async ([url]) => {
    calls.push(url);
    if (url.endsWith("/pulls/7")) return { number: 7, head: { sha, ref: "main" }, base: { sha: base, ref: "development" }, merge_commit_sha: merge, changed_files: 0, merged: true };
    if (url.includes("/git/commits/")) return { tree: { sha: "d".repeat(40) } };
    if (url.includes("/attempts/2/jobs")) return { total_count: 1, jobs: [{ id: 22, name: "verify", status: "completed", conclusion: "success", started_at: "2026-10-15T00:00:10Z", completed_at: "2026-10-15T00:01:00Z", steps: [{ name: "test", started_at: "2026-10-15T00:00:15Z", completed_at: "2026-10-15T00:00:55Z" }] }] };
    if (url.includes(`head_sha=${sha}`)) return { total_count: 2, workflow_runs: [run, { ...run, id: 33, pull_requests: [{ number: 8 }] }] };
    if (url.includes(`head_sha=${merge}`)) return { total_count: 0, workflow_runs: [] };
    throw new Error(`Unexpected URL ${url}`);
  };
  return { api, calls, run };
}
test("CI evidence reports exact attempt, queue, job and step duration without mixing other PR runs", async () => {
  const h = fixture(), r = await readCiEvidence({ ...h, repo: "lakesidegamedev/AHDGame", number: 7, runId: 11 });
  assert.equal(r.runs.length, 1); assert.equal(r.runs[0].attempt, 2); assert.equal(r.runs[0].association, "pull_request");
  assert.equal(r.runs[0].queueMs, 5000); assert.equal(r.runs[0].observedWallMs, 60000);
  assert.equal(r.runs[0].jobs[0].durationMs, 50000); assert.equal(r.runs[0].jobs[0].steps[0].durationMs, 40000);
  assert.equal(r.trees.base.tree, r.trees.merge.tree); assert.equal(r.truncated, false);
  assert.ok(h.calls.some((p) => p.includes("/attempts/2/jobs")));
});
test("head-only and incomplete run evidence cannot become false complete wall time", async () => {
  const h = fixture(); h.run.pull_requests = []; h.run.status = "in_progress";
  const r = await readCiEvidence({ ...h, repo: "lakesidegamedev/AHDGame", number: 7 });
  assert.equal(r.runs[0].association, "head_only"); assert.equal(r.runs[0].observedWallMs, null);
  assert.match(r.note, /do not prove PR/);
});
test("CI reads reject invalid identifiers before any external request and propagate API failure", async () => {
  for (const number of [0, -1, "7", NaN, 1.5]) await assert.rejects(readCiEvidence({ api: () => { throw new Error("unexpected call"); }, repo: "lakesidegamedev/AHDGame", number }), /positive PR/);
  await assert.rejects(readCiEvidence({ api: () => {}, repo: "other/repo", number: 7 }), /allowed repository/);
  const h = fixture(); await assert.rejects(readCiEvidence({ repo: "lakesidegamedev/AHDGame", number: 7, api: async ([url]) => { if (url.includes("/actions/")) throw new Error("GitHub unavailable"); return h.api([url]); } }), /GitHub unavailable/);
});

test("default receipts stay compact and unknown run identifiers cannot select unrelated evidence", async () => {
  const h = fixture();
  const r = await readCiEvidence({ ...h, repo: "lakesidegamedev/AHDGame", number: 7 });
  assert.equal(r.runs[0].stepsIncluded, false); assert.equal(r.runs[0].jobs[0].steps, undefined);
  assert.ok(JSON.stringify(r).length < 18000);
  await assert.rejects(readCiEvidence({ ...h, repo: "lakesidegamedev/AHDGame", number: 7, runId: 999 }), /listed run/);
});
test("large step receipts remain valid below transport limit with explicit truncation", async () => {
  const h = fixture(), api = async args => {
    if (args[0].includes("/attempts/")) return { total_count: 100, jobs: Array.from({ length: 100 }, (_, id) => ({ id, name: "job" + id, status: "completed", started_at: "2026-10-15T00:00:10Z", completed_at: "2026-10-15T00:01:00Z", steps: Array.from({ length: 40 }, () => ({ name: "x".repeat(180), status: "completed" })) })) };
    return h.api(args);
  };
  const r = await readCiEvidence({ api, repo: "lakesidegamedev/AHDGame", number: 7, runId: 11 });
  const text = JSON.stringify(r); assert.ok(text.length <= 18000); assert.equal(JSON.parse(text).runs[0].id, 11);
  assert.ok(r.runs[0].jobsTruncated || r.runs[0].jobs.some((j) => j.stepsTruncated));
  assert.equal(r.runs[0].observedWallMs, 60000);
});

test("a workflow-runs read that returns nothing is an empty listing, not a crash", async () => {
  const h = fixture();
  const r = await readCiEvidence({ repo: "lakesidegamedev/AHDGame", number: 7, api: async ([url]) => (url.includes("/runs?head_sha=") ? null : h.api([url])) });
  assert.equal(r.runs.length, 0);
});
