"use strict";
// Keir 11.2 (audit 2026-11-21, P1-1, H3, H5): no Keir pull request sits silently.
//
// On 21 Nov 11 of the 21 open AHDGame PRs were Keir's and 8 had no live Keir task behind them: green PRs whose task had
// finished, five red on a missing Conflict of interest section, one red on verify, one conflicting, one superseded by a
// merged fix. 22 branches of closed Keir PRs were left behind. This pass runs hourly and gives every open Keir PR with no
// live owner exactly one of:
//   - its only blocker is Keir's own description (no Conflict of interest section): the description is repaired;
//   - green on every check (only the owner's approval missing): one ask per head, through the normal approval card;
//   - blocked (a red check, a conflict): one plain line to the owner per head and reason;
//   - superseded or stale: the owner is told first that Keir plans to close it and when; it is closed only after that
//     warning and a grace period, with a note on the PR saying why and how to undo it.
// Branches of closed, unmerged Keir PRs are deleted.
//
// Third pass (review B1, B2, M4, M5, m5, m6, M7):
//   - Keir never fights a person. A PR Keir closed that is open again, or a branch Keir deleted that exists again, was a
//     person's decision: Keir records it, tells the owner once, and never acts on that PR or branch again. Every close and
//     delete writes its intent to the ledger before it happens, so a restart or a half-failed write never repeats it
//     blind. A close or delete that keeps failing is given up after two tries and the owner is told once.
//   - "Superseded" needs strong evidence: both PRs say they close the same issue (fixes, closes or resolves; never Refs),
//     that issue is closed, and every file Keir's PR changes is also changed by the merged PR. Anything weaker is a
//     question to the owner, never a close.
//   - Someone else's work is never closed: a commit authored or committed by anyone but Keir, a change made on GitHub, a
//     merge commit, a new head pushed while no Keir task owned the PR, or a comment or review from a person.
//   - A PR red only on custom-rules is never treated as green.
//   - Closes and branch deletions each have their own switch (default off), every action can run in preview, GitHub
//     writes need Keir's own token (KEIR_GITHUB_TOKEN), and everything stops under the kill switch or a pause.
const { JOB_TERMINAL } = require("./machines");
const { GAME_REPO, GITHUB_OWNER } = require("./github");
const { hasDisclosure, withDisclosure } = require("./prdisclosure");
const { referencedIssues } = require("./prhousekeeping");
const controlsLib = require("./controls");
const { listAll, PR_FIELDS, REF_FIELDS } = require("./ghlist");

