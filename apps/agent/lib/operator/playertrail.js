"use strict";
// Keir 10 (W3): what the ticket's reporter did in the game around a time.
//
// Page views, clicks, rage clicks, errors and failed requests from PostHog, for
// the reporter only (the same scope as trace_character). Ticket 1829 needed to
// know the slideshow had skipped before the player could say so.
//
// Credentials come from the environment, never a file read here:
//   POSTHOG_READ_API_KEY      a personal key with query:read (POSTHOG_PERSONAL_API_KEY also accepted)
//   POSTHOG_PROJECT_ID        the game's project id
//   POSTHOG_HOST              optional, default https://us.posthog.com (the game uses PostHog US cloud)
// The game identifies a player to PostHog by their account id (distinct_id), and
// only after cookie consent: no events for a player simply means no trail.
// Emails and IPs are never selected, and text found in elements is scrubbed.

const HEX24 = /^[0-9a-f]{24}$/;
const EVENTS = ["$pageview", "$autocapture", "$rageclick", "$dead_click", "$exception"];
const MAX_ROWS = 400;

const scrub = (v, n = 80) => String(v ?? "").replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]").replace(/\s+/g, " ").trim().slice(0, n);
const hogTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

function summarize(rows, { host, project }) {
  const counts = {}, timeline = [], errors = [], rage = [], sessions = new Map();
  for (const [event, ts, path, session, text, errMessage, status] of rows) {
    counts[event] = (counts[event] || 0) + 1;
    if (session && !sessions.has(session)) sessions.set(session, ts);
    const row = { at: String(ts).replace(" ", "T").slice(0, 19) + "Z", event: event.replace(/^\$/, ""), path: scrub(path, 120) || undefined, ...(text ? { text: scrub(text, 60) } : {}), ...(errMessage ? { error: scrub(errMessage, 160) } : {}), ...(status ? { status: Number(status) || undefined } : {}) };
    if (event === "$exception" || /error|fail/i.test(event) || (Number(status) >= 400)) errors.push(row);
    if (event === "$rageclick") rage.push(row);
    if (timeline.length < 60 && (event !== "$autocapture" || text)) timeline.push(row);
  }
  const replays = [...sessions.keys()].slice(0, 3).map((s) => `${host}/project/${project}/replay/${encodeURIComponent(s)}`);
  return { counts, rageClicks: rage.slice(0, 10), errors: errors.slice(0, 15), timeline, replayLinks: replays };
}

function createPlayerTrail({ env = process.env, fetcher = fetch, resolveIdentity, now = () => Date.now() } = {}) {
  async function call(job, input, signal) {
    if (job.role === "player") throw new Error("players cannot read activity trails through Keir");
    if (!job.ticket) throw new Error("player_trail needs an assigned ticket: it reads the reporter only");
    const key = env.POSTHOG_READ_API_KEY || env.POSTHOG_PERSONAL_API_KEY, project = env.POSTHOG_PROJECT_ID, host = String(env.POSTHOG_HOST || "https://us.posthog.com").replace(/\/+$/, "");
    if (!key || !/^\d{1,12}$/.test(String(project || ""))) return { configured: false, note: "The activity trail (PostHog) is not configured on this host. Do not tell the player their activity cannot be seen; say you could not check it." };
    const who = await resolveIdentity(job, signal);
    if (!who?.matched || !HEX24.test(who.private?.userId || "")) return { matched: false, note: "The reporter's account could not be tied to this ticket (see resolve_reporter), so no activity can be read." };
    const around = input.around ? Date.parse(input.around) : now();
    if (!Number.isFinite(around)) throw new Error("around must be an ISO time such as 2026-11-13T21:30:00Z");
    const minutes = Math.min(Math.max(Number(input.minutes) || 30, 5), 360);
    const from = around - minutes * 60000, to = Math.min(around + minutes * 60000, now() + 60000);
    const res = await fetcher(`${host}/api/projects/${project}/query/`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
      body: JSON.stringify({ query: { kind: "HogQLQuery",
        query: `SELECT event, toString(timestamp), properties.$pathname, properties.$session_id, properties.$el_text, coalesce(properties.$exception_message, properties.error_message), coalesce(properties.status, properties.status_code) FROM events WHERE distinct_id = {distinct} AND timestamp >= toDateTime({from}) AND timestamp <= toDateTime({to}) AND (event IN {kinds} OR event ILIKE '%error%' OR event ILIKE '%fail%') ORDER BY timestamp ASC LIMIT ${MAX_ROWS}`,
        values: { distinct: who.private.userId, from: hogTime(from), to: hogTime(to), kinds: EVENTS } } }),
    });
    if (!res.ok) throw new Error(`PostHog ${res.status}`);
    const rows = (await res.json()).results || [];
    if (!rows.length) return { matched: true, window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, events: 0, note: "No events in this window. The player may have declined analytics cookies, so this is not proof they did nothing." };
    return { matched: true, window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, events: rows.length, ...summarize(rows, { host, project }),
      instruction: "Staff evidence only. Replay links are for developers: never put a replay link, an event list or 'we watched your session' in a reply to the player. Say what you found in game terms." };
  }
  return { call };
}

module.exports = { createPlayerTrail, summarize, scrub };
