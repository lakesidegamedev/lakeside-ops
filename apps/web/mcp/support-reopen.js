"use strict";
const crypto = require("node:crypto");
const tracker = require("./support-tracker");
const { discord, CATEGORY, channelSlug } = require("./support-create-ticket");
const GUILD = process.env.AHD_GUILD_ID || "1465445442987888743";
const CATEGORY_ID = process.env.AHD_TICKET_CATEGORY_ID || "1483979826967744534";
const terminal = (status) => ["closed", "resolved", "rejected", "wont_fix"].includes(status);
const locks = new Set();

function privatePermissions(category, botId, reporterId) {
  const rows = (category.permission_overwrites || []).filter((o) => o.type === 0 || o.id === botId).map(({ id, type, allow, deny }) => ({ id, type, allow, deny }));
  const everyone = rows.find((o) => o.id === GUILD);
  if (everyone) { everyone.allow = String(BigInt(everyone.allow || 0) & ~1024n); everyone.deny = String(BigInt(everyone.deny || 0) | 1024n); }
  else rows.push({ id: GUILD, type: 0, allow: "0", deny: "1024" });
  if (!rows.some((o) => o.id === botId)) rows.push({ id: botId, type: 1, allow: "101392", deny: "0" });
  rows.push({ id: reporterId, type: 1, allow: "101376", deny: "0" });
  return rows;
}

