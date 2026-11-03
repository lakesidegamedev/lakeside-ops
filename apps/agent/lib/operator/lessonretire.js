"use strict";
// Lesson retirement (Keir 8.x). Pure planning: which live lessons to retire, with a reason each.
// It never touches the notebook; bin/keir-lesson-retire.js and the curator schedule apply the plan
// through notebook.retire(), which records a reversible history entry.
//   duplicate  Jaccard on word sets >= 0.7 with a lesson that has the better record (recalls, verified, newer)
//   stale      code source gone or changed, and the verifier's rewrite attempt failed
//   unused     the report's unused flag (never recalled across a full tracking window)
// Never retired: decisions, anything recalled in the last 7 days. Capped per plan.
const DAY = 86400000;
const WORDS = (t) => new Set(String(t || "").toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []);
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let both = 0; for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}
const better = (a, b) => (b.recalls || 0) - (a.recalls || 0) || Boolean(b.verifiedAt) - Boolean(a.verifiedAt) || (b.at || 0) - (a.at || 0);

function planRetirements({ notes = [], report = null, now = Date.now(), cap = 5, threshold = 0.7, recentDays = 7 } = {}) {
  const eligible = notes.filter((n) => n.kind === "lesson" && !n.supersededBy && !n.retiredAt && !(n.lastRecalledAt && now - n.lastRecalledAt < recentDays * DAY));
  const plan = new Map();
  const add = (n, rule, reason) => { if (!plan.has(n.id)) plan.set(n.id, { id: n.id, rule, reason, text: n.text }); };
  for (const n of eligible) if (n.invalidatedAt && n.lastVerificationAttempt && n.verificationError) add(n, "stale", "code source changed or gone and the rewrite attempt failed");
  const unused = new Set((report?.lessons || []).filter((l) => l.flags.includes("unused")).map((l) => l.id));
  const live = notes.filter((n) => n.kind === "lesson" && !n.supersededBy && !n.retiredAt);
  const sets = new Map(live.map((n) => [n.id, WORDS(n.text)]));
  for (const n of eligible) {
    const twin = live.filter((o) => o.id !== n.id && (o.player || "") === (n.player || "") && jaccard(sets.get(n.id), sets.get(o.id)) >= threshold)
      .find((o) => better(n, o) > 0 || (better(n, o) === 0 && o.id < n.id));
    if (twin) add(n, "duplicate", `near duplicate of ${twin.id}`);
  }
  for (const n of eligible) if (unused.has(n.id)) add(n, "unused", "never recalled in the tracking window");
  return [...plan.values()].slice(0, Math.max(0, cap));
}

// Recall-score multiplier from a lesson's record against the baseline. Bounded 0.8 to 1.25 and 1.0
// below three tickets, so a thin record never moves the ranking.
function recordMultiplier(row, baseline, { minTickets = 3 } = {}) {
  if (!row || row.tickets < minTickets) return 1;
  const d = (k) => (row[k] ?? 0) - (baseline?.[k] ?? 0);
  return Math.min(1.25, Math.max(0.8, 1 + 0.5 * (d("resolved") - d("reopened") - d("negative"))));
}
function recordMultipliers(report) {
  const out = new Map();
  for (const l of report?.lessons || []) { const m = recordMultiplier(l, report.baseline); if (m !== 1) out.set(l.id, m); }
  return out;
}
// Report for a notebook's lessons from its recall log and a ledger's outcome data.
function reportFor({ notes, recallLog, ledgerData = {}, now = Date.now(), minTrackingDays = 14 }) {
  const { buildReport } = require("./lessonreport");
  let recalls = [];
  try { recalls = require("node:fs").readFileSync(recallLog, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* no log yet */ }
  return buildReport({ notes, recalls, outcomes: ledgerData.ticketOutcomes || {}, feedback: ledgerData.feedbackLog || [], jobs: ledgerData.jobs || {}, now, minTrackingDays });
}
module.exports = { reportFor, planRetirements, recordMultiplier, recordMultipliers, jaccard };
