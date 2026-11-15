"use strict";
// Keir 10 (W3): three more github tool actions.
//   pr_diff      changed files and patches of a PR, size capped (read)
//   pr_comment   a plain comment on a PR Keir opened or staff asked about (never an approval)
//   rerun_check  re-run one failed check job on a PR's head commit
// Authority matches the existing github actions: players never reach these, a
// comment needs a task staff gave, and a re-run needs a staff-side or ticket
// task. Callers pass the broker's own gh wrappers so this stays testable.

const ACTIONS = ["pr_diff", "pr_comment", "rerun_check"];
const READ_ACTIONS = ["pr_diff"];
const PATCH_CAP = 40000;
const FILE_CAP = 8000;
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

const num = (v, what) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${what} needs the PR number`); return n; };

async function prDiff({ input, repo, api, redactSecrets }) {
  const number = num(input.number, "pr_diff");
  const [pr, files] = await Promise.all([api([`repos/${repo}/pulls/${number}`]), api([`repos/${repo}/pulls/${number}/files?per_page=100`])]);
  if (!pr) throw new Error(`PR ${number} was not found`);
  const want = input.path ? String(input.path) : null;
  let budget = PATCH_CAP, omitted = 0;
  const out = (files || []).map((f) => {
    const row = { file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions };
    if (want && !f.filename.includes(want)) return row;
    if (f.patch === undefined) return { ...row, patch: null, note: "binary or too large for GitHub to show" };
    const patch = redactSecrets(String(f.patch)).slice(0, FILE_CAP);
    if (patch.length > budget) { omitted++; return { ...row, patch: null, note: "omitted: size cap reached; pass path to read this file" }; }
    budget -= patch.length;
    return { ...row, patch, ...(f.patch.length > FILE_CAP ? { truncated: true } : {}) };
  });
  return { number, title: pr.title, state: pr.merged ? "merged" : pr.state, head: String(pr.head?.sha || "").slice(0, 10), changedFiles: (files || []).length, files: out, omittedPatches: omitted,
    note: files?.length >= 100 ? "GitHub lists 100 files at most here; the PR has more." : undefined };
}

async function prComment({ job, input, repo, api, post, allowed, opened, leak, redactSecrets, noDashes, effect, hash, audit }) {
  if (job.role === "player" || !allowed) throw new Error("pr_comment needs a task the owner or a developer gave you");
  const number = num(input.number, "pr_comment");
  const text = noDashes(String(input.comment || "").trim());
  if (text.length < 20) throw new Error("pr_comment needs the comment text in comment");
  if (text.length > 4000) throw new Error("pr_comment is at most 4000 characters");
  const bad = leak(text);
  if (bad) throw new Error(`The repository is public: the comment mentions "${bad}". Remove it and post again.`);
  const pr = await api([`repos/${repo}/pulls/${number}`]);
  if (!pr || pr.state !== "open") throw new Error(`PR ${number} is not open`);
  if (!opened(number, pr)) throw new Error("pr_comment is for PRs Keir opened or that staff asked about in this task");
  const body = `${redactSecrets(text)}\n\n_Comment from Keir. This is not an approval._`;
  const posted = await effect(job, `pr-comment:${repo}:${number}:${hash(body)}`, () => post([`repos/${repo}/issues/${number}/comments`, "-f", `body=${body}`]));
  audit("pr_comment", { job: job.id, repository: repo, number });
  return { posted: true, number, url: posted?.html_url || pr.html_url };
}

async function rerunCheck({ job, input, repo, api, post, allowed, effect, audit }) {
  if (job.role === "player" || !allowed) throw new Error("rerun_check needs a staff-side ticket or developer task");
  const number = num(input.number, "rerun_check");
  const pr = await api([`repos/${repo}/pulls/${number}`]);
  if (!pr || pr.state !== "open") throw new Error(`PR ${number} is not open`);
  const sha = pr.head?.sha;
  const runs = (await api([`repos/${repo}/commits/${sha}/check-runs?per_page=100`]))?.check_runs || [];
  const failed = runs.filter((r) => FAILED.has(r.conclusion));
  if (!failed.length) return { rerun: false, reason: "no failed check on this PR's latest commit", checks: runs.map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion })).slice(0, 20) };
  const wanted = input.check ? failed.filter((r) => String(r.id) === String(input.check) || r.name === input.check) : failed;
  if (wanted.length !== 1) return { rerun: false, reason: wanted.length ? "several checks failed; name one with check (id or name)" : "that check did not fail on the latest commit", failed: failed.map((r) => ({ id: r.id, name: r.name, conclusion: r.conclusion })) };
  const target = wanted[0];
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+/.test(String(target.html_url || ""))) return { rerun: false, reason: "that check is not a workflow job and cannot be re-run from here", check: target.name };
  await effect(job, `rerun-check:${repo}:${target.id}`, () => post(["-X", "POST", `repos/${repo}/actions/jobs/${target.id}/rerun`]));
  audit("check_rerun", { job: job.id, repository: repo, number, check: target.name });
  return { rerun: true, number, check: target.name, instruction: "The job was queued again. Use github watch on this PR; do not poll." };
}

async function run(action, ctx) {
  if (action === "pr_diff") return prDiff(ctx);
  if (action === "pr_comment") return prComment(ctx);
  if (action === "rerun_check") return rerunCheck(ctx);
  throw new Error("unknown github action");
}

module.exports = { ACTIONS, READ_ACTIONS, run, prDiff, prComment, rerunCheck };
