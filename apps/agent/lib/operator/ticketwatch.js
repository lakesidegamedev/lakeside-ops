"use strict";
const { JOB_TERMINAL } = require("./machines");
// Keir 10.1 (owner, 2026-11-16): a model-free watchdog over open tickets. Tickets 1833, 1834 and 1835 all
// stalled because a lifecycle step depended on the model remembering a flag, and nothing noticed. These checks
// read only stored facts and the support queue, and tell a person once per ticket and condition:
//   - moderation: a moderation ticket opened (Keir never works these), and again if still open after 4 hours;
//   - unowned:    an open ticket with no Keir task and no staff claim for over an hour;
//   - spinning:   Keir checked the ticket repeatedly with no new player message and no new post;
//   - waiting:    the player spoke last and has waited over 2 hours;
//   - silent:     an answered ticket is still open 6 hours later, or Keir's question to the player has gone
//                 26 hours unanswered without the ticket closing (self-recovery offers to close at 24), with no
//                 owner decision pending.
// Alerts go to the owner as one DM per sweep; moderation items also go to each support delegate.

const HOUR = 3600000;
const LIMITS = { unownedMs: HOUR, waitingMs: 2 * HOUR, silentMs: 6 * HOUR, askedMs: 26 * HOUR, moderationRemindMs: 4 * HOUR, spinRuns: 5 };
const TERMINAL = new Set(JOB_TERMINAL);
const { SUPPORT_CLOSED, endedReason, closeTicketJobs } = require("./ticketstate");
const { QUIET_MS } = require("./autoclose");
const ms = (v) => (typeof v === "number" ? v : Date.parse(v || "") || 0);
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Pure: what is wrong with one open ticket, from stored facts only.
function assess(d, ticket, now, limits = LIMITS) {
  const n = Number(ticket.number);
  const opened = ms(ticket.createdAt);
  if (ticket.category === "moderation") {
    const out = [{ kind: "moderation", key: `moderation:${n}` }];
    if (now - opened >= limits.moderationRemindMs) out.push({ kind: "moderation-open", key: `moderation-open:${n}`, hours: Math.floor((now - opened) / HOUR) });
    return out;
  }
  if (ticket.category === "incident") return [];
  const job = d.jobs?.[d.seen?.[`ticket:${n}`]];
  if (!job || TERMINAL.has(job.state)) {
    if (job?.channelClosed || job?.resolved) return [];
    if (ticket.claimedBy) return [];
    return now - opened >= limits.unownedMs ? [{ kind: "unowned", key: `unowned:${n}` }] : [];
  }
  if (job.resolved || job.channelClosed) return [];
  const out = [];
  const posted = ms(job.lastPublishedAt);
  const heard = Math.max(ms(job.observedPlayerAt), ms(job.lastPlayerAt));
  const pendingDecision = job.ownerDecisionPending || Object.values(d.decisions || {}).some((x) => x.jobId === job.id && x.state === "pending");
  const since = Math.max(posted, heard);
  const runs = (job.activationAt || []).filter((at) => ms(at) > since).length;
  // Keir 10.1.13: an answered ticket waiting out the auto-closer's quiet clock is not spinning (1842); the silent
  // check below owns it if it is still open long after.
  const answered = posted > 0 && posted >= heard;
  if (runs >= limits.spinRuns && !(answered && now - posted < limits.silentMs + QUIET_MS)) out.push({ kind: "spinning", key: `spinning:${n}:${since}`, runs });
  if (heard > posted && now - heard >= limits.waitingMs) out.push({ kind: "waiting", key: `waiting:${n}:${heard}`, hours: Math.floor((now - heard) / HOUR) });
  else if (since && !pendingDecision && now - since >= (job.resolutionReadyAt ? limits.silentMs : limits.askedMs)) out.push({ kind: "silent", key: `silent:${n}:${since}`, hours: Math.floor((now - since) / HOUR) });
  return out;
}

