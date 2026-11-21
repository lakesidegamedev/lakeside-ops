"use strict";
// Keir 11.2 (audit 2026-11-21, P1-1, H3, H5): no Keir pull request sits silently.
//
// On 21 Nov 11 of the 21 open AHDGame PRs were Keir's and 8 had no live Keir task behind them: green PRs whose task had
// finished, five red on a missing Conflict of interest section, one red on verify, one conflicting, one superseded by a
// merged fix. 22 branches of closed Keir PRs were left behind. This pass runs hourly and gives every open Keir PR with no
// live owner exactly one of:
//   - superseded by a merged PR for the same issue or ticket: closed with a note, branch deleted;
//   - its only blocker is Keir's own description (no Conflict of interest section): the description is repaired;
//   - green (only the owner's approval missing): one ask per head, through the normal approval card;
//   - blocked (red check, conflict): one plain line to the owner per head and reason;
//   - still sitting after KEIR_STALE_PR_DAYS with no owner: closed as stale with a note, branch deleted.
// Branches of closed, unmerged Keir PRs are deleted.
//
// Safety: only PRs Keir created (a keir/ branch by keir-bot, or a fix/keir- branch of a recorded coding worker run, or a
// PR recorded in Keir's ledger on a Keir branch) are ever touched, and a PR or branch with a commit from anyone else, or a
// web edit or base merge made on GitHub, is never closed or deleted. Every write is logged with its reason, bounded per
// pass, and recorded so it is not repeated. If GitHub cannot be read the pass does nothing and tries again next hour.
const { JOB_TERMINAL } = require("./machines");
const { GAME_REPO, GITHUB_OWNER } = require("./github");
const { hasDisclosure, withDisclosure } = require("./prdisclosure");
const { referencedIssues } = require("./prhousekeeping");

const KEIR_BRANCH = /^(?:keir\/|fix\/keir-)/;
const STALE_DAYS = 5;
const LIMITS = Object.freeze({ closes: 3, deletes: 10, asks: 2, notices: 3, repairs: 3, reads: 60 });
const READY = ["verify", "dependency-review"];
const RUN_LIVE = new Set(["queued", "running", "checks", "merge_ready", "to_staging", "to_main", "verifying"]);
function latestByName(runs) {
  const out = new Map();
  for (const r of runs || []) { const prior = out.get(r.name); if (!prior || String(r.started_at || "") >= String(prior.started_at || "")) out.set(r.name, r); }
  return out;
}
const prNumber = (url) => Number(/\/pull\/(\d+)\s*$/.exec(String(url || ""))?.[1] || 0);

