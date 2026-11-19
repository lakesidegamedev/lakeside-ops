"use strict";
const { JOB_TERMINAL } = require("./machines");
const { GAME_REPO, canonicalRepository } = require("./github");
// Keir 3.0 stage A: one canonical work record per ticket or owner request,
// derived as a pure projection over the v1 ledger. Jobs become attempts on a
// record. This module changes no behavior: the running operator does not read
// it yet. It exists so the coordinator, shadow review and dashboards can all
// consume the same shared state instead of job-local fields, and so every
// legacy job, action, decision, watch and receipt can be proven to map to
// exactly one record before any migration runs.

const TERMINAL = JOB_TERMINAL;
const CI_MAX_WATCH_MS = 3 * 3600000; // mirrors ciwatch MAX_WATCH_MS

const ticketNumberOf = (name) => Number(/^ticket-.*-(\d+)$/.exec(name || "")?.[1] || 0);
const ticketOf = (job) => job.ticket || ticketNumberOf(job.source?.channelName) || 0;

// Follow codingParent links to the investigating job that owns the work.
// Cycle-safe: a corrupt parent loop stops at the first repeat.
function rootJob(job, jobs) {
  const seen = new Set();
  let current = job;
  while (current?.codingParent && jobs[current.codingParent] && !seen.has(current.id)) {
    seen.add(current.id);
    current = jobs[current.codingParent];
  }
  return current;
}

function workIdForJob(job, jobs) {
  const root = rootJob(job, jobs);
  const ticket = ticketOf(job) || ticketOf(root);
  return ticket ? `ticket:${ticket}` : `request:${root.id}`;
}

function recordState(attempts) {
  const states = attempts.map((j) => j.state);
  if (states.every((s) => TERMINAL.includes(s))) return "terminal";
  if (states.includes("running")) return "active";
  if (states.includes("queued")) return "queued";
  if (states.includes("blocked")) return "blocked";
  if (states.includes("deferred")) return "deferred";
  return "waiting";
}

function nextAction(record) {
  if (record.state === "terminal") return "none";
  if (record.pendingApprovals.length || record.pendingDecisions.length) return "awaiting-approval";
  if (record.state === "active" || record.state === "queued") return "attempt";
  if (record.waits.some((w) => w.kind === "ci")) return "awaiting-ci";
  if (record.state === "blocked") return "blocked";
  if (record.state === "deferred") return "staff-owned";
  return "awaiting-event";
}

