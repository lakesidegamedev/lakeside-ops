"use strict";
// Keir review sweep. Things Ask and Keir flag for a human go into something that is actually worked, not a page or a
// Discord ping (owner, 2026-11-18). Every 30 minutes a model-free collector gathers:
//   Ask:  GET {KEIR_ASK_URL}/api/keir-ask/review (open doc conflicts; blocked, salvaged or downvoted answers not yet reviewed)
//   Keir: player thumbs down or reports that 10.4's downvote loop did not re-wake, and tickets where Keir's own guards
//         refused a post more than twice in 24 hours
// and turns each NEW item into one internal Keir task (kind "finding": the normal activation lane, never a reply to a
// player: finding tasks cannot post in Discord). Dedup is by source+id in ledger.data.reviewQueue.seen. At most 3 new tasks
// per sweep and 12 per rolling day; the rest wait for the next sweep. The collector never calls a model and never throws.
// The open count and the oldest age go into the shift log, which is how every activation sees the queue.

const SWEEP_MS = 30 * 60000;
const PER_SWEEP = 3;
const PER_DAY = 12;
const DAY_MS = 24 * 3600000;
const VOTE_WINDOW_MS = 7 * DAY_MS;
const REFUSAL_WINDOW_MS = DAY_MS;
const REFUSAL_THRESHOLD = 2; // more than this many on one ticket
const SEEN_RETAIN_MS = 60 * DAY_MS;
const ASK_TIMEOUT_MS = 20000;
const REFUSAL_KINDS = ["asked_deflection_refused", "case_contradiction_refused", "team_cover_refused", "resolve_refused_policy"];
const TERMINAL = new Set(["done", "dismissed", "cancelled"]);
const clip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);
const noDash = (t) => String(t || "").replace(/[–—]/g, "-");

const state = (ledger) => { const q = (ledger.data.reviewQueue ||= {}); q.seen ||= {}; q.spawned ||= []; return q; };

