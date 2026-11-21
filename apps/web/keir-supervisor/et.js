"use strict";
// Every time the owner reads from the private supervisor is US Eastern ("ET"),
// never UTC. One formatter so the transcript context, tool results and the
// attention list all say the same thing.
const ZONE = "America/New_York";

const clock = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit", hour12: true });
const day = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "short", month: "short", day: "numeric" });
const year = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, year: "numeric" });

function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// "12:08 PM ET", or "Sat, Nov 21, 12:08 PM ET" with { date: true }.
function formatET(value, { date = false, withYear = false } = {}) {
  const ms = toMs(value);
  if (ms === null) return null;
  const at = new Date(ms);
  const time = `${clock.format(at)} ET`;
  if (!date) return time;
  return `${day.format(at)}${withYear ? ` ${year.format(at)}` : ""}, ${time}`;
}

module.exports = { formatET, ZONE };