// Pure: never mutates `data`, output ordering is deterministic.
function projectWorkRecords(data) {
  const jobs = data.jobs || {};
  const byId = new Map();
  const attemptWork = new Map();
  for (const job of Object.values(jobs)) {
    const workId = workIdForJob(job, jobs);
    attemptWork.set(job.id, workId);
    if (!byId.has(workId)) byId.set(workId, []);
    byId.get(workId).push(job);
  }

  const actions = Object.values(data.actions || {});
  const decisions = Object.values(data.decisions || {});
  const records = {};
  for (const [workId, attempts] of [...byId.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    attempts.sort((x, y) => (x.at || 0) - (y.at || 0) || (x.id < y.id ? -1 : 1));
    const attemptIds = new Set(attempts.map((j) => j.id));
    const ticket = workId.startsWith("ticket:") ? Number(workId.slice(7)) : 0;
    const coordinatorId = ticket ? data.seen?.[`ticket:${ticket}`] : null;
    const channelId = attempts.find((j) => j.channelId)?.channelId
      || attempts.find((j) => j.source?.channelId)?.source.channelId || null;

    const waits = [];
    for (const job of attempts) {
      for (const [number, w] of Object.entries(job.ciWatch || {})) {
        waits.push({ kind: "ci", correlation: `${canonicalRepository(w.repository || GAME_REPO)}#${number}`,
          attemptId: job.id, since: w.since || 0, deadline: (w.since || 0) + CI_MAX_WATCH_MS,
          orphaned: TERMINAL.includes(job.state) });
      }
      if (job.state === "waiting" && job.wakeAt) waits.push({ kind: "timer", attemptId: job.id, wakeAt: job.wakeAt });
    }
    const pendingDecisions = decisions
      .filter((x) => x.state === "pending" && attemptIds.has(x.jobId))
      .map((x) => ({ decisionId: x.id, actionId: x.actionId || null, attemptId: x.jobId, freeform: !x.actionId }));
    for (const x of pendingDecisions) waits.push({ kind: "decision", decisionId: x.decisionId, attemptId: x.attemptId });

    const posts = ticket ? data.ticketPosts?.[ticket] || [] : [];
    const delivered = Object.values(data.outbox || {})
      .filter((o) => typeof o.destination === "string" && o.destination.startsWith("channel:")
        && attemptIds.has(o.destination.slice(8)) && o.deliveredAt)
      .map((o) => o.deliveredAt);
    const lastPublicActivityAt = Math.max(0,
      ...attempts.map((j) => j.lastPublishedAt || 0),
      ...posts.map((p) => p.at || 0), ...delivered);

    const knowledge = ticket ? data.ticketRecords?.[String(ticket)] : null;
    const open = (list) => (list || []).filter((x) => !x.closedAt).length;
    const record = {
      id: workId,
      kind: ticket ? "ticket" : "request",
      ticket: ticket || null,
      channelId,
      state: recordState(attempts),
      attempts: attempts.map((j) => j.id),
      coordinatorAttemptId: coordinatorId && attemptIds.has(coordinatorId) ? coordinatorId : null,
      staffClaimedBy: channelId ? data.channels?.[channelId]?.claimedBy || null : null,
      createdAt: Math.min(...attempts.map((j) => j.at || 0)),
      updatedAt: Math.max(...attempts.map((j) => j.updatedAt || j.at || 0)),
      lastPublicActivityAt: lastPublicActivityAt || null,
      pullRequests: [...new Set(attempts.flatMap((j) => j.pullRequests || []))],
      pendingApprovals: actions
        .filter((a) => a.state === "pending" && attemptIds.has(a.jobId))
        .map((a) => ({ actionId: a.id, kind: a.kind, digest: a.digest, attemptId: a.jobId, expiresAt: a.expiresAt || null })),
      pendingDecisions,
      waits,
      blockers: attempts.filter((j) => j.state === "blocked").map((j) => ({ attemptId: j.id })),
      // Resolution posted and waiting out closure grace: quiet by design.
      closureGrace: attempts.some((j) => !TERMINAL.includes(j.state) && (j.resolutionReadyAt || j.resolutionSubmitted)),
      knowledge: knowledge ? { facts: (knowledge.facts || []).length, ruledOut: (knowledge.ruledOut || []).length,
        openPromises: open(knowledge.promises), openQuestions: open(knowledge.questions) } : null,
    };
    record.nextAction = nextAction(record);
    records[workId] = record;
  }
  return { records, attemptWork: Object.fromEntries(attemptWork) };
}

// Structural proof over a ledger snapshot. Counts and ids only, never message
// text or summaries, so the report is safe to keep with release evidence.
function integrityReport(data) {
  const jobs = data.jobs || {};
  const { records, attemptWork } = projectWorkRecords(data);
  const mapped = Object.values(records).flatMap((r) => r.attempts);
  const jobIds = new Set(Object.keys(jobs));
  const problems = [];
  if (mapped.length !== jobIds.size || new Set(mapped).size !== mapped.length)
    problems.push("attempt mapping is not a partition of jobs");
  for (const id of jobIds) if (!attemptWork[id]) problems.push(`job ${id} has no work record`);

  const orphanedCi = [], staleChildren = [], pendingOnTerminal = [];
  for (const job of Object.values(jobs)) {
    if (job.ciWatch && TERMINAL.includes(job.state)) orphanedCi.push(job.id);
    if (job.codingParent && !jobs[job.codingParent]) staleChildren.push(job.id);
    if (job.codingParent && ["done", "blocked", "dismissed"].includes(job.state)
      && jobs[job.codingParent] && TERMINAL.includes(jobs[job.codingParent].state) && !job.codingReported)
      staleChildren.push(job.id);
  }
  const danglingActions = [], danglingDecisions = [], doubleAskJobs = [];
  for (const a of Object.values(data.actions || {})) {
    if (!jobIds.has(a.jobId)) danglingActions.push(a.id);
    else if (a.state === "pending" && TERMINAL.includes(jobs[a.jobId].state)) pendingOnTerminal.push(a.id);
  }
  const decisionsByJob = new Map();
  for (const x of Object.values(data.decisions || {})) {
    if (!jobIds.has(x.jobId) || (x.actionId && !(data.actions || {})[x.actionId])) danglingDecisions.push(x.id);
    if (!decisionsByJob.has(x.jobId)) decisionsByJob.set(x.jobId, []);
    decisionsByJob.get(x.jobId).push(x);
  }
  // The observed double ask: one job carries both a freeform review decision
  // and an exact-action decision. Stage D makes this structurally impossible.
  for (const [jobId, list] of decisionsByJob)
    if (list.some((x) => !x.actionId) && list.some((x) => x.actionId)) doubleAskJobs.push(jobId);

  const ticketRecords = Object.values(records).filter((r) => r.kind === "ticket");
  return {
    jobs: jobIds.size,
    records: Object.keys(records).length,
    ticketRecords: ticketRecords.length,
    multiAttemptTickets: ticketRecords.filter((r) => r.attempts.length > 1).length,
    maxAttemptsPerTicket: Math.max(0, ...ticketRecords.map((r) => r.attempts.length)),
    unmappedJobs: [...jobIds].filter((id) => !attemptWork[id]),
    orphanedCiWatches: orphanedCi,
    staleCodingChildren: staleChildren,
    pendingActionsOnTerminalJobs: pendingOnTerminal,
    danglingActions, danglingDecisions, doubleAskJobs,
    problems,
  };
}

// Fingerprint of the ledger state a projection was taken from. The v3
// snapshot written by the migration is frozen; the 2.x binary keeps writing
// jobs, actions and decisions, so a snapshot whose fingerprint no longer
// matches is stale and must be regenerated, never read as current state.
function sourceDigest(data) {
  const crypto = require("node:crypto");
  const pick = (o) => Object.values(o || {}).map((x) => [x.id, x.state, x.updatedAt || x.at || 0].join(":")).sort();
  return crypto.createHash("sha256").update(JSON.stringify([pick(data.jobs), pick(data.actions), pick(data.decisions)])).digest("hex");
}
const v3Stale = (data) => Boolean(data.v3) && data.v3.sourceDigest !== sourceDigest(data);

module.exports = { projectWorkRecords, integrityReport, workIdForJob, rootJob, ticketOf, sourceDigest, v3Stale, TERMINAL };
