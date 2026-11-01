"use strict";
// Keir 5.6.3: settle uncertain GitHub merge receipts from GitHub itself.
// A merge call that errors after GitHub accepted it ("Merge already in
// progress", a timeout) left its effect "started" forever. That held the task
// for owner inspection, and every guard that skips in-flight writes (spin
// guard, handoff watch, shutdown) then ignored the task: ticket 1578 carried
// one from 05:14 to 13:23 UTC on 2026-10-16 for a PR that had merged.
// A merge key names the PR and its exact head, so the outcome is checkable:
// merged at that head is done; still open at that head, or closed, is a merge
// that did not happen. Anything else stays held. This never merges.
//
// Keir 7.0.3: compensation payments are settled the same way. heal-ops marks
// each paid corporation, so a fresh dry run of the same payment reports
// nobody still owed once it has landed (ticket 1730, 2026-11-01: a
// $1,306,621 credit succeeded, the call timed out, and the task sat "stuck"
// in the owner's app for an hour). Still owed means it did not land and a
// later approved call may run it. Anything else stays held. This never pays.
const { repositoryName } = require("./github");
const heal = require("../heal");
const MERGE_KEY = /^merge:(\d+):([0-9a-f]{40})$/;
const ACTION_KEY = /^action:([0-9a-f]+)$/;
const compensationAction = (d, key) => { const id = ACTION_KEY.exec(key)?.[1]; const a = id && d.actions?.[id]; return a?.kind === "heal" && a.args?.spec?.kind === "compensation" ? a : null; };
const SETTLE_MS = 10 * 60000;
const REPOS = ["AHDGame", "AHDClient"];

function createEffectRecovery({ ledger, api, mcp = null, now = () => Date.now(), running = () => false, log = () => {} }) {
  const d = ledger.data;
  async function settle(job, key, e, number, head) {
    for (const name of REPOS) {
      let pr;
      try { pr = await api(`repos/${repositoryName(name)}/pulls/${number}`); } catch { continue; }
      if (pr?.head?.sha !== head) continue; // another repo's PR with this number
      if (pr.merged) {
        job.effects[key] = { ...e, state: "done", at: now(), result: { merged: true, sha: pr.merge_commit_sha, reconciled: true } };
        return "merged";
      }
      if (pr.state === "closed" || (pr.state === "open" && !pr.merged)) {
        // Verified not merged: a later call may try again.
        job.effects[key] = { ...e, state: "rejected", at: now(), error: `verified not merged (${pr.state}): ${String(e.error || "").slice(0, 200)}` };
        return "not-merged";
      }
    }
    return null;
  }
  async function settlePayment(job, key, e, action) {
    if (!mcp) return null;
    let plan;
    try { const call = heal.planCall(action.args.spec, "Keir effect recovery (dry run)"); plan = await mcp.call("heal-ops", call.name, call.args, false); } catch { return null; }
    // Only an explicit dry-run answer counts; a failed or empty call proves nothing.
    if (!plan || plan.ok === false || !plan.plan || !Number.isFinite(Number(plan.plan.affected))) return null;
    const owed = Number(plan.plan.affected);
    if (owed === 0) {
      job.effects[key] = { ...e, state: "done", at: now(), result: { paid: true, reconciled: true } };
      action.state = "done";
      return "paid";
    }
    if (owed === action.args.affected) {
      job.effects[key] = { ...e, state: "rejected", at: now(), error: `verified not paid: ${String(e.error || "").slice(0, 200)}` };
      return "not-paid";
    }
    return null;
  }
  async function tick() {
    let changed = false;
    for (const job of Object.values(d.jobs)) {
      if (running(job)) continue;
      const uncertain = Object.entries(job.effects || {}).filter(([k, e]) => e?.state === "started" && (MERGE_KEY.test(k) || compensationAction(d, k)) && now() - (e.at || 0) >= SETTLE_MS);
      for (const [key, e] of uncertain) {
        const merge = MERGE_KEY.exec(key);
        const outcome = merge ? await settle(job, key, e, Number(merge[1]), merge[2]) : await settlePayment(job, key, e, compensationAction(d, key));
        if (!outcome) continue;
        changed = true;
        ledger.audit("effect_reconciled", { job: job.id, key, outcome });
        log(`effect recovery: ${job.id} ${key} ${outcome}`);
      }
      // A task held only for receipt inspection resumes once nothing is uncertain.
      if (uncertain.length && job.state === "blocked" && !Object.values(job.effects || {}).some((x) => x?.state === "started")) {
        (job.inbox ||= []).push({ role: "system", authorId: "effect-recovery", at: new Date(now()).toISOString(),
          content: "The uncertain merge or payment receipt on this task was checked against GitHub or heal-ops and settled (see effect_reconciled). A settled payment is not repeated. Re-read the PR state, then continue from your last checkpoint; do not repeat a merge that is already done." });
        job.state = "queued"; changed = true;
      }
    }
    if (changed) ledger.save();
  }
  return { tick };
}
module.exports = { createEffectRecovery, MERGE_KEY, SETTLE_MS, compensationAction };
