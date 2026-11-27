"use strict";
// The per-ticket session host. Each ticket has one continuing session; new
// events (player, staff or owner messages, an owner's answer, a reminder) are
// added to it in order, one wake at a time per ticket. Owner and staff
// messages go first. Nothing here retries a wake, counts handoffs or silences
// Keir because someone else posted: a person posting is context, and only an
// explicit pause stops Keir.

const fs = require("node:fs");
const path = require("node:path");
const S = require("./state");
const { buildTools } = require("./tools");

const ROLE_ORDER = { owner: 0, staff: 1, approval: 2, player: 3, participant: 4, reminder: 5, system: 6 };
const LABEL = { owner: "OWNER", staff: "STAFF", player: "PLAYER", participant: "OTHER PERSON", approval: "OWNER ANSWER", reminder: "REMINDER", system: "SYSTEM" };

function instructions() {
  const dir = __dirname;
  return [fs.readFileSync(path.join(dir, "BRIEF.md"), "utf8"), fs.readFileSync(path.join(dir, "STYLE.md"), "utf8")].join("\n\n");
}

function formatEvents(events) {
  return [...events]
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || Date.parse(a.at) - Date.parse(b.at))
    .map((e) => `- [${e.at}] ${LABEL[e.role] || e.role.toUpperCase()}${e.name ? ` ${e.name}` : ""}: ${String(e.text || "").trim() || "(no text)"}${e.images ? ` [${e.images} screenshot(s)]` : ""}`)
    .join("\n");
}

const TEAM_KINDS = new Set(["support_post", "staff_message", "status", "resolution", "fix", "finding", "heal_request", "reopen", "merge"]);
const ROUTINE = /^(?:resolution receipt recorded|discord-ticket-|closed; earlier resolution receipt kept|ticket channel)/i;
const sameText = (a, b) => String(a || "").replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase() === String(b || "").replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase();

/** What the team (not this session) did on the ticket since the last sync, oldest first. */
function teamActivity(events, state) {
  const since = Date.parse(state.syncedAt || 0) || 0;
  const mine = (state.posts || []).map((p) => p.text);
  return events
    .filter((e) => TEAM_KINDS.has(e.kind) && Date.parse(e.at) > since)
    .filter((e) => !(e.kind === "support_post" && mine.some((t) => sameText(t, e.text))))
    .filter((e) => !(e.kind === "status" && (!String(e.text || "").trim() || ROUTINE.test(String(e.text).trim()))))
    .map((e) => ({ at: new Date(e.at).toISOString(), who: e.kind === "support_post" ? "support team post" : e.kind === "staff_message" ? String(e.who || "staff") : `${e.kind} by ${String(e.who || "the team")}`, text: String(e.text || "").replace(/\s+/g, " ").trim().slice(0, 500) }))
    .slice(-12);
}

function wakePrompt({ ticket, state, events, now, first, intro, teamUpdates = [] }) {
  const parts = [];
  parts.push(`Now: ${new Date(now).toISOString()}`);
  if (teamUpdates.length) parts.push("The team worked on this ticket since you last did. This wins over your own earlier notes and plans: re-plan from it, and never build or post something they already did.", teamUpdates.map((u) => `- [${u.at}] ${u.who}: ${u.text}`).join("\n"));
  if (first) parts.push(`This is ticket ${ticket}. ${intro || ""} Start by reading it with ticket_read.`.trim());
  if (state.paused) parts.push(`The ticket is PAUSED by ${state.paused.by}. Do not post or change anything; finish.`);
  parts.push("New since you last finished:", formatEvents(events) || "- (nothing new; you were woken by a reminder)");
  parts.push("Ticket state:", S.render(state));
  if (events.some((e) => ["player", "owner", "staff", "participant"].includes(e.role))) parts.push("Answer first, investigate after: they are waiting and can see you typing. As soon as one quick read gives you something true and useful, post it (with self-review), then keep investigating and post the rest when you have it. Never post a canned \"looking into it\".");
  parts.push("Do what the ticket needs now, keep the state current, and end with finish.");
  return parts.join("\n\n");
}

