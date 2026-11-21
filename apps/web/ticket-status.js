"use strict";

// One word for a finished ticket: Closed.
//
// The ticket database keeps several stored statuses for a finished ticket
// ("resolved" when a resolution receipt was recorded, "closed" otherwise,
// "rejected", merges close with mergedInto). People and agents only ever see
// Open or Closed. Logic that genuinely depends on the stored value (whether a
// player may reopen, whether a receipt is kept) keeps reading ticket.status;
// anything shown goes through ticketStatusLabel so a new surface cannot drift.

// Every stored value seen in the tickets collection or written by the support
// tools and Keir. Unknown values are treated as open: an unrecognised status
// must never make a card or a player-facing page claim the work is finished.
const CLOSED_STATUSES = new Set([
  "resolved", "closed", "rejected", "wont_fix", "wontfix", "not_implementing",
  "completed", "done", "merged", "duplicate", "archived",
]);
const OPEN_STATUSES = new Set([
  "open", "triaging", "assessed", "investigating", "in_progress", "fixing",
  "awaiting_player", "reopened", "blocked", "parked",
]);

function statusOf(ticketOrStatus) {
  if (ticketOrStatus && typeof ticketOrStatus === "object") return String(ticketOrStatus.status || "").trim().toLowerCase();
  return String(ticketOrStatus || "").trim().toLowerCase();
}

function mergedTarget(ticket) {
  if (!ticket || typeof ticket !== "object") return null;
  const target = ticket.mergedInto ?? ticket.merged_into ?? null;
  return target === null || target === undefined || target === "" ? null : target;
}

// True when the ticket is finished, whatever word the database used.
function isTicketClosed(ticketOrStatus) {
  if (mergedTarget(ticketOrStatus) !== null) return true;
  return CLOSED_STATUSES.has(statusOf(ticketOrStatus));
}

// "Open" | "Closed" | "Closed, merged into N". Accepts a ticket record or a
// bare stored status string.
function ticketStatusLabel(ticketOrStatus) {
  const target = mergedTarget(ticketOrStatus);
  if (target !== null) return `Closed, merged into ${target}`;
  if (statusOf(ticketOrStatus) === "merged") return "Closed, merged";
  return isTicketClosed(ticketOrStatus) ? "Closed" : "Open";
}

// "open" | "closed": the machine-readable twin of the label.
function ticketState(ticketOrStatus) {
  return isTicketClosed(ticketOrStatus) ? "closed" : "open";
}

function asDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// When the ticket last became closed: the latest terminal entry in its status
// history, else closedAt / resolvedAt / mergedAt. Null for open tickets.
function ticketClosedAt(ticket) {
  if (!ticket || !isTicketClosed(ticket)) return null;
  const history = Array.isArray(ticket.statusHistory) ? ticket.statusHistory : [];
  let fromHistory = null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i];
    if (!h || !CLOSED_STATUSES.has(statusOf(h))) break;
    const at = asDate(h.at);
    if (at) fromHistory = at; // walk back through the trailing run of terminal entries
  }
  const candidates = [fromHistory, asDate(ticket.closedAt), asDate(ticket.resolvedAt), asDate(ticket.mergedAt)].filter(Boolean);
  if (!candidates.length) return null;
  return fromHistory || candidates.sort((a, b) => b - a)[0];
}

module.exports = {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  isTicketClosed,
  ticketStatusLabel,
  ticketState,
  ticketClosedAt,
};
