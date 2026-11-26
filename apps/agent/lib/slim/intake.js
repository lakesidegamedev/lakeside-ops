"use strict";
// Ticket intake for the slim Keir. Polls the support service for tickets that
// are not closed and turns new messages from people into session events.
// The ticket history (support_history_get) is the source: every player, staff
// and owner message lands there within seconds, Discord channel or not.
//
// Never handled: internal investigation tickets. Moderation tickets are
// handled with their own limits (see BRIEF.md and the mod_summary tool). A ticket already open when Keir starts gets one
// takeover wake; its earlier messages are read from the history, not replayed.

const fs = require("node:fs");
const path = require("node:path");

const SKIP_CATEGORIES = new Set(["investigation"]);
const HUMAN = { player_message: "player", staff_message: "staff", participant_message: "participant" };

function roleFor(e, cfg) {
  const base = HUMAN[e.kind];
  if (!base || base === "player") return base || null;
  const who = String(e.who || "").toLowerCase();
  if (cfg.ownerIds.includes(String(e.authorId || ""))) return "owner";
  if (!e.authorId && (cfg.ownerHandles || []).some((h) => h && who.endsWith(` ${h.toLowerCase()}`))) return "owner";
  return base;
}

function eventFor(e, cfg) {
  const role = roleFor(e, cfg);
  if (!role) return null;
  return { role, name: String(e.who || "").replace(/^(player|staff|other person)\s*/, "") || null, at: new Date(e.at).toISOString(), text: e.text, id: e.id };
}

function createIntakeState(file) {
  let data = { tickets: {} };
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* fresh */ }
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file); };
  return { data, save };
}

async function readAll(mcp, n) {
  const events = []; let offset = 0, head = null;
  for (let i = 0; i < 20; i++) {
    const r = await mcp.call("support", "support_history_get", { number: n, offset, limit: 300 }, false);
    head ||= r; events.push(...(r.events || []));
    if (r.nextOffset == null) break; offset = r.nextOffset;
  }
  return { ...head, events };
}

/**
 * One poll. Returns [{ ticket, events, intro?, takeover?, names }] to deliver.
 * `started` marks the intake's first poll: tickets seen then are taken over.
 */
async function poll({ mcp, cfg, state, first, now = Date.now() }) {
  // Nothing that happened before Keir went live is ever delivered or acted on.
  state.data.liveSince ||= new Date(now).toISOString();
  const live = Date.parse(state.data.liveSince);
  const list = await mcp.call("support", "support_list", { kind: "ticket", openOnly: true, limit: 60 }, false);
  const open = (list.items || []).filter((t) => t.kind === "ticket" && !SKIP_CATEGORIES.has(String(t.category || "").toLowerCase()));
  const out = [];
  const openNow = new Set(open.map((t) => Number(t.number)));
  for (const n of Object.keys(state.data.tickets)) if (!openNow.has(Number(n))) state.data.tickets[n].open = false;
  // Every open ticket's history is read at once; one slow ticket does not hold up the rest.
  const histories = new Map(await Promise.all(open.map(async (t) => [Number(t.number), await readAll(mcp, Number(t.number)).catch(() => null)])));
  for (const t of open) {
    const n = Number(t.number);
    const h = histories.get(n);
    if (!h) continue;
    const known = state.data.tickets[n];
    const names = [h.reporter, h.character].filter(Boolean);
    // The ticket's Discord channel, for the typing indicator and fast pickup.
    let channelId = known?.channelId || null;
    if (!channelId) { try { channelId = (await mcp.call("support", "support_get", { kind: "ticket", number: n }, false))?.conversation?.channelId || null; } catch { /* retried next poll */ } }
    if (!known) {
      const ids = h.events.map((e) => e.id).filter(Boolean);
      const humans = h.events.map((e) => eventFor(e, cfg)).filter(Boolean);
      if (first) {
        state.data.tickets[n] = { seen: ids, open: true, since: new Date().toISOString(), channelId };
        const last = humans[humans.length - 1];
        out.push({ ticket: n, names, category: h.category || null, takeover: true, lastHumanAt: last?.at || null, intro: `Title: ${h.title}. Category: ${h.category || "unknown"}.`,
          events: [{ role: "system", at: new Date().toISOString(), text: "You are taking over this ticket now. Earlier messages and replies (by the support team) are in its history: read it with history_read and ticket_read before doing anything, and do not repeat what was already said." }] });
      } else {
        state.data.tickets[n] = { seen: ids, open: true, since: new Date().toISOString(), channelId };
        const opened = Date.parse(h.opened || h.events[0]?.at || 0);
        // A ticket new to Keir that opened before it went live is a takeover, never a replay of old messages.
        const recent = humans.filter((e) => Date.parse(e.at) >= live);
        // Someone already answered before Keir saw it: never replay it as new. Only messages after the team's
        // last reply are delivered; with none, Keir just starts watching and wakes on the next message.
        const teamAt = Math.max(0, ...h.events.filter((e) => e.kind === "support_post" || e.kind === "staff_message").map((e) => Date.parse(e.at)));
        const unanswered = recent.filter((e) => Date.parse(e.at) > teamAt);
        if (teamAt && !unanswered.length) continue;
        if (opened < live || teamAt) out.push({ ticket: n, names, category: h.category || null, takeover: true, lastHumanAt: humans[humans.length - 1]?.at || null, intro: `Title: ${h.title}. Category: ${h.category || "unknown"}.`,
          events: [{ role: "system", at: new Date(now).toISOString(), text: "You are taking over this ticket now. Earlier messages and replies (by the support team) are in its history: read it with history_read and ticket_read before doing anything, and do not repeat what was already said." }, ...(teamAt ? unanswered : recent)] });
        else out.push({ ticket: n, names, category: h.category || null, isNew: true, channelId, openedAt: h.opened || humans[0]?.at || null, intro: `Title: ${h.title}. Category: ${h.category || "unknown"}.`, events: humans });
      }
      continue;
    }
    known.open = true;
    if (channelId) known.channelId = channelId;
    const seen = new Set(known.seen);
    const fresh = h.events.filter((e) => e.id && !seen.has(e.id));
    if (!fresh.length) continue;
    known.seen.push(...fresh.map((e) => e.id));
    if (known.seen.length > 5000) known.seen = known.seen.slice(-5000);
    const events = fresh.filter((e) => Date.parse(e.at) >= live).map((e) => eventFor(e, cfg)).filter(Boolean);
    if (events.length) out.push({ ticket: n, names, category: h.category || null, events });
  }
  state.save();
  return out;
}

/** Tickets open now that intake has not seen yet (a cheap list read, no history): [{ number, createdAt }]. */
async function newTickets({ mcp, state }) {
  const list = await mcp.call("support", "support_list", { kind: "ticket", openOnly: true, limit: 60 }, false);
  return (list.items || []).filter((t) => t.kind === "ticket" && !SKIP_CATEGORIES.has(String(t.category || "").toLowerCase()) && !state.data.tickets[Number(t.number)]).map((t) => ({ number: Number(t.number), createdAt: t.createdAt || null }));
}

module.exports = { poll, newTickets, roleFor, eventFor, createIntakeState, readAll, SKIP_CATEGORIES };