function createHost({ cfg, store, sessions, toolServer, adaptersFor, killSwitch, checkoutFor, sandboxFor = () => "read-only", now = () => Date.now(), log = () => {}, onWake = () => {}, onEffect = () => {}, alert = async () => {} }) {
  const chains = new Map();
  const pendingDir = path.join(cfg.stateDir, "pending");
  fs.mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
  const pendingFile = (n) => path.join(pendingDir, `ticket-${Number(n)}.json`);
  const loadPending = (n) => { try { return JSON.parse(fs.readFileSync(pendingFile(n), "utf8")); } catch { return []; } };
  const savePending = (n, list) => fs.writeFileSync(pendingFile(n), JSON.stringify(list), { mode: 0o600 });
  // Messages being worked when the process stopped go back to pending, so a
  // restart in the middle of a wake loses nothing.
  const inflightFile = (n) => path.join(pendingDir, `inflight-${Number(n)}.json`);
  for (const f of fs.readdirSync(pendingDir).filter((x) => /^inflight-\d+\.json$/.test(x))) {
    const n = Number(f.match(/\d+/)[0]);
    try { savePending(n, [...JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf8")), ...loadPending(n)]); } catch { /* unreadable: dropped */ }
    fs.rmSync(path.join(pendingDir, f), { force: true });
  }

  /** Queue events for a ticket and wake its session when allowed. */
  function deliver(ticket, events, opts = {}) {
    const n = Number(ticket);
    const prev = chains.get(n) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => wakeOnce(n, events, opts));
    chains.set(n, next);
    return next;
  }

  async function wakeOnce(n, events, opts) {
    const { intro } = opts || {};
    let state = store.load(n);
    for (const e of events) if (e.role && e.role !== "approval" && e.role !== "reminder") state = S.recordHuman(state, e);
    if (events.some((e) => e.role === "reminder")) state.reminder = null;
    store.save(state);
    const queued = [...loadPending(n), ...events];
    if (cfg.mode === "off") { savePending(n, queued); return { ticket: n, skipped: "off" }; }
    if (killSwitch.state().engaged) { savePending(n, queued); return { ticket: n, skipped: "kill switch" }; }
    if (state.paused) { savePending(n, queued); return { ticket: n, skipped: "paused" }; }
    if (state.closed && !events.some((e) => ["player", "owner", "staff"].includes(e.role))) { savePending(n, []); return { ticket: n, skipped: "closed" }; }
    // Budget: a ceiling per ticket, then pause and tell the coordinator.
    const day = new Date(now()).toISOString().slice(0, 10);
    if (state.budget.day !== day) { state.budget = { ...state.budget, day, wakes: 0 }; store.save(state); }
    if (state.budget.wakes >= cfg.budget.wakesPerDay || state.budget.minutes >= cfg.budget.minutesPerTicket) {
      state.paused = { by: "budget", at: new Date(now()).toISOString(), reason: `budget reached (${state.budget.wakes} wakes today, ${Math.round(state.budget.minutes)} minutes in all)` };
      store.save(state); savePending(n, queued);
      if (!state.budget.alerted) { state.budget.alerted = true; store.save(state); await alert({ ticket: n, reason: state.paused.reason }).catch(() => {}); }
      return { ticket: n, skipped: "budget" };
    }
    savePending(n, []);
    fs.writeFileSync(inflightFile(n), JSON.stringify(queued), { mode: 0o600 });

    const ctx = { ticket: n, cfg, store, adapters: adaptersFor(n), killSwitch, now, effects: [], ruleHits: [], finished: null, playerNames: () => store.load(n).playerNames || [], ownerSpoke: queued.some((e) => e.role === "owner"), onEffect: (e) => onEffect(n, e) };
    const tools = buildTools(ctx);
    const calls = [];
    const endpoint = await toolServer.open({ tools, ctx, onCall: (c) => calls.push({ at: new Date(now()).toISOString(), name: c.name, ok: c.ok, ...(c.ok ? {} : { error: String(c.error).slice(0, 300) }) }) });
    // The team's activity on the ticket since the last wake (staff, owner and coordinator posts, fixes, status notes)
    // is read from the history first. It wins over the session's own notes: the next step is re-planned from it.
    let teamUpdates = [];
    try {
      const h = await ctx.adapters.historyRead?.({ number: n, limit: 300 });
      if (h?.events) {
        const s1 = store.load(n);
        teamUpdates = teamActivity(h.events, s1);
        const latest = h.events.reduce((m, e) => Math.max(m, Date.parse(e.at) || 0), Date.parse(s1.syncedAt || 0) || 0);
        if (teamUpdates.length) {
          const facts = teamUpdates.map((u) => ({ fact: `${u.who} (${u.at.slice(0, 16).replace("T", " ")} UTC): ${u.text}`, source: "ticket history, team update" }));
          const synced = S.applyUpdate(s1, { established: facts, next: { step: "Re-plan from the team's latest update before acting: it wins over your own earlier notes", waits_on: "nothing" } }, now());
          synced.syncedAt = new Date(latest).toISOString();
          store.save(synced);
        } else if (latest) { s1.syncedAt = new Date(latest).toISOString(); store.save(s1); }
      }
    } catch (e) { log(`[keir-slim] ticket ${n} team sync: ${e.message}`); }

    // Screenshots: attach every image this session has not seen yet. If they cannot be loaded, the session is told once.
    let images = [];
    if (adaptersFor && (!state.sessionId || queued.some((e) => ["player", "staff", "owner", "participant"].includes(e.role)))) {
      try {
        const got = (await ctx.adapters.ticketImages?.(n)) || [];
        const s0 = store.load(n);
        const seen = new Set(s0.seenImages || []);
        const dir = path.join(cfg.stateDir, "sessions", `ticket-${n}`, "images");
        for (const img of got) {
          const hash = require("node:crypto").createHash("sha1").update(img.data).digest("hex").slice(0, 16);
          if (seen.has(hash)) continue;
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const file = path.join(dir, `${hash}.${(img.mimeType.split("/")[1] || "png").replace("jpeg", "jpg")}`);
          fs.writeFileSync(file, Buffer.from(img.data, "base64"), { mode: 0o600 });
          images.push(file); seen.add(hash);
        }
        if (images.length) { s0.seenImages = [...seen].slice(-50); store.save(s0); }
      } catch (e) {
        const s0 = store.load(n);
        if (!s0.imageFailNoted) {
          s0.imageFailNoted = true; store.save(s0);
          queued.push({ role: "system", at: new Date(now()).toISOString(), text: "This ticket's screenshots could not be loaded for you. If it matters, say so once, then work from the text, the page link and the records. Never ask the player again to describe or resend a screenshot." });
        }
        log(`[keir-slim] ticket ${n} images: ${e.message}`);
      }
    }
    const started = now();
    let outcome;
    try {
      outcome = await sessions.wake({
        ticket: n,
        sessionId: state.sessionId,
        cwd: checkoutFor(n),
        sandbox: sandboxFor(n),
        instructions: instructions(),
        prompt: wakePrompt({ ticket: n, state: store.load(n), events: queued, now: now(), first: !state.sessionId, intro, teamUpdates }) + (images.length ? `\n\n${images.length} screenshot(s) from this ticket are attached to this message as images. Look at them before asking anything about them.` : ""),
        images,
        url: endpoint.url,
        completionUrl: endpoint.completionUrl,
        timeoutMs: cfg.wakeTimeoutMs,
      });
    } catch (e) {
      outcome = { error: e.message };
      log(`[keir-slim] ticket ${n} wake failed: ${e.message}`);
    } finally {
      endpoint.close();
      fs.rmSync(inflightFile(n), { force: true });
    }
    const minutes = (now() - started) / 60000;
    state = store.load(n);
    if (outcome.sessionId) state.sessionId = outcome.sessionId;
    state.budget.wakes += 1;
    state.budget.minutes += minutes;
    store.save(state);
    // The newest message from a person must never be left without a reply because a post was refused: retry it.
    const after = store.load(n);
    const lastPostAt = Math.max(0, ...after.posts.filter((p) => p.delivered !== false).map((p) => Date.parse(p.at)));
    const unanswered = after.lastHumanAt && Date.parse(after.lastHumanAt) > lastPostAt && !after.closed && !after.paused;
    if (unanswered && ctx.ruleHits.length) {
      const tries = after.retryFor === after.lastHumanAt ? after.retries || 0 : 0;
      if (tries < 2 && (!after.reminder || (after.reminder.minutes || 99) > 5)) {
        after.retryFor = after.lastHumanAt; after.retries = tries + 1;
        after.reminder = { after: "5 minutes", minutes: 5, reason: "Answer the person's newest message in one consolidated reply: your last draft was refused", setAt: new Date(now()).toISOString() };
        store.save(after);
      }
    }
    const report = { ticket: n, events: queued, startedAt: new Date(started).toISOString(), minutes: Math.round(minutes * 100) / 100, finished: Boolean(ctx.finished || outcome.completion), sessionId: state.sessionId, restarted: Boolean(outcome.restarted), timedOut: Boolean(outcome.timedOut), error: outcome.error || null, usage: outcome.usage || null, effects: ctx.effects, ruleHits: ctx.ruleHits, calls, finalText: outcome.result || null };
    onWake(report);
    return report;
  }

  function pause(ticket, { by, reason }) {
    const s = store.load(ticket);
    s.paused = { by: String(by || "staff").slice(0, 80), at: new Date(now()).toISOString(), reason: String(reason || "").slice(0, 300) };
    store.save(s);
    return s.paused;
  }

  /** Resume a paused ticket; anything that arrived meanwhile is delivered. */
  function resume(ticket) {
    const s = store.load(ticket);
    s.paused = null;
    if (s.budget) s.budget.alerted = false;
    store.save(s);
    return deliver(ticket, [{ role: "system", at: new Date(now()).toISOString(), text: "The pause is lifted." }]);
  }

  /** The player's own names (account, display, character), for the name rule. */
  function setPlayerNames(ticket, names) {
    const s = store.load(ticket);
    s.playerNames = [...new Set((names || []).filter(Boolean).map((x) => String(x).slice(0, 60)))];
    store.save(s);
    return s.playerNames;
  }

  /** The owner's answer to an approval request becomes an event in the session. */
  function answer(ticket, approvalId, { status, text, by = "owner" }) {
    const { state, approval } = S.answerApproval(store.load(ticket), approvalId, { status, text }, now());
    if (!approval) throw new Error(`no approval ${approvalId} on ticket ${ticket}`);
    store.save(state);
    return deliver(ticket, [{ role: "approval", name: by, at: new Date(now()).toISOString(), text: `${approval.kind} ${approval.id} (${approval.summary}): ${approval.status}${approval.answer ? `, ${approval.answer}` : ""}` }]);
  }

  return { deliver, pause, resume, setPlayerNames, answer, wakePrompt, formatEvents };
}

module.exports = { createHost, instructions, formatEvents, wakePrompt, teamActivity };
