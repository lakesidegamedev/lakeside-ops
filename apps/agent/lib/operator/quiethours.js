"use strict";
// Per-device quiet hours. The owner picks a start, an end and a time zone on the
// phone. Off by default. The window is read as local wall-clock time in that
// zone, so DST shifts move it with the clock, and start after end means it
// crosses midnight. There is deliberately no urgent bypass: during the window
// nothing is delivered to that phone, and what is still open is sent afterwards.
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

// Returns a stored shape, or null when the input would not describe a usable window.
function normalizeQuiet(q) {
  if (!q || typeof q !== "object" || q.enabled !== true) return { enabled: false };
  const start = HHMM.exec(String(q.start)), end = HHMM.exec(String(q.end));
  const tz = typeof q.tz === "string" ? q.tz : "";
  if (!start || !end || start[0] === end[0] || !validZone(tz)) return { enabled: false };
  return { enabled: true, start: start[0], end: end[0], tz };
}

function localMinutes(at, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get("hour") * 60 + get("minute");
}

function quietNow(quiet, at = Date.now()) {
  const q = normalizeQuiet(quiet);
  if (!q.enabled) return false;
  const [sh, sm] = q.start.split(":").map(Number), [eh, em] = q.end.split(":").map(Number);
  const s = sh * 60 + sm, e = eh * 60 + em, m = localMinutes(at, q.tz);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

module.exports = { normalizeQuiet, quietNow };
