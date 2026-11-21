"use strict";

// kanban-tickets.js: the live ticket status on kanban cards, and the pass that
// makes cards follow their tickets.
//
// Ticket records are read from the same tickets collection the support tools
// and the ticket hub read (the caller passes its existing getDb; no new
// client or credential). Reads are batched into one query, cached briefly and
// bounded by a timeout. When the ticket service cannot be read a card says
// "ticket status unknown"; an older cached answer is shown with its age, never
// as if it were fresh.

const { isTicketClosed, ticketStatusLabel, ticketClosedAt } = require("./ticket-status");
const { ticketClosedSentence, shortDay } = require("./kanban-store");

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 4_000;
const KEEP_STALE_MS = 6 * 3_600_000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`ticket read timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function resolutionLine(ticket) {
  const r = ticket && ticket.resolution;
  const text = r && typeof r === "object" ? (r.summary || r.message) : typeof r === "string" ? r : "";
  if (!text) return null;
  // The start of the player-facing answer, up to about two short sentences.
  const line = String(text).replace(/\s+/g, " ").trim();
  if (line.length <= 160) return line;
  const cut = line.slice(0, 160);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 120))}...`;
}

// A ticket record -> what the kanban needs. Stored "resolved" and "closed"
// both come out as Closed; the stored value is kept only as stored_status.
function ticketSnapshot(ticket) {
  const closedAt = ticketClosedAt(ticket);
  return {
    number: ticket.ticketNumber,
    state: isTicketClosed(ticket) ? "closed" : "open",
    label: ticketStatusLabel(ticket),
    closed_at: closedAt ? closedAt.toISOString() : null,
    merged_into: ticket.mergedInto ?? null,
    resolution: isTicketClosed(ticket) ? resolutionLine(ticket) : null,
    title: ticket.title ? String(ticket.title).slice(0, 200) : null,
    stored_status: ticket.status || null,
  };
}

function ageText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} seconds`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes`;
  return `${Math.round(m / 60)} hours`;
}