async function reopenTicket({ Tickets, number, receiptId, reason, by, ticketPublicUrl, discordImpl = discord, now = () => new Date() }) {
  if (locks.has(number)) return { ok: false, pending: true, error: "reopen already in progress; retry" };
  locks.add(number);
  let request;
  let lease;
  try {
    let ticket = await Tickets.findOne({ ticketNumber: number });
    if (!ticket) throw new Error("ticket not found");
    if (ticket.reopenRequest?.state === "complete" && ticket.reopenRequest.receiptId === receiptId && !terminal(ticket.status)) {
      const live = await discordImpl(`/channels/${ticket.discordChannelId}`, { allow404: true });
      if (!live) throw new Error("reopened channel is missing; inspect before another reopen");
      return { ok: true, alreadyReopened: true, number, channelId: live.id, receiptUrl: ticketPublicUrl(number) };
    }
    if (!terminal(ticket.status) || ticket.resolution?.receiptId !== receiptId) throw new Error("exact terminal resolution receipt no longer matches");
    if (ticket.mergedInto != null || ticket.category === "moderation") throw new Error("merged or moderation tickets need manual staff handling");
    if (!/^\d{15,22}$/.test(ticket.discordUserId || "")) throw new Error("original reporter is unavailable");
    if (!ticket.discordChannelId) throw new Error("original channel identity is required");
    const old = await discordImpl(`/channels/${ticket.discordChannelId}`, { allow404: true });
    if (old) throw new Error("original channel is still live; refusing duplicate conversation");
    const guard = { _id: ticket._id, status: ticket.status, discordChannelId: ticket.discordChannelId, updatedAt: ticket.updatedAt, "resolution.receiptId": receiptId };
    request = ticket.reopenRequest;
    if (request && request.receiptId !== receiptId) throw new Error("another reopen request needs review");
    if (!request) {
      request = { id: crypto.randomUUID(), receiptId, oldChannelId: ticket.discordChannelId, state: "reserved", createdAt: now(), by, reason };
      const reserved = await Tickets.updateOne({ ...guard, reopenRequest: { $exists: false } }, { $set: { reopenRequest: request } });
      if (!reserved.matchedCount) return { ok: false, pending: true, error: "reservation raced with another update; retry" };
    }
    lease = crypto.randomUUID();
    const acquired = await Tickets.updateOne({ ...guard, "reopenRequest.id": request.id, $or: [{ "reopenRequest.leaseUntil": { $exists: false } }, { "reopenRequest.leaseUntil": { $lte: now() } }] }, { $set: { "reopenRequest.lease": lease, "reopenRequest.leaseUntil": new Date(now().getTime() + 120000) } });
    if (!acquired.matchedCount) return { ok: false, pending: true, error: "reopen lease held or ticket changed; retry after two minutes" };
    const topic = `support-reopen:${number}:${request.id}`;
    const channels = await discordImpl(`/guilds/${GUILD}/channels`);
    const matches = channels.filter((c) => c.topic === topic);
    if (matches.length > 1) throw new Error("multiple channels carry reopen marker; inspect manually");
    let channel = matches[0];
    if (!channel) {
      const category = channels.find((c) => c.id === CATEGORY_ID && c.type === 4);
      if (!category) throw new Error("canonical private ticket category unavailable");
      const member = await discordImpl(`/guilds/${GUILD}/members/${ticket.discordUserId}`);
      const me = await discordImpl("/users/@me");
      const meta = CATEGORY[ticket.category] || CATEGORY.other;
      channel = await discordImpl(`/guilds/${GUILD}/channels`, { method: "POST", body: JSON.stringify({ name: `ticket-${meta.slug}-${channelSlug(member.user.username)}-${number}`, type: 0, parent_id: CATEGORY_ID, topic, permission_overwrites: privatePermissions(category, me.id, ticket.discordUserId) }) });
    }
    if (channel.type !== 0 || channel.parent_id !== CATEGORY_ID || channel.topic !== topic) throw new Error("recovery channel identity is invalid");
    const card = await discordImpl(`/channels/${channel.id}/messages`, { method: "POST", body: JSON.stringify({ nonce: `reopen-${request.id.slice(0, 16)}`, enforce_nonce: true, embeds: [{ title: `🐛 Bug Report - #${number}`, color: 15548997, fields: [{ name: "Reporter", value: `<@${ticket.discordUserId}>` }, { name: "Category", value: CATEGORY[ticket.category]?.label || "Other" }, { name: "Subject", value: String(ticket.title || "Support report").slice(0, 200) }, { name: "Receipt", value: `[View ticket history](${ticketPublicUrl(number)})` }], description: "This ticket has been reopened. The earlier conversation is preserved in the ticket history; support will follow up here." }], components: [{ type: 1, components: [{ type: 2, custom_id: "ticket_claim", style: 2, label: "Claim" }, { type: 2, custom_id: "ticket_close", style: 4, label: "Close Ticket" }] }] }) });
    const stamp = now();
    const updated = await Tickets.updateOne({ ...guard, "reopenRequest.id": request.id, "reopenRequest.lease": lease }, { $set: { status: "in_progress", discordChannelId: channel.id, updatedAt: stamp, reviewAfter: stamp, "intake.cardMessageId": card.id, "reopenRequest.state": "complete", "reopenRequest.channelId": channel.id, "reopenRequest.completedAt": stamp }, $unset: { resolution: "", resolutionAttribution: "", resolvedAt: "", resolvedBy: "", closedAt: "", closedBy: "", "reopenRequest.lease": "", "reopenRequest.leaseUntil": "" }, $push: { resolutionHistory: { ...ticket.resolution, ...(ticket.resolutionAttribution ? { attribution: ticket.resolutionAttribution } : {}) }, conversationHistory: { channelId: request.oldChannelId, replacedAt: stamp, requestId: request.id, reason, by }, statusHistory: { status: "in_progress", at: stamp, by, source: "mcp", note: `Reopened existing ticket: ${reason}` } } });
    if (!updated.matchedCount) return { ok: false, uncertain: true, number, channelId: channel.id, requestId: request.id, error: "ticket changed before reattachment; channel retained for inspection, ticket not reopened" };
    return { ok: true, number, channelId: channel.id, channelUrl: `https://discord.com/channels/${GUILD}/${channel.id}`, receiptUrl: ticketPublicUrl(number), requestId: request.id };
  } catch (error) {
    return { ok: false, pending: Boolean(request), requestId: request?.id, error: String(error.message || error), instruction: request ? "Retry the same number and receipt. Recovery searches the durable channel topic marker before creating anything." : undefined };
  } finally {
    if (request && lease) await Tickets.updateOne({ ticketNumber: number, "reopenRequest.id": request.id, "reopenRequest.lease": lease }, { $unset: { "reopenRequest.lease": "", "reopenRequest.leaseUntil": "" } }).catch(() => {});
    locks.delete(number);
  }
}
function registerReopen(server, { auth, Tickets, TrackerItems, z, jsonResult, errorResult, ticketPublicUrl }) {
  server.tool("support_reopen", "Reopen the same resolved ticket after its Discord channel was deleted. Preserves its number, reporter, receipt and history. Requires the exact current receipt ID and reason; refuses live channels, moderation and merged tickets. Retry with identical inputs after uncertain delivery.", { number: z.number().int().positive(), receipt_id: z.string().min(1).max(100), reason: z.string().trim().min(1).max(500) }, async ({ number, receipt_id, reason }) => {
    if (auth?.scopes?.write !== true) return errorResult("write scope required");
    const result = await reopenTicket({ Tickets, number, receiptId: receipt_id, reason, by: auth.name || "agent", ticketPublicUrl });
    if (result.ok && TrackerItems) {
      try {
        const ticket = await Tickets.findOne({ ticketNumber: number });
        const built = tracker.buildTrackerUpsert("ticket", number, ticket.title, { status: "active", updated_by: auth.name || "agent" }, Date.now());
        if (built.error) throw new Error(built.error);
        await TrackerItems.updateOne({ id: built.id }, built.update, { upsert: true });
        await Tickets.updateOne({ ticketNumber: number, discordChannelId: result.channelId }, { $set: { trackerItemId: built.id, trackerUpdatedAt: new Date() } });
      } catch (error) { result.trackerWarning = String(error.message || error); }
    }
    return jsonResult(result);
  });
}
module.exports = { reopenTicket, registerReopen, privatePermissions };
