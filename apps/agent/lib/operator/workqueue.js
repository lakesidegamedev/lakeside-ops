"use strict";
// Work visibility is a projection. A scheduled check is never a delivery ETA.
const crypto = require("node:crypto");
const { rootJob, ticketOf } = require("./workrecord");
const { parkedOnHandoffs } = require("./developerwatch");
const CLOSED = new Set(["done", "dismissed", "cancelled"]);
const clip = (s, n = 240) => String(s || "").slice(0, n);
const timestamp = n => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
function family(data, job) { return Object.values(data.jobs || {}).filter(j => rootJob(j, data.jobs).id === job.id); }
function held(data, job, config, now = Date.now()) {
  const automatic = job.role !== "owner" && !["command", "conversation"].includes(job.kind);
  return automatic && (data.channels?.[job.channelId]?.claimedBy || config.supportDeferred?.(job) || job.staffActiveUntil > now);
}
function workStatus(data, job, { now = Date.now(), config = {} } = {}) {
  const members = family(data, job), live = members.filter(j => !CLOSED.has(j.state));
  const ids = new Set(members.map(j => j.id));
  const origin = require("./ownermuse-policy").origin(data, job);
  const decisions = Object.values(data.decisions || {}).filter(d => ids.has(d.jobId) && d.state === "pending");
  const questions = Object.values(data.appThread?.questions || {}).filter(q => ids.has(q.jobId) && q.state === "pending");
  const uncertain = live.filter(j => j.state !== "running").some(j => Object.values(j.effects || {}).some(e => ["started", "executing", "uncertain"].includes(e.state))) || Object.values(data.actions || {}).some(a => ids.has(a.jobId) && data.jobs[a.jobId]?.state !== "running" && ["executing", "uncertain"].includes(a.state));
  const orphanApproval = Object.values(data.actions || {}).some(a => ids.has(a.jobId) && a.state === "pending") && !decisions.length;
  const worker = live.find(j => j.state === "running");
  const waiting = live.find(j => j.state === "waiting") || job;
  const hold = held(data, job, config, now);
  let state = CLOSED.has(job.state) ? "finished" : hold ? "held" : worker ? "working" : job.state === "blocked" ? "stuck" : job.state === "queued" ? "queued" : "waiting";
  let reason = clip(worker?.liveLog?.at(-1)?.what || worker?.summary || job.summary) || "No next milestone recorded.";
  let next = worker ? "Keir will record the next result." : "Keir must record the next milestone.";
  if (hold) { reason = "Another person or agent owns the next move."; next = "Waiting for the current owner; Keir will preserve the claim."; }
  else if (uncertain) { state = "stuck"; reason = "An earlier action has an unverified outcome."; next = "Verify its receipt before any retry."; }
  else if (origin.scoped && !origin.valid && !CLOSED.has(job.state)) { state = "stuck"; reason = "The saved request needs an authenticated restart."; next = "Open the task to restart from its saved evidence."; }
  else if (decisions.length || questions.length) { state = "needs-you"; reason = clip(decisions[0]?.question || questions[0]?.title); next = "Open the task or ticket to answer the pending decision."; }
  else if (orphanApproval) { state = "stuck"; reason = "An action is pending without a reviewable decision."; next = "Keir must reconcile the approval request and its original authority."; }
  else if (!worker && !CLOSED.has(job.state) && (job.ownerDecisionPending || job.recoveryReviewRequired)) { state = "stuck"; reason = "Keir must review this hold; no owner approval is pending."; next = "Recover the original instruction and establish the exact next action before asking for approval."; }
  else if (live.some(j => Object.keys(j.ciWatch || {}).length)) { reason = "Waiting for repository checks."; next = "Recheck the current PR head and act on its result."; }
  else if (waiting.waitingFor) { reason = `Waiting for ${clip(waiting.waitingFor.kind || "an external update", 80)}.`; next = clip(waiting.summary) || "Check the dependency at the next scheduled wakeup."; }
  else if (live.some(j => j.codingParent) && !worker) { reason = "Waiting for delegated work."; next = "Incorporate the worker's result before continuing."; }
  const checkAt = live.filter(j => j.state === "waiting").map(j => timestamp(j.wakeAt)).filter(Boolean).sort((a,b) => a-b)[0] || null;
  const since = timestamp(job.waitReview?.since) || timestamp(job.updatedAt) || timestamp(job.at);
  const reviewAt = timestamp(job.waitReview?.reviewAt);
  const forecast = !CLOSED.has(job.state) && job.completionForecast?.kind === "worker-estimate" && timestamp(job.completionForecast.at) && timestamp(job.completionForecast.expectedAt) ? job.completionForecast : null;
  // Overdue is shown to the owner, so it must mean Keir is late, not that a
  // player has not answered yet. Keir's own review timer still nudges Keir.
  const onPlayer = state === "waiting" && ["player_reply", "player"].includes(String(waiting.waitingFor?.kind || ""));
  const overdue = !CLOSED.has(job.state) && !onPlayer && (Boolean(reviewAt && now >= reviewAt) || Boolean(forecast && now > forecast.expectedAt) || state === "stuck" || (state === "waiting" && (!checkAt || now > checkAt + 120000)));
  const step = (job.plan || []).find(p => p.status === "running") || (job.plan || []).find(p => p.status !== "done");
  return { state, reason, next, milestone: clip(step?.title || data.statusCards?.[ticketOf(job)]?.status || reason),
    owner: hold ? "Current ticket owner" : "Keir", since, ageMs: since ? Math.max(0, now - since) : null,
    nextCheckAt: checkAt, reviewAt, deadline: timestamp(job.deadline), overdue,
    expectedDoneAt: forecast?.expectedAt || null, etaLabel: CLOSED.has(job.state) ? "Task finished" : forecast ? "Keir task estimate, not a guaranteed delivery time" : "Completion time not established", estimateBasis: forecast?.basis || null, estimateAt: forecast?.at || null, uncertain,
    activeWorkers: live.filter(j => j.state === "running").length };
}
function progressKey(job) {
  return crypto.createHash("sha256").update(JSON.stringify([
    Object.entries(job.effects || {}).filter(([,e]) => e.state === "done").map(([k]) => k).sort(),
    (job.plan || []).map(p => p.status === "done"), job.resolutionSubmittedAt || null,
  ])).digest("hex").slice(0,16);
}
function reviewWaits(ledger, config = {}, now = Date.now()) {
  const changed = [];
  for (const job of Object.values(ledger.data.jobs || {})) {
    if (job.codingParent || job.internalProbe || job.benchmark || job.appWatch || !["waiting", "blocked", "deferred"].includes(job.state)) continue;
    const key = progressKey(job);
    if (!job.waitReview || job.waitReview.progress !== key) {
      const since = Math.min(now, timestamp(job.updatedAt) || timestamp(job.at) || now);
      job.waitReview = { since, reviewAt: since + 3600000, progress: key }; changed.push(job.id);
    }
    if (timestamp(job.completionForecast?.expectedAt)) job.waitReview.reviewAt = Math.min(job.waitReview.reviewAt, job.completionForecast.expectedAt + 5 * 60000);
    // An external reply already has a bounded safety check. The hourly
    // diagnostic must not replace it, including after a status receipt changes
    // the progress key. Human messages still wake through the normal inbox.
    const replyDeadline = ["player_reply", "developer_reply"].includes(job.waitingFor?.kind) && timestamp(job.waitingFor.deadline);
    if (replyDeadline && now < replyDeadline) continue;
    if (now < job.waitReview.reviewAt || job.waitReview.notifiedAt) continue;
    job.waitReview.notifiedAt = now;
    const status = workStatus(ledger.data, job, { now, config });
    // Only a safe waiting task gets one diagnostic wake per progress change.
    // Claims, decisions and uncertain actions remain held and visible.
    // A task parked on unclaimed handoffs (5.6.2) waits for the owner's brief
    // or real developer progress; an hourly diagnostic wake only re-reads them.
    if (job.state === "waiting" && !parkedOnHandoffs(job) && !held(ledger.data, job, config, now) && !status.uncertain && ["waiting", "queued"].includes(status.state)) {
      (job.inbox ||= []).push({ role: "system", authorId: "wait-review", at: new Date(now).toISOString(), content: "This wait is overdue. Inspect its dependency and report a concrete next milestone, blocker and next check. Do not repeat an uncertain action or widen existing authority. A timer wake or more tests alone is not delivery." });
      job.wakeAt = now;
    }
    ledger.audit("wait_review_due", { job: job.id, ticket: ticketOf(job), state: status.state });
    // Keir 5.6 (owner, 2026-10-16): no owner DM. The task wakes itself above,
    // and selfrecovery parks or reclaims anything that stays stuck. Overdue
    // waits stay visible on /v3/status and the audit log, not in his DMs.
    changed.push(job.id);
  }
  if (changed.length) ledger.save();
  return changed;
}
function createWorkQueue({ ledger, config = {}, mcp, now = () => Date.now() }) {
  let snapshot = null, checkedAt = 0, attemptAt = null, error = null, pending = null;
  async function refresh() {
    if (!mcp?.servers?.().includes("support")) return;
    if (attemptAt !== null && now() - attemptAt < 30000) return pending;
    attemptAt = now();
    pending = (async () => {
      try {
        const r = await mcp.call("support", "support_list", { kind: "ticket", openOnly: true, limit: 60 }, false, AbortSignal.timeout(8000));
        if (!Array.isArray(r.items)) throw new Error("Incomplete support response");
        snapshot = r.items; checkedAt = now(); error = null;
      } catch { error = "Ticket source could not refresh. The last snapshot is retained."; }
      finally { pending = null; }
    })();
    return pending;
  }
  async function view() {
    await refresh();
    const d = ledger.data, jobs = Object.values(d.jobs || {}).filter(j => !j.codingParent && !j.internalProbe && !j.benchmark && !j.appWatch);
    const tasks = jobs.filter(j => j.role === "owner").filter(j => !CLOSED.has(j.state) || now() - (j.updatedAt || j.at || 0) < 86400000).map(j => ({ id: j.id, title: clip(j.source?.content || j.summary,120), ticket: ticketOf(j), updatedAt: j.updatedAt || j.at, timing: workStatus(d,j,{ now: now(), config }) }));
    const tickets = (snapshot || []).map(t => {
      const candidates = jobs.filter(j => Number(ticketOf(j)) === Number(t.number));
      const job = candidates.filter(j => !CLOSED.has(j.state)).sort((a,b) => (b.updatedAt || b.at || 0) - (a.updatedAt || a.at || 0)).find(j => j.kind !== "ticket") || candidates.find(j => !CLOSED.has(j.state)) || candidates.sort((a,b) => (b.updatedAt || b.at || 0) - (a.updatedAt || a.at || 0))[0];
      return { number: t.number, title: t.title, status: t.status, category: t.category, createdAt: Date.parse(t.createdAt) || null, task: job?.id || null,
        // There is no assign action in the app, so an untaken open ticket is queued
        // for Keir's intake rather than shown as stuck work that needs the owner.
        timing: job && !CLOSED.has(job.state) ? workStatus(d,job,{ now: now(), config }) : { state: "queued", owner: "Keir intake", reason: job ? "The previous task finished, but the ticket is still open." : "Keir has not picked this ticket up yet.", next: "Keir's intake pass takes it next; no action needed.", expectedDoneAt: null, etaLabel: "Completion time not established", overdue: false } };
    });
    return { at: now(), tickets, tasks, source: { enabled: Boolean(mcp?.servers?.().includes("support")), at: checkedAt || null, error, complete: snapshot !== null && !error && snapshot.length < 60, limited: (snapshot?.length || 0) >= 60 } };
  }
  return { view };
}
module.exports = { workStatus, reviewWaits, createWorkQueue };
