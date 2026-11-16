"use strict";
// Keir 10.1: housekeeping archives finished tasks but left their actions and decisions behind. By 2026-11-16 the
// ledger held 651 actions and 311 decisions for tasks that no longer existed, and the integrity report listed every
// one of them each hour, which buried any new problem. A record whose task is gone and that is a week old moves to
// the archive with the task. Nothing pending is touched, and an approved action is archived as orphaned: it is
// never executed (its task, the only thing that could run it, is gone).
const GRACE_MS = 7 * 86400000;
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
    const orphaned = ["approved", "executing"].includes(a.state);
    out.push({ type: "action", ...a, ...(orphaned ? { state: "orphaned", stateBeforeOrphan: a.state } : {}) }); delete data.actions[id];
  }
  return out;
}

module.exports = { sweepOrphans, GRACE_MS };
