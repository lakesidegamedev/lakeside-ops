"use strict";
// Keir 11.1: why an evidence answer fell short, and what is worth keeping from it.
//
// An evidence gap is a ticket where Keir could not give a sourced number, or gave one that was challenged. Four reasons:
//   wrong_metric          a number was posted, then corrected (a level for a growth rate, offered for sold)
//   tool_discovery        the read that answers it was not found or not in scope on the first try
//   missing_data          the read ran and said what is not recorded (envelope gaps, or only null rows)
//   unclear_explanation   sourced figures, but the player said the answer was wrong or misleading
//
// What is kept. At most one reusable lesson per signature (reason, tool, metric), written into the lane lesson
// store from fixed wording. The lesson never contains ticket text, player names or figures: only the reason, a tool
// name from EVIDENCE_TOOLS and a metric slug. A lesson starts unconfirmed. It counts as confirmed on an independent
// case only: a different ticket from a different reporter, resolved cleanly (sourced read without gaps, no
// correction, no negative feedback), on which the lesson was actually recalled. Recall alone, the origin ticket
// and a repeat by the same reporter never confirm it. Confirmation changes how the lesson is reported, nothing
// else: no read scope, permission, entitlement or setting is derived from it.
const crypto = require("node:crypto");
const { tag } = require("./lanelessons");

const REASONS = ["wrong_metric", "tool_discovery", "missing_data", "unclear_explanation"];
// The evidence reads of Keir 11.1. private: bound to the ticket's verified reporter.
const EVIDENCE_TOOLS = { market_history: { private: false }, reporter_operating_results: { private: true }, reporter_action_points: { private: true } };
const BY = "evidence-gap";
const MAX_TICKETS = 200, MAX_SIGNATURES = 120, MAX_CASES = 12, CONFIRMED_AT = 2;
const METRIC = /^[a-z][a-z0-9_.:-]{0,59}$/;
const NOT_FOUND = /outside support scope|not a \S+ read|unknown tool|tool not found|method not found|not available to this task/i;
const NEGATIVE_FEEDBACK = new Set(["wrong_or_misleading", "bot_bug", "slow_or_silent"]);

const hashOf = (v) => crypto.createHash("sha256").update(`keir-evidence-gap:${v}`).digest("hex").slice(0, 12);
const parse = (r) => { if (typeof r !== "string") return r; try { return JSON.parse(r); } catch { return null; } };
const metricOf = (r) => (typeof r?.metric === "string" && METRIC.test(r.metric) ? r.metric : null);
const sigOf = (g) => `${g.reason}:${g.tool}:${g.metric || "-"}`;

const entry = (d, ticket) => {
  const all = (d.evidenceGaps ||= { tickets: {}, signatures: {} }).tickets;
  const key = String(ticket);
  if (!all[key]) {
    all[key] = { served: [], gaps: [], numbered: false, corrected: false, negative: false, at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > MAX_TICKETS) for (const k of keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - MAX_TICKETS)) delete all[k];
  }
  return all[key];
};
const addGap = (e, gap) => { if (!e.gaps.some((g) => sigOf(g) === sigOf(gap))) e.gaps.push(gap); };

// A result is "served" when it has at least one non-null row and no declared gaps; it is a data gap when the
// source said what it could not give, or every row is empty.
const KEY_FIELDS = new Set(["turn", "year", "previousTurn", "siteId", "corporation", "corporationId", "character", "ticket"]);
// Standing caveats the tools attach to every answer of a kind. They describe what a series never includes, not something
// that went wrong for this player, so they do not make the figures incomplete. Any other code, or a gap with no code, does.
const STANDING_CAVEATS = new Set(["other_world_rows_excluded", "one_off_fees_not_in_operating_results", "grant_log_window"]);
const REAL_GAP = (g) => !(g && typeof g === "object" && STANDING_CAVEATS.has(g.code));
function judge(result) {
  const r = parse(result);
  if (!r || typeof r !== "object" || r.error) return null;
  const rows = Array.isArray(r.rows) ? r.rows : null;
  if (!rows) return null;
  // Identity columns are always present; a row counts only when some measured value in it is.
  const hasValue = (row) => row && typeof row === "object" && Object.entries(row).some(([k, v]) => !KEY_FIELDS.has(k) && v !== null && v !== undefined && typeof v !== "object");
  const gaps = Array.isArray(r.gaps) ? r.gaps.filter(REAL_GAP).length : 0;
  const filled = rows.some(hasValue);
  return { metric: metricOf(r), served: filled && gaps === 0, missing: !filled || gaps > 0 };
}

