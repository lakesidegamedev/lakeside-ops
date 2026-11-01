"use strict";
// Where a ticket post can still reach the player (2026-11-01 review).
// Ticket 1743: updates kept going to a ticket staff had merged and closed,
// and failed against a deleted channel. Ticket 1736: a detailed resolution
// was replaced by a one-line "Closed in Discord" receipt twelve hours later.
// Pure: raw ticket document in, verdict out.

// The bot records an out-of-band channel deletion as a ticket message.
function channelGone(ticket) {
  const id = ticket && ticket.discordChannelId;
  if (!id) return false;
  const marker = `Ticket channel ${id} was deleted`;
  return (ticket.messages || []).some((m) => String(typeof m === "string" ? m : (m && (m.content || m.text)) || "").includes(marker));
}

// Why a delivered update would reach nobody, or null when it can go out.
function deliveryRefusal(ticket, number) {
  if (!ticket) return null;
  if (ticket.mergedInto) return `Not delivered: ticket #${number} was merged into #${ticket.mergedInto}. Post the update on #${ticket.mergedInto}, where the reporter now is.`;
  const gone = channelGone(ticket);
  if (gone || ["closed", "rejected"].includes(ticket.status)) return `Not delivered: ticket #${number} is ${ticket.status}${gone ? " and its channel was deleted" : ""}, so nobody would see it. If the player still needs this, reopen it with support_reopen first; otherwise record it without deliver.`;
  return null;
}

// Closing a ticket that already has a resolution receipt keeps that receipt
// and posts nothing new. A same-status call is still a deliberate correction.
const keepsPriorReceipt = (ticket, prior, status) => Boolean(prior && ticket && ticket.status === "resolved" && status === "closed");

module.exports = { channelGone, deliveryRefusal, keepsPriorReceipt };
