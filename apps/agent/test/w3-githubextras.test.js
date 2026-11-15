"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const gx = require("../lib/operator/githubextras");

const base = (over = {}) => ({ job: { id: "j", role: "support" }, input: { number: 7 }, repo: "o/r", allowed: true, redactSecrets: (s) => s, noDashes: (s) => s.replace(/[–—]/g, ","), leak: () => null, effect: async (_j, _k, fn) => fn(), hash: (s) => String(s).length, audit: () => {}, opened: () => true, ...over });

test("pr_diff lists files, caps the patch budget and can focus one path", async () => {
  const big = "x".repeat(30000);
  const api = async ([route]) => route.includes("/files") ? [{ filename: "a.js", status: "modified", additions: 1, deletions: 0, patch: big }, { filename: "b.js", status: "added", additions: 2, deletions: 0, patch: big }, { filename: "c.js", status: "added", additions: 1, deletions: 0, patch: "small" }] : { title: "T", state: "open", head: { sha: "abcdef1234567" } };
  const out = await gx.prDiff(base({ api }));
  assert.equal(out.changedFiles, 3); assert.equal(out.files[0].truncated, true);
  assert.ok(out.files.reduce((n, f) => n + (f.patch || "").length, 0) <= 40000);
  assert.ok(out.files.some((f) => f.note && /omitted/.test(f.note)) || out.omittedPatches === 0);
  const one = await gx.prDiff(base({ api, input: { number: 7, path: "c.js" } }));
  assert.equal(one.files[2].patch, "small"); assert.equal(one.files[0].patch, undefined);
});

test("pr_comment posts a plain comment on an open PR Keir may speak on", async () => {
  const posted = [];
  const out = await gx.prComment(base({ input: { number: 7, comment: "The migration step needs a rollback note, see the second file." }, api: async () => ({ state: "open", html_url: "u" }), post: async (a) => { posted.push(a); return { html_url: "c" }; } }));
  assert.equal(out.posted, true); assert.match(posted[0].at(-1), /not an approval/);
  await assert.rejects(gx.prComment(base({ input: { number: 7, comment: "A long enough comment body here." }, api: async () => ({ state: "open" }), post: async () => ({}), opened: () => false })), /PRs Keir opened/);
  await assert.rejects(gx.prComment(base({ job: { role: "player" }, input: { number: 7, comment: "A long enough comment body here." }, api: async () => ({}), post: async () => ({}) })), /needs a task/);
  await assert.rejects(gx.prComment(base({ input: { number: 7, comment: "A long enough comment body here." }, api: async () => ({ state: "closed" }), post: async () => ({}) })), /not open/);
});

test("pr_comment refuses private details on a public repository", async () => {
  await assert.rejects(gx.prComment(base({ input: { number: 7, comment: "see /root/projects/secret for the details of this" }, leak: () => "/root/projects", api: async () => ({ state: "open" }), post: async () => ({}) })), /public/);
});

test("rerun_check re-runs exactly one failed job", async () => {
  const runs = [{ id: 11, name: "verify", conclusion: "failure", html_url: "https://github.com/o/r/actions/runs/5/job/11" }, { id: 12, name: "custom-rules", conclusion: "success", html_url: "x" }];
  const calls = [];
  const api = async ([route]) => route.includes("check-runs") ? { check_runs: runs } : { state: "open", head: { sha: "abc" } };
  const out = await gx.rerunCheck(base({ api, post: async (a) => { calls.push(a); return {}; } }));
  assert.equal(out.rerun, true); assert.deepEqual(calls[0], ["-X", "POST", "repos/o/r/actions/jobs/11/rerun"]);
  runs.push({ id: 13, name: "dependency-review", conclusion: "failure", html_url: "https://github.com/o/r/actions/runs/5/job/13" });
  const two = await gx.rerunCheck(base({ api, post: async () => { throw new Error("must not run"); } }));
  assert.equal(two.rerun, false); assert.match(two.reason, /several/);
  const named = await gx.rerunCheck(base({ api, input: { number: 7, check: "dependency-review" }, post: async (a) => { calls.push(a); return {}; } }));
  assert.equal(named.rerun, true);
  assert.equal((await gx.rerunCheck(base({ api: async ([r]) => r.includes("check-runs") ? { check_runs: [] } : { state: "open", head: { sha: "a" } }, post: async () => ({}) }))).rerun, false);
});
