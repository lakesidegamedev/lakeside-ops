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

function wakePrompt({ ticket, state, events, now, first, intro }) {
  const parts = [];
  parts.push(`Now: ${new Date(now).toISOString()}`);
  if (first) parts.push(`This is ticket ${ticket}. ${intro || ""} Start by reading it with ticket_read.`.trim());
  if (state.paused) parts.push(`The ticket is PAUSED by ${state.paused.by}. Do not post or change anything; finish.`);
  parts.push("New since you last finished:", formatEvents(events) || "- (nothing new; you were woken by a reminder)");
  parts.push("Ticket state:", S.render(state));
  parts.push("Do what the ticket needs now, keep the state current, and end with finish.");
  return parts.join("\n\n");
}

function createHost({ cfg, store, sessions, toolServer, adaptersFor, killSwitch, checkoutFor, sandboxFor = () => "read-only", now = () => Date.now(), log = () => {}, onWake = () => {}, alert = async () => {} }) {
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

  async function wakeOnce(n, events, { intro } = {}) {
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

    const ctx = { ticket: n, cfg, store, adapters: adaptersFor(n), killSwitch, now, effects: [], ruleHits: [], finished: null, playerNames: () => store.load(n).playerNames || [], ownerSpoke: queued.some((e) => e.role === "owner") };
    const tools = buildTools(ctx);
    const calls = [];
    const endpoint = await toolServer.open({ tools, ctx, onCall: (c) => calls.push({ at: new Date(now()).toISOString(), name: c.name, ok: c.ok, ...(c.ok ? {} : { error: String(c.error).slice(0, 300) }) }) });
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
        prompt: wakePrompt({ ticket: n, state: store.load(n), events: queued, now: now(), first: !state.sessionId, intro }) + (images.length ? `\n\n${images.length} screenshot(s) from this ticket are attached to this message as images. Look at them before asking anything about them.` : ""),
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

module.exports = { createHost, instructions, formatEvents, wakePrompt };
