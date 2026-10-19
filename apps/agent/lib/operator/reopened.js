"use strict";
const { ticketNumber } = require("./gateway");
const FRESH_MS = 30 * 60000;
const stamp = (v) => typeof v === "number" ? v : Date.parse(v || "");

// A deleted conversation stays terminal. A verified canonical reopen starts a
// fresh job, with fresh handoff context, rather than resurrecting old effects.
function createReopenedTickets({ ledger, config, supportOwner, readTicket, readChannel, now = () => Date.now() }) {
  async function adopt(number, candidate) {
    const d = ledger.data;
    const old = d.jobs[d.seen[`ticket:${number}`]];
    if (!old || old.kind !== "ticket" || old.state !== "done" || !old.channelClosed || d.paused || supportOwner.deferred(old)) return null;
    if (Object.values(old.effects || {}).some((e) => e.state === "started")) return null;
    const pending = (old.pendingHandoffs || []).map((id) => d.handoffDesk?.handoffs?.[id]).filter((h) => h && h.state === "acknowledged" && h.workIds?.includes(`ticket:${number}`) && h.filedAt >= now() - FRESH_MS && h.deadline > now());
    if (!pending.length) return null;
    const canonical = await readTicket(number);
    const conversation = canonical?.conversation;
    const reopenedAt = stamp(conversation?.reopenedAt);
    if (canonical?.number !== number || !["open", "in_progress", "triaging"].includes(canonical.status) || canonical.resolution || ["moderation", "investigation", "incident"].includes(canonical.category)) return null;
    if (!conversation?.reopenRequestId || conversation.previousChannelId !== old.channelId || !conversation.channelId || conversation.channelId === old.channelId || !Number.isFinite(reopenedAt) || reopenedAt <= (old.updatedAt || old.at)) return null;
    const handoffs = pending.filter((h) => h.filedAt >= reopenedAt);
    if (!handoffs.length) return null;
    const ch = candidate || await readChannel(conversation.channelId);
    if (!ch || ch.id !== conversation.channelId || ch.type !== 0 || ch.guild_id !== config.guildId || ticketNumber(ch.name) !== number || ch.topic !== `support-reopen:${number}:${conversation.reopenRequestId}` || d.channels[ch.id]?.claimedBy) return null;
    if (await readChannel(old.channelId)) return null;
    // The canonical read and Discord reads awaited I/O. An owner change or
    // another adoption during those reads invalidates this attempt.
    if (d.seen[`ticket:${number}`] !== old.id || old.state !== "done" || !old.channelClosed || d.paused || supportOwner.deferred(old) || d.channels[ch.id]?.claimedBy) return null;
    const fresh = await readTicket(number);
    if (fresh?.number !== number || !["open", "in_progress", "triaging"].includes(fresh.status) || fresh.resolution || fresh.conversation?.channelId !== ch.id || fresh.conversation?.reopenRequestId !== conversation.reopenRequestId || fresh.conversation?.previousChannelId !== old.channelId || stamp(fresh.conversation?.reopenedAt) !== reopenedAt) return null;
    if (d.seen[`ticket:${number}`] !== old.id || old.state !== "done" || !old.channelClosed || d.paused || supportOwner.deferred(old) || d.channels[ch.id]?.claimedBy) return null;
    const key = `ticket:${number}:reopened:${conversation.reopenRequestId}`;
    const job = ledger.createJob(key, { kind: "ticket", role: "support", ticket: number, channelId: ch.id,
      source: { channelId: ch.id, channelName: ch.name, at: new Date(reopenedAt).toISOString(), content: `Ticket ${number} was explicitly reopened into this new conversation. Read support_get and the fresh handoff before acting. Keep this ticket open for the requested follow-up; the old closure and old final answer are historical, not a current resolution.` },
      deadline: now() + config.taskLifetimeMs, reopenedFromJob: old.id, reopenRequestId: conversation.reopenRequestId,
      pendingHandoffs: handoffs.map((h) => h.id), inbox: handoffs.map((h) => ({ authorId: `handoff:${h.from}`, role: "system", at: new Date(h.filedAt).toISOString(), content: `Handoff from ${h.from} (receipt ${h.id}). Scope: ${h.scope}\nAsks:\n${h.asks.map((a) => `- ${a}`).join("\n")}${h.body ? `\n\n${h.body}` : ""}${h.document ? `\n\nFull handoff document: ${h.document.name} (digest ${h.document.digest}).` : ""}\n\nThis handoff carries context, not approval of any game change. Keep the reopened ticket open.` })) });
    d.seen[`ticket:${number}`] = job.id;
    d.channels[ch.id] = { ...d.channels[ch.id], ticket: number, category: canonical.category };
    ledger.audit("ticket_reopened_canonical", { ticket: number, oldJob: old.id, job: job.id, oldChannel: old.channelId, channel: ch.id, request: conversation.reopenRequestId, handoffs: handoffs.map((h) => h.id) });
    ledger.save();
    return { job: job.id, oldJob: old.id, channelId: ch.id };
  }
  return { adopt };
}
module.exports = { createReopenedTickets, FRESH_MS };
