"use strict";
const { requireRealDecision } = require("./decisionpolicy");
const INTERNAL = /\b(?:decision|approval)\s+(?:DM|inbox)\b|\bdig done\b|\bportal\/env\b|\btask (?:finished|completed)\b/i;
const CLOSED = new Set(["resolved", "closed", "merged"]);
const stamp = v => typeof v === "number" ? v : Date.parse(v?.$date || v || "") || 0;
const clip = s => String(require("./ownermuse-policy").logInput(String(s || ""))).replace(/\s+/g, " ").slice(0, 240);
function auditConversation(data, { tickets = {}, messages = {}, decisionMessages = {}, now = Date.now(), since = now - 30 * 60000, ownerId, excludedTickets = [] } = {}) {
  const findings = [], samples = [], excluded = new Set(excludedTickets.map(Number));
  const add = (kind, detail) => findings.push({ kind, ...detail });
  for (const [number, ticket] of Object.entries(tickets)) {
    const n = Number(number); if (excluded.has(n)) continue;
    const jobs = Object.values(data.jobs || {}).filter(j => Number(j.ticket) === n && j.kind === "ticket");
    const job = jobs.sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    for (const update of ticket.publicUpdates || []) {
      if (stamp(update.at) < since || update.delivery?.status !== "posted") continue;
      const id = update.delivery?.messageId;
      if ((update.deliveryMode === "reply" || update.kind === "resolution") && id && id === ticket.intake?.cardMessageId)
        add("answer-delivered-only-to-card", { ticket: n, updateKey: update.key, messageId: id });
    }
    if (job?.ownerClosureHold && (job.resolutionSubmitted || CLOSED.has(ticket.status))) add("closure-against-owner-hold", { ticket: n, jobId: job.id });
    const rows = messages[number];
    if (!Array.isArray(rows)) {
      if (!(CLOSED.has(ticket.status) && rows?.status === 404)) add("ticket-observation-unavailable", { ticket: n, error: rows?.error || "messages unavailable" });
      continue;
    }
    const sorted = [...rows].sort((a, b) => stamp(a.timestamp) - stamp(b.timestamp));
    const replies = sorted.filter(m => m.author?.bot && String(m.content || "").trim().length > 8 && !/^Your ticket receipt:/.test(m.content));
    for (const m of replies.filter(m => stamp(m.timestamp) >= since)) if (INTERNAL.test(m.content)) add("internal-handoff-public", { ticket: n, messageId: m.id, excerpt: clip(m.content) });
    const latestReply = replies.at(-1), latestHuman = sorted.filter(m => !m.author?.bot && String(m.content || "").trim()).at(-1);
    if (!CLOSED.has(ticket.status) && !data.channels?.[ticket.conversation?.channelId]?.claimedBy && latestHuman && stamp(latestHuman.timestamp) > stamp(latestReply?.timestamp) && now - stamp(latestHuman.timestamp) > 15 * 60000)
      add("player-reply-unanswered", { ticket: n, messageId: latestHuman.id, minutes: Math.floor((now - stamp(latestHuman.timestamp)) / 60000) });
    if (job && !CLOSED.has(ticket.status) && ["queued", "running", "waiting", "blocked"].includes(job.state) && !job.waitingFor && !data.channels?.[ticket.conversation?.channelId]?.claimedBy && (job.updatedAt || 0) >= since && now - stamp(latestReply?.timestamp || job.at) > 2 * 3600000)
      add("active-ticket-conversation-stale", { ticket: n, messageId: latestReply?.id || null, minutes: Math.floor((now - stamp(latestReply?.timestamp || job.at)) / 60000) });
    // This is a review cue, not an automatic ruling about a player's intent.
    if (latestHuman && latestReply && stamp(latestHuman.timestamp) >= since && /\b(?:never (?:re)?buy|still (?:can.?t|cannot)|not (?:fixed|resolved)|doesn.?t work)\b/i.test(latestHuman.content) && /\b(?:accepted|resolved|clos(?:e|ing) (?:this |the )?ticket|that is the ruling)\b/i.test(latestReply.content) && !job?.ownerClosureHold)
      add("unmet-goal-needs-review", { ticket: n, playerMessageId: latestHuman.id, messageId: latestReply.id });
    samples.push({ ticket: n, status: ticket.status, closureHeld: Boolean(job?.ownerClosureHold), latestPlayer: latestHuman ? { id: latestHuman.id, text: clip(latestHuman.content) } : null,
      replies: replies.slice(-2).map(m => ({ id: m.id, at: m.timestamp, text: clip(m.content) })) });
  }
  const observedDecisions = Object.values(data.decisions || {}).filter(x => !excluded.has(Number(data.jobs?.[x.jobId]?.ticket)));
  const live = observedDecisions.filter(x => x.state === "pending");
  for (const j of Object.values(data.jobs || {})) if (j.ownerDecisionPending && !excluded.has(Number(j.ticket)) && !["done", "cancelled", "dismissed"].includes(j.state) && !live.some(x => x.jobId === j.id)) add("orphan-owner-decision-hold", { jobId: j.id, ticket: j.ticket || null });
  const bindings = new Map();
  for (const x of live) {
    try { if (!x.actionId && !x.signoff && !x.binds) requireRealDecision(x.question); }
    catch { add("routine-permission-decision", { decisionId: x.id, jobId: x.jobId }); }
    const key = `${x.jobId}:${x.actionId || "question"}`;
    if (bindings.has(key)) add("duplicate-pending-decision", { decisionId: x.id, otherDecisionId: bindings.get(key) });
    bindings.set(key, x.id);
    if (ownerId && !x.sent?.[ownerId] && now - x.at > 2 * 60000) add("owner-discord-copy-missing", { decisionId: x.id });
    for (const s of Object.values(x.sent || {})) {
      if (!s.messageId || s.deleted) continue;
      const m = decisionMessages[`${s.channelId}:${s.messageId}`];
      if (!m || m.error) add("decision-copy-unavailable", { decisionId: x.id, messageId: s.messageId, error: m?.error || "not observed" });
      else if (!s.content || !String(m.content || "").startsWith(s.content) || !String(s.content).includes(x.question)) add("decision-copy-content-drift", { decisionId: x.id, messageId: s.messageId });
    }
  }
  for (const x of observedDecisions) if (x.state !== "pending" && now - (x.answeredAt || x.expiredAt || x.at) > 2 * 60000)
    for (const s of Object.values(x.sent || {})) {
      if (!s.messageId || s.deleted) continue;
      const m = decisionMessages[`${s.channelId}:${s.messageId}`];
      if (m && !m.error) add("stale-decision-copy", { decisionId: x.id, messageId: s.messageId });
    }
  return { at: now, since, ticketsChecked: samples.length, decisionsChecked: live.length, findings, samples };
}
module.exports = { auditConversation };
