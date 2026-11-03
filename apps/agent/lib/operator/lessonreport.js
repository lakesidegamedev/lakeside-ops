"use strict";
// Lesson accounting (Keir 8): for each live lesson, how often it reached an activation and what
// happened on those tickets, against the same numbers for every ticket where anything was recalled.
// Pure: bin/keir-lesson-report.js reads the files and prints this. It never edits a lesson.
//   unused    live lesson never recalled, once tracking has run long enough to mean something
//   suspect   recalled on enough tickets and clearly worse than baseline (reopened or negative feedback)
//   unverified   never re-checked against the code (information only)
// Nothing here retires a lesson. Retirement is a separate, capped, reversible step after a lesson
// has been unused for a full tracking window.
const NEGATIVE = new Set(["slow_or_silent", "wrong_or_misleading", "bot_bug", "tone", "behaviour_request"]);
const DAY = 86400000;
const isLive = (n) => !n.supersededBy && !n.retiredAt && !n.invalidatedAt;

function buildReport({ notes = [], recalls = [], outcomes = {}, feedback = [], jobs = {}, now = Date.now(), minTrackingDays = 14, suspectMinTickets = 3, suspectMargin = 0.25 } = {}) {
  const trackingSince = recalls.length ? Math.min(...recalls.map((r) => r.at)) : null;
  const trackingDays = trackingSince ? (now - trackingSince) / DAY : 0;
  const state = new Map();
  for (const o of Object.values(outcomes)) {
    const s = o.reopened || o.superseded ? "reopened" : ["resolved", "closed"].includes(o.status) ? "resolved" : "open";
    if (!state.has(o.ticket) || s === "reopened") state.set(o.ticket, s);
  }
  const negative = new Set(feedback.filter((f) => f.ticket && NEGATIVE.has(f.kind)).map((f) => f.ticket));
  const praised = new Set(feedback.filter((f) => f.ticket && f.kind === "praise").map((f) => f.ticket));
  const per = new Map(), seen = new Set();
  for (const r of recalls) for (const id of r.ids || []) {
    const e = per.get(id) || { events: 0, tickets: new Set(), last: 0 };
    e.events++; e.last = Math.max(e.last, r.at);
    const t = r.ticket || jobs[r.job]?.ticket || null;
    if (t) { e.tickets.add(t); seen.add(t); }
    per.set(id, e);
  }
  const share = (tickets, pred) => (tickets.size ? [...tickets].filter(pred).length / tickets.size : null);
  const measures = (tickets) => ({ tickets: tickets.size, resolved: share(tickets, (t) => state.get(t) === "resolved"), reopened: share(tickets, (t) => state.get(t) === "reopened"), negative: share(tickets, (t) => negative.has(t)), praised: share(tickets, (t) => praised.has(t)) });
  const baseline = measures(seen);
  const lessons = notes.filter((n) => n.kind === "lesson" && isLive(n)).map((n) => {
    const e = per.get(n.id), m = measures(e?.tickets || new Set()), flags = [];
    const ageDays = (now - (n.at || now)) / DAY;
    if (!e && trackingDays >= minTrackingDays && ageDays >= minTrackingDays) flags.push("unused");
    if (e && m.tickets >= suspectMinTickets && ((m.negative ?? 0) - (baseline.negative ?? 0) >= suspectMargin || (m.reopened ?? 0) - (baseline.reopened ?? 0) >= suspectMargin)) flags.push("suspect");
    if (!n.verifiedAt) flags.push("unverified");
    return { id: n.id, text: n.text, ageDays: Math.round(ageDays * 10) / 10, recalls: e?.events || 0, lastRecalledAt: e?.last || null, ...m, flags };
  });
  return {
    trackingSince, trackingDays: Math.round(trackingDays * 10) / 10, baseline, lessons,
    summary: { lessons: lessons.length, recalledAtLeastOnce: lessons.filter((l) => l.recalls).length, unused: lessons.filter((l) => l.flags.includes("unused")).length, suspect: lessons.filter((l) => l.flags.includes("suspect")).length, unverified: lessons.filter((l) => l.flags.includes("unverified")).length,
      enoughData: trackingDays >= minTrackingDays },
  };
}
module.exports = { buildReport, NEGATIVE };
