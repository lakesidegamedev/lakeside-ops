"use strict";
// Keir 11.4 (owner, 2026-11-21): what the owner reads is plain. His iPhone Inbox showed "Next: Keir must record the next
// milestone." on every row, "Reconfirmed the cause from main e67daa9db9", and "Read live turn state at 14:26Z". His
// standing rule: nothing shown to him or to players uses UTC. Pure functions.
//
//   etTimes(text, now)  UTC clock times and ISO timestamps become US Eastern, labelled ET.
//   plain(text, now)    etTimes, plus commit hashes, file paths with line numbers, and task, worker and job ids are
//                       replaced with what they mean or dropped.
const ZONE = "America/New_York";
const clock = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, month: "short", day: "numeric" });
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

function et(ms, now = Date.now()) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  const sameDay = dayKey.format(d) === dayKey.format(new Date(now));
  return `${sameDay ? "" : `${day.format(d)}, `}${clock.format(d)} ET`;
}

// The UTC instant for an HH:MM clock time on the day of `now` (UTC), stepping back a day when that is in the future.
function utcClock(h, m, s, now) {
  const base = new Date(now);
  let at = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, m, s || 0);
  if (at - now > 3600000) at -= 86400000;
  return at;
}

function etTimes(text, now = Date.now()) {
  return String(text ?? "")
    // ISO timestamps: 2026-11-21T14:26:00.000Z, 2026-11-21 14:26 UTC
    .replace(/\b(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(?:Z|UTC|GMT|\+00:?00)\b/gi, (all, date, h, m, s) => et(Date.parse(`${date}T${h}:${m}:${s || "00"}Z`), now) || all)
    // Clock times marked UTC: 14:26Z, 14:26 UTC, 2:26 PM UTC
    .replace(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(?:Z|UTC|GMT)\b/gi, (all, h, m, s, ap) => {
      let hh = Number(h); if (ap) hh = (hh % 12) + (/pm/i.test(ap) ? 12 : 0);
      return hh > 23 || Number(m) > 59 ? all : et(utcClock(hh, Number(m), Number(s), now), now);
    })
    // A bare 24-hour time in Keir's own notes is UTC: "since the 14:25 update". 12-hour and ET-labelled times are left alone.
    .replace(/(?<![\d:.])([01]\d|2[0-3]):([0-5]\d)(?![\d:])(?!\s*(?:AM|PM|ET|EST|EDT)\b)/gi, (all, h, m) => et(utcClock(Number(h), Number(m), 0, now), now));
}

// Players read times in Discord's own timestamp markup, which shows each reader their local time (as turn incidents do).
function discordTimes(text, now = Date.now()) {
  const mark = (ms) => (Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:t>` : null);
  return String(text ?? "")
    .replace(/\b(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(?:Z|UTC|GMT|\+00:?00)\b/gi, (all, date, h, m, s) => { const ms = Date.parse(`${date}T${h}:${m}:${s || "00"}Z`); return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:f>` : all; })
    .replace(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(?:Z|UTC|GMT)\b/gi, (all, h, m, s, ap) => {
      let hh = Number(h); if (ap) hh = (hh % 12) + (/pm/i.test(ap) ? 12 : 0);
      return hh > 23 || Number(m) > 59 ? all : mark(utcClock(hh, Number(m), Number(s), now));
    });
}

function plain(text, now = Date.now()) {
  return etTimes(text, now)
    .replace(/\b(?:from |on |at )?(?:origin\/)?main (?:at |commit )?[0-9a-f]{7,40}\b/gi, (m) => `${/^from /i.test(m) ? "from " : /^on /i.test(m) ? "on " : ""}the live version`)
    .replace(/\b(?:commit|sha|head|revision)\s+[0-9a-f]{7,40}\b/gi, "the change")
    .replace(/\b(?:development|staging) (?:at )?[0-9a-f]{7,40}\b/gi, (m) => `the ${m.split(" ")[0]} version`)
    .replace(/(?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|py|rs|swift|md|sh|ya?ml)(?::\d+(?::\d+)?)?/g, "the code")
    .replace(/\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs)(?::\d+(?::\d+)?)\b/g, "the code")
    .replace(/\b(?:(?:a|the|my|coding)\s+)*worker\s+cw-\d+-\d+\b/gi, "the coding worker")
    .replace(/\bcw-\d+-\d+\b/g, "a coding worker")
    .replace(/\b(?:job|task|action|decision|attempt|run|worker)\s+(?:id\s+)?(?:j_)?[0-9a-f]{10,}\b/gi, (m) => m.split(/\s+/)[0])
    .replace(/\bj_[0-9a-f]{16}\b/g, "")
    .replace(/(?<![\w#/])[0-9a-f]{12,40}(?![\w])/g, (m) => (/[a-f]/.test(m) && /\d/.test(m) ? "" : m))
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}

// One line: the first sentence, clipped.
function oneLine(text, max = 200) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const first = (t.match(/^.+?[.!?](?=\s|$)/) || [t])[0];
  return first.length > max ? `${first.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : first;
}

module.exports = { et, etTimes, discordTimes, plain, oneLine, ZONE };
