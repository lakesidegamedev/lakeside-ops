"use strict";
const { GAME_REPO, CI_REPOSITORIES, canonicalRepository, redChecks } = require("./github");
// Polls GitHub for tasks waiting on a PR's checks (github watch) and wakes the
// task when checks finish, fail, or an identical promotion is qualified. No model
// runs while waiting: CI polling cost about 80 Opus minutes on one ticket
// overnight on 2026-10-12.
const MAX_WATCH_MS = 3 * 3600000;
// A watch whose PR cannot be read (wrong repository, deleted PR, revoked
// access) used to retry forever: the deadline only applied to readable
// results. Five consecutive failures, or the normal deadline, end it.
const MAX_WATCH_ERRORS = 5;
const { promotionQualification } = require("./qualification");

function createCiWatch({ ledger, api, now = () => Date.now(), log = () => {}, onWaiting = async () => {} }) {
  async function verdict(number, repository = GAME_REPO) {
    repository = canonicalRepository(repository);
    if (!CI_REPOSITORIES.includes(repository)) throw new Error("Unknown CI watch repository");
    const pr = await api([`repos/${repository}/pulls/${number}`]);
    if (pr.merged || pr.state === "closed") return { done: true, text: `PR #${number} is ${pr.merged ? "merged" : "closed"}.` };
    const runs = (await api([`repos/${repository}/commits/${pr.head.sha}/check-runs?per_page=100`])).check_runs || [];
    const red = redChecks(runs).map((r) => r.name);
    if (red.length) return { done: true, text: `CI failed (${red.slice(0, 6).join(", ")}) on PR #${number}. Use github ci_failures; unrelated checks may still be running.` };
    const qualification = await promotionQualification({ api, pr, runs, repository });
    if (qualification.qualified) return { done: true, text: `PR #${number} is qualified by the identical tested staging tree (run ${qualification.run}); duplicate analysis need not delay promotion. Check mergeability and deployment health.` };
    if (!runs.length || runs.some((r) => r.status !== "completed")) return { done: false, queued: runs.filter(r => r.status === "queued").length, running: runs.filter(r => r.status === "in_progress").length, head: pr.head.sha, base: pr.base?.ref || null };
    return { done: true, text: `CI finished on PR #${number}: all ${runs.length} checks green.` };
  }
  async function tick() {
    // Several ticket attempts can subscribe to one promotion. Share only
    // within this tick so the next poll always observes the current head.
    const verdicts = new Map();
    for (const job of Object.values(ledger.data.jobs)) {
      if (!job.ciWatch || ["done", "dismissed", "cancelled"].includes(job.state)) { if (job.ciWatch && ["done", "dismissed", "cancelled"].includes(job.state)) { delete job.ciWatch; ledger.save(); } continue; }
      for (const [number, w] of Object.entries(job.ciWatch)) {
        let v;
        try {
          const key = `${canonicalRepository(w.repository || GAME_REPO)}:${Number(number)}`;
          if (!verdicts.has(key)) verdicts.set(key, verdict(Number(number), w.repository));
          v = await verdicts.get(key); w.errors = 0;
        }
        catch (e) {
          log(`ciwatch ${number}: ${e.message}`);
          w.errors = (w.errors || 0) + 1;
          if (w.errors < MAX_WATCH_ERRORS && now() - w.since < MAX_WATCH_MS) { ledger.save(); continue; }
          v = { done: true, text: `The CI watch on PR #${number} (${canonicalRepository(w.repository || GAME_REPO)}) could not read the PR ${w.errors} times in a row (${String(e.message).slice(0, 160)}). The number or repository is probably wrong; check it with github status, passing repository if the PR is in the other repo.` };
        }
        if (!v.done && now() - w.since < MAX_WATCH_MS) {
          if (now() - w.since >= 10 * 60000) try { await onWaiting(job, { number: Number(number), repository: canonicalRepository(w.repository || GAME_REPO), since: w.since, ...v }); } catch (e) { log(`ciwait ${number}: ${e.message}`); }
          continue;
        }
        const text = v.done ? v.text : `PR #${number}'s checks are still running after 3 hours; look at it.`;
        (job.inbox ||= []).push({ authorId: "ci-watch", role: "system", content: text, at: new Date(now()).toISOString() });
        delete job.ciWatch[number];
        if (!Object.keys(job.ciWatch).length) delete job.ciWatch;
        if (["waiting", "blocked"].includes(job.state)) { job.state = "queued"; job.wakeAt = 0; }
        ledger.audit("ci_watch_done", { job: job.id, number: Number(number) });
        ledger.save();
      }
    }
  }
  return { tick };
}
module.exports = { createCiWatch, MAX_WATCH_MS, MAX_WATCH_ERRORS };
