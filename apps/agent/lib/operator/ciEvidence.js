"use strict";
const { CI_REPOSITORIES, canonicalRepository } = require("./github");
// Read-only, bounded receipts. Never infer a critical path from the slowest job,
// or infer PR qualification merely because two runs share a head commit.
const duration = (start, end) => {
  const a = Date.parse(start), b = Date.parse(end);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
};
function jobReceipt(j) {
  return { id: j.id, name: String(j.name || "").slice(0, 180), status: j.status, conclusion: j.conclusion,
    startedAt: j.started_at, completedAt: j.completed_at, durationMs: duration(j.started_at, j.completed_at),
    steps: (j.steps || []).slice(0, 40).map((s) => ({ name: String(s.name || "").slice(0, 180), status: s.status, conclusion: s.conclusion, durationMs: duration(s.started_at, s.completed_at) })), stepsTruncated: (j.steps || []).length > 40 };
}
async function readCiEvidence({ api, repo, number, workflow = "ci.yml", runId }) {
  repo = canonicalRepository(repo);
  if (!CI_REPOSITORIES.includes(repo) || !Number.isSafeInteger(number) || number < 1) throw new Error("ci_runs requires a positive PR number in an allowed repository");
  if (typeof workflow !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}\.ya?ml$/.test(workflow)) throw new Error("ci_runs workflow must be a bounded workflow filename");
  const prefix = `repos/${repo}`, pr = await api([`${prefix}/pulls/${number}`]);
  if (pr.number !== number || !/^[a-f0-9]{40}$/i.test(pr.head?.sha || "")) throw new Error("PR receipt does not match");
  const shas = [...new Set([pr.head.sha, pr.merge_commit_sha].filter((s) => /^[a-f0-9]{40}$/i.test(s || "")))];
  const listed = await Promise.all(shas.map((sha) => api([`${prefix}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${sha}&per_page=20`])));
  const candidates = new Map();
  for (const page of listed) for (const r of page?.workflow_runs || []) {
    if (!shas.includes(r.head_sha)) continue;
    const pulls = r.pull_requests || [];
    if (pulls.length && !pulls.some((p) => p.number === number)) continue;
    candidates.set(r.id, r);
  }
  if (runId !== undefined && (!Number.isSafeInteger(runId) || !candidates.has(runId))) throw new Error("ci_runs run must match a listed run for this PR commit");
  const chosen = (runId === undefined ? [...candidates.values()] : [candidates.get(runId)]).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 5);
  const runs = [];
  for (const r of chosen) {
    if (!Number.isSafeInteger(r.id) || !Number.isSafeInteger(r.run_attempt) || r.run_attempt < 1) throw new Error("Invalid Actions run receipt");
    const page = (await api([`${prefix}/actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100`])) || {};
    const jobs = (page.jobs || []).slice(0, 100).map(jobReceipt);
    const completed = r.status === "completed" && jobs.length > 0 && jobs.every((j) => j.status === "completed" && Number.isFinite(Date.parse(j.completedAt))) && (page.total_count || 0) <= 100;
    const finished = completed ? jobs.map((j) => j.completedAt).filter((s) => Number.isFinite(Date.parse(s))).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) : null;
    runs.push({ id: r.id, name: r.name, event: r.event, attempt: r.run_attempt, head: r.head_sha, url: r.html_url,
      association: (r.pull_requests || []).some((p) => p.number === number) ? "pull_request" : "head_only",
      status: r.status, conclusion: r.conclusion, createdAt: r.created_at, startedAt: r.run_started_at,
      queueMs: duration(r.created_at, r.run_started_at), observedWallMs: duration(r.created_at, finished),
      jobCount: page.total_count, jobsTruncated: (page.total_count || 0) > jobs.length, stepsIncluded: runId !== undefined,
      jobs: runId !== undefined ? jobs : jobs.sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 10).map(({ steps, stepsTruncated, ...job }) => job) });
    if (runId === undefined && jobs.length > 10) runs.at(-1).jobsTruncated = true;
  }
  const trees = {};
  for (const [name, sha] of Object.entries({ base: pr.base?.sha, head: pr.head.sha, merge: pr.merge_commit_sha })) {
    if (!/^[a-f0-9]{40}$/i.test(sha || "")) continue;
    try { const c = await api([`${prefix}/git/commits/${sha}`]); trees[name] = { commit: sha, tree: c.tree?.sha || null }; }
    catch { trees[name] = { commit: sha, tree: null, unavailable: true }; }
  }
  const result = { number, workflow, branches: { base: pr.base?.ref, head: pr.head?.ref }, changedFiles: pr.changed_files, merged: Boolean(pr.merged), trees,
    runs, truncated: listed.some((p) => p?.total_count > 20) || candidates.size > chosen.length,
    note: "Latest recorded attempt per run only. Default shows up to ten longest jobs; pass run to inspect listed run steps. head_only runs do not prove PR or target qualification. Tree receipts are exact recorded commits, not proof of the workflow diff base. Missing timings are null. Job durations are not a dependency critical path; no savings inferred." };
  // Stay below the tool transport's 22KB cap with valid JSON, not a cut-off receipt.
  while (JSON.stringify(result).length > 18000) {
    const jobs = runs.flatMap((r) => r.jobs);
    const withSteps = jobs.filter((j) => j.steps?.length).sort((a, b) => b.steps.length - a.steps.length)[0];
    if (withSteps) { withSteps.steps = []; withSteps.stepsTruncated = true; continue; }
    const largest = runs.filter((r) => r.jobs.length).sort((a, b) => b.jobs.length - a.jobs.length)[0];
    if (!largest) break;
    largest.jobs.pop(); largest.jobsTruncated = true;
  }
  return result;
}
module.exports = { readCiEvidence, duration };