/** After a read_tool call: a refused or empty evidence read is a gap, a clean one is evidence. error is the refusal message. */
function noteRead(d, job, input, result, error = null, at = Date.now(), ctx = {}) {
  if (!job?.ticket) return;
  const tool = String(input?.tool || "");
  if (input?.server !== "gamestate" || !EVIDENCE_TOOLS[tool]) return;
  const e = entry(d, job.ticket);
  if (error) {
    // A tool the live server does not list (not deployed, or outside this task's scope) was never discoverable: that is a
    // capability limit stated to the player, not a discovery failure to learn from. ctx.callable is the live set, or null.
    if (NOT_FOUND.test(String(error)) && !(ctx.callable instanceof Set && !ctx.callable.has(tool))) addGap(e, { reason: "tool_discovery", tool, metric: null, at });
    else if (NOT_FOUND.test(String(error))) (e.unavailable ||= []).includes(tool) || e.unavailable.push(tool);
    return;
  }
  const j = judge(result);
  if (!j) return;
  if (j.served) { if (!e.served.some((s) => s.tool === tool && s.metric === j.metric)) e.served.push({ tool, metric: j.metric, at }); }
  else if (j.missing) addGap(e, { reason: "missing_data", tool, metric: j.metric, at });
}

/** A public post. A correction of an earlier post that carried a number is a wrong-metric signal. */
function notePost(d, ticket, text, correction, at = Date.now()) {
  const e = entry(d, ticket);
  if (correction) {
    e.corrected = true;
    if (e.numbered) {
      const basis = e.served.at(-1) || e.gaps.at(-1) || null;
      addGap(e, { reason: "wrong_metric", tool: basis?.tool || "market_history", metric: basis?.metric || null, at });
    }
    return;
  }
  if (/\d/.test(String(text || ""))) e.numbered = true;
}

/** Player feedback on an answer. Sourced figures that were still called wrong or misleading are an explanation gap. */
function noteFeedback(d, ticket, kind, at = Date.now()) {
  if (!ticket) return;
  // The only reporter outcome that counts is the reporter's own structured vote on an answer. Thanks in the channel, a
  // resolved status and an automatic close say nothing about whether the figure was right.
  if (kind === "helpful") {
    const e = entry(d, ticket);
    e.reporterConfirmed = at;
    // The vote can land after the ticket settled. A recalled-quiet case on this ticket becomes a confirmed one (never a negative one).
    if (e.settledAt && !e.negative) for (const s of Object.values(signatures(d))) {
      const i = (s.quiet || []).findIndex((c) => c.ticket === Number(ticket));
      if (i < 0) continue;
      const [c] = s.quiet.splice(i, 1);
      s.cases = [...(s.cases || []), { ...c, at }].slice(-MAX_CASES);
    }
    return;
  }
  if (!NEGATIVE_FEEDBACK.has(kind)) return;
  const e = entry(d, ticket);
  e.negative = true; delete e.reporterConfirmed;
  const basis = e.served.at(-1);
  if (basis && !e.gaps.some((g) => g.reason === "wrong_metric")) addGap(e, { reason: "unclear_explanation", tool: basis.tool, metric: basis.metric, at });
}

const TEXT = {
  wrong_metric: (g) => `Evidence gap, wrong metric: a figure from ${g.tool}${g.metric ? ` (${g.metric})` : ""} was quoted and then corrected. Before quoting a figure, name the metric, its unit and its turn from the read's envelope, and never swap a neighbouring measure for it: a level is not a growth rate, units offered are not units sold.`,
  tool_discovery: (g) => `Evidence gap, tool discovery: ${g.tool} was not found on the first attempt. List the gamestate read tools with read_tools and call ${g.tool} directly instead of falling back to a raw collection read or an estimate.`,
  missing_data: (g) => `Evidence gap, missing data: ${g.tool}${g.metric ? ` (${g.metric})` : ""} returned gaps or only empty rows. Say which values are not recorded and over what span, and never fill a gap with an estimate or another source.`,
  unclear_explanation: (g) => `Evidence gap, unclear explanation: figures from ${g.tool}${g.metric ? ` (${g.metric})` : ""} were sourced, yet the answer was called wrong or misleading. Lead with the metric name, unit and turn, then one plain sentence on what the figure means and what it does not.`,
};

/** Recalls of these note ids on one ticket, from the notebook's own recall log. Fails soft to none. */
function recalledOn(notebook, ticket, ids) {
  try {
    const fs = require("node:fs");
    if (!notebook?.recallLog || !fs.existsSync(notebook.recallLog)) return false;
    const want = new Set(ids);
    return fs.readFileSync(notebook.recallLog, "utf8").split("\n").some((line) => {
      if (!line) return false;
      try { const r = JSON.parse(line); return String(r.ticket) === String(ticket) && (r.ids || []).some((id) => want.has(id)); } catch { return false; }
    });
  } catch { return false; }
}

function signatures(d) { return (d.evidenceGaps ||= { tickets: {}, signatures: {} }).signatures; }
function prune(sigs) {
  const keys = Object.keys(sigs);
  if (keys.length > MAX_SIGNATURES) for (const k of keys.sort((a, b) => (sigs[a].at || 0) - (sigs[b].at || 0)).slice(0, keys.length - MAX_SIGNATURES)) delete sigs[k];
}

