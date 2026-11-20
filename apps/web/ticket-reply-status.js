"use strict";

// The desk describes support delivery receipts, not everything a human might
// have said directly in Discord. Never count an intake card or an older room.
function ticketReplyState(ticket) {
  const room = ticket.discordChannelId;
  if (!room || ticket.category === "investigation") return null;
  const reopened = ticket.reopenRequest?.state === "complete";
  const since = Date.parse(reopened ? ticket.reopenRequest.completedAt : ticket.createdAt);
  if (!Number.isFinite(since)) return null;
  let first = Infinity;
  for (const update of ticket.publicUpdates || []) {
    const receipt = update?.delivery;
    if (update?.deliveryMode !== "reply" || receipt?.status !== "posted" || receipt.channelId !== room ||
        !/^\d{16,20}$/.test(receipt.messageId || "") || receipt.messageId === ticket.intake?.cardMessageId) continue;
    const sent = Date.parse(receipt.postedAt);
    if (sent >= since && sent < first) first = sent;
  }
  return Number.isFinite(first) ? { state: "delivered", at: new Date(first).toISOString() } : { state: "no_receipt" };
}

module.exports = { ticketReplyState };
