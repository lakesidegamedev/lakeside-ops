"use strict";
const { JOB_TERMINAL } = require("./machines");
const { receiptOf } = require("./appagent");
const { ticketOf } = require("./workrecord");
const CLOSED = JOB_TERMINAL;
const HOLD_LABELS = { "staff-category": "Staff category requires review", paused: "Keir is paused", "closure-grace": "Ticket closure grace period", "closed-ticket": "Ticket is closed", "uncertain-effect": "An earlier action needs verification", "pending-decision": "An owner decision is pending", "pending-action": "An action needs approval or completion" };
function handoffOf(receipt) {
  return { id: receipt.id, directiveId: receipt.directiveId, sourceTaskId: receipt.sourceTaskId,
    sourceMessageId: receipt.sourceMessageId, coordinatorTaskId: receipt.coordinatorTaskId,
    at: receipt.at, incorporatedAt: receipt.incorporatedAt || null, outcome: receipt.outcome,
    status: receipt.incorporatedAt ? "Incorporated by Support Keir" : receipt.remainingBlockers?.length || receipt.outcome === "held" ? "Waiting on a hold" : "Delivered to Support Keir",
    remainingBlockers: (receipt.remainingBlockers || []).map((reason) => HOLD_LABELS[reason] || String(reason).replace(/[_-]/g, " ")),
    approvalReferences: receipt.approvalReferences || [] };
}
function verifiedPlayerReply(ticket, number, guildId) {
  if (ticket?.kind !== "ticket" || ticket.number !== number) return null;
  const channel = ticket.conversation?.channelId;
  const snowflake = value => typeof value === "string" && /^\d{16,20}$/.test(value);
  if (!snowflake(channel)) return null;
  const since = Date.parse(ticket.conversation.reopenedAt || ticket.createdAt);
  if (!Number.isFinite(since) || !Array.isArray(ticket.publicUpdates)) return null;
  let latest = null;
  for (const update of ticket.publicUpdates) {
    const receipt = update?.delivery;
    if (update?.deliveryMode !== "reply" || receipt?.status !== "posted" || receipt.channelId !== channel ||
        !snowflake(receipt.messageId) || receipt.messageId === ticket.intake?.cardMessageId) continue;
    const at = Date.parse(receipt.postedAt);
    if (!Number.isFinite(at) || at < since || at <= (latest?.at || 0)) continue;
    latest = { id: receipt.messageId, at, kind: "Player reply", text: String(update.message || "").slice(0, 2000),
      ...(snowflake(guildId) ? { url: `https://discord.com/channels/${guildId}/${channel}/${receipt.messageId}` } : {}) };
  }
  return latest;
}
function ticketDetail(data, number, now = Date.now(), config = {}, support = null) {
  const jobs = Object.values(data.jobs).filter((j) => Number(ticketOf(j)) === number).sort((a, b) => (b.updatedAt || b.at) - (a.updatedAt || a.at));
  const ids = new Set(jobs.map((j) => j.id));
  const card = data.statusCards?.[number] || {};
  const blockers = [];
  const handoffs = Object.values(data.supportDirectives || {}).filter((r) => Number(r.ticket) === number).map(handoffOf).sort((a, b) => b.at - a.at);
  for (const handoff of handoffs.filter((h) => !h.incorporatedAt && h.remainingBlockers.length)) blockers.push({ kind: "handoff", title: "Owner instruction is waiting on a hold", detail: handoff.remainingBlockers.join(" · "), taskId: handoff.coordinatorTaskId, directiveId: handoff.id });
  const decisions = Object.values(data.decisions || {}).filter((x) => ids.has(x.jobId) && x.state === "pending");
  for (const decision of decisions) blockers.push({ kind: "decision", title: decision.tldr || decision.question, detail: decision.question, decisionId: decision.id });
  for (const action of Object.values(data.actions || {}).filter((x) => ids.has(x.jobId) && x.state === "pending")) blockers.push({ kind: "approval", title: "Action awaiting approval", detail: action.reason || action.kind, actionId: action.id });
  for (const item of (card.items || []).filter((x) => x.blocked)) blockers.push({ kind: "fix", title: item.name, detail: item.note || "This fix is blocked; Keir has not recorded a reason." });
  for (const job of jobs.filter((j) => !CLOSED.includes(j.state))) {
    if (job.state === "blocked") blockers.push({ kind: "task", title: "Keir is blocked", detail: job.summary || "No blocker detail recorded", taskId: job.id });
    if (job.waitingFor) blockers.push({ kind: "waiting", title: `Waiting for ${job.waitingFor.kind}`, detail: job.summary || "", taskId: job.id });
    if (Object.keys(job.ciWatch || {}).length) blockers.push({ kind: "ci", title: "Waiting for checks", detail: "PR " + Object.keys(job.ciWatch).map((n) => `#${n}`).join(", "), taskId: job.id });
    // Keir 11.2 fourth pass (review N1): a parked or slowed wait stays visible where the owner looks, with what closes it,
    // what wakes it and what the player is owed.
    if (job.closing?.parked) { const c = job.closing; blockers.push({ kind: "parked", title: `Parked: waiting on ${String(c.waitingOn || "").slice(0, 120)}`, detail: `Closes when ${String(c.closesWhen || "").replace(/^closes when /i, "").slice(0, 200)}. Wakes when ${c.parked.source || "something changes"}, when someone writes, or at the next check in code.${c.parked.owed ? ` The player is owed ${c.parked.owed}.` : ""}`, taskId: job.id }); }
    else if (job.closing?.slowed) { const c = job.closing; blockers.push({ kind: "waiting", title: `Checking every few hours: ${String(c.waitingOn || "").slice(0, 120)}`, detail: `Closes when ${String(c.closesWhen || "").replace(/^closes when /i, "").slice(0, 200)}. ${c.slowed.why}.`, taskId: job.id }); }
    if (job.staffActiveUntil > now || job.state === "deferred") blockers.push({ kind: "staff", title: "Staff owns the next move", detail: job.summary || "Keir is holding this ticket for staff.", taskId: job.id });
  }
  const current = jobs.find((j) => j.state === "running") || jobs.find((j) => !CLOSED.includes(j.state)) || jobs[0];
  const receipts = jobs.flatMap((j) => Object.entries(j.effects || {}).map(([key, value]) => ({ ...receiptOf(key, value), taskId: j.id }))).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 40);
  const history = jobs.flatMap((j) => (j.history || []).map((h, i) => ({ id: `${j.id}-${i}`, taskId: j.id, at: h.at, kind: h.kind || h.state || "checkpoint", text: String(h.summary || "").slice(0, 2000) })));
  for (const [i, post] of (data.ticketPosts?.[number] || []).entries()) {
    if (post.kind === "status_card") history.push({ id: `post-${i}`, at: post.at, kind: "Status update", text: post.text });
  }
  const playerReply = verifiedPlayerReply(support, number, config.guildId);
  if (playerReply) history.push(playerReply);
  history.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return { number, title: support?.number === number ? support.title || null : data.ticketRecords?.[number]?.title || null, retryTaskId: stalledTicketJob(data, number)?.id || null, timing: current ? require("./workqueue").workStatus(data, require("./workrecord").rootJob(current, data.jobs), { now, config }) : null, blockers, decisions: decisions.map((x) => require("./appdecision").decisionView(data, x, now)),
    current: current ? { id: current.id, state: current.state, status: current.liveLog?.at(-1)?.what || card.status || current.summary || null, summary: current.summary || null, startedAt: current.startedAt || null, updatedAt: current.updatedAt || current.at, plan: current.plan || [] } : null,
    card, receipts, handoffs, history: history.slice(0, 50),
    tasks: jobs.map((j) => ({ id: j.id, canOpen: j.role === "owner", state: j.state, kind: j.kind, summary: j.summary, updatedAt: j.updatedAt || j.at })),
    pullRequests: [...new Set(jobs.flatMap((j) => j.pullRequests || []))], updatedAt: now };
}
function stalledTicketJob(data, number) {
  const job = data.jobs[data.seen?.[`ticket:${number}`]];
  if (job?.kind !== "ticket" || Number(job.ticket) !== number || job.state !== "blocked") return null;
  return job.deadlineBlockedAt || /activation aborted/i.test(job.summary || "") ? job : null;
}
module.exports = { ticketDetail, stalledTicketJob, verifiedPlayerReply };