// PR numbers Keir's ledger knows it opened, and which of them a live Keir task or worker still owns.
function ledgerIndex(d) {
  const known = new Map(); // number -> { jobs: Set, live: bool, branch }
  const add = (n, jobId, live, branch = null) => {
    if (!n) return;
    const e = known.get(n) || { jobs: new Set(), live: false, branch: null };
    if (jobId) e.jobs.add(jobId);
    e.live ||= Boolean(live); e.branch ||= branch;
    known.set(n, e);
  };
  for (const j of Object.values(d.jobs || {})) {
    const live = !JOB_TERMINAL.includes(j.state);
    for (const u of j.pullRequests || []) if (/\/AHDGame\/pull\//.test(u)) add(prNumber(u), j.id, live);
    for (const n of [j.ownerWaitPr, j.adoptedPr]) if (n && live) add(Number(n), j.id, true);
  }
  for (const a of Object.values(d.actions || {})) if (a.kind === "publish_patch" && a.result?.pullRequest) add(prNumber(a.result.pullRequest), a.jobId, false, a.result.branch);
  for (const r of Object.values(d.codingWorkers?.runs || {})) if (r.pr) add(Number(r.pr), r.jobId || null, RUN_LIVE.has(r.state), r.branch);
  for (const x of Object.values(d.decisions || {})) {
    if (x.state !== "pending") continue;
    const m = /^pr:AHDGame:(\d+)$/.exec(x.askKey || "");
    if (m) add(Number(m[1]), x.jobId, true);
  }
  return known;
}
function workerBranches(d) { return new Set(Object.values(d.codingWorkers?.runs || {}).map((r) => r.branch).filter(Boolean)); }

// Keir made this PR: a Keir branch, and either keir-bot authored it or Keir's records hold it.
function isKeirPr(pr, d, index = ledgerIndex(d)) {
  const ref = pr?.head?.ref || "";
  if (!KEIR_BRANCH.test(ref) || pr.head?.repo?.full_name && pr.head.repo.full_name !== GAME_REPO) return false;
  if (/^keir\//.test(ref) && String(pr.user?.login || "").toLowerCase() === "keir-bot") return true;
  if (/^fix\/keir-/.test(ref) && workerBranches(d).has(ref)) return true;
  return index.has(Number(pr.number));
}

// A commit that is not Keir's: another author, or a change made on GitHub's web (edit, update branch, merge base).
// commits: GitHub's PR commit list. Returns a reason, or null when every commit is Keir's.
function foreignCommit(commits, keirEmail) {
  if (!Array.isArray(commits) || !commits.length) return "commits unreadable";
  const first = commits[0]?.commit?.author?.email || "";
  const allowed = new Set([String(keirEmail || "").toLowerCase(), first.toLowerCase()].filter(Boolean));
  for (const c of commits) {
    const author = String(c.commit?.author?.email || "").toLowerCase();
    const committer = String(c.commit?.committer?.email || "").toLowerCase();
    if (c.committer?.login === "web-flow" || /noreply@github\.com$/.test(committer)) return "a change made on GitHub";
    if ((c.parents || []).length > 1) return "a merge commit";
    if (!/Prepared by Keir/.test(c.commit?.message || "") && !allowed.has(author)) return "a commit by someone else";
  }
  return null;
}

function plainReason(failed, mergeable) {
  if (failed.includes("merge")) return { key: "refused", text: "GitHub refused the merge" };
  if (mergeable === false) return { key: "conflict", text: "it conflicts with newer changes and needs rebasing" };
  if (failed.includes("verify")) return { key: "verify", text: "the build and test check failed" };
  if (failed.includes("custom-rules")) return { key: "custom-rules", text: "the description check failed" };
  if (failed.includes("dependency-review")) return { key: "dependency-review", text: "the dependency check failed" };
  return { key: failed[0] || "unknown", text: `the ${failed[0] || "required"} check failed` };
}

function createKeirPrs({ ledger, api, write, config = {}, now = () => Date.now(), log = () => {}, staleDays = STALE_DAYS, limits = LIMITS, drain = () => {} }) {
  const d = ledger.data;
  const STALE_MS = Math.max(1, Number(staleDays) || STALE_DAYS) * 86400000;
  const state = () => { d.keirPrs ||= { prs: {}, actions: [] }; d.keirPrs.prs ||= {}; d.keirPrs.actions ||= []; return d.keirPrs; };
  const record = (kind, number, reason, extra = {}) => {
    const s = state();
    s.actions = [...s.actions, { at: now(), kind, number, reason, ...extra }].slice(-200);
    ledger.audit(`keir_pr_${kind}`, { pr: number, reason, ...extra });
    log(`keirprs: ${kind} #${number}: ${reason}`);
  };

  async function close(pr, rec, reason, comment, budget) {
    if (budget.closes <= 0) return false;
    budget.closes--;
    // The note goes once per PR: a close that fails after it is retried next pass without a second note.
    if (!rec.closeNoteAt) { await write(["-X", "POST", `repos/${GAME_REPO}/issues/${pr.number}/comments`, "-f", `body=${comment}`]); rec.closeNoteAt = now(); ledger.save(); }
    await write(["-X", "PATCH", `repos/${GAME_REPO}/pulls/${pr.number}`, "-f", "state=closed"]);
    rec.closedAt = now(); rec.closedReason = reason;
    record("closed", pr.number, reason);
    await deleteBranch(pr.head.ref, pr.number, pr.head.sha, budget).catch((e) => log(`keirprs: branch ${pr.head.ref}: ${String(e.message).slice(0, 160)}`));
    return true;
  }
  async function deleteBranch(ref, number, sha, budget) {
    if (budget.deletes <= 0 || !KEIR_BRANCH.test(ref)) return false;
    const live = await api([`repos/${GAME_REPO}/git/ref/heads/${ref}`]).catch((e) => (/404|Not Found/i.test(String(e.message)) ? { gone: true } : null));
    if (!live) return false; // unreadable: try later
    if (live.gone) return false;
    if (sha && live.object?.sha && live.object.sha !== sha) { record("branch_kept", number, "someone pushed after the PR closed", { branch: ref }); return false; }
    budget.deletes--;
    await write(["-X", "DELETE", `repos/${GAME_REPO}/git/refs/heads/${ref}`]);
    record("branch_deleted", number, "its pull request was closed without merging", { branch: ref });
    return true;
  }

  // A merged PR that covers the same fix: it shares a referenced issue, or names the same ticket as Keir's task.
  function supersededBy(pr, merged, index) {
    const mine = referencedIssues(pr);
    const tickets = new Set([...(index.get(Number(pr.number))?.jobs || [])].map((id) => d.jobs?.[id]?.ticket).filter(Boolean).map(Number));
    const created = Date.parse(pr.created_at || "") || 0;
    for (const m of merged) {
      if (Number(m.number) === Number(pr.number) || !m.merged_at || Date.parse(m.merged_at) < created) continue;
      const theirs = referencedIssues(m);
      if ([...mine].some((n) => theirs.has(n))) return m;
      const text = `${m.title || ""}\n${m.body || ""}`;
      if ([...tickets].some((t) => new RegExp(`\\btickets?\\s*#?\\s*${t}\\b`, "i").test(text))) return m;
    }
    return null;
  }

  async function sweepOpen(budget) {
    const index = ledgerIndex(d);
    const open = await api([`repos/${GAME_REPO}/pulls?state=open&base=development&per_page=100`]);
    if (!Array.isArray(open)) throw new Error("open pull requests unreadable");
    const merged = await api([`repos/${GAME_REPO}/pulls?state=closed&base=development&sort=updated&direction=desc&per_page=100`]);
    if (!Array.isArray(merged)) throw new Error("closed pull requests unreadable");
    const mergedOnly = merged.filter((p) => p.merged_at);
    const s = state();
    const seen = new Set();
    for (const pr of open) {
      try {
      if (pr.draft || !isKeirPr(pr, d, index)) continue;
      const n = Number(pr.number), head = pr.head?.sha;
      seen.add(n);
      const rec = (s.prs[n] ||= { number: n, firstSeenAt: now(), asked: {}, notices: {} });
      rec.title = String(pr.title || "").slice(0, 120); rec.head = head; rec.checkedAt = now();
      if (index.get(n)?.live) { delete rec.orphanSince; rec.owner = "live task"; continue; }
      rec.owner = null;
      rec.orphanSince ||= now();
      if (budget.reads <= 0) break;
      budget.reads -= 3;
      const commits = await api([`repos/${GAME_REPO}/pulls/${n}/commits?per_page=100`]).catch(() => null);
      const foreign = foreignCommit(commits, config.keirGitEmail);
      rec.foreign = foreign;
      const by = supersededBy(pr, mergedOnly, index);
      if (by) {
        if (foreign) { await notice(pr, rec, `superseded:${by.number}`, `PR #${n} (${rec.title}) looks superseded by merged PR #${by.number}, but it has ${foreign}, so Keir left it open. Close it if it is no longer needed.`, budget); continue; }
        await close(pr, rec, `superseded by #${by.number}`, `Closing as superseded: #${by.number} is merged and covers the same fix. Closed automatically by Keir, which opened this PR.`, budget);
        continue;
      }
      const runs = latestByName((await api([`repos/${GAME_REPO}/commits/${head}/check-runs?per_page=100`]).catch(() => null))?.check_runs);
      const full = await api([`repos/${GAME_REPO}/pulls/${n}`]).catch(() => null);
      if (!full || !runs) continue; // unreadable: no guess
      const failed = [...runs.values()].filter((r) => r.status === "completed" && !["success", "neutral", "skipped", "cancelled"].includes(r.conclusion)).map((r) => r.name);
      const running = [...runs.values()].some((r) => r.status !== "completed");
      const readyRest = READY.every((name) => runs.get(name)?.conclusion === "success");
      // Keir's own description is the blocker: repair it once per head, then let the check run again.
      if (failed.includes("custom-rules") && !hasDisclosure(full.body) && !foreign && rec.repairedHead !== head && budget.repairs > 0) {
        budget.repairs--;
        await write(["-X", "PATCH", `repos/${GAME_REPO}/pulls/${n}`, "-f", `body=${withDisclosure(full.body)}`]);
        const red = runs.get("custom-rules");
        if (red?.id) await write(["-X", "POST", `repos/${GAME_REPO}/actions/jobs/${red.id}/rerun`]).catch(() => null);
        rec.repairedHead = head;
        record("description_repaired", n, "added the Conflict of interest section custom-rules requires");
        continue;
      }
      const otherRed = failed.filter((name) => name !== "custom-rules");
      const stale = now() - rec.orphanSince > STALE_MS;
      if (!otherRed.length && !running && readyRest && full.mergeable !== false) {
        if (!rec.asked[head]) {
          if (budget.asks <= 0) continue;
          budget.asks--;
          rec.asked[head] = now();
          ledger.createJob(`keirpr:${n}:${head}`, { kind: "command", role: "support", internalProbe: true, repository: "AHDGame", adoptedPr: n, deadline: now() + 6 * 3600000,
            source: { at: new Date(now()).toISOString(), content: `Keir's own pull request ${n} ("${rec.title}") is green and no Keir task owns it any more, at head ${head}. Read the change (github pr ${n}), then call github merge for it. That sends the owner one approval card with your plain-language explanation; his Approve merges it. Do not post in any channel, do not push to the branch, and do not send him a GitHub link.` } });
          record("ask_opened", n, "green with no live task", { head });
          drain();
          continue;
        }
        if (stale && !foreign && now() - rec.asked[head] > STALE_MS) await close(pr, rec, `stale: asked on ${new Date(rec.asked[head]).toISOString().slice(0, 10)} with no answer`, `Closing as stale: this change was put to the owner and nobody carried it forward for ${Math.round(STALE_MS / 86400000)} days. Closed automatically by Keir, which opened this PR; it can be reopened if still wanted.`, budget);
        continue;
      }
      if (running) continue;
      const why = plainReason(otherRed.length ? otherRed : failed, full.mergeable);
      if (stale && !foreign) {
        await close(pr, rec, `stale: blocked (${why.key})`, `Closing as stale: ${why.text}, and no Keir task or person has carried it forward for ${Math.round((now() - rec.orphanSince) / 86400000)} days. Closed automatically by Keir, which opened this PR; it can be reopened if still wanted.`, budget);
        continue;
      }
      const closes = new Date(rec.orphanSince + STALE_MS).toISOString().slice(0, 10);
      await notice(pr, rec, `${why.key}:${head}`, `PR #${n} (${rec.title}) is blocked: ${why.text}. No Keir task is working on it.${foreign ? "" : ` Keir will close it on ${closes} unless someone picks it up.`}`, budget);
      } catch (e) { log(`keirprs: #${pr.number}: ${String(e.message).slice(0, 160)}; retried next pass`); }
    }
    for (const [n, rec] of Object.entries(s.prs)) if (!seen.has(Number(n)) && now() - (rec.checkedAt || 0) > 14 * 86400000) delete s.prs[n];
  }

  async function notice(pr, rec, key, text, budget) {
    if (rec.notices[key] || budget.notices <= 0) return false;
    budget.notices--;
    rec.notices[key] = now();
    ledger.notify(`pr-blocked:${pr.number}:${key}`, "owner", text);
    record("owner_notice", pr.number, key);
    return true;
  }

  // Branches of closed, unmerged Keir PRs. Merged branches are deleted when Keir merges; others are left to their owner.
  async function sweepBranches(budget) {
    const index = ledgerIndex(d);
    const refs = [];
    for (const prefix of ["keir/", "fix/keir-"]) {
      const rows = await api([`repos/${GAME_REPO}/git/matching-refs/heads/${prefix}?per_page=100`]);
      if (!Array.isArray(rows)) throw new Error("branches unreadable");
      refs.push(...rows.map((r) => ({ ref: String(r.ref || "").replace(/^refs\/heads\//, ""), sha: r.object?.sha })));
    }
    const s = state();
    s.branchCursor = (s.branchCursor || 0) % Math.max(1, refs.length);
    const order = [...refs.slice(s.branchCursor), ...refs.slice(0, s.branchCursor)];
    let looked = 0;
    for (const { ref, sha } of order) {
      if (budget.deletes <= 0 || budget.reads <= 0 || looked >= 20) break;
      looked++; budget.reads--;
      const prs = await api([`repos/${GAME_REPO}/pulls?state=all&head=${GITHUB_OWNER}:${ref}&per_page=10`]).catch(() => null);
      if (!Array.isArray(prs) || !prs.length) continue;
      if (prs.some((p) => p.state === "open" || p.merged_at)) continue;
      const pr = prs[0];
      if (!isKeirPr(pr, d, index)) continue;
      if (pr.head?.sha && sha && pr.head.sha !== sha) { record("branch_kept", pr.number, "the branch moved after its PR closed", { branch: ref }); continue; }
      budget.reads--;
      const foreign = foreignCommit(await api([`repos/${GAME_REPO}/pulls/${pr.number}/commits?per_page=100`]).catch(() => null), config.keirGitEmail);
      if (foreign) { continue; }
      budget.deletes--;
      await write(["-X", "DELETE", `repos/${GAME_REPO}/git/refs/heads/${ref}`]);
      record("branch_deleted", pr.number, "its pull request was closed without merging", { branch: ref });
    }
    s.branchCursor = (s.branchCursor + looked) % Math.max(1, refs.length);
  }

  async function tick() {
    const budget = { ...LIMITS, ...limits };
    try { await sweepOpen(budget); } catch (e) { log(`keirprs: open sweep skipped: ${String(e.message).slice(0, 200)}`); }
    try { await sweepBranches(budget); } catch (e) { log(`keirprs: branch sweep skipped: ${String(e.message).slice(0, 200)}`); }
    state().lastSweepAt = now();
    ledger.save();
    return budget;
  }
  return { tick };
}

module.exports = { createKeirPrs, isKeirPr, foreignCommit, ledgerIndex, plainReason, KEIR_BRANCH, STALE_DAYS, LIMITS };
