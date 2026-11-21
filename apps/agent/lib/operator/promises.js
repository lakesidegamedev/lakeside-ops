"use strict";
// Keir 11.2 (audit 2026-11-21, P0-1, H2): promises keep themselves.
//
// Ticket 1868 was told "once a turn has run on it, I will compare your revenue with before and tell you what it did".
// The job was then blocked by the activation time limit, a blocked job never wakes on a timer, the promise was never
// written to the ticket's promise list (the model was trusted to file it), and four turns passed with no follow-up.
//
// Now the post path records every follow-up promise with a due time, whatever the model does. When a promise comes due
// the ticket's task is woken even if it is blocked or finished, with the promise in front of it. If it still has not
// posted after a second wake, the player gets one plain "I can't confirm this yet" line from code and staff hear once.
// A later Keir reply on the ticket keeps the promise. Closed, stopped or staff-held tickets are never woken.
//
// Third pass (review B3, m2, m3): the keeper cannot feed itself. A reply made after a promise wake, before the player or
// staff write again, never records or re-arms a promise; "I can't confirm yet" after a wake ends that promise. Each
// promise gets at most two wakes and one fallback line, and each ticket at most MAX_TICKET_WAKES wakes and one fallback
// line a day. Refusals, quoted speech and "we'll see" are not promises. The owner hears what actually reached the player.
const { JOB_TERMINAL } = require("./machines");
const controlsLib = require("./controls");

