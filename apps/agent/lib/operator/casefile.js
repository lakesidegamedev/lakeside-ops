"use strict";
// Keir 10 case file. One structured record per ticket, built from what the broker
// already records, so a wake or a new model run starts from the same short
// account of the ticket instead of five scattered blobs: what we know, what we
// told the player, what we promised, what is still open, the fixes in flight and
// how many posts are left. It is rebuilt on every activation, never stored, so it
// cannot drift from the facts it summarises.

const MAX_TOLD = 8;
const line = (text, n = 220) => String(text || "").replace(/\s+/g, " ").trim().slice(0, n);
const iso = (at) => { const n = typeof at === "number" ? at : Date.parse(at || ""); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 16).replace("T", " ") : null; };
const ts = (v) => { const n = typeof v === "number" ? v : Date.parse(v || ""); return Number.isFinite(n) ? n : 0; };
const isHuman = (m) => m && m.role !== "system" && m.role !== "assistant" && !m.investigationResult && !m.codingResult && !/^(developer-watch|system|engineering-followup|turn-watch|sweeper)$/.test(String(m.authorId || ""));

// Every question mark sentence in the player's words since a time, as short lines.
function questionsIn(text) {
  return String(text || "").split(/(?<=[?.!])\s+|\n+/).map((s) => s.trim()).filter((s) => s.endsWith("?") && s.length > 6).map((s) => line(s, 200));
}

function toldPlayer(d, ticket) {
  const posts = (d.ticketPosts?.[ticket] || d.ticketPosts?.[String(ticket)] || []).filter((p) => p && p.text && p.kind !== "status_card");
  const rows = posts.length ? posts.map((p) => ({ at: ts(p.at), text: p.text }))
    : ((d.trust?.replies || []).filter((r) => Number(r.ticket) === Number(ticket) && r.text).map((r) => ({ at: ts(r.at), text: r.text })));
  return rows.sort((a, b) => a.at - b.at).slice(-MAX_TOLD).map((r) => ({ at: iso(r.at), text: line(r.text) }));
}

// The player's questions that Keir has not answered since they were asked.
function openQuestions(job, d, rec) {
  const lastAsk = job.lastAskAt || 0;
  const msgs = [job.source, ...(job.requestInbox || []), ...(job.inbox || [])].filter(isHuman);
  const fresh = msgs.filter((m) => ts(m.at) > lastAsk || (m === job.source && !lastAsk));
  const fromPlayer = [...new Set(fresh.flatMap((m) => questionsIn(m.content)))].slice(-6);
  const recorded = (rec?.questions || []).filter((q) => !q.closedAt).map((q) => line(q.text, 200)).slice(-4);
  return { fromPlayer, recorded };
}

function fixesOf(d, job) {
  const items = d.statusCards?.[job.ticket]?.items || [];
  return items.map((i) => ({ name: line(i.name, 120), stage: i.stage, ...(i.blocked ? { blocked: line(i.note, 120) || true } : {}) }));
}

function decisionsOf(d, job) {
  const ids = new Set(Object.values(d.jobs || {}).filter((j) => j.id === job.id || j.codingParent === job.id).map((j) => j.id));
  return Object.values(d.decisions || {}).filter((x) => ids.has(x.jobId)).slice(-4).map((x) => ({ state: x.state, question: line(x.question, 160), ...(x.answer ? { answer: line(x.answer, 80) } : {}) }));
}

