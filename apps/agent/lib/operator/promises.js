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
const { JOB_TERMINAL } = require("./machines");

const HOUR = 3600000;
const DUE = Object.freeze({ turn: 90 * 60000, release: 4 * HOUR, today: 6 * HOUR, tomorrow: 24 * HOUR, owner: 12 * HOUR, plain: 4 * HOUR });
const RETRY_MS = 30 * 60000;
const KEEP_AFTER_MS = 10 * 60000; // parts of the same reply and instant notices do not keep it
const MAX_OPEN = 5;
const FALLBACK = "I can't confirm this yet. I'm still checking and will update this ticket when I can.";

// First person, future, a follow-up verb: "I will compare...", "I'll confirm here once...", "we'll let you know".
const FOLLOW = /\b(?:i|we)(?:'|’)?(?:ll| will| am going to| are going to|'m going to|'re going to)\s+(?:\w+\s+){0,3}?(?:compare|check|confirm|update|tell|let you know|come back|follow up|get back|report back|look|post|reply|verify|read|recheck|re-check|see)\b/i;
const NOT_PROMISE = /\b(?:if you (?:want|like|need)|if (?:that|it) helps|unless you)\b/i;
function sentences(text) { return String(text || "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean); }

// The promise in a post, with its due time, or null. Questions and offers are not promises.
function detect(text, now, due = DUE) {
  for (const s of sentences(text)) {
    if (s.endsWith("?") || !FOLLOW.test(s) || NOT_PROMISE.test(s)) continue;
    const kind = /\b(?:next|a|the|another|each|every)\s+turn\b|\bturn (?:has )?(?:run|processed|passes|finishes)\b|\bafter turn \d+/i.test(s) ? "turn"
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
function notePost(d, ticket, job, message, now) {
  if (!ticket || !job) return null;
  const rows = list(d, ticket);
  const found = detect(message, now);
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
  // One open promise per ticket: a repeat keeps the earliest due time the player was given.
  const open = rows.find((p) => p.state === "open");
  if (open) { open.text = found.text; open.dueAt = Math.min(open.dueAt, found.dueAt); open.repeats = (open.repeats || 0) + 1; return open; }
  const p = { id: `${ticket}-${now.toString(36)}`, at: now, jobId: job.id, state: "open", wakes: 0, ...found };
  rows.push(p);
  d.ticketPromises[ticket] = rows.filter((x) => x.state === "open" || now - x.at < 7 * 24 * HOUR).slice(-MAX_OPEN * 4);
  return p;
}

// held(job) -> reason or null (staff claim, takeover, pause). post(ticket, text) -> resolves when delivered.
function createPromises({ ledger, now = () => Date.now(), log = () => {}, held = () => null, post = null, retryMs = RETRY_MS }) {
  const d = ledger.data;
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
      content: `${second ? "Still owed: y" : "Y"}ou told the player at ${told} UTC: "${p.text}". That follow-up is due now. Read what you need, then post it. If you cannot confirm it yet, tell the player plainly in one or two sentences that you cannot confirm it yet and what you are waiting for. If you already gave this follow-up, finish without posting again; otherwise do not finish without posting one of the two.` });
    if (!["queued", "running"].includes(job.state)) { job.state = "queued"; job.wakeAt = 0; }
    p.wakes += 1; p.wokenAt = now(); p.nextAt = now() + retryMs;
    ledger.audit("promise_wake", { ticket: p.id.split("-")[0], promise: p.id, job: job.id, wakes: p.wakes, was: p.kind });
  }
  async function tick() {
    let woke = 0, changed = false;
    for (const [ticket, rows] of Object.entries(d.ticketPromises || {})) {
      for (const p of rows) {
        if (p.state !== "open" || p.dueAt > now() || (p.nextAt || 0) > now()) continue;
        const job = root(ticket);
        const why = ended(job);
        if (why) { p.state = "cancelled"; p.reason = why; changed = true; continue; }
        if (held(job)) continue; // staff or the owner have the ticket; nothing is posted or woken meanwhile
        if (job.state === "running") { p.nextAt = now() + 5 * 60000; continue; }
        if (p.wakes < 2) { wake(job, p, p.wakes > 0); woke++; changed = true; continue; }
        // Two wakes and still nothing: the player hears one plain line, staff hear once, and the promise is closed.
        p.state = "failed"; p.failedAt = now(); changed = true;
        ledger.notify(`promise-overdue:${ticket}:${p.id}`, "owner", `Ticket ${ticket}: Keir promised the player a follow-up ("${p.text.slice(0, 200)}") and two wakes did not produce it. The player was told Keir cannot confirm it yet. A person may want to look.`);
        ledger.audit("promise_failed", { ticket: Number(ticket), promise: p.id });
        if (post) {
          try { await post(Number(ticket), FALLBACK); p.fallbackAt = now(); }
          catch (e) { p.fallbackError = String(e.message).slice(0, 200); log(`promise fallback ${ticket}: ${p.fallbackError}`); }
        }
      }
    }
    if (changed) ledger.save();
    return { woke };
  }
  return { tick };
}

module.exports = { overlap, detect, notePost, createPromises, DUE, FALLBACK, RETRY_MS, KEEP_AFTER_MS };
