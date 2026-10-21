"use strict";
// Keir 3.0 stage B: the measured baseline every responsiveness claim is
// checked against, computed purely from a ledger snapshot and usage rows.
// It also feeds 3.0 ticket intelligence: SLA clocks, silence breaches and
// queue age are derived from work records, not job-local timestamps.
// Counts and durations only, never message text.

const { projectWorkRecords, integrityReport } = require("./workrecord");

// Brief budgets (keir-3.0 handoff). Kept as data so a budget change is a
// visible decision, never a quiet redefinition inside measurement code.
const BUDGETS = {
  ackP95Ms: 15000,          // acknowledgment within seconds
  simpleReplyP95Ms: 15000,  // p95 simple reply, healthy provider
  materialEventMs: 60000,   // material event to next action
  silenceMaxMs: 10 * 60000, // no active ticket silent beyond this
};

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(values) {
  return { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null };
}

function parseUsage(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn last line is not data */ }
  }
  return rows;
}

function computeMetrics(data, usageRows = [], { now = Date.now() } = {}) {
  const jobs = data.jobs || {};
  // Request-to-ack runs from when the person sent the message (the Discord
  // timestamp in job.source.at), not from job creation, which happens only
  // after the scan poll and classification. Ingest and post-intake shares are
  // reported separately; a job with no message timestamp falls back to its
  // creation time and is counted, so the fallback is never silent.
  const acks = [], ackFromJob = [], ackIngest = [];
  let ackFallbacks = 0;
  for (const [key, entry] of Object.entries(data.outbox || {})) {
    if (!key.startsWith("ack:") || !entry.deliveredAt) continue;
    const job = typeof entry.destination === "string" && entry.destination.startsWith("channel:")
      ? jobs[entry.destination.slice(8)] : null;
    if (!job?.at) continue;
    const sentAt = Date.parse(job.source?.at || "");
    ackFromJob.push(entry.deliveredAt - job.at);
    if (Number.isFinite(sentAt) && sentAt <= job.at) {
      acks.push(entry.deliveredAt - sentAt);
      ackIngest.push(job.at - sentAt);
    } else { acks.push(entry.deliveredAt - job.at); ackFallbacks++; }
  }

  const byKind = {};
  for (const row of usageRows) {
    if (!Number.isFinite(row.durationMs)) continue;
    (byKind[row.kind || "unknown"] ||= []).push(row.durationMs);
  }
  const activations = Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([kind, values]) => [kind, summarize(values)]));

  const { records } = projectWorkRecords(data);
  const active = Object.values(records).filter((r) => r.state !== "terminal");
  const activeTickets = active.filter((r) => r.kind === "ticket" && !r.staffClaimedBy);
  const silenceMs = activeTickets.map((r) => now - (r.lastPublicActivityAt || r.createdAt || now));
  const queuedAge = Object.values(jobs).filter((j) => j.state === "queued")
    .map((j) => ({ conversation: j.kind === "conversation", age: now - (j.at || now) }));

  const integrity = integrityReport(data);
  const ack = summarize(acks);
  // Conversation activation duration is an upper-bound proxy for simple
  // replies today: every quick answer pays a full model activation. The 3.0
  // fast lane exists precisely to break that equivalence, so the field is
  // named as a proxy and never presented as reply latency itself.
  const simpleReplyProxy = activations.conversation || summarize([]);
  const verdict = (observed, budget) => observed === null ? "no-data" : observed <= budget ? "within" : "exceeds";

  return {
    at: now,
    ticketPerformance: require("./ticketperformance").ticketPerformance(data, usageRows, { until: now }),
    ackLatencyMs: ack,
    ackBreakdownMs: { fromJobCreation: summarize(ackFromJob), ingest: summarize(ackIngest),
      fallbackToJobCreation: ackFallbacks },
    activationsMs: activations,
    records: { total: Object.keys(records).length, active: active.length, activeTickets: activeTickets.length },
    silence: { activeTicketsMs: summarize(silenceMs),
      overBudget: silenceMs.filter((ms) => ms > BUDGETS.silenceMaxMs).length,
      overTwoHours: silenceMs.filter((ms) => ms > 2 * 3600000).length },
    queue: { queued: queuedAge.length,
      oldestConversationMs: Math.max(0, ...queuedAge.filter((q) => q.conversation).map((q) => q.age)),
      oldestWorkerMs: Math.max(0, ...queuedAge.filter((q) => !q.conversation).map((q) => q.age)) },
    coordination: { multiAttemptTickets: integrity.multiAttemptTickets,
      maxAttemptsPerTicket: integrity.maxAttemptsPerTicket,
      doubleAskJobs: integrity.doubleAskJobs.length,
      orphanedCiWatches: integrity.orphanedCiWatches.length,
      pendingActionsOnTerminalJobs: integrity.pendingActionsOnTerminalJobs.length },
    budgets: {
      ackP95: { budgetMs: BUDGETS.ackP95Ms, observedMs: ack.p95, verdict: verdict(ack.p95, BUDGETS.ackP95Ms) },
      simpleReplyP95Proxy: { budgetMs: BUDGETS.simpleReplyP95Ms, observedMs: simpleReplyProxy.p95,
        verdict: verdict(simpleReplyProxy.p95, BUDGETS.simpleReplyP95Ms) },
      silenceMax: { budgetMs: BUDGETS.silenceMaxMs, observedMs: summarize(silenceMs).max,
        verdict: silenceMs.length ? verdict(Math.max(...silenceMs), BUDGETS.silenceMaxMs) : "no-data" },
    },
  };
}

module.exports = { BUDGETS, percentile, summarize, parseUsage, computeMetrics };