// The case file for a ticket job. ledger: the store (ledger.data); broker is optional (postBudget).
function caseFile(ledger, job, { broker = null, now = Date.now() } = {}) {
  const d = ledger.data, ticket = job.ticket;
  const rec = d.ticketRecords?.[String(ticket)] || { facts: [], ruledOut: [], promises: [], questions: [] };
  const open = (list) => (list || []).filter((x) => !x.closedAt);
  const observations = d.ticketObservations?.[ticket] || [];
  const file = {
    ticket, lane: job.lane || null, laneReason: job.laneReason || undefined,
    know: open(rec.facts).slice(-10).map((f) => ({ text: line(f.text, 260), ...(f.source ? { source: line(f.source, 100) } : {}) })),
    ruledOut: open(rec.ruledOut).slice(-6).map((f) => line(f.text, 160)),
    toldPlayer: toldPlayer(d, ticket),
    promises: open(rec.promises).slice(-6).map((p) => line(p.text, 200)),
    openQuestions: openQuestions(job, d, rec),
    fixes: fixesOf(d, job),
    raised: (job.raisedToDevelopers || []).slice(-4).map((r) => ({ id: r.id, title: line(r.title, 100), kind: r.kind, ...(r.releasedAt ? { released: true } : {}) })),
    pullRequests: (job.pullRequests || []).slice(-4).map((p) => ({ number: p.number || p.pr, state: p.state || p.status })),
    decisions: decisionsOf(d, job),
    readsDone: observations.slice(-6).map((o) => ({ tool: o.tool, at: iso(o.at), input: line(o.input, 90) })),
    lastPlayerAt: iso(job.lastPlayerAt), lastReplyAt: iso(job.lastAskAt || job.lastPublishedAt),
  };
  try { const left = broker?.postBudget?.(job); if (left !== undefined && left !== null) file.postsLeft = left; } catch { /* W2's budget is optional */ }
  return prune(file);
}

// Drop empty sections so the file stays short.
function prune(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && !v.length) continue;
    if (k === "openQuestions" && !v.fromPlayer.length && !v.recorded.length) continue;
    out[k] = v;
  }
  return out;
}

// What changed since this ticket's last activation, for a wake. Returns null on a first activation.
function whatChanged(ledger, job, { now = Date.now() } = {}) {
  const d = ledger.data, since = job.prevActivationAt || 0;
  if (!(job.activationCount > 1)) return null;
  const rows = [...(job.requestInbox || []), ...(job.inbox || [])];
  const fresh = rows.filter((m) => ts(m.at) > since || !m.at);
  const messages = fresh.filter(isHuman).slice(-6).map((m) => ({ from: m.role || m.authorId || "player", at: iso(m.at), text: line(m.content, 400) }));
  const results = fresh.filter((m) => m.investigationResult || m.codingResult).slice(-4).map((m) => ({ kind: m.codingResult ? "worker report" : "investigation", text: line(m.content, 300) }));
  const events = fresh.filter((m) => m.role === "system" && !m.investigationResult && !m.codingResult).slice(-5).map((m) => ({ from: m.authorId || "system", text: line(m.content, 240) }));
  const answered = Object.values(d.decisions || {}).filter((x) => x.jobId === job.id && x.state !== "pending" && ts(x.answeredAt || x.at) > since).map((x) => ({ question: line(x.question, 140), answer: line(x.answer || x.state, 60) }));
  const refusals = (job.history || []).filter((h) => h.kind === "refused" && ts(h.at) > since).slice(-3).map((h) => line(h.summary, 240));
  const cards = d.statusCards?.[job.ticket]?.items || [];
  const out = { since: iso(since) || undefined, messages, results, events, decisionAnswers: answered, refusals };
  if (cards.length && ts(d.statusCards[job.ticket].at) > since) out.cardNow = cards.map((i) => `${i.name}: ${i.stage}`).slice(0, 6);
  return prune(out);
}

// Watch the player's messages so the question lane's soft limit has a count.
function observe(job) {
  const seen = new Set(job.playerMessageIds || []);
  for (const m of [job.source, ...(job.requestInbox || []), ...(job.inbox || [])].filter(isHuman)) {
    const id = m.messageId || `${m.at}:${String(m.content || "").slice(0, 40)}`;
    if (id && !seen.has(id)) { seen.add(id); job.playerMessageCount = (job.playerMessageCount || 0) + 1; }
  }
  job.playerMessageIds = [...seen].slice(-60);
}

module.exports = { caseFile, whatChanged, observe, questionsIn, toldPlayer, openQuestions, isHuman };