/** Ask's own feed. Returns { ok, items, counts }. A missing secret, an old Ask without the route, or any error is "unavailable". */
async function fetchAsk({ config, fetcher = fetch, now }) {
  const base = String(config.askUrl || "").replace(/\/+$/, "");
  if (!base || !config.askSecret) return { ok: false, items: [], counts: null, why: "not configured" };
  try {
    const res = await fetcher(`${base}/api/keir-ask/review?limit=100`, { headers: { authorization: `Bearer ${config.askSecret}` }, signal: AbortSignal.timeout(ASK_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, items: [], counts: null, why: `ask ${res.status}` };
    const body = await res.json();
    const conflicts = (Array.isArray(body.docConflicts) ? body.docConflicts : []).map((c) => ({
      source: "ask", kind: "doc_conflict", id: String(c.id), key: `ask:doc_conflict:${c.id}`, at: Date.parse(c.created) || now(),
      title: `Doc conflict: ${clip(c.docs, 80)}`, data: c }));
    const answers = (Array.isArray(body.answers) ? body.answers : []).map((a) => ({
      source: "ask", kind: "answer", id: String(a.id), key: `ask:answer:${a.id}`, at: Date.parse(a.ts) || now(),
      title: `Flagged Ask answer (${(a.flags || []).join(", ") || "flagged"}): ${clip(a.question, 80)}`, data: a }));
    return { ok: true, items: [...conflicts, ...answers], counts: { docConflicts: Number(body.counts?.docConflicts) || conflicts.length, answers: Number(body.counts?.answers) || answers.length } };
  } catch (e) { return { ok: false, items: [], counts: null, why: String(e.message || e).slice(0, 80) }; }
}

/** Player thumbs down or reports 10.4 did not re-wake. A vote is re-woken when the ticket's wake stamp is at or after it. */
function keirVotes({ ledger, now }) {
  const f = ledger.data.answerFeedback || {}, since = now() - VOTE_WINDOW_MS, out = [];
  for (const [k, v] of Object.entries(f.votes || {})) {
    if (!v || v.voter !== "player" || !["down", "report"].includes(v.vote) || !v.ticket || (v.at || 0) < since) continue;
    if ((f.wakes?.[v.ticket] || 0) >= v.at) continue;
    out.push({ source: "keir", kind: "thumbs_down", id: k, key: `keir:vote:${k}:${v.vote}`, at: v.at, ticket: v.ticket,
      title: `Player ${v.vote === "report" ? "report" : "thumbs down"} on ticket ${v.ticket}`, data: { vote: v.vote, reason: v.reason || null, ticket: v.ticket, model: v.model || null, lane: v.lane || null, release: v.release || null } });
  }
  return out;
}

/** Tickets where Keir's own guards refused a post more than twice in 24 hours. One item per ticket per day. */
function keirRefusals({ ledger, events, now }) {
  const since = now() - REFUSAL_WINDOW_MS;
  let rows;
  try {
    rows = events?.enabled && events.byKind ? REFUSAL_KINDS.flatMap((k) => events.byKind(`audit:${k}`, since)) : (ledger.data.audit || []).filter((a) => a.at >= since && REFUSAL_KINDS.includes(a.kind));
  } catch { rows = (ledger.data.audit || []).filter((a) => a.at >= since && REFUSAL_KINDS.includes(a.kind)); }
  const by = new Map();
  for (const a of rows) {
    const t = Number(a.ticket);
    if (!t || (a.at || 0) < since) continue;
    const g = by.get(t) || { ticket: t, n: 0, kinds: {}, first: a.at, last: a.at };
    g.n++; g.kinds[a.kind] = (g.kinds[a.kind] || 0) + 1; g.first = Math.min(g.first, a.at); g.last = Math.max(g.last, a.at);
    by.set(t, g);
  }
  return [...by.values()].filter((g) => g.n > REFUSAL_THRESHOLD).map((g) => ({
    source: "keir", kind: "refusals", id: String(g.ticket), key: `keir:refusals:${g.ticket}:${new Date(g.last).toISOString().slice(0, 10)}`, at: g.first, ticket: g.ticket,
    title: `Ticket ${g.ticket}: Keir's guards refused ${g.n} posts in 24h`, data: { ticket: g.ticket, count: g.n, kinds: g.kinds } }));
}

const COMMON = "This is an internal review task. Never post to a player and never call channel_reply, progress_update or support_action; finding tasks cannot. Be brief. Finish with a one-line verdict in finish. Use review_item to close the loop.";

/** The task text for one item. */
function instructionsFor(item) {
  const d = item.data;
  if (item.kind === "doc_conflict") {
    return `Review item (Ask doc conflict #${item.id}). Ask found a documentation page that disagrees with the code.\nDocs: ${d.docs}\nThe doc says: ${d.claim}\nAsk says the code does: ${d.actual}${d.evidence ? `\nAsk's evidence: ${d.evidence}` : ""}\nSeen ${d.seen} time(s).\n\n` +
      `Decide which statement is right by reading the implemented code (read_tool ops-knowledge code_search or code_exact with source "dev") and live data where it matters. If the doc is wrong, record the correction with whichever write path you already have for it; if none of your tools can write it, raise ONE kanban card with raise_to_developers naming the page, the wrong claim, the right statement and the file as evidence. If the doc is right and Ask was wrong, say so. Then call review_item action resolve with kind doc_conflict, id ${item.id}, a one-line note, and outcome "fixed" (the doc is corrected or a card carries the fix) or "dismissed" (the doc was right).\n\n${COMMON}`;
  }
  if (item.kind === "answer") {
    return `Review item (flagged Ask answer #${item.id}, ${(d.flags || []).join(", ")}).\nQuestion: ${d.question}\nAnswer began: ${d.excerpt}\n${d.reason ? `Reason on record: ${d.reason}\n` : ""}${(d.issues || []).length ? `Validator issues: ${d.issues.join(", ")}\n` : ""}\n` +
      `Check the answer against live data and the code (read_tool: gamestate, engine, heal-ops reads, ops-knowledge code_search with source "dev"). If it is wrong, add an Ask correction through whichever write path you already have, or raise ONE kanban card with raise_to_developers if you have none. Then call review_item action resolve with kind answer, id ${item.id}, a one-line note and verdict "good" (the answer was right) or "bad" (it was wrong).\n\n${COMMON}`;
  }
  const t = item.ticket;
  const why = item.kind === "thumbs_down" ? `A player marked one of Keir's answers on ticket ${t} as ${d.vote === "report" ? "a problem" : "not helpful"}${d.reason ? `: "${clip(d.reason, 200)}"` : " (no reason given)"}. The ticket's own task was not re-woken by that vote.`
    : `Keir's own guards refused ${d.count} posts on ticket ${t} in the last 24 hours (${Object.entries(d.kinds).map(([k, n]) => `${k} x${n}`).join(", ")}).`;
  return `Review item (Keir, ticket ${t}). ${why}\n\n` +
    `Re-read the ticket: ticket_history, ticket_record read and the case file in the brief. Work out what went wrong and write it as one line with review_item action lesson (ticket ${t}). If the player is still owed an answer, call review_item action wake_ticket (ticket ${t}) with a short note on what to answer; it goes through the ticket's own inbox and does nothing if the ticket is closed.\n\n${COMMON}`;
}

function createReviewSweep({ ledger, config, events = null, fetcher = fetch, now = () => Date.now(), log = () => {}, wake = null, held = () => false, enabled = true }) {
  async function collect() {
    const ask = await fetchAsk({ config, fetcher, now });
    let keir = [];
    try { keir = [...keirVotes({ ledger, now }), ...keirRefusals({ ledger, events, now })]; } catch (e) { log(`review sweep: keir collect: ${String(e.message).slice(0, 120)}`); }
    return { ask, keir };
  }

  function dayCount(q) { q.spawned = q.spawned.filter((t) => now() - t < DAY_MS); return q.spawned.length; }

  function createTask(item) {
    const at = now();
    const job = ledger.createJob(`review:${item.key}`, { kind: "finding", role: "support", repository: "AHDGame", reviewItem: { source: item.source, kind: item.kind, id: item.id, key: item.key, ticket: item.ticket || null },
      deadline: at + DAY_MS, source: { role: "system", content: noDash(instructionsFor(item)).slice(0, 6000), at: new Date(at).toISOString() } });
    ledger.audit("review_task_created", { job: job.id, item: item.key });
    return job;
  }

  async function sweep() {
    const q = state(ledger), at = now();
    const { ask, keir } = await collect();
    q.lastSweepAt = at;
    q.askUnavailable = !ask.ok;
    q.askWhy = ask.ok ? null : ask.why;
    const all = [...ask.items, ...keir].sort((a, b) => a.at - b.at);
    const created = [];
    if (enabled && !ledger.data.paused && !held()) {
      for (const item of all) {
        if (created.length >= PER_SWEEP || dayCount(q) >= PER_DAY) break;
        if (q.seen[item.key]) continue;
        try {
          const job = createTask(item);
          q.seen[item.key] = { at, job: job.id, source: item.source, kind: item.kind };
          q.spawned.push(at); created.push(item.key);
        } catch (e) { log(`review sweep: task for ${item.key}: ${String(e.message).slice(0, 120)}`); }
      }
    }
    // Keir items are open until their task finishes; Ask items are open while Ask still lists them.
    const handled = (item) => { const s = q.seen[item.key]; return Boolean(s && TERMINAL.has(ledger.data.jobs?.[s.job]?.state)); };
    const keirOpen = keir.filter((i) => !handled(i));
    const askOpen = ask.counts ? ask.counts.docConflicts + ask.counts.answers : 0;
    const oldest = [...ask.items, ...keirOpen].reduce((m, i) => Math.min(m, i.at), Infinity);
    q.summary = { at, ask: askOpen, keir: keirOpen.length, open: askOpen + keirOpen.length, oldestAt: Number.isFinite(oldest) ? oldest : null, askUnavailable: !ask.ok };
    for (const [k, v] of Object.entries(q.seen)) if (at - v.at > SEEN_RETAIN_MS) delete q.seen[k];
    ledger.save();
    if (created.length) { log(`review sweep: ${created.length} task(s) from ${all.length} item(s)`); try { wake?.(); } catch { /* the drain loop also picks the task up */ } }
    return { items: all.length, created, summary: q.summary };
  }

  return { sweep, collect };
}

/** The shift log line: "Review queue: N open (Ask X, Keir Y), oldest Zh". */
function shiftLine(ledger, now = Date.now()) {
  const s = ledger.data.reviewQueue?.summary;
  if (!s) return null;
  const hours = s.oldestAt ? Math.max(0, Math.round((now - s.oldestAt) / 3600000)) : 0;
  return `Review queue: ${s.open} open (Ask ${s.ask}, Keir ${s.keir})${s.open ? `, oldest ${hours}h` : ""}${s.askUnavailable ? ", Ask feed unavailable" : ""}`;
}

module.exports = { createReviewSweep, shiftLine, fetchAsk, keirVotes, keirRefusals, instructionsFor, SWEEP_MS, PER_SWEEP, PER_DAY, REFUSAL_KINDS };