// getDb: async () => a Mongo db with the tickets collection.
function createTicketStatusReader({ getDb, ttlMs = DEFAULT_TTL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const cache = new Map(); // number -> { snapshot, fetchedAt }
  let lastError = null;

  async function fetch(numbers) {
    if (!getDb) throw new Error("no ticket database configured");
    const db = await withTimeout(Promise.resolve(getDb()), timeoutMs);
    const rows = await withTimeout(db.collection("tickets").find(
      { ticketNumber: { $in: numbers } },
      { projection: { ticketNumber: 1, title: 1, status: 1, closedAt: 1, resolvedAt: 1, mergedInto: 1, mergedAt: 1, statusHistory: 1, "resolution.message": 1, "resolution.summary": 1 } },
    ).toArray(), timeoutMs);
    return rows;
  }

  // Returns Map(number -> status). Every requested number gets an entry:
  // { state: "open" | "closed" | "unknown", label, closed_at, checked_at,
  //   age_seconds, fresh, note? }.
  // fresh: true skips the cache (the reconcile pass never acts on a cached read).
  async function statuses(input, { fresh = false } = {}) {
    const numbers = [...new Set((input || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
    const at = now();
    const out = new Map();
    const need = fresh ? numbers : numbers.filter((n) => { const c = cache.get(n); return !c || at - c.fetchedAt >= ttlMs; });
    let failed = null;
    if (need.length) {
      try {
        const rows = await fetch(need);
        const fetchedAt = now();
        const found = new Set();
        for (const row of rows) {
          const n = Number(row.ticketNumber);
          if (!Number.isSafeInteger(n)) continue;
          found.add(n);
          cache.set(n, { snapshot: ticketSnapshot(row), fetchedAt });
        }
        for (const n of need) if (!found.has(n)) cache.set(n, { snapshot: { number: n, state: "unknown", label: "ticket status unknown", note: `no ticket ${n} in the ticket records` }, fetchedAt });
        lastError = null;
      } catch (error) {
        failed = String(error && error.message || error).slice(0, 200);
        lastError = { at, message: failed };
      }
    }
    for (const n of numbers) {
      const c = cache.get(n);
      const fetchedNow = need.includes(n) && !failed;
      if (!c || (failed && need.includes(n) && (fresh || at - c.fetchedAt > KEEP_STALE_MS))) {
        out.set(n, { number: n, state: "unknown", label: "ticket status unknown", checked_at: null, age_seconds: null, fresh: false, note: `the ticket service could not be read${failed ? ` (${failed})` : ""}` });
        continue;
      }
      const ageMs = Math.max(0, at - c.fetchedAt);
      const stale = !fetchedNow && ageMs >= ttlMs;
      out.set(n, {
        ...c.snapshot,
        checked_at: new Date(c.fetchedAt).toISOString(),
        age_seconds: Math.round(ageMs / 1000),
        fresh: !stale,
        ...(stale ? { note: `last read ${ageText(ageMs)} ago; the ticket service could not be read just now` } : {}),
      });
    }
    return out;
  }

  return { statuses, lastError: () => lastError, clear: () => cache.clear() };
}

// What a person or agent reads for one ticket: "Ticket 1852: Closed on 17 Nov".
function ticketLine(st, at = Date.now()) {
  if (!st || st.state === "unknown") return `Ticket ${st ? st.number : "?"}: ticket status unknown${st && st.note ? ` (${st.note})` : ""}`;
  const day = st.state === "closed" && st.closed_at ? ` on ${shortDay(st.closed_at, at)}` : "";
  const age = st.fresh === false && st.note ? ` (${st.note})` : "";
  return `Ticket ${st.number}: ${st.label}${day}${age}`;
}

// The warning that leads a card whose ticket is closed but which is still
// open. Empty when nothing is wrong.
function ticketWarning(item, statusMap, at = Date.now()) {
  if (!item || item.lane === "done" || !Array.isArray(item.tickets) || !item.tickets.length) return null;
  const closed = item.tickets.map((n) => statusMap.get(n)).filter((st) => st && st.state === "closed");
  if (!closed.length) return null;
  const sentence = closed.map((st) => ticketClosedSentence(st.number, { closed_at: st.closed_at, merged_into: st.merged_into }, at)).join(" ");
  const still = closed.length === item.tickets.length ? "" : ` Ticket ${item.tickets.filter((n) => !closed.some((st) => st.number === n)).join(", ")} is still open or unknown.`;
  const lastClosed = closed.map((st) => Date.parse(st.closed_at) || 0).reduce((a, b) => Math.max(a, b), 0);
  const workedAfter = lastClosed > 0 && Date.parse(item.last_progress_at || "") > lastClosed;
  const what = item.ticket_role === "follow_up" || (item.github && item.github.repo) || workedAfter
    ? "This card is leftover follow-up work, not the ticket."
    : "This card was raised as the ticket's own work and is not done; it is not evidence that the ticket is being worked. The ticket reconcile pass will close it.";
  const stale = item.activity === "no recent activity" ? ` Its assignee ${item.assigned_to} has reported nothing recently.` : "";
  return `${sentence}${still} ${what}${stale}`;
}

// Put the true ticket status on cards. Warnings lead the object so an agent
// reads them first. Never throws: on any failure the cards come back with
// "ticket status unknown".
async function decorateItems(items, reader, { now = () => Date.now() } = {}) {
  const list = Array.isArray(items) ? items : [];
  const numbers = [...new Set(list.flatMap((it) => (Array.isArray(it.tickets) ? it.tickets : [])))];
  let map = new Map();
  if (numbers.length) {
    try {
      map = reader ? await reader.statuses(numbers) : new Map();
    } catch {
      map = new Map();
    }
  }
  const at = now();
  return list.map((it) => {
    if (!Array.isArray(it.tickets) || !it.tickets.length) return it;
    const st = it.tickets.map((n) => map.get(n) || { number: n, state: "unknown", label: "ticket status unknown", note: "the ticket service is not connected here" });
    const warning = ticketWarning(it, map, at);
    const ticket_status = st.map((s) => ({
      number: s.number, status: s.state === "unknown" ? "unknown" : s.label, closed_at: s.closed_at || null,
      ...(s.resolution ? { resolution: s.resolution } : {}), checked_at: s.checked_at || null, age_seconds: s.age_seconds ?? null,
      ...(s.note ? { note: s.note } : {}), summary: ticketLine(s, at),
    }));
    const closedButOpen = Boolean(warning);
    const label = it.ticket_role === "follow_up" || (it.github && it.github.repo)
      ? (st.some((s) => s.state === "closed") ? `Follow-up from closed ticket ${st.filter((s) => s.state === "closed").map((s) => s.number).join(", ")}` : `Follow-up from ticket ${it.tickets.join(", ")}`)
      : null;
    return {
      ...(warning ? { ticket_warning: warning } : {}),
      ...(it.activity ? { activity_warning: it.stale_reason } : {}),
      ...it,
      ticket_status,
      ticket_closed_card_open: closedButOpen,
      ...(label ? { ticket_label: label } : {}),
    };
  });
}

async function decorateItem(item, reader, opts) {
  const [out] = await decorateItems([item], reader, opts);
  return out;
}

// Board, list and brief shapes.
async function decorateList(result, reader, opts) {
  return { ...result, items: await decorateItems(result.items, reader, opts) };
}

async function decorateBrief(brief, reader, opts) {
  const sections = ["mine", "blocked", "now", "next"];
  const out = { ...brief };
  const all = sections.flatMap((k) => brief[k] || []);
  const decorated = await decorateItems(all.map((l) => ({ ...l, tickets: l.tickets || [], assigned_to: l.owner, github: l.github ? { repo: l.github } : null, activity: l.activity ? "no recent activity" : null, stale_reason: l.activity || null })), reader, opts);
  const byId = new Map(decorated.map((d) => [d.id, d]));
  for (const k of sections) {
    if (!Array.isArray(brief[k])) continue;
    out[k] = brief[k].map((l) => {
      const d = byId.get(l.id);
      if (!d || !d.ticket_status) return l;
      return { ...(d.ticket_warning ? { ticket_warning: d.ticket_warning } : {}), ...l, tickets: d.ticket_status.map((s) => s.summary) };
    });
  }
  return out;
}

// The reconcile pass. Reads every needed ticket fresh (never the cache); when
// that read fails, ticket rules do nothing this run.
async function runTicketReconcile({ store, reader, dryRun = false, limit } = {}) {
  const numbers = store.ticketNumbersToCheck();
  let statuses = new Map();
  let ticketsReadable = true;
  let error = null;
  if (numbers.length) {
    try {
      statuses = await reader.statuses(numbers, { fresh: true });
      if (numbers.every((n) => (statuses.get(n) || {}).state === "unknown") && reader.lastError && reader.lastError()) {
        ticketsReadable = false;
        error = reader.lastError().message;
      }
    } catch (e) {
      ticketsReadable = false;
      error = String(e && e.message || e);
    }
  }
  const result = store.reconcileTickets({ statuses, ticketsReadable, dryRun, limit });
  return { ...result, tickets_checked: numbers.length, ...(error ? { ticket_error: `ticket service unreachable, ticket rules skipped: ${error}` } : {}) };
}

module.exports = {
  createTicketStatusReader,
  ticketSnapshot,
  ticketLine,
  ticketWarning,
  decorateItems,
  decorateItem,
  decorateList,
  decorateBrief,
  runTicketReconcile,
};
