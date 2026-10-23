"use strict";
// 2026-10-23 DeepSeek v4.1 Flash shadow: a third of activations hit the step
// limit. They repeated reads that had already failed, kept calling a server
// that had just timed out, and spent every step reading, so the final reply
// was cut off. Pure: a session in, a refusal or note out.
const crypto = require("node:crypto");

// Reads only. A write or finish that failed can pass once state changes.
const READS = new Set(["read_tool", "read_tools", "reporter_state", "past_ticket", "similar_reports", "ticket_history", "recall", "view_page", "view_attachment", "source_history", "recent_changes"]);
const UNREACHABLE = /aborted due to timeout|timed out|ETIMEDOUT|socket connection was closed/i;
const key = (name, input) => crypto.createHash("sha256").update(JSON.stringify([name, input ?? null])).digest("hex");
const target = (name, input) => name === "read_tool" && input?.server && input?.tool ? `${input.server}/${input.tool}` : null;
const state = (session) => (session.guard ||= { failed: new Map(), down: new Map() });

function refuse(session, name, input) {
  if (!READS.has(name)) return null;
  const g = state(session), t = target(name, input);
  if (t && g.down.has(t)) return `${t} failed to respond earlier in this activation (${g.down.get(t)}). Do not call it again now. Use another source or continue with what you have.`;
  const prior = g.failed.get(key(name, input));
  return prior ? `This exact call already failed in this activation: ${prior} Do not repeat it. Change the arguments, use another source, or continue with what you have.` : null;
}

function failed(session, name, input, message) {
  if (!READS.has(name)) return;
  const g = state(session), m = String(message || "").slice(0, 300), t = target(name, input);
  g.failed.set(key(name, input), m);
  if (t && UNREACHABLE.test(m)) g.down.set(t, m.slice(0, 120));
}

// Counts every tool call, failed ones included. Parallel calls share a model
// step, so this warns early rather than late.
function budgetNote(session) {
  const max = session.maxTurns;
  if (!Number.isFinite(max) || max <= 0) return null;
  const left = max - (session.steps || 0);
  if (left > Math.max(2, Math.round(max / 6))) return null;
  return left <= 0
    ? `Step budget used (${max}). Your next call may be cut off: post the reply or save a checkpoint, then finish.`
    : `Step budget: ${left} of ${max} left. Stop reading. Post the reply or save a checkpoint now, then finish. Work after the last step is lost.`;
}

module.exports = { refuse, failed, budgetNote, READS };