const HOUR = 3600000;
const DUE = Object.freeze({ turn: 90 * 60000, release: 4 * HOUR, today: 6 * HOUR, tomorrow: 24 * HOUR, owner: 12 * HOUR, plain: 4 * HOUR });
const RETRY_MS = 30 * 60000;
const KEEP_AFTER_MS = 10 * 60000; // parts of the same reply and instant notices do not keep it
const MAX_OPEN = 5;
const FALLBACK = "I can't confirm this yet. I'm still checking and will update this ticket when I can.";
const DAY = 24 * HOUR;
const MAX_TICKET_WAKES = 4;
const MAX_TICKET_FALLBACKS = 1;
// "I can't confirm yet" and its close relatives: after a wake, that answer ends the promise.
const CANNOT_CONFIRM = /\b(?:can(?:'|’)?t|cannot|can not|unable to|not able to)\s+(?:yet\s+)?(?:confirm|verify|say|tell you)\b|\bno confirmed answer yet\b|\bnot (?:confirmed|known) yet\b/i;
function cannotConfirm(text) { return CANNOT_CONFIRM.test(String(text || "")); }
// Keir 11.2 second pass: a turn promise comes due when the game's turn has actually advanced past the turn it was made
// in, read from the turn clock the watch keeps (game_overview every 5 minutes; operator.js watchTick). When that read is
// stale or failing, the fixed duration (DUE.turn) is the fallback. A game that is paused or stuck still brings the
// promise due after TURN_BACKSTOP_MS, so the player hears "I can't confirm yet" rather than nothing.
const CLOCK_FRESH_MS = 20 * 60000;
const TURN_BACKSTOP_MS = 8 * HOUR;
const GRACE_MS = 10 * 60000;
function clockOf(d, now) {
  const c = d?.watch?.turnClock;
  return c && Number.isFinite(c.turn) && now - (c.at || 0) <= CLOCK_FRESH_MS ? c : null;
}
function isDue(d, p, now) {
  if (p.kind === "turn" && Number.isFinite(p.afterTurn)) {
    const clock = clockOf(d, now);
    if (clock) return clock.turn >= p.afterTurn || now >= p.at + TURN_BACKSTOP_MS;
    return now >= p.at + DUE.turn;
  }
  return p.dueAt <= now;
}
// A recorded promise the next post may keep: a turn promise once its turn has run (or it was woken for it); any other
// open promise at any time, since coming back early with the answer keeps it.
function calledFor(d, ticket, now) {
  return (d.ticketPromises?.[ticket] || []).some((p) => p.state === "open" && (p.wokenAt || isDue(d, p, now) || !(p.kind === "turn" && Number.isFinite(p.afterTurn))));
}

// First person, future, a follow-up verb: "I will compare...", "I'll confirm here once...", "we'll let you know".
const FOLLOW = /\b(?:i|we)(?:'|’)?(?:ll| will| am going to| are going to|'m going to|'re going to)\s+(?:\w+\s+){0,3}?(?:compare|check|confirm|update|tell|let you know|come back|follow up|get back|report back|look|post|reply|verify|read|recheck|re-check)\b/i;
const NOT_PROMISE = /\b(?:if you (?:want|like|need)|if (?:that|it) helps|unless you)\b|\b(?:i|we)(?:'|’)?(?:ll| will| am going to| are going to|'m going to|'re going to)\s+(?:not|never)\b|\b(?:won(?:'|’)?t|will not|shan(?:'|’)?t)\b/i;
// Quoted speech is somebody's words, not Keir's promise.
const unquote = (t) => String(t || "").replace(/"[^"\n]*"|“[^”\n]*”/g, " ");
function sentences(text) { return unquote(text).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean); }

// The promise in a post, with its due time, or null. Questions and offers are not promises.
function detect(text, now, due = DUE) {
  for (const s of sentences(text)) {
    if (s.endsWith("?") || !FOLLOW.test(s) || NOT_PROMISE.test(s)) continue;
    const kind = /\b(?:next|a|the|another|each|every)\s+turn\b|\bnext (?:few|couple of|two|three) turns\b|\bturn (?:has )?(?:run|processed|passes|finishes)\b|\bafter turn \d+/i.test(s) ? "turn"
      : /\b(?:deploy\w*|released?|goes live|is live|reaches the main server|on the main server|ships?)\b/i.test(s) ? "release"
      : /\btomorrow\b/i.test(s) ? "tomorrow"
      : /\b(?:later today|this (?:evening|afternoon|morning)|tonight|in a few hours)\b/i.test(s) ? "today"
      : /\bowner\b|\bEgg\b|\bdevelopers?\b/.test(s) ? "owner"
      : "plain";
    return { text: s.slice(0, 300), kind, dueAt: now + (due[kind] || DUE.plain) };
  }
  return null;
}

const STOP = new Set(["about", "after", "again", "before", "there", "their", "these", "those", "which", "while", "would", "could", "should", "where", "when", "what", "will", "with", "your", "yours", "here", "have", "been", "this", "that", "from", "then", "them", "they", "just", "once", "still", "until", "check", "come", "back", "update", "confirm", "turn", "turns", "player", "ticket"]);
const words = (t) => new Set(String(t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 5 && !STOP.has(w)).map((w) => w.replace(/(?:ing|ed|es|e|s)$/, "")));
function overlap(a, b) { const x = words(a), y = words(b); let n = 0; for (const w of x) if (y.has(w)) n++; return n; }

function list(d, ticket) { d.ticketPromises ||= {}; return (d.ticketPromises[ticket] ||= []); }

// Called by the post path for every delivered Keir reply on a ticket (never for cards or code notices).
// askedAt: the last time the player or staff wrote on the ticket. A reply made after a promise wake and before anyone
// wrote again answers that wake: it keeps or ends the woken promise and never records a new one (review B3).
function notePost(d, ticket, job, message, now, { askedAt = 0 } = {}) {
  if (!ticket || !job) return null;
  const rows = list(d, ticket);
  const afterWake = rows.some((p) => p.wokenAt && p.wokenAt > (askedAt || 0) && p.wokenAt <= now && now - p.wokenAt < DAY);
  if (afterWake && cannotConfirm(message)) {
    for (const p of rows) if (p.state === "open" && p.wokenAt) { p.state = "ended"; p.endedAt = now; p.reason = "the player was told it cannot be confirmed yet"; }
  }
  const found = afterWake ? null : detect(message, now);
  // A later reply keeps an open promise when it comes after the wake, at least half way to the due time, is the turn report
  // a turn promise was about, or is on the same subject.
  // Parts of the same reply and anything within ten minutes never count.
  for (const p of rows) {
    if (p.state !== "open" || now - p.at < KEEP_AFTER_MS) continue;
    const halfway = now - p.at >= (p.dueAt - p.at) / 2;
    const turnReport = !found && p.kind === "turn" && /\bturn\b[^.]{0,40}\b(?:has (?:now )?run|ran|processed)\b|\bturn \d+\b/i.test(String(message || ""));
    if ((p.wokenAt && now > p.wokenAt) || halfway || turnReport || (!found && overlap(p.text, message) >= 2)) { p.state = "kept"; p.keptAt = now; }
  }
  if (!found) return null;
  if (found.kind === "turn") {
    const clock = clockOf(d, now);
    if (clock) {
      found.afterTurn = clock.turn + 1;
      if (clock.nextTurn && clock.nextTurn > now) found.dueAt = clock.nextTurn + GRACE_MS;
    }
  }
  // One open promise per ticket: a repeat keeps the earliest due time the player was given.
  const open = rows.find((p) => p.state === "open");
  if (open) {
    open.text = found.text; open.dueAt = Math.min(open.dueAt, found.dueAt); open.repeats = (open.repeats || 0) + 1;
    if (Number.isFinite(found.afterTurn)) open.afterTurn = Number.isFinite(open.afterTurn) ? Math.min(open.afterTurn, found.afterTurn) : found.afterTurn;
    return open;
  }
  const p = { id: `${ticket}-${now.toString(36)}`, at: now, jobId: job.id, state: "open", wakes: 0, ...found };
  rows.push(p);
  d.ticketPromises[ticket] = rows.filter((x) => x.state === "open" || now - x.at < 7 * 24 * HOUR).slice(-MAX_OPEN * 4);
  return p;
}

// held(job) -> reason or null (staff claim, takeover, pause). post(ticket, text) -> resolves when delivered.
function createPromises({ ledger, now = () => Date.now(), log = () => {}, held = () => null, post = null, retryMs = RETRY_MS, controls = controlsLib.DEFAULT_CONTROLS }) {
  const d = ledger.data;
  // Per-ticket bound over a rolling day, kept on the ledger so it survives restarts.
  function spent(ticket, kind) {
    const b = ((d.promiseBudget ||= {})[ticket] ||= { wakes: [], fallbacks: [] });
    b[kind] = (b[kind] || []).filter((t) => now() - t < DAY);
    return b[kind];
  }
  const root = (ticket) => d.jobs?.[d.seen?.[`ticket:${ticket}`]];
  function ended(job) {
    if (!job) return "no ticket task";
    if (job.channelClosed || job.resolved) return "ticket closed";
    if (["cancelled", "dismissed"].includes(job.state)) return "task stopped";
    if (d.channels?.[job.channelId]?.keirStopped) return "Keir told to stand down";
    return null;
  }
  function wake(job, p, second) {
    const told = new Date(p.at).toISOString().slice(11, 16);
    (job.inbox ||= []).push({ authorId: "promise-keeper", role: "system", at: new Date(now()).toISOString(),
      content: `${second ? "Still owed: y" : "Y"}ou told the player at ${told} UTC: "${p.text}". That follow-up is due now. Read what you need, then post it. If you cannot confirm it yet, tell the player plainly in one or two sentences that you cannot confirm it yet and what you are waiting for. If you already gave this follow-up, finish without posting again; otherwise do not finish without posting one of the two.${job.closing?.closesWhen ? ` Your recorded closing condition: closes when ${String(job.closing.closesWhen).replace(/^closes when /i, "").slice(0, 200)}; waiting on ${String(job.closing.waitingOn || "").slice(0, 160)}.` : ""}` });
    if (!["queued", "running"].includes(job.state)) { job.state = "queued"; job.wakeAt = 0; }
    p.wakes += 1; p.wokenAt = now(); p.nextAt = now() + retryMs;
    ledger.audit("promise_wake", { ticket: p.id.split("-")[0], promise: p.id, job: job.id, wakes: p.wakes, was: p.kind });
  }
  async function tick() {
    let woke = 0, changed = false;
    const g = controls.gate("promiseWakes");
    if (!g.run) return { woke, skipped: g.why };
    const preview = (action, ticket, p, reason) => controlsLib.preview(d, "promises", action, `ticket ${ticket}`, `${reason}: "${String(p.text).slice(0, 160)}"`, {}, now());
    for (const [ticket, rows] of Object.entries(d.ticketPromises || {})) {
      for (const p of rows) {
        if (p.state !== "open" || (p.nextAt || 0) > now() || (!p.wakes && !isDue(d, p, now()))) continue;
        const job = root(ticket);
        const why = ended(job);
        if (why) { if (g.act) { p.state = "cancelled"; p.reason = why; changed = true; } continue; }
        if (held(job)) continue; // staff or the owner have the ticket; nothing is posted or woken meanwhile
        if (job.state === "running") { if (g.act) p.nextAt = now() + 5 * 60000; continue; }
        if (p.wakes < 2) {
          if (spent(ticket, "wakes").length >= MAX_TICKET_WAKES) {
            if (!g.act) { preview("stop", ticket, p, `${MAX_TICKET_WAKES} promise wakes on this ticket today; the promise would end`); continue; }
            // The ticket has had its wakes for today: the promise ends, staff hear once a day.
            p.state = "capped"; p.endedAt = now(); p.reason = `${MAX_TICKET_WAKES} promise wakes on this ticket in a day`; changed = true;
            ledger.audit("promise_capped", { ticket: Number(ticket), promise: p.id });
            ledger.notify(`promise-capped:${ticket}:${new Date(now()).toISOString().slice(0, 10)}`, "owner", `Ticket ${ticket}: Keir has woken ${MAX_TICKET_WAKES} times today for follow-ups it promised and stopped waking for more. Last promise: "${p.text.slice(0, 200)}". A person may want to look.`);
            continue;
          }
          if (!g.act) { preview("wake", ticket, p, `promise due (wake ${p.wakes + 1} of 2)`); continue; }
          wake(job, p, p.wakes > 0); spent(ticket, "wakes").push(now()); woke++; changed = true; continue;
        }
        // Two wakes and still nothing: the player hears one plain line (at most one a day per ticket), staff hear once
        // with what actually happened, and the promise is closed.
        const fallbackOk = post && spent(ticket, "fallbacks").length < MAX_TICKET_FALLBACKS;
        if (!g.act) { preview(fallbackOk ? "post fallback" : "end", ticket, p, fallbackOk ? `two wakes gave no follow-up; would post "${FALLBACK}"` : "two wakes gave no follow-up; the day's fallback line already went out"); continue; }
        p.state = "failed"; p.failedAt = now(); changed = true;
        ledger.audit("promise_failed", { ticket: Number(ticket), promise: p.id });
        let outcome = post ? "No message was posted to the player (the ticket already had today's fallback line)." : "No message was posted to the player.";
        if (fallbackOk) {
          spent(ticket, "fallbacks").push(now());
          try { await post(Number(ticket), FALLBACK); p.fallbackAt = now(); outcome = "The player was told Keir cannot confirm it yet."; }
          catch (e) { p.fallbackError = String(e.message).slice(0, 200); log(`promise fallback ${ticket}: ${p.fallbackError}`); outcome = `The plain "cannot confirm yet" line could not be posted (${p.fallbackError}), so the player has heard nothing.`; }
        }
        ledger.notify(`promise-overdue:${ticket}:${p.id}`, "owner", `Ticket ${ticket}: Keir promised the player a follow-up ("${p.text.slice(0, 200)}") and two wakes did not produce it. ${outcome} A person may want to look.`);
      }
    }
    if (changed) ledger.save();
    return { woke };
  }
  return { tick };
}

// A turn report that went out on a promise's account keeps that promise: one report per promise.
function keepForReport(d, ticket, now) {
  const p = (d.ticketPromises?.[ticket] || []).find((x) => x.state === "open" && (x.wokenAt || isDue(d, x, now) || !(x.kind === "turn" && Number.isFinite(x.afterTurn))));
  if (p) { p.state = "kept"; p.keptAt = now; p.keptBy = "turn report"; }
  return p || null;
}

module.exports = { overlap, detect, notePost, createPromises, isDue, calledFor, keepForReport, cannotConfirm, DUE, FALLBACK, RETRY_MS, KEEP_AFTER_MS, TURN_BACKSTOP_MS, MAX_TICKET_WAKES };
