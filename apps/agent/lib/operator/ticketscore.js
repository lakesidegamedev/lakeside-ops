"use strict";
// Keir 10: one score per closed ticket, computed from what the ledger already
// records. Higher is better, 0 to 100. The score feeds the nightly review (it
// reads the worst tickets) and the ranked gap ledger (gaps hit by low-scoring
// tickets count double). No model call; same inputs always give the same score.
//
// Signals: reopened, corrections posted ("Correction:" posts), player
// complaints (feedbackLog kinds wrong_or_misleading, slow_or_silent, tone),
// staff and owner negative feedback, refusals per effect, model activations,
// owner decisions, hours open. Praise adds a little.
const PLAYER_COMPLAINTS = new Set(["wrong_or_misleading", "slow_or_silent", "tone"]);
const STAFF_NEGATIVE = new Set(["wrong_or_misleading", "slow_or_silent", "tone", "bot_bug", "behaviour_request"]);
const LOW_SCORE = 60;
const HOUR = 3600000;

// Which effect a refused tool call was trying to have.
const EFFECT_OF = {
  channel_reply: "reply", progress_update: "reply", support_action: "reply", status_card: "card",
  raise_to_developers: "issue", publish_patch: "fix", request_heal: "heal", merge_into_incident: "merge", finish: "finish",
  read_tool: "read", evidence_batch: "read", reporter_state: "read",
};
const effectOf = (tool) => EFFECT_OF[tool] || "other";

const stamp = (v) => { const n = typeof v === "number" ? v : Date.parse(v || ""); return Number.isFinite(n) && n > 0 ? n : 0; };

// The lane a ticket belongs to. A router lane on the job wins; otherwise the intake tag, then the channel category.
function laneOf(job, data) {
  if (job?.lane) return String(job.lane);
  const kind = job?.tags?.kind, cat = data?.channels?.[job?.channelId || job?.source?.channelId]?.category;
  if (["bug_report", "data_repair"].includes(kind) || cat === "bug") return "bug";
  if (["mechanics_question", "gameplay_advice"].includes(kind) || ["mechanics", "gameplay", "question"].includes(cat)) return "question";
  if (["feature_request", "design_feedback"].includes(kind) || ["suggestion", "idea"].includes(cat)) return "idea";
  if (["moderation", "account"].includes(kind) || ["account", "moderation"].includes(cat)) return "account";
  if (job?.incidentCandidates?.length || cat === "incident") return "outage";
  return "question";
}

function signalsFor(data, ticket, outcome) {
  const jobs = Object.values(data.jobs || {}).filter((j) => Number(j.ticket) === Number(ticket));
  const ids = new Set(jobs.map((j) => j.id));
  const feedback = (data.feedbackLog || []).filter((f) => Number(f.ticket) === Number(ticket));
  const posts = (data.ticketPosts?.[ticket] || []).filter((p) => p && p.text);
  const refusals = {};
  for (const a of data.audit || []) {
    if (a.kind !== "tool_refused" && a.type !== "tool_refused" && a.event !== "tool_refused") continue;
    if (!ids.has(a.job) && Number(a.ticket) !== Number(ticket)) continue;
    const e = effectOf(a.tool); refusals[e] = (refusals[e] || 0) + 1;
  }
  const activations = (data.audit || []).filter((a) => (a.kind === "cli_activation" || a.type === "cli_activation" || a.event === "cli_activation") && ids.has(a.job)).length
    || jobs.reduce((n, j) => n + (Number(j.activationCount) || 0), 0) || jobs.length;
  const created = stamp(outcome?.createdAt) || Math.min(...jobs.map((j) => stamp(j.at)).filter(Boolean), Infinity);
  const closed = stamp(outcome?.resolvedAt);
  return {
    reopened: Boolean(outcome?.reopened || jobs.some((j) => j.reopenedFromJob)),
    corrections: posts.filter((p) => /^\s*Correction:/i.test(p.text)).length,
    playerComplaints: feedback.filter((f) => f.role === "player" && PLAYER_COMPLAINTS.has(f.kind)).map((f) => f.severity === "serious" ? 2 : 1).reduce((a, b) => a + b, 0),
    staffNegative: feedback.filter((f) => f.role !== "player" && STAFF_NEGATIVE.has(f.kind)).length,
    praise: feedback.filter((f) => f.kind === "praise").length,
    refusals,
    refusalTotal: Object.values(refusals).reduce((a, b) => a + b, 0),
    activations,
    ownerDecisions: Object.values(data.decisions || {}).filter((x) => ids.has(x.jobId)).length,
    hoursOpen: Number.isFinite(created) && closed > created ? Math.round(((closed - created) / HOUR) * 10) / 10 : null,
  };
}

