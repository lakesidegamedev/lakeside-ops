"use strict";
// Keir 10.1: housekeeping archives finished tasks but left their actions and decisions behind. By 2026-11-16 the
// ledger held 651 actions and 311 decisions for tasks that no longer existed, and the integrity report listed every
// one of them each hour, which buried any new problem. A record whose task is gone and that is a week old moves to
// the archive with the task. Nothing pending is touched, and an approved action is archived as orphaned: it is
// never executed (its task, the only thing that could run it, is gone), unless GitHub shows its merge happened (11.2).
const GRACE_MS = 7 * 86400000;
const { truthForAction } = require("./prtruth");
const { prOfAction } = require("./decisions");
const ms = (v) => (typeof v === "number" ? v : Date.parse(v || "") || 0);

function sweepOrphans(data, now = Date.now()) {
  const jobs = data.jobs || {};
  const out = [];
  for (const [id, x] of Object.entries(data.decisions || {})) {
    if (jobs[x.jobId] || x.state === "pending" || now - ms(x.answeredAt || x.at) < GRACE_MS) continue;
    out.push({ type: "decision", ...x }); delete data.decisions[id];
  }
  const decided = new Set(Object.values(data.decisions || {}).map((x) => x.actionId).filter(Boolean));
  for (const [id, a] of Object.entries(data.actions || {})) {
    if (jobs[a.jobId] || a.state === "pending" || decided.has(id) || now - ms(a.executedAt || a.at) < GRACE_MS) continue;
    // Keir 11.2: a merge is "never executed" only if GitHub says so. The reconcile pass (prtruth.js) records what it read;
    // a merged PR is archived done, and a PR whose state was never read is archived unverified, not orphaned.
    const truth = ["approved", "executing"].includes(a.state) ? truthForAction(data, a) : null;
    const isPr = ["approved", "executing"].includes(a.state) && Boolean(prOfAction(a));
    const relabel = !["approved", "executing"].includes(a.state) ? {}
      : truth?.merged ? { state: "done", stateBeforeArchive: a.state, reconciledFrom: "github", executedAt: a.executedAt || truth.mergedAt || null }
      : isPr && !truth ? { state: "unverified", stateBeforeOrphan: a.state }
      : { state: "orphaned", stateBeforeOrphan: a.state };
    out.push({ type: "action", ...a, ...relabel }); delete data.actions[id];
  }
  return out;
}

module.exports = { sweepOrphans, GRACE_MS };