const LINES = {
  moderation: (t) => `New moderation ticket ${t.number}: ${clip(t.title, 80)}${t.description ? `. "${clip(t.description, 200)}"` : ""}. Keir does not work moderation tickets.`,
  "moderation-open": (t, f) => `Moderation ticket ${t.number} (${clip(t.title, 60)}) is still open after ${f.hours} hours.`,
  unowned: (t) => `Ticket ${t.number} (${clip(t.title, 60)}) has been open over an hour with nobody on it.`,
  spinning: (t, f) => `Ticket ${t.number} (${clip(t.title, 60)}): Keir checked it ${f.runs} times with nothing new and has not closed it.`,
  waiting: (t, f) => `Ticket ${t.number} (${clip(t.title, 60)}): the player has waited ${f.hours} hours for a reply.`,
  silent: (t, f) => `Ticket ${t.number} (${clip(t.title, 60)}): no one has posted for ${f.hours} hours and it is still open.`,
};

function createTicketWatch({ ledger, mcp, config, now = () => Date.now(), log = () => {}, limits = LIMITS }) {
  const d = ledger.data;
  async function detail(n) {
    try { return await mcp.call("support", "support_get", { kind: "ticket", number: n }, false, AbortSignal.timeout(8000)); } catch { return null; }
  }
  async function tick() {
    if (d.paused) return { skipped: "paused" };
    const r = await mcp.call("support", "support_list", { kind: "ticket", openOnly: true, limit: 60 }, false, AbortSignal.timeout(8000));
    const open = (Array.isArray(r) ? r : r?.items || []).filter((t) => t && t.number && !["closed", "resolved"].includes(t.status));
    const state = (d.ticketWatch ||= { alerted: {} });
    const t0 = now();
    const fresh = [];
    for (const t of open) {
      for (const f of assess(d, t, t0, limits)) {
        if (state.alerted[f.key]) continue;
        // The unowned check reads the claim and the moderation alert quotes the request; both need the record.
        if (f.kind === "unowned" || f.kind === "moderation") {
          const g = await detail(t.number);
          const ch = g?.conversation?.channelId;
          if (f.kind === "unowned" && ch && d.channels?.[ch]?.claimedBy) { state.alerted[f.key] = t0; continue; }
          if (f.kind === "moderation") t.description = g?.description || "";
        }
        fresh.push({ t, f });
      }
    }
    // Keir 10.1.13 (owner): never alert about a ticket that is already over. The list can lag, so each alerted
    // ticket's real record is read; a resolved or closed one (or a channel deleted outside Keir) stops its jobs instead.
    const ended = new Map();
    for (const { t } of fresh) {
      if (ended.has(t.number)) continue;
      let why = endedReason(d, t.number);
      if (!why) {
        const g = await detail(t.number);
        const status = String(g?.status || "");
        if (SUPPORT_CLOSED.has(status) || g?.resolution) why = `support status ${status || "resolved"}`;
        else if (g?.conversation?.channelClosed || g?.conversation?.channelDeleted || g?.conversation?.status === "closed") why = "channel closed";
      }
      ended.set(t.number, why || null);
      if (why) { closeTicketJobs(ledger, t.number, why, { channelGone: true, skipRunning: true }); ledger.audit("ticket_watch_skipped_ended", { ticket: t.number, why }); }
    }
    for (let i = fresh.length - 1; i >= 0; i--) if (ended.get(fresh[i].t.number)) fresh.splice(i, 1);
    // Forget tickets that closed, so a reopened ticket alerts again.
    const live = new Set(open.map((t) => String(t.number)));
    for (const k of Object.keys(state.alerted)) if (!live.has(k.split(":")[1])) delete state.alerted[k];
    if (!fresh.length) { ledger.save(); return { open: open.length, alerts: 0 }; }
    const ownerLines = fresh.map(({ t, f }) => `- ${LINES[f.kind](t, f)}`);
    ledger.notify(`ticketwatch:${t0}`, "owner", `Tickets that need a look:\n${ownerLines.join("\n")}`);
    const mod = fresh.filter(({ f }) => f.kind.startsWith("moderation")).map(({ t, f }) => `- ${LINES[f.kind](t, f)}`);
    if (mod.length) for (const id of config.staffIds || []) ledger.notify(`ticketwatch:${t0}:${id}`, id, `Moderation tickets:\n${mod.join("\n")}`);
    for (const { f } of fresh) state.alerted[f.key] = t0;
    ledger.audit("ticket_watch_alert", { items: fresh.map(({ f }) => f.key) });
    ledger.save();
    log(`ticket watch: ${fresh.length} alert(s)`);
    return { open: open.length, alerts: fresh.length };
  }
  return { tick };
}

module.exports = { createTicketWatch, assess, LIMITS };