/**
 * At a clean or unclean close. reporter is any stable id for the ticket's reporter (only its hash is stored).
 *
 * A gap is first a candidate: nothing is written to the notebook, so nothing reaches automatic recall, until the same
 * signature has been seen on a second ticket from a different reporter. Then one fixed-wording lesson is written, still
 * unverified. A lesson counts as confirmed on a later case only when that case is independent of every origin, the
 * lesson was recalled on it, the answer served evidence cleanly AND the reporter gave an outcome of their own (a helpful
 * vote). Closing a ticket, resolving it or letting it auto-close is no outcome: such a case is counted as recalled-quiet,
 * which the lesson report shows apart from confirmation. Returns what happened.
 */
function settle({ d, notebook, ticket, reporter, audit, now = () => Date.now() }) {
  const e = d.evidenceGaps?.tickets?.[String(ticket)];
  const out = { lessons: [], confirmed: [], quiet: [] };
  if (!e || e.settledAt) return out;
  const who = reporter ? hashOf(reporter) : null;
  const sigs = signatures(d);
  const log = (kind, v) => { try { audit?.(kind, { ticket, ...v }); } catch {} };
  for (const g of e.gaps) {
    const sig = sigOf(g);
    const s = (sigs[sig] ||= { reason: g.reason, tool: g.tool, metric: g.metric, tickets: 0, origins: [], lesson: null, cases: [], quiet: [], at: now() });
    s.origins ||= []; s.quiet ||= [];
    s.tickets += 1; s.at = now();
    if (!s.origins.some((o) => o.ticket === Number(ticket) || (who && o.reporter === who))) s.origins.push({ ticket: Number(ticket), reporter: who });
    if (s.origins.length > MAX_CASES) s.origins.shift();
    log("evidence_gap", { reason: g.reason, tool: g.tool, metric: g.metric });
    const independentOrigins = new Set(s.origins.filter((o) => o.reporter).map((o) => o.reporter)).size;
    if (!s.lesson && independentOrigins >= 2 && notebook?.remember) {
      try {
        const note = notebook.remember({ kind: "lesson", text: tag("question", TEXT[g.reason](g)), by: BY, verified: false });
        s.lesson = note.id;
        out.lessons.push(note.id);
      } catch (err) { log("evidence_gap_lesson_skipped", { reason: String(err.message).slice(0, 120) }); }
    }
  }
  const clean = !e.gaps.length && !e.corrected && !e.negative;
  if (clean) {
    for (const served of e.served) {
      for (const [sig, s] of Object.entries(sigs)) {
        if (!s.lesson || s.tool !== served.tool || (s.metric || null) !== (served.metric || null)) continue;
        s.origins ||= []; s.cases ||= []; s.quiet ||= [];
        const independent = who && !s.origins.some((o) => o.ticket === Number(ticket) || o.reporter === who) && !s.cases.some((c) => c.ticket === Number(ticket) || c.reporter === who) && !s.quiet.some((c) => c.ticket === Number(ticket) || c.reporter === who);
        if (!independent || !recalledOn(notebook, ticket, [s.lesson])) continue;
        const note = notebook?.all?.().find((n) => n.id === s.lesson);
        if (e.reporterConfirmed) {
          s.cases.push({ ticket: Number(ticket), reporter: who, at: now() });
          if (s.cases.length > MAX_CASES) s.cases.shift();
          if (note) { note.outcomeConfirmed = s.cases.length; note.outcomeConfirmedAt = now(); }
          out.confirmed.push({ sig, cases: s.cases.length });
          log("evidence_lesson_confirmed", { signature: sig, cases: s.cases.length });
        } else {
          s.quiet.push({ ticket: Number(ticket), reporter: who, at: now() });
          if (s.quiet.length > MAX_CASES) s.quiet.shift();
          if (note) { note.recalledQuiet = s.quiet.length; }
          out.quiet.push({ sig, cases: s.quiet.length });
          log("evidence_lesson_recalled_quiet", { signature: sig, cases: s.quiet.length });
        }
        if (note) { try { notebook.save?.(); } catch {} }
      }
    }
  }
  prune(sigs);
  e.settledAt = now();
  return out;
}

/** Counts by reason across open and settled tickets, and lessons by confirmation, for reports. */
function summary(d) {
  const tickets = Object.values(d.evidenceGaps?.tickets || {});
  const byReason = Object.fromEntries(REASONS.map((r) => [r, 0]));
  for (const t of tickets) for (const g of t.gaps) byReason[g.reason] = (byReason[g.reason] || 0) + 1;
  const sigs = Object.values(d.evidenceGaps?.signatures || {});
  return { tickets: tickets.length, byReason, candidates: sigs.filter((s) => !s.lesson).length, lessons: sigs.filter((s) => s.lesson).length, confirmed: sigs.filter((s) => (s.cases || []).length >= CONFIRMED_AT).length, recalledQuiet: sigs.reduce((n, s) => n + (s.quiet || []).length, 0) };
}

module.exports = { REASONS, EVIDENCE_TOOLS, BY, noteRead, notePost, noteFeedback, settle, summary, judge, sigOf, CONFIRMED_AT };