// Penalties are small and capped so one noisy signal cannot zero a ticket.
function scoreFrom(s) {
  const p = {};
  if (s.reopened) p.reopened = 25;
  if (s.corrections) p.corrections = Math.min(30, s.corrections * 10);
  if (s.playerComplaints) p.playerComplaints = Math.min(36, s.playerComplaints * 12);
  if (s.staffNegative) p.staffNegative = Math.min(30, s.staffNegative * 15);
  const refused = Object.values(s.refusals).reduce((n, c) => n + Math.min(3, c) * 2, 0);
  if (refused) p.refusals = Math.min(20, refused);
  if (s.activations > 3) p.activations = Math.min(15, (s.activations - 3) * 3);
  if (s.ownerDecisions) p.ownerDecisions = Math.min(15, s.ownerDecisions * 5);
  if (s.hoursOpen > 24) p.hoursOpen = Math.min(15, Math.floor((s.hoursOpen - 24) / 6) + 1);
  const bonus = Math.min(10, s.praise * 5);
  const score = Math.max(0, Math.min(100, 100 - Object.values(p).reduce((a, b) => a + b, 0) + bonus));
  return { score, penalties: p, bonus };
}

// Score one closed ticket. Idempotent: the same closure scores once; a reopen and a new closure score again.
function scoreTicket(data, ticket, outcome, now = Date.now()) {
  const store = data.ticketScores ||= {};
  const closureKey = String(stamp(outcome?.resolvedAt) || outcome?.receiptId || "");
  const prior = store[ticket];
  if (prior && prior.closureKey === closureKey) return prior;
  const job = Object.values(data.jobs || {}).filter((j) => Number(j.ticket) === Number(ticket)).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  const signals = signalsFor(data, ticket, outcome);
  const { score, penalties, bonus } = scoreFrom(signals);
  return (store[ticket] = { ticket: Number(ticket), score, lane: laneOf(job, data), closureKey, closedAt: stamp(outcome?.resolvedAt) || null, scoredAt: now, penalties, bonus, signals });
}

// All closed tickets the outcome ledger knows about. Returns how many were newly scored.
function scoreClosed(data, now = Date.now()) {
  let n = 0;
  for (const outcome of Object.values(data.ticketOutcomes || {})) {
    if (!outcome?.ticket || !outcome.resolvedAt || outcome.superseded || outcome.mergedInto) continue;
    const before = data.ticketScores?.[outcome.ticket];
    const after = scoreTicket(data, outcome.ticket, outcome, now);
    if (after !== before) n++;
  }
  return n;
}

// Lowest-scored closed tickets in a window, worst first.
function worst(data, { since = 0, limit = 4, below = 101 } = {}) {
  return Object.values(data.ticketScores || {}).filter((t) => (t.closedAt || t.scoredAt) >= since && t.score < below)
    .sort((a, b) => a.score - b.score || (b.closedAt || 0) - (a.closedAt || 0)).slice(0, limit);
}

const isLow = (data, ticket) => Number(data.ticketScores?.[ticket]?.score) < LOW_SCORE;

module.exports = { scoreTicket, scoreClosed, scoreFrom, signalsFor, worst, isLow, laneOf, effectOf, LOW_SCORE };
