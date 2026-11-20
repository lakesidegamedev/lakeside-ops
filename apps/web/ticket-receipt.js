"use strict";

const crypto = require("node:crypto");

const TERMINAL_STATUSES = new Set([
  "resolved",
  "closed",
  "wont_fix",
  "rejected",
  "not_implementing",
  "completed",
  "done",
]);

const PUBLIC_STATUS_LABELS = {
  open: "Report received",
  triaging: "Under review",
  assessed: "Review complete",
  fixing: "Work in progress",
  in_progress: "Work in progress",
  resolved: "Resolved",
  closed: "Closed",
  wont_fix: "Review complete",
  rejected: "Review complete",
  completed: "Completed",
  done: "Completed",
};

const PUBLIC_UPDATE_LABELS = {
  development: "Fix in testing",
  heal: "Game data corrected",
  production: "Fix live",
  resolution: "Resolution shared",
  context: "Details requested",
};

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || "").toLowerCase());
}

function clip(value, max) {
  const text = String(value == null ? "" : value).trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function asDate(value, fallback = null) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .map((action) => {
      if (typeof action === "string") return { label: clip(action, 500) };
      if (!action || typeof action !== "object") return null;
      const label = clip(action.label || action.action || action.title, 500);
      if (!label) return null;
      const detail = clip(action.detail || action.description, 1000);
      return detail ? { label, detail } : { label };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function resolutionId({ message, actions, followUp, source }) {
  const body = JSON.stringify({ message, actions, followUp, source });
  return `receipt-${crypto.createHash("sha1").update(body).digest("hex").slice(0, 20)}`;
}

function normalizeResolution(input, { by = null, now = new Date() } = {}) {
  const raw = typeof input === "string" ? { message: input } : input || {};
  const message = clip(raw.message || raw.summary, 5000);
  if (!message) throw new Error("resolution message is required");
  const actions = normalizeActions(raw.actions);
  const followUp = clip(raw.followUp || raw.followup, 2000) || null;
  const source = ["discord", "agent", "ops"].includes(String(raw.source || ""))
    ? String(raw.source)
    : "ops";
  const resolvedAt =
    asDate(raw.resolvedAt || raw.closedAt || raw.createdAt, now) || now;
  const createdAt = asDate(raw.createdAt, resolvedAt) || resolvedAt;
  const closedBy = clip(raw.closedBy || raw.resolvedBy || by, 160) || null;
  const delivery =
    raw.delivery && typeof raw.delivery === "object"
      ? { ...raw.delivery }
      : { status: "pending" };
  const deliveredAt = asDate(raw.deliveredAt, null);
  return {
    receiptVersion: 1,
    receiptId:
      raw.receiptId || resolutionId({ message, actions, followUp, source }),
    message,
    actions,
    followUp,
    source,
    createdAt,
    resolvedAt,
    ...(closedBy ? { closedBy } : {}),
    delivery,
    ...(deliveredAt ? { deliveredAt } : {}),
  };
}

function getResolution(ticket) {
  if (!ticket || !ticket.resolution) return null;
  try {
    return normalizeResolution(ticket.resolution, {
      by: ticket.closedBy || null,
      now: asDate(ticket.resolution.createdAt, new Date()) || new Date(),
    });
  } catch {
    return null;
  }
}

function nextResolutionVersion(prior, proposed) {
  if (prior && prior.receiptId === proposed.receiptId) return prior;
  return {
    ...proposed,
    ...(prior && prior.channelClose ? { channelClose: prior.channelClose } : {}),
    ...(prior && prior.channelClosedAt
      ? { channelClosedAt: prior.channelClosedAt }
      : {}),
  };
}

function publicStatusLabel(status) {
  const key = String(status || "").toLowerCase();
  return PUBLIC_STATUS_LABELS[key] || "Update recorded";
}

function publicUpdateLabel(kind) {
  return (
    PUBLIC_UPDATE_LABELS[String(kind || "").toLowerCase()] || "Update recorded"
  );
}

function resolutionSourceLabel(source) {
  return (
    {
      discord: "Closed from a Discord request",
      agent: "Closed by the support agent",
      ops: "Closed by support",
    }[String(source || "").toLowerCase()] || "Closed by support"
  );
}

function publicTimeline(ticket) {
  const events = [];
  let sequence = 0;
  const add = ({ label, at, detail = null, kind = "status" }) => {
    const date = asDate(at, null);
    if (!date || !label) return;
    events.push({
      label,
      at: date,
      detail: detail ? clip(detail, 1200) : null,
      kind,
      sequence: sequence++,
    });
  };

  add({
    label: "Report received",
    at: ticket && ticket.createdAt,
    kind: "reported",
  });
  for (const entry of Array.isArray(ticket && ticket.statusHistory)
    ? ticket.statusHistory
    : []) {
    const status = String((entry && entry.status) || "").toLowerCase();
    if (!status) continue;
    add({ label: publicStatusLabel(status), at: entry.at, kind: "status" });
  }
  for (const update of Array.isArray(ticket && ticket.publicUpdates)
    ? ticket.publicUpdates
    : []) {
    if (update && update.supersededAt) continue;
    const kind = String((update && update.kind) || "update").toLowerCase();
    if (kind === "context" && (ticket.publicUpdates || []).some((milestone) => ["development", "production", "heal", "resolution"].includes(milestone.kind) && !milestone.supersededAt && asDate(milestone.at, new Date(0)) <= asDate(update.at, new Date(0)))) continue;
    add({
      label: publicUpdateLabel(kind),
      at: update.at || update.createdAt,
      // A ticket-only update never shows its stored text on the public page.
      detail: update.ticketOnly === true ? require("./ticket-private-reply").genericMessage(kind) : update.message,
      kind,
    });
  }

  const resolution = getResolution(ticket);
  if (isTerminalStatus(ticket && ticket.status) && resolution) {
    add({
      label: publicStatusLabel(ticket.status),
      at: resolution.resolvedAt || ticket.closedAt || ticket.updatedAt,
      kind: "resolution",
    });
  }

  events.sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.sequence - b.sequence,
  );
  const collapsed = [];
  for (const event of events) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && previous.label === event.label && !event.detail) continue;
    collapsed.push(event);
  }
  return collapsed.map(({ sequence: _sequence, ...event }) => event);
}

module.exports = {
  TERMINAL_STATUSES,
  isTerminalStatus,
  normalizeActions,
  normalizeResolution,
  nextResolutionVersion,
  getResolution,
  publicStatusLabel,
  publicUpdateLabel,
  resolutionSourceLabel,
  publicTimeline,
  resolutionId,
};
