"use strict";
// Exact status requests read the canonical health summary without a model's
// tool discovery. Broader questions and requested changes keep their normal route.
function isGameStatusQuery(text) {
  const s = String(text).trim().replace(/\s+/g, " ");
  return /^(?:please )?(?:(?:show(?: me)?|what(?:'s| is)) (?:the )?)?game status[.!?]*$/i.test(s)
    || /^how(?:'s| is) (?:the )?game(?: doing| running)?[.!?]*$/i.test(s);
}
function formatStatus(s, now = Date.now()) {
  const checked = Date.parse(s?.checkedAt);
  if (!Number.isSafeInteger(s?.turn) || s.turn < 0 || typeof s.paused !== "boolean" || !Number.isFinite(checked) || now - checked > 120000 || checked > now + 30000)
    throw new Error("Current game status is unavailable");
  const parts = [`Live game status, checked just now: turn ${s.turn}${Number.isFinite(s.year) ? `, year ${s.year}` : ""}.`, s.paused ? `The game is paused${s.pauseReason ? `: ${String(s.pauseReason).slice(0, 180)}` : "."}` : "The game is running."];
  if (typeof s.lastTurn?.success === "boolean") {
    const seconds = Number.isFinite(s.lastTurn.durationMs) ? Math.round(s.lastTurn.durationMs / 1000) : null;
    parts.push(`The latest turn ${s.lastTurn.success ? "succeeded" : "failed"}${seconds === null ? "" : ` in ${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds`}.`);
  }
  if (Number.isSafeInteger(s.lastTurn?.warnings)) parts.push(`${s.lastTurn.warnings} warning${s.lastTurn.warnings === 1 ? "" : "s"} on the latest turn.`);
  if (Number.isSafeInteger(s.recent?.failures) && Number.isSafeInteger(s.recent?.count) && s.recent.count > 0) parts.push(`${s.recent.failures} failed attempts across the last ${s.recent.count} recorded turn attempts. These are historical records; the latest turn result is reported separately.`);
  const next = Date.parse(s.schedule?.next);
  if (Number.isFinite(next)) parts.push(`The next turn is scheduled for ${new Date(next).toISOString().slice(11, 16)} UTC${s.schedule.overdueMin > 0 ? `, ${Math.ceil(s.schedule.overdueMin)} minutes overdue` : ""}.`);
  return parts.join(" ");
}
async function readGameStatus(mcp) {
  const status = await mcp.call("engine", "engine_health", {}, false, AbortSignal.timeout(8000));
  return formatStatus(status);
}
module.exports = { isGameStatusQuery, formatStatus, readGameStatus };
