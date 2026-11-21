"use strict";
// Keir 11.2: GitHub is the truth for approvals (audit 2026-11-21, P1-5 and H4, H8).
//
// Keir's records never learned that an approved merge happened: every approved merge stayed "approved" until the
// weekly cleanup relabelled it "orphaned: never executed", including PRs merged minutes after approval. A PR merged by
// another developer (ticket 1857, PR 6866) left the owner's question pending with live buttons. This pass reads each
// PR that a pending question or an unfinished approval is about, before the decision tick sends reminders or
// escalations, and moves Keir's records to what GitHub says:
//   merged (by anyone, any path)  -> the question closes, the action is recorded done;
//   closed without merging        -> the question is withdrawn, the action withdrawn;
//   open at a newer head          -> the question is withdrawn and its task asked to re-ask once for the new head.
// A publish_patch action stuck "executing" whose PR exists on GitHub is recorded done.
// Nothing is guessed: a read that fails leaves every record as it was until a later pass reads it.
const { JOB_TERMINAL } = require("./machines");
const { GAME_REPO, canonicalRepository, repositoryName } = require("./github");
const { prOfAction, prOfDecision } = require("./decisions");

const TTL_MS = 2 * 60000;
const KEEP_MS = 14 * 86400000;
const MAX_READS = 15;
// Keir 11.2: PRs a waiting job's closing condition names, or a review task's fix PR, are read at most this often and at
// most WAIT_READS a pass, so the code-side wake check (closing.js) can tell "nothing changed" without a model run.
const WAIT_REFRESH_MS = 30 * 60000;
const WAIT_READS = 5;
const repoOf = (r) => (!r ? GAME_REPO : /\//.test(r) ? canonicalRepository(r) : repositoryName(r));
const prKey = (repo, n) => `${repo}#${n}`;

function createPrTruth({ ledger, api, now = () => Date.now(), log = () => {}, maxReads = MAX_READS }) {
  const d = ledger.data;
  const store = () => { d.prTruth ||= {}; d.prTruth.prs ||= {}; d.prTruth.reasked ||= {}; return d.prTruth; };

  // One PR's state, or null when GitHub could not be read. Cached briefly so the decision loop stays cheap.
  async function read(repo, number, budget, ttl = TTL_MS) {
    const t = store(), key = prKey(repo, number), cached = t.prs[key];
    if (cached && now() - cached.checkedAt < ttl) return cached;
    if (budget.left <= 0) return null;
    budget.left--;
    let pr;
    try { pr = await api([`repos/${repo}/pulls/${Number(number)}`]); } catch (e) { log(`prtruth: #${number}: ${String(e.message).slice(0, 160)}`); return null; }
    if (!pr || Number(pr.number) !== Number(number) || !pr.state) return null;
    const merged = Boolean(pr.merged || pr.merged_at);
    const rec = { number: Number(number), repo, state: merged ? "merged" : pr.state, merged, head: pr.head?.sha || null, mergedAt: pr.merged_at ? Date.parse(pr.merged_at) : null, mergedBy: pr.merged_by?.login || null, checkedAt: now() };
    t.prs[key] = rec;
    return rec;
  }

  function tell(job, content) {
    if (!job || JOB_TERMINAL.includes(job.state)) return;
    (job.inbox ||= []).push({ authorId: "github-truth", role: "system", at: new Date(now()).toISOString(), content });
    if (!Object.values(d.decisions || {}).some((y) => y.state === "pending" && y.jobId === job.id)) delete job.ownerDecisionPending;
    if (["waiting", "blocked"].includes(job.state)) { job.state = "queued"; job.wakeAt = 0; }
  }

  function settleDecision(x, truth) {
    const job = d.jobs?.[x.jobId], action = x.actionId && d.actions?.[x.actionId], pr = prOfDecision(d, x);
    if (truth.merged) {
      x.state = "withdrawn"; x.withdrawnReason = "merged on GitHub"; x.reconciledAt = now();
      if (action && ["pending", "approved", "executing"].includes(action.state)) { action.state = "done"; action.executedAt = truth.mergedAt || now(); action.reconciledFrom = "github"; }
      ledger.audit("decision_reconciled", { decision: x.id, pr: truth.number, outcome: "merged", by: truth.mergedBy });
      tell(job, `PR #${truth.number} was merged on GitHub${truth.mergedBy ? ` by ${truth.mergedBy}` : ""}. The owner question about it is closed and the merge is done. Do not ask about it again and do not say it is waiting on the owner.`);
      return true;
    }
    if (truth.state === "closed") {
      x.state = "withdrawn"; x.withdrawnReason = "closed on GitHub without merging"; x.reconciledAt = now();
      if (action && ["pending", "approved"].includes(action.state)) action.state = "withdrawn";
      ledger.audit("decision_reconciled", { decision: x.id, pr: truth.number, outcome: "closed" });
      tell(job, `PR #${truth.number} was closed on GitHub without merging. The owner question about it is withdrawn. Do not say it is waiting on the owner.`);
      return true;
    }
    if (pr?.head && truth.head && truth.head !== pr.head) {
      x.state = "withdrawn"; x.withdrawnReason = "new commits on the pull request"; x.reconciledAt = now();
      if (action && action.state === "pending") action.state = "superseded";
      ledger.audit("decision_reconciled", { decision: x.id, pr: truth.number, outcome: "new_head", head: truth.head });
      // Re-ask once per new head, and only through a task that is still alive; an orphaned PR goes to the open-PR pass.
      const t = store(), rk = `${truth.repo}#${truth.number}:${truth.head}`;
      if (!t.reasked[rk] && job && !JOB_TERMINAL.includes(job.state)) {
        t.reasked[rk] = now();
        tell(job, `PR #${truth.number} has new commits since the owner was asked, so that question is withdrawn. If it should still merge, call github merge for it once more; that asks for the new version. Ask once.`);
      }
      return true;
    }
    return false;
  }

  function settleAction(a, truth) {
    if (truth.merged) { a.state = "done"; a.executedAt = a.executedAt || truth.mergedAt || now(); a.reconciledFrom = "github"; ledger.audit("action_reconciled", { action: a.id, pr: truth.number, outcome: "merged" }); return true; }
    if (truth.state === "closed") {
      a.state = a.state === "executing" ? "failed" : "withdrawn"; a.reconciledFrom = "github"; a.error = a.error || "closed on GitHub without merging";
      ledger.audit("action_reconciled", { action: a.id, pr: truth.number, outcome: "closed" }); return true;
    }
    return false;
  }

  async function tick() {
    const budget = { left: maxReads };
    let changed = 0;
    // Pending questions first: they drive reminders, escalations and "waiting on the owner" lines.
    for (const x of Object.values(d.decisions || {})) {
      if (x.state !== "pending") continue;
      const pr = prOfDecision(d, x);
      if (!pr) continue;
      const truth = await read(repoOf(pr.repository), pr.number, budget);
      if (truth && x.state === "pending" && settleDecision(x, truth)) changed++;
    }
    for (const a of Object.values(d.actions || {})) {
      if (!["approved", "executing"].includes(a.state)) continue;
      const pr = prOfAction(a);
      if (pr) {
        const truth = await read(repoOf(pr.repository), pr.number, budget);
        if (truth && ["approved", "executing"].includes(a.state) && settleAction(a, truth)) changed++;
        continue;
      }
      // A publish_patch left executing after its PR reached GitHub (66f1a21d, 86ec347a: 78 hours).
      if (a.kind === "publish_patch" && a.state === "executing" && now() - (a.at || 0) > 30 * 60000 && !a.args?.revise && budget.left > 0) {
        const repo = repoOf(a.args?.repository), branch = `keir/task-${a.jobId}-${a.id}`;
        budget.left--;
        let found;
        try { found = await api([`repos/${repo}/pulls?state=all&head=${repo.split("/")[0]}:${branch}&per_page=5`]); } catch { continue; }
        const pr = Array.isArray(found) ? found.find((p) => p.head?.ref === branch) : null;
        if (!pr) continue;
        a.state = "done"; a.executedAt = now(); a.reconciledFrom = "github"; a.result = { pullRequest: pr.html_url, branch };
        const job = d.jobs?.[a.jobId];
        if (job && !(job.pullRequests || []).includes(pr.html_url)) job.pullRequests = [...(job.pullRequests || []), pr.html_url];
        ledger.audit("action_reconciled", { action: a.id, pr: pr.number, outcome: "published" });
        changed++;
      }
    }
    changed += await waitedPrs();
    const t = store();
    for (const [k, v] of Object.entries(t.prs)) if (now() - v.checkedAt > KEEP_MS) delete t.prs[k];
    for (const [k, at] of Object.entries(t.reasked)) if (now() - at > KEEP_MS) delete t.reasked[k];
    if (changed) ledger.save();
    return { changed, reads: maxReads - budget.left };
  }

  // Keir 11.2: keep PR state fresh for waits, and move review fixes through fix in review, live and reopened.
  async function waitedPrs() {
    const budget = { left: WAIT_READS };
    let changed = 0;
    const prNum = (u) => Number(/\/AHDGame\/pull\/(\d+)\s*$/.exec(String(u || ""))?.[1] || 0);
    for (const job of Object.values(d.jobs || {})) {
      if (budget.left <= 0) break;
      const review = job.reviewItem?.kind === "doc_conflict" && job.reviewItem.source === "ask";
      const terminal = JOB_TERMINAL.includes(job.state);
      // A finished review task is followed only while its fix PR is still open (it can still be closed unmerged).
      if (terminal && !(review && job.reviewFix?.state === "fix_in_review" && now() - (job.updatedAt || job.at || 0) < KEEP_MS)) continue;
      const on = job.closing?.on;
      const waited = on && ["pr", "deploy"].includes(on.kind) && Number.isFinite(on.ref) ? on.ref : null;
      const fixPr = review ? (job.pullRequests || []).map(prNum).filter(Boolean).at(-1) || null : null;
      for (const n of [...new Set([waited, fixPr].filter(Boolean))]) {
        const truth = await read(GAME_REPO, n, budget, WAIT_REFRESH_MS);
        if (truth && n === fixPr && reviewFix(job, truth)) changed++;
      }
    }
    return changed;
  }
  // A review item's fix is "fix in review" until its PR is merged and a deploy receipt shows it live (reviewFixLive, set by
  // github where); a PR closed without merging reopens the item: the task is told, and woken if it had finished.
  function reviewFix(job, truth) {
    const rf = job.reviewFix ||= { pr: truth.number, state: "fix_in_review", at: now() };
    if (rf.pr !== truth.number) { rf.pr = truth.number; rf.state = "fix_in_review"; rf.at = now(); }
    const was = rf.state;
    if (truth.state === "closed" && !truth.merged) {
      if (was === "reopened") return false;
      rf.state = "reopened"; rf.at = now();
      if (job.reviewFixLive?.number === truth.number) delete job.reviewFixLive;
      ledger.audit("review_fix_reopened", { job: job.id, item: job.reviewItem.key, pr: truth.number });
      const content = `Fix PR #${truth.number} for ${job.reviewItem.kind} ${job.reviewItem.id} was closed without merging. The item is open again: it is not fixed. Decide whether a new fix is needed or the doc was right, and do not mark it fixed until a merged fix is live.`;
      (job.inbox ||= []).push({ authorId: "github-truth", role: "system", at: new Date(now()).toISOString(), content });
      if (["waiting", "blocked", "done", "dismissed"].includes(job.state)) { job.state = "queued"; job.wakeAt = 0; if (job.deadline < now()) job.deadline = now() + 24 * 3600000; }
      return true;
    }
    const next = job.reviewFixLive?.number === truth.number ? "live" : truth.merged ? "merged" : "fix_in_review";
    if (was === "fixed" || was === next) return false;
    rf.state = next; rf.at = now();
    return true;
  }

  return { tick, read, reviewFix };
}

// What GitHub last said about the PR an action merges, from the reconcile cache (orphans.js uses it).
function truthForAction(data, a) {
  const pr = prOfAction(a);
  if (!pr) return null;
  return data.prTruth?.prs?.[prKey(repoOf(pr.repository), pr.number)] || null;
}

module.exports = { createPrTruth, truthForAction, repoOf, prKey, TTL_MS };