const KEIR_BRANCH = /^(?:keir\/|fix\/keir-)/;
const STALE_DAYS = 5;
// A PR is never closed before this long after the pass first saw it, nor before this long after the owner was warned.
const GRACE_HOURS = 48;
const MAX_ATTEMPTS = 2;
const LIMITS = Object.freeze({ closes: 3, deletes: 10, asks: 2, notices: 3, repairs: 3, reads: 60 });
const READY = ["verify", "dependency-review"];
const RUN_LIVE = new Set(["queued", "running", "checks", "merge_ready", "to_staging", "to_main", "verifying"]);
const MARK = "<!-- keir:auto -->";
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
    // Keir 11.2: a job that woke quietly and handed its PR over (closing.js) no longer drives it; this pass does.
    const handed = new Set(j.closing?.handedPrs || []);
    for (const u of j.pullRequests || []) if (/\/AHDGame\/pull\//.test(u)) add(prNumber(u), j.id, live && !handed.has(prNumber(u)));
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
function liveWorkerOn(d, ref) { return Object.values(d.codingWorkers?.runs || {}).some((r) => r.branch === ref && RUN_LIVE.has(r.state)); }

// Keir made this PR: a Keir branch, and either keir-bot authored it or Keir's records hold it.
function isKeirPr(pr, d, index = ledgerIndex(d)) {
  const ref = pr?.head?.ref || "";
  if (!KEIR_BRANCH.test(ref) || pr.head?.repo?.full_name && pr.head.repo.full_name !== GAME_REPO) return false;
  if (/^keir\//.test(ref) && String(pr.user?.login || "").toLowerCase() === "keir-bot") return true;
  if (/^fix\/keir-/.test(ref) && workerBranches(d).has(ref)) return true;
  return index.has(Number(pr.number));
}

// A commit that is not Keir's. commits: GitHub's PR commit list. Returns a reason, or null when every commit is Keir's.
// Keir's commits carry Keir's git identity as both author and committer. A coding worker's branch (fix/keir-) also allows
// the worker's identity, taken from the first commit only when that commit's author and committer agree. A commit message
// proves nothing ("Prepared by Keir" survives a cherry-pick or an amend), so it is not read.
function foreignCommit(commits, keirEmail, { worker = false } = {}) {
  if (!Array.isArray(commits) || !commits.length) return "commits unreadable";
  const allowed = new Set([String(keirEmail || "").toLowerCase()].filter(Boolean));
  const first = commits[0]?.commit || {};
  const fa = String(first.author?.email || "").toLowerCase(), fc = String(first.committer?.email || "").toLowerCase();
  if (worker && fa && fa === fc) allowed.add(fa);
  for (const c of commits) {
    const author = String(c.commit?.author?.email || "").toLowerCase();
    const committer = String(c.commit?.committer?.email || "").toLowerCase();
    if (c.committer?.login === "web-flow" || /noreply@github\.com$/.test(committer)) return "a change made on GitHub";
    if ((c.parents || []).length > 1) return "a merge commit";
    if (!allowed.has(author)) return "a commit by someone else";
    if (!allowed.has(committer)) return "a commit rebased or amended by someone else";
  }
  return null;
}

// A comment or review on the PR from a person (not Keir, not a bot). Keir's own comments carry its marker or sign-off,
// which matters when Keir writes under an account a person also uses.
const KEIR_TEXT = /<!-- keir|Closed automatically by Keir|Prepared by Keir/;
function personActivity(comments, reviews) {
  for (const c of [...(comments || []), ...(reviews || [])]) {
    const login = String(c.user?.login || "");
    if (!login || c.user?.type === "Bot" || /\[bot\]$|^keir-bot$|^github-actions$/i.test(login)) continue;
    if (KEIR_TEXT.test(String(c.body || ""))) continue;
    return `${c.pull_request_review_id !== undefined || c.state ? "a review" : "a comment"} by ${login}`;
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

// Issues a PR says it closes (fixes, closes, resolves). "Refs #N" is a partial fix or an umbrella and never counts.
function closingIssues(pr) {
  const text = `${pr?.body || ""}`;
  return new Set([...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+((?:#\d+(?:,\s*)?)+)/gi)].flatMap((m) => [...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1]))));
}

function createKeirPrs({ ledger, api, write, config = {}, now = () => Date.now(), log = () => {}, staleDays = STALE_DAYS, graceHours = GRACE_HOURS, limits = LIMITS, drain = () => {}, controls = controlsLib.DEFAULT_CONTROLS }) {
  const d = ledger.data;
  const STALE_MS = Math.max(1, Number(staleDays) || STALE_DAYS) * 86400000;
  const GRACE_MS = Math.max(0, Number.isFinite(Number(graceHours)) ? Number(graceHours) : GRACE_HOURS) * 3600000;
  // Review N7: with the pass in preview the whole pass works on a copy of its records, so preview never changes what it later
  // does (first-sight grace, orphan clocks, asks). shadow is null when acting.
  let shadow = null;
  const state = () => {
    if (shadow) return shadow;
    d.keirPrs ||= { prs: {}, actions: [] }; d.keirPrs.prs ||= {}; d.keirPrs.actions ||= []; d.keirPrs.branches ||= {}; return d.keirPrs;
  };
  const record = (kind, number, reason, extra = {}) => {
    if (shadow) { preview(`record ${kind}`, `#${number}`, reason); return; }
    const s = state();
    s.actions = [...s.actions, { at: now(), kind, number, reason, ...extra }].slice(-200);
    ledger.audit(`keir_pr_${kind}`, { pr: number, reason, ...extra });
    log(`keirprs: ${kind} #${number}: ${reason}`);
  };
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  let gates = null;
  // What this pass may do right now. A GitHub write also needs Keir's own token: without it the write would go out under
  // the box's default account (the owner's), so it is only previewed.
  function can(kind) {
    const g = kind === "close" ? gates.close : kind === "delete" ? gates.del : gates.pass;
    if (!g.run) return { act: false, why: g.why };
    if (["close", "delete", "repair", "comment"].includes(kind) && g.act && !config.githubReviewerToken) return { act: false, why: "KEIR_GITHUB_TOKEN is not set, so GitHub writes would go out under the owner's account" };
    return g;
  }
  const preview = (action, target, reason, extra) => controlsLib.preview(d, "open-prs", action, target, reason, extra, now());

  // A person reversed one of Keir's actions: never act on it again, tell the owner once.
  function handsOff(rec, why) {
    if (rec.handsOff) return;
    rec.handsOff = { at: now(), why };
    record("reversal", rec.number, why);
  }
  function tellReversal(rec) {
    if (!rec.handsOff || rec.handsOff.toldAt) return;
    const text = `PR #${rec.number}${rec.title ? ` (${rec.title})` : ""}: ${rec.handsOff.why}. Keir takes that as a person's decision and will not close, delete or ask about it again.`;
    if (!can("notice").act) { preview("tell owner", `#${rec.number}`, text); return; }
    ledger.notify(`keir-pr-reversed:${rec.number}`, "owner", text);
    rec.handsOff.toldAt = now();
  }

  async function notice(pr, rec, key, text, budget) {
    if (rec.notices[key]) return false;
    if (!can("notice").act) { preview("owner line", `#${pr.number}:${key}`, text); return false; }
    if (budget.notices <= 0) return false;
    budget.notices--;
    rec.notices[key] = now();
    ledger.notify(`pr-blocked:${pr.number}:${key}`, "owner", text);
    record("owner_notice", pr.number, key);
    return true;
  }

  async function close(pr, rec, reason, comment, budget) {
    if ((rec.closeAttempts || 0) >= MAX_ATTEMPTS) {
      if (!rec.closeGaveUpAt) {
        rec.closeGaveUpAt = now();
        record("close_given_up", pr.number, `${rec.closeAttempts} attempts failed`);
        if (can("notice").act) ledger.notify(`keir-pr-close-failed:${pr.number}`, "owner", `Keir tried ${rec.closeAttempts} times to close PR #${pr.number} (${rec.title}) and GitHub refused each time. It is left open; Keir will not try again.`);
      }
      return false;
    }
    const c = can("close");
    if (!c.act) { preview("close", `#${pr.number}`, `${reason} (not done: ${c.why})`, { title: rec.title }); return false; }
    if (budget.closes <= 0) return false;
    budget.closes--;
    // Intent first, so a restart or a failure between the writes is recognised as Keir's own attempt.
    rec.closeStartedAt = now(); rec.closeAttempts = (rec.closeAttempts || 0) + 1; rec.closeReason = reason;
    ledger.save();
    try {
      // The note goes once per PR: a close that fails after it is retried next pass without a second note.
      if (!rec.closeNoteAt) { await write(["-X", "POST", `repos/${GAME_REPO}/issues/${pr.number}/comments`, "-f", `body=${comment}\n\n${MARK}`]); rec.closeNoteAt = now(); ledger.save(); }
      await write(["-X", "PATCH", `repos/${GAME_REPO}/pulls/${pr.number}`, "-f", "state=closed"]);
    } catch (e) {
      rec.closeFailedAt = now(); rec.closeError = String(e.message).slice(0, 200);
      record("close_failed", pr.number, rec.closeError);
      ledger.save();
      return false;
    }
    rec.closedAt = now(); rec.closedReason = reason; rec.closedHead = pr.head?.sha || null;
    record("closed", pr.number, reason);
    ledger.save();
    await deleteBranch(pr.head.ref, pr.number, pr.head.sha, budget).catch((e) => log(`keirprs: branch ${pr.head.ref}: ${String(e.message).slice(0, 160)}`));
    return true;
  }

  async function deleteBranch(ref, number, sha, budget) {
    if (!KEIR_BRANCH.test(ref)) return false;
    const s = state(), b = s.branches[ref];
    if (b?.handsOff || (b?.attempts || 0) >= MAX_ATTEMPTS) return false;
    if (liveWorkerOn(d, ref)) return false;
    const live = await api([`repos/${GAME_REPO}/git/ref/heads/${ref}`]).catch((e) => (/404|Not Found/i.test(String(e.message)) ? { gone: true } : null));
    if (!live) return false; // unreadable: try later
    if (live.gone) return false;
    if (b?.deletedAt || (b?.deleteStartedAt && !b.failedAt)) { branchRestored(ref, number); return false; }
    if (sha && live.object?.sha && live.object.sha !== sha) { keptOnce(ref, number, live.object.sha, "someone pushed after the PR closed"); return false; }
    const c = can("delete");
    if (!c.act) { preview("delete branch", ref, `its pull request #${number} was closed without merging (not done: ${c.why})`); return false; }
    if (budget.deletes <= 0) return false;
    budget.deletes--;
    const rec = (s.branches[ref] = { pr: number, sha: sha || live.object?.sha || null, deleteStartedAt: now(), attempts: (b?.attempts || 0) + 1 });
    ledger.save();
    try { await write(["-X", "DELETE", `repos/${GAME_REPO}/git/refs/heads/${ref}`]); }
    catch (e) { rec.failedAt = now(); rec.error = String(e.message).slice(0, 200); record("branch_delete_failed", number, rec.error, { branch: ref }); ledger.save(); return false; }
    rec.deletedAt = now();
    record("branch_deleted", number, "its pull request was closed without merging", { branch: ref });
    ledger.save();
    return true;
  }
  function keptOnce(ref, number, sha, why) {
    const s = state(), b = (s.branches[ref] ||= { pr: number });
    if (b.keptSha === sha) return;
    b.keptSha = sha;
    record("branch_kept", number, why, { branch: ref });
  }
  // A branch Keir deleted exists again: a person restored it.
  function branchRestored(ref, number) {
    const s = state(), b = (s.branches[ref] ||= { pr: number });
    if (b.handsOff) return;
    b.handsOff = { at: now(), why: "restored after Keir deleted it" };
    record("reversal", number, `branch ${ref} restored after Keir deleted it`, { branch: ref });
    const rec = number && s.prs[number];
    if (rec) { handsOff(rec, `its branch ${ref} was restored after Keir deleted it`); tellReversal(rec); }
    else if (can("notice").act) ledger.notify(`keir-branch-restored:${ref}`, "owner", `Branch ${ref} (PR #${number}) was restored after Keir deleted it. Keir takes that as a person's decision and will not delete it again.`);
    else preview("tell owner", ref, "branch restored after Keir deleted it");
  }

  // A merged PR that covers the same fix. strong: both close the same issue (fixes, closes, resolves), the issue is closed,
  // and every file Keir's PR changes is changed by the merged PR too. weak: a shared reference of any kind, or the merged
  // PR names Keir's ticket; never enough to close.
  async function supersededBy(pr, merged, index, budget) {
    const mineClose = closingIssues(pr), mineAny = referencedIssues(pr);
    const tickets = new Set([...(index.get(Number(pr.number))?.jobs || [])].map((id) => d.jobs?.[id]?.ticket).filter(Boolean).map(Number));
    const created = Date.parse(pr.created_at || "") || 0;
    let weak = null;
    for (const m of merged) {
      if (Number(m.number) === Number(pr.number) || !m.merged_at || Date.parse(m.merged_at) < created) continue;
      const shared = [...mineClose].filter((n) => closingIssues(m).has(n));
      if (shared.length && budget.reads >= 3) {
        budget.reads -= 3;
        const issue = await api([`repos/${GAME_REPO}/issues/${shared[0]}`]).catch(() => null);
        // Review 3 m4: every page of both file lists (GitHub lists at most 3000 files); an incomplete list compares nothing.
        const files_ = (num) => listAll(api, `repos/${GAME_REPO}/pulls/${num}/files`, { jq: "[.[] | {filename}]", maxPages: 30, key: (f) => f.filename }).catch(() => null);
        const mine = await files_(pr.number);
        const theirs = await files_(m.number);
        const files = Array.isArray(mine) && Array.isArray(theirs) ? { mine: mine.map((f) => f.filename), theirs: new Set(theirs.map((f) => f.filename)) } : null;
        if (issue?.state === "closed" && files && files.mine.length && files.mine.every((f) => files.theirs.has(f))) return { by: m, strength: "strong", why: `both close issue #${shared[0]}, which is closed, and #${m.number} changes every file this PR changes` };
        weak ||= { by: m, strength: "weak", why: `both say they close issue #${shared[0]}, but ${issue?.state !== "closed" ? "that issue is still open" : !files ? "their files could not be compared" : "they change different files"}` };
        continue;
      }
      const any = [...mineAny].find((n) => referencedIssues(m).has(n));
      if (any && !weak) weak = { by: m, strength: "weak", why: `both mention issue #${any}` };
      const text = `${m.title || ""}\n${m.body || ""}`;
      const t = [...tickets].find((x) => new RegExp(`\\btickets?\\s*#?\\s*${x}\\b`, "i").test(text));
      if (t && !weak) weak = { by: m, strength: "weak", why: `#${m.number} names ticket ${t}` };
    }
    return weak;
  }

  // The owner is warned first; the close happens only after the grace period, and never if a person is involved.
  async function warnThenClose(pr, rec, kind, reason, warnText, closeNote, budget) {
    if (rec.personTouched || rec.foreign) return false;
    // With closes off (the default) or in preview, nothing is said to the owner about a close that will not happen.
    const c = can("close");
    if (!c.act) { preview("close", `#${pr.number}`, `${reason} (not done: ${c.why})`, { title: rec.title }); return false; }
    if (now() - (rec.firstSeenAt || now()) < GRACE_MS) return false;
    rec.warned ||= {};
    if (!rec.warned[kind]) {
      const when = day(now() + GRACE_MS);
      const sent = await notice(pr, rec, `will-close:${kind}`, `${warnText} Keir plans to close PR #${pr.number} on ${when} with a note. To keep it, comment on it or tell Keir; a person's comment, push or reopen stops Keir for good.`, budget);
      if (sent) rec.warned[kind] = now();
      return false;
    }
    if (now() - rec.warned[kind] < GRACE_MS) return false;
    // Last check before closing: a person who commented or reviewed since owns the decision.
    if (budget.reads < 2) return false;
    budget.reads -= 2;
    const comments = await api([`repos/${GAME_REPO}/issues/${pr.number}/comments?per_page=100`]).catch(() => null);
    const reviews = await api([`repos/${GAME_REPO}/pulls/${pr.number}/reviews?per_page=100`]).catch(() => null);
    if (!Array.isArray(comments) || !Array.isArray(reviews)) return false; // unreadable: no guess
    const person = personActivity(comments, reviews);
    if (person) { rec.personTouched = person; record("person_activity", pr.number, person); return false; }
    return close(pr, rec, reason, closeNote, budget);
  }

  async function sweepOpen(budget) {
    const index = ledgerIndex(d);
    // Fourth pass: paged, only the fields used, and a list that cannot be read in full stops the sweep (ghlist.js). The open
    // list must be complete; the closed list is a window of the 300 most recently updated (where a superseding merge is).
    const open = await listAll(api, `repos/${GAME_REPO}/pulls?state=open&base=development`, { jq: PR_FIELDS });
    const merged = await listAll(api, `repos/${GAME_REPO}/pulls?state=closed&base=development&sort=updated&direction=desc`, { jq: PR_FIELDS, maxPages: 3, window: true });
    const mergedOnly = merged.filter((p) => p.merged_at);
    const s = state();
    const seen = new Set();
    for (const pr of open) {
      try {
      if (pr.draft || !isKeirPr(pr, d, index)) continue;
      const n = Number(pr.number), head = pr.head?.sha;
      seen.add(n);
      const rec = (s.prs[n] ||= { number: n, firstSeenAt: now(), asked: {}, notices: {} });
      rec.asked ||= {}; rec.notices ||= {};
      rec.title = String(pr.title || "").slice(0, 120); rec.checkedAt = now();
      // B1: Keir closed it and it is open again. If Keir's own close attempt never landed, it is a failed close; otherwise
      // a person reopened it. Read the PR's events when unsure.
      if (!rec.handsOff && (rec.closedAt || rec.closeStartedAt)) {
        let reopened = Boolean(rec.closedAt);
        if (!reopened && rec.closeStartedAt) {
          const events = await api([`repos/${GAME_REPO}/issues/${n}/events?per_page=100`]).catch(() => null);
          if (!Array.isArray(events)) continue; // unsure: do nothing this pass
          reopened = events.some((e) => e.event === "reopened");
        }
        if (reopened) handsOff(rec, "it was reopened after Keir closed it");
      }
      if (rec.handsOff) { tellReversal(rec); rec.head = head; continue; }
      const wasOrphan = Boolean(rec.orphanSince);
      if (index.get(n)?.live) { delete rec.orphanSince; rec.owner = "live task"; rec.head = head; continue; }
      // M4: a new head while no Keir task owned the PR was pushed by someone else.
      if (wasOrphan && rec.head && head && rec.head !== head) { rec.personTouched ||= "new commits pushed while no Keir task owned it"; rec.orphanSince = now(); record("person_activity", n, rec.personTouched, { head }); }
      rec.head = head;
      rec.owner = null;
      rec.orphanSince ||= now();
      if (budget.reads <= 0) break;
      budget.reads -= 3;
      const commits = await api([`repos/${GAME_REPO}/pulls/${n}/commits?per_page=100`]).catch(() => null);
      const foreign = foreignCommit(commits, config.keirGitEmail, { worker: /^fix\/keir-/.test(pr.head?.ref || "") && workerBranches(d).has(pr.head.ref) });
      rec.foreign = foreign;
      const sup = await supersededBy(pr, mergedOnly, index, budget);
      if (sup?.strength === "strong" && !foreign && !rec.personTouched) {
        await warnThenClose(pr, rec, `superseded:${sup.by.number}`, `superseded by #${sup.by.number}`,
          `PR #${n} (${rec.title}) looks superseded by merged PR #${sup.by.number}: ${sup.why}.`,
          `Closing as superseded by #${sup.by.number}: ${sup.why}. Closed automatically by Keir, which opened this PR. If this change is still wanted, reopen the PR; Keir will then leave it alone.`, budget);
        continue;
      }
      // Review N5: a weak match (or someone else's work) never closes and never stops the ask. It changes the ask's wording to
      // the three real choices (merge it, close it as a duplicate, keep it open), and the PR stays owned until one is chosen.
      // It is cleared when the head changes.
      if (rec.supersedeAsk && rec.supersedeHead !== head) { delete rec.supersedeAsk; delete rec.supersedeWhy; }
      if (sup) {
        rec.supersedeAsk = sup.by.number; rec.supersedeWhy = sup.why; rec.supersedeHead = head;
        await notice(pr, rec, `superseded?:${sup.by.number}`, `PR #${n} (${rec.title}) may overlap merged PR #${sup.by.number} (${sup.why}${foreign ? `; it also has ${foreign}` : ""}). Keir will not close it on that alone; it may simply still be wanted. If it is green, Keir asks you to merge it, close it as a duplicate, or keep it open.`, budget);
      }
      const runs = latestByName((await api([`repos/${GAME_REPO}/commits/${head}/check-runs?per_page=100`]).catch(() => null))?.check_runs);
      const full = await api([`repos/${GAME_REPO}/pulls/${n}`]).catch(() => null);
      if (!full || !runs) continue; // unreadable: no guess
      const failed = [...runs.values()].filter((r) => r.status === "completed" && !["success", "neutral", "skipped", "cancelled"].includes(r.conclusion)).map((r) => r.name);
      const running = [...runs.values()].some((r) => r.status !== "completed");
      const readyRest = READY.every((name) => runs.get(name)?.conclusion === "success");
      // Keir's own description is the blocker: repair it once per head, then let the check run again.
      if (failed.includes("custom-rules") && !hasDisclosure(full.body) && !foreign && !rec.personTouched && rec.repairedHead !== head) {
        const c = can("repair");
        if (!c.act) { preview("repair description", `#${n}`, `add the Conflict of interest section custom-rules requires (not done: ${c.why})`); continue; }
        // Review m5: a repair that keeps failing is given up after two tries at a head, with one owner line.
        if ((rec.repairAttempts?.[head] || 0) >= MAX_ATTEMPTS) {
          await notice(pr, rec, `repair-failed:${head}`, `PR #${n} (${rec.title}) is blocked only by its description (no Conflict of interest section), and Keir's ${MAX_ATTEMPTS} tries to add it failed. A person needs to add it.`, budget);
          continue;
        }
        if (budget.repairs > 0) {
          budget.repairs--;
          rec.repairAttempts = { [head]: (rec.repairAttempts?.[head] || 0) + 1 };
          await write(["-X", "PATCH", `repos/${GAME_REPO}/pulls/${n}`, "-f", `body=${withDisclosure(full.body)}`]);
          const red = runs.get("custom-rules");
          if (red?.id) await write(["-X", "POST", `repos/${GAME_REPO}/actions/jobs/${red.id}/rerun`]).catch(() => null);
          rec.repairedHead = head;
          record("description_repaired", n, "added the Conflict of interest section custom-rules requires");
        }
        continue; // repaired now, or next pass when this pass's repairs are used up
      }
      const stale = now() - rec.orphanSince > STALE_MS;
      // M5: green means every check passed, custom-rules included.
      if (!failed.length && !running && readyRest && full.mergeable !== false) {
        // Review 3 m1: the ask is recorded when its job starts. A job that ended without raising any decision about this PR
        // never asked, so the head is asked once more (two tries per head), never claimed as put to the owner.
        const tries = rec.askTries?.[head] || 1, askJob = d.jobs?.[d.seen?.[`keirpr:${n}:${head}${tries > 1 ? `:${tries}` : ""}`]];
        // Review 4 m2: an overlap ask is a choice question with no askKey, so a decision the ask jobs of this head raised
        // counts too.
        const askJobIds = new Set([`keirpr:${n}:${head}`, `keirpr:${n}:${head}:2`].map((k) => d.seen?.[k]).filter(Boolean));
        const raised = Object.values(d.decisions || {}).some((x) => x.askKey === `pr:AHDGame:${n}` || askJobIds.has(x.jobId));
        if (rec.asked[head] && tries < 2 && askJob && JOB_TERMINAL.includes(askJob.state) && !raised) {
          rec.askTries = { [head]: tries + 1 }; delete rec.asked[head];
        }
        if (!rec.asked[head]) {
          const overlap = rec.supersedeAsk ? ` It may overlap merged PR #${rec.supersedeAsk} (${rec.supersedeWhy || "a shared reference"}), or it may simply be ready to merge.` : "";
          if (!can("ask").act) { preview("ask owner", `#${n}`, `green with no live task: one ${overlap ? "merge, close-as-duplicate or keep-open" : "merge"} ask`); continue; }
          if (budget.asks <= 0) continue;
          budget.asks--;
          rec.asked[head] = now();
          const how = overlap
            ? `Read both changes (github pr ${n} and github pr ${rec.supersedeAsk}). Then ask the owner one question with raise_to_developers kind decision and exactly these options: "Merge PR ${n}", "Close PR ${n} as a duplicate of #${rec.supersedeAsk}", "Keep PR ${n} open for now". Say plainly what each PR changes and how they overlap. If he picks merge, call github merge for it (his Approve on that card merges it); if he picks close, close PR ${n} with a one-line note naming #${rec.supersedeAsk}; if he picks keep, finish.`
            : `Read the change (github pr ${n}), then call github merge for it. That sends the owner one approval card with your plain-language explanation; his Approve merges it.`;
          ledger.createJob(`keirpr:${n}:${head}${(rec.askTries?.[head] || 1) > 1 ? `:${rec.askTries[head]}` : ""}`, { kind: "command", role: "support", internalProbe: true, repository: "AHDGame", adoptedPr: n, deadline: now() + (overlap ? 72 : 6) * 3600000,
            source: { at: new Date(now()).toISOString(), content: `Keir's own pull request ${n} ("${rec.title}") is green and no Keir task owns it any more, at head ${head}.${overlap} ${how} Do not post in any channel, do not push to the branch, and do not send him a GitHub link.` } });
          record("ask_opened", n, overlap ? `green with no live task; may overlap #${rec.supersedeAsk}` : "green with no live task", { head });
          drain();
          continue;
        }
        const askedAt = rec.asked[head];
        // Review 4 m2: "put to the owner" only when a question was really raised.
        const put = raised ? `was put to the owner on ${day(askedAt)}` : `has been green with no owner question since ${day(askedAt)}`;
        if (stale && askedAt && now() - askedAt > STALE_MS) await warnThenClose(pr, rec, "stale", `stale: ${raised ? "asked" : "green, never asked"} on ${day(askedAt)} with no answer`,
          `PR #${n} (${rec.title}) ${put} and nobody has carried it forward.`,
          `Closing as stale: this change ${put} and nobody carried it forward for ${Math.round(STALE_MS / 86400000)} days. Closed automatically by Keir, which opened this PR. If it is still wanted, reopen it; Keir will then leave it alone.`, budget);
        continue;
      }
      if (running) continue;
      const why = plainReason(failed, full.mergeable);
      if (stale && !foreign && !rec.personTouched) {
        await warnThenClose(pr, rec, "stale", `stale: blocked (${why.key})`, `PR #${n} (${rec.title}) is blocked: ${why.text}, and no Keir task or person has carried it forward since ${day(rec.orphanSince)}.`,
          `Closing as stale: ${why.text}, and no Keir task or person has carried it forward for ${Math.round((now() - rec.orphanSince) / 86400000)} days. Closed automatically by Keir, which opened this PR. If it is still wanted, reopen it; Keir will then leave it alone.`, budget);
        continue;
      }
      const keepOpen = foreign || rec.personTouched || !can("close").act;
      await notice(pr, rec, `${why.key}:${head}`, `PR #${n} (${rec.title}) is blocked: ${why.text}. No Keir task is working on it.${keepOpen ? "" : ` Keir may close it after ${day(rec.orphanSince + STALE_MS)} if nobody picks it up, and will warn first.`}`, budget);
      } catch (e) { log(`keirprs: #${pr.number}: ${String(e.message).slice(0, 160)}; retried next pass`); }
    }
    // Review N6: what Keir did to a PR, and a person's reversal of it, is kept for as long as the PR can exist (forever, in a
    // compact form): a PR Keir closed that a person reopens weeks later is still recognised and never closed again.
    for (const [n, rec] of Object.entries(s.prs)) {
      if (seen.has(Number(n)) || now() - (rec.checkedAt || 0) <= 14 * 86400000) continue;
      if (rec.handsOff || rec.closedAt || rec.closeStartedAt || rec.personTouched) s.prs[n] = compact(rec);
      else delete s.prs[n];
    }
  }

  // Branches of closed, unmerged Keir PRs. Merged branches are deleted when Keir merges; others are left to their owner.
  async function sweepBranches(budget) {
    const index = ledgerIndex(d);
    const refs = [];
    for (const prefix of ["keir/", "fix/keir-"]) {
      const rows = await listAll(api, `repos/${GAME_REPO}/git/matching-refs/heads/${prefix}`, { jq: REF_FIELDS, maxPages: 20, key: (r) => r.ref });
      refs.push(...rows.map((r) => ({ ref: String(r.ref || "").replace(/^refs\/heads\//, ""), sha: r.object?.sha })));
    }
    const s = state();
    // B1: a branch Keir deleted exists again.
    for (const { ref } of refs) { const b = s.branches[ref]; if (b && !b.handsOff && (b.deletedAt || (b.deleteStartedAt && !b.failedAt))) branchRestored(ref, b.pr); }
    const hist = controlsLib.history(d, "openPrBranches", { controls, now: now(), act: can("delete").act });
    s.branchCursor = (s.branchCursor || 0) % Math.max(1, refs.length);
    const order = [...refs.slice(s.branchCursor), ...refs.slice(0, s.branchCursor)];
    let looked = 0;
    for (const { ref, sha } of order) {
      if (budget.deletes <= 0 || budget.reads <= 0 || looked >= 20) break;
      looked++;
      const b = s.branches[ref];
      if (b?.handsOff || (b?.attempts || 0) >= MAX_ATTEMPTS || liveWorkerOn(d, ref)) continue;
      budget.reads--;
      const prs = await api([`repos/${GAME_REPO}/pulls?state=all&head=${GITHUB_OWNER}:${ref}&per_page=10`]).catch(() => null);
      if (!Array.isArray(prs) || !prs.length) continue;
      if (prs.some((p) => p.state === "open" || p.merged_at)) continue;
      const pr = prs[0];
      if (!isKeirPr(pr, d, index) || index.get(Number(pr.number))?.live || s.prs[pr.number]?.handsOff) continue;
      if (pr.head?.sha && sha && pr.head.sha !== sha) { keptOnce(ref, pr.number, sha, "the branch moved after its PR closed"); continue; }
      const age = hist.check(Date.parse(pr.closed_at || "") || NaN);
      if (age === "too old" || age === "later") continue;
      budget.reads--;
      const foreign = foreignCommit(await api([`repos/${GAME_REPO}/pulls/${pr.number}/commits?per_page=100`]).catch(() => null), config.keirGitEmail, { worker: /^fix\/keir-/.test(ref) && workerBranches(d).has(ref) });
      if (foreign) { keptOnce(ref, pr.number, sha, foreign); continue; }
      await deleteBranch(ref, pr.number, sha, budget);
    }
    s.branchCursor = (s.branchCursor + looked) % Math.max(1, refs.length);
  }

  // A compact record of a PR no longer open: enough to recognise Keir's close and a person's reversal forever.
  function compact(rec) {
    const keep = ["number", "title", "closedAt", "closedHead", "closedReason", "closeStartedAt", "closeAttempts", "closeNoteAt", "handsOff", "personTouched", "firstSeenAt"];
    return { ...Object.fromEntries(keep.filter((k) => rec[k] !== undefined).map((k) => [k, k === "title" ? String(rec[k]).slice(0, 60) : rec[k]])), asked: {}, notices: {}, compact: true, checkedAt: rec.checkedAt };
  }
  async function tick() {
    const budget = { ...LIMITS, ...limits };
    gates = { pass: controls.gate("openPrPass"), close: controls.gate("openPrCloses", { destructive: true }), del: controls.gate("openPrBranchDeletes", { destructive: true }) };
    if (!gates.pass.run) { log(`keirprs: not run: ${gates.pass.why}`); return { ...budget, skipped: gates.pass.why }; }
    shadow = gates.pass.act ? null : JSON.parse(JSON.stringify({ prs: {}, actions: [], branches: {}, ...(d.keirPrs || {}) }));
    // The close and delete switches sit inside the pass (review 3 F5): they act only when the pass acts and they do. A pass
    // in preview previews closes and deletes whatever their own switches say; with the pass on and closes off, closes are
    // previewed.
    gates.close = controlsLib.nestedGate(gates.pass, gates.close);
    gates.del = controlsLib.nestedGate(gates.pass, gates.del);
    // A list that could not be read in full is "could not read, did nothing": logged, audited and returned (the preview
    // report prints it), never treated as an empty list.
    const unread = [];
    try { await sweepOpen(budget); } catch (e) { unread.push(`open sweep: ${String(e.message).slice(0, 200)}`); log(`keirprs: open sweep skipped, could not read, did nothing: ${String(e.message).slice(0, 200)}`); }
    try { await sweepBranches(budget); } catch (e) { unread.push(`branch sweep: ${String(e.message).slice(0, 200)}`); log(`keirprs: branch sweep skipped, could not read, did nothing: ${String(e.message).slice(0, 200)}`); }
    if (unread.length && gates.pass.act) ledger.audit("keir_pr_list_unread", { unread });
    budget.unread = unread;
    state().lastSweepAt = now();
    if (!shadow) ledger.save();
    return budget;
  }
  return { tick };
}

module.exports = { createKeirPrs, isKeirPr, foreignCommit, personActivity, closingIssues, ledgerIndex, plainReason, KEIR_BRANCH, STALE_DAYS, GRACE_HOURS, LIMITS, MARK };
