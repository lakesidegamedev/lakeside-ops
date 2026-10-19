"use strict";
// Keir 3.0 shadow review. The 2.x shadow inferred workflow from job-local
// timestamps, which produced false silence (another job had posted) and
// double flags (blocked reported as both blocked and waiting-on-owner).
// Shadow3 consumes the work-record projection and integrity report for
// workflow anomalies: one anomaly per condition, silence measured from the
// record's shared public receipt, blocked distinguished from awaiting
// approval, closure grace not counted as silence.
// It also keeps every outbox content and delivery check the 2.x shadow ran
// (technical leakage, long replies, generic acks, off-ticket player replies,
// undelivered and repeated messages, unanswered developer requests, long
// runs, alerts). Those catch public-copy failures, which a workflow view
// cannot see. Read-only; safe to run against the paused ledger.

const { projectWorkRecords, integrityReport } = require("./workrecord");
const { BUDGETS } = require("./metrics");

const TERMINAL = ["done", "cancelled", "dismissed"];
const TECHNICAL = /```|\/root\/|\/var\/lib|src\/[\w/.-]+\.(?:ts|tsx|js)|publish_patch|repository_snapshot|mcp__|\bsha\b|[0-9a-f]{10,40}/i;
const GENERIC_ACK = /^(?:i['’]m on it|on it|looking into it)[.!]*$/i;
const short = (t, n = 160) => String(t || "").replace(/\s+/g, " ").slice(0, n);

// identity: { ownerId, staffIds }. Without it, developer-request and owner-DM
// checks are skipped rather than guessed.
function outboxFindings(data, { now, since, ownerId = null, staffIds = [] }) {
  const jobs = data.jobs || {};
  const jobOf = (dest) => typeof dest === "string" && dest.startsWith("channel:") ? jobs[dest.slice(8)] : null;
  const found = [];
  const seenText = new Set();
  for (const [key, o] of Object.entries(data.outbox || {})) {
    if ((o.deliveredAt || o.at || 0) < since) continue;
    const job = jobOf(o.destination);
    const text = String(o.content || "");
    const kind = key.split(":")[0];
    if (!job) {
      if (ownerId && (o.destination === "owner" || o.destination === ownerId) && !(o.decision && data.decisions?.[o.decision] && o.recipient === ownerId))
        found.push({ kind: "owner-dm", key: kind, text: short(text) });
      continue;
    }
    const where = job.ticket ? `ticket ${job.ticket}` : job.source?.channelName || job.channelId || job.id;
    if (text.length > 700) found.push({ kind: "long-reply", where, chars: text.length });
    if (TECHNICAL.test(text) && (job.role !== "owner" || job.ticket))
      found.push({ kind: "technical-detail-public", where, text: short(text, 120) });
    if (GENERIC_ACK.test(text.trim())) found.push({ kind: "generic-ack", where });
    if (job.role === "player" && !job.ticket && !data.summonedChannels?.[job.channelId])
      found.push({ kind: "player-reply-off-ticket", where });
    if (!o.deliveredAt && now - (o.at || now) > 120000)
      found.push({ kind: "undelivered", where, minutes: Math.round((now - o.at) / 60000), error: o.error || "pending" });
    const repeatKey = `${job.replyChannel}|${short(text, 80)}`;
    if ((o.at || 0) >= since) {
      if (seenText.has(repeatKey)) found.push({ kind: "repeated-message", where, text: short(text, 80) });
      seenText.add(repeatKey);
    }
  }
  for (const j of Object.values(jobs)) {
    const age = now - (j.at || 0);
    const developer = ownerId && [ownerId, ...staffIds].includes(j.actorId) && j.kind === "command";
    if (developer && !TERMINAL.includes(j.state) && age > 20 * 60000 && (j.updatedAt || 0) > since - 6 * 3600000) {
      const answered = Object.keys(data.outbox || {}).some((k) => k.includes(j.id) && !k.startsWith("ack:"))
        || Object.keys(j.effects || {}).some((k) => k.startsWith("ticket-update:")) || Boolean(j.lastPublishedAt);
      if (!answered) found.push({ kind: "developer-request-unanswered", jobId: j.id, minutes: Math.round(age / 60000) });
    }
    if (j.state === "running" && now - (j.startedAt || now) > 20 * 60000)
      found.push({ kind: "long-running-attempt", jobId: j.id, minutes: Math.round((now - j.startedAt) / 60000) });
  }
  for (const a of (data.alerts || []).filter((x) => x.at > since && !String(x.key).startsWith("digest:")))
    found.push({ kind: "alert", key: a.key, text: short(a.content) });
  return found;
}

function shadowReport(data, { now = Date.now(), since = now - 20 * 60000, ownerId = null, staffIds = [] } = {}) {
  const { records } = projectWorkRecords(data);
  const integrity = integrityReport(data);
  const anomalies = [];
  for (const r of Object.values(records)) {
    if (r.state === "terminal") continue;
    const silentMs = now - (r.lastPublicActivityAt || r.createdAt || now);
    if (r.kind === "ticket" && !r.staffClaimedBy && !r.closureGrace && silentMs > BUDGETS.silenceMaxMs)
      anomalies.push({ kind: "silent-ticket", workId: r.id, silentMinutes: Math.round(silentMs / 60000) });
    if (r.pendingDecisions.length || r.pendingApprovals.length)
      anomalies.push({ kind: "awaiting-approval", workId: r.id,
        decisions: r.pendingDecisions.length, approvals: r.pendingApprovals.length });
    else if (r.blockers.length)
      anomalies.push({ kind: "blocked", workId: r.id, attempts: r.blockers.map((b) => b.attemptId) });
    for (const w of r.waits.filter((x) => x.kind === "ci" && x.orphaned))
      anomalies.push({ kind: "orphaned-ci-watch", workId: r.id, correlation: w.correlation });
    // A record nobody will move: not running, not queued, nothing to wake it.
    if (r.state === "waiting" && !r.waits.length && !r.closureGrace)
      anomalies.push({ kind: "no-wake-condition", workId: r.id });
  }
  for (const jobId of integrity.doubleAskJobs) anomalies.push({ kind: "double-ask-risk", jobId });
  for (const id of integrity.pendingActionsOnTerminalJobs) anomalies.push({ kind: "pending-action-on-terminal-job", actionId: id });
  anomalies.push(...outboxFindings(data, { now, since, ownerId, staffIds }));
  return { at: now, since, records: Object.keys(records).length, anomalies,
    integrityProblems: integrity.problems, unmappedJobs: integrity.unmappedJobs };
}

module.exports = { shadowReport, outboxFindings };
