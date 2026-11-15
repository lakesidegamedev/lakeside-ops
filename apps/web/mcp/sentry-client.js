"use strict";

// Read-only Sentry API client and response shaping for the sentry MCP server.
// Pure functions and an injectable fetch so tests run on fixtures, no token.
// Players only ever see the first 8 characters of an event id ("Ref: 584ffe8b").
// Never return email, IP or username: user is reduced to its id.

const API = "https://sentry.io/api/0";

class SentryError extends Error {
  constructor(message, status) { super(message); this.name = "SentryError"; this.status = status || null; }
}

function createClient({ token, org = "lakeside-games", fetchImpl = globalThis.fetch, base = API } = {}) {
  if (!token) throw new SentryError("SENTRY_AUTH_TOKEN is not set", 500);
  async function request(path, params = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
    }
    let res;
    try { res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }); }
    catch (e) { throw new SentryError(`Sentry unreachable: ${e.message}`, 502); }
    if (res.status === 401) throw new SentryError("Sentry rejected the token (401). The read token is invalid or expired.", 401);
    if (res.status === 403) throw new SentryError("Sentry token lacks permission for this call (403).", 403);
    if (res.status === 404) throw new SentryError("Not found in Sentry (404).", 404);
    if (res.status === 429) {
      const wait = res.headers && res.headers.get ? res.headers.get("retry-after") : null;
      throw new SentryError(`Sentry rate limit hit (429)${wait ? `, retry after ${wait}s` : ""}.`, 429);
    }
    if (!res.ok) throw new SentryError(`Sentry returned HTTP ${res.status}.`, res.status);
    return res;
  }
  async function get(path, params) { return (await request(path, params)).json(); }
  // Sentry paginates with a Link header; the next page is the rel="next" entry with results="true".
  async function getPaged(path, params) {
    const res = await request(path, params);
    const link = res.headers && res.headers.get ? res.headers.get("link") || "" : "";
    const m = link.match(/<[^>]*[?&]cursor=([^&>]+)[^>]*>;\s*rel="next";\s*results="true"/);
    const body = await res.json();
    return { data: Array.isArray(body) ? body : body.data || [], next: m ? decodeURIComponent(m[1]) : null };
  }
  let projectCache = null;
  async function projectIds(slugs) {
    if (!projectCache) {
      const list = await get(`/organizations/${org}/projects/`);
      projectCache = new Map(list.map(p => [p.slug, String(p.id)]));
    }
    return slugs.map(s => {
      if (/^\d+$/.test(s)) return s;
      const id = projectCache.get(s);
      if (!id) throw new SentryError(`Unknown project "${s}". Known: ${[...projectCache.keys()].join(", ")}`, 400);
      return id;
    });
  }
  return { org, get, getPaged, projectIds };
}

const iso = v => (v ? String(v) : null);

function shapeIssue(i) {
  return {
    id: String(i.id), shortId: i.shortId, title: i.title, culprit: i.culprit || null,
    count: Number(i.count) || 0, userCount: Number(i.userCount) || 0,
    firstSeen: iso(i.firstSeen), lastSeen: iso(i.lastSeen), permalink: i.permalink || null,
    level: i.level || null, project: i.project && i.project.slug ? i.project.slug : null,
  };
}

// One readable line per breadcrumb: what the player did, not what they typed.
// The game only ships method, path and status for requests and from/to paths
// for navigation, so nothing here can carry a payload.
function describeCrumb(b) {
  const d = (b && b.data) || {};
  if ((b.category === "fetch" || b.category === "xhr") && d.url) {
    return `${d.method || "GET"} ${d.url}${d.status_code != null ? ` -> ${d.status_code}` : ""}`;
  }
  if (b.category === "navigation" && (d.from || d.to)) return `navigate ${d.from || "?"} -> ${d.to || "?"}`;
  if (b.category && b.category.startsWith("ui.") && b.message) return `${b.category.slice(3)} ${String(b.message).slice(0, 120)}`;
  if (b.category === "console" && b.message) return `console ${String(b.message).slice(0, 120)}`;
  return null;
}

const tagMap = event => Object.fromEntries((event.tags || []).map(t => [t.key, t.value]));

function shapeEvent(event) {
  const entries = event.entries || [];
  const exc = entries.find(e => e.type === "exception");
  const value = exc && exc.data && Array.isArray(exc.data.values) ? exc.data.values[exc.data.values.length - 1] : null;
  const frames = value && value.stacktrace && Array.isArray(value.stacktrace.frames) ? value.stacktrace.frames : [];
  const inApp = frames.filter(f => f.inApp).slice(-5).reverse();
  const topFrames = (inApp.length ? inApp : frames.slice(-5).reverse()).map(f => ({
    function: f.function || null, file: f.filename || f.absPath || null, line: f.lineNo ?? null, col: f.colNo ?? null, inApp: !!f.inApp,
  }));
  const crumbs = entries.find(e => e.type === "breadcrumbs");
  const crumbTail = (crumbs && crumbs.data && Array.isArray(crumbs.data.values) ? crumbs.data.values : []).slice(-15).map(b => ({
    timestamp: iso(b.timestamp), category: b.category || null, level: b.level || null,
    message: b.message ? String(b.message).slice(0, 200) : null,
    step: describeCrumb(b),
  }));
  const req = entries.find(e => e.type === "request");
  const tags = tagMap(event);
  const wanted = ["route", "error_code", "release", "browser", "browser.name", "environment", "handled", "os", "url"];
  const picked = {};
  for (const k of wanted) if (tags[k] != null) picked[k] = tags[k];
  if (event.release && event.release.version && !picked.release) picked.release = event.release.version;
  return {
    eventId: event.eventID || event.id, ref: String(event.eventID || event.id || "").slice(0, 8),
    timestamp: iso(event.dateCreated), title: event.title || null,
    exception: value ? { type: value.type || null, value: value.value ? String(value.value).slice(0, 500) : null } : null,
    topFrames, tags: picked, breadcrumbs: crumbTail,
    url: (req && req.data && req.data.url) || tags.url || null,
    userId: event.user && event.user.id ? String(event.user.id) : null,
    characterId: tags["character.id"] || null,
    countryId: tags["country.id"] || null,
  };
}

// Normalise "Ref: 584ffe8b", "584FFE8B" or a full 32 char id to a lowercase hex prefix.
function normaliseRef(input) {
  const m = String(input || "").toLowerCase().match(/[0-9a-f]{6,32}/g);
  if (!m) return null;
  return m.sort((a, b) => b.length - a.length)[0];
}

// Events API refuses wildcards on id, so match the prefix client-side.
function matchEventPrefix(rows, ref) {
  const prefix = normaliseRef(ref);
  if (!prefix) return [];
  return rows.filter(r => String(r.id || "").toLowerCase().startsWith(prefix));
}

async function listIssues(client, { project, query, statsPeriod = "24h", sort = "date", limit = 25 } = {}) {
  const projects = project ? await client.projectIds([].concat(project)) : undefined;
  const q = query && query.trim() ? query.trim() : "is:unresolved";
  const rows = await client.get(`/organizations/${client.org}/issues/`, {
    query: /\bis:/.test(q) ? q : `is:unresolved ${q}`, statsPeriod, sort, limit: Math.min(Math.max(limit, 1), 100), project: projects,
  });
  return rows.map(shapeIssue);
}

async function getIssue(client, id) {
  const issue = await client.get(`/organizations/${client.org}/issues/${encodeURIComponent(id)}/`);
  let latest = null;
  try { latest = shapeEvent(await client.get(`/organizations/${client.org}/issues/${encodeURIComponent(issue.id)}/events/latest/`)); }
  catch (e) { if (!(e instanceof SentryError) || e.status === 401 || e.status === 429) throw e; }
  return { issue: shapeIssue(issue), latestEvent: latest };
}

async function lookupEvent(client, ref, { statsPeriod = "14d", maxPages = 10, project } = {}) {
  const prefix = normaliseRef(ref);
  if (!prefix) throw new SentryError("Give an event id or the 8 character ref from the error page.", 400);
  let cursor; let scanned = 0;
  const projects = project ? await client.projectIds([].concat(project)) : undefined;
  for (let page = 0; page < maxPages; page++) {
    const { data, next } = await client.getPaged(`/organizations/${client.org}/events/`, {
      field: ["id", "title", "issue", "project", "timestamp"], dataset: "errors", statsPeriod, per_page: 100, sort: "-timestamp",
      project: projects, cursor,
    });
    scanned += data.length;
    const hits = matchEventPrefix(data, prefix);
    if (hits.length) return { found: true, scanned, matches: hits.map(h => ({ eventId: h.id, ref: h.id.slice(0, 8), title: h.title, issue: h.issue || null, project: h.project || null, timestamp: h.timestamp })) };
    if (!next) break;
    cursor = next;
  }
  return { found: false, scanned, note: `No event starting ${prefix} in the last ${statsPeriod}. Try a longer statsPeriod.` };
}

async function newSince(client, { since, project, limit = 50 }) {
  const t = new Date(since);
  if (Number.isNaN(t.getTime())) throw new SentryError("since must be an ISO timestamp.", 400);
  const hours = Math.max(1, Math.ceil((Date.now() - t.getTime()) / 3600000));
  const period = hours > 24 * 30 ? "30d" : hours > 48 ? `${Math.ceil(hours / 24)}d` : `${hours}h`;
  const issues = await listIssues(client, { project, query: `is:unresolved firstSeen:>${t.toISOString()}`, statsPeriod: period, sort: "new", limit });
  return issues.filter(i => i.firstSeen && new Date(i.firstSeen) > t);
}

// Search syntax for one player's errors: account id, character id and an
// optional page path. Values are quoted so ids and paths cannot inject terms.
function playerQuery({ userId, characterId, page }) {
  const q = (v) => `"${String(v).replace(/["\\]/g, "")}"`;
  const terms = [];
  if (userId) terms.push(`user.id:${q(userId)}`);
  if (characterId) terms.push(`character.id:${q(characterId)}`);
  if (page) terms.push(`url:*${String(page).replace(/[\s"*\\]/g, "")}*`);
  return terms.join(" ");
}

function windowFor({ around, windowMinutes = 60 }) {
  if (!around) return null;
  const t = new Date(around);
  if (Number.isNaN(t.getTime())) throw new SentryError("around must be an ISO timestamp.", 400);
  const ms = Math.min(Math.max(windowMinutes, 5), 24 * 60) * 60000;
  return { start: new Date(t.getTime() - ms).toISOString(), end: new Date(t.getTime() + ms).toISOString() };
}

async function playerErrors(client, { userId, characterId, page, around, windowMinutes = 60, statsPeriod = "7d", detail = 3, project } = {}) {
  if (!userId && !characterId) throw new SentryError("Give the player's account id (userId) or character id.", 400);
  const projects = project ? await client.projectIds([].concat(project)) : undefined;
  const win = windowFor({ around, windowMinutes });
  const { data } = await client.getPaged(`/organizations/${client.org}/events/`, {
    field: ["id", "title", "timestamp", "url", "issue", "project", "release"], dataset: "errors",
    query: playerQuery({ userId, characterId, page }), sort: "-timestamp", per_page: 50, project: projects,
    ...(win ? win : { statsPeriod }),
  });
  const events = data.map(r => ({ eventId: r.id, ref: String(r.id || "").slice(0, 8), title: r.title, timestamp: r.timestamp, url: r.url || null, issue: r.issue || null, project: r.project || null }));
  const detailed = [];
  for (const e of events.slice(0, Math.min(Math.max(detail, 0), 5))) {
    if (!e.project) continue;
    try { detailed.push(shapeEvent(await client.get(`/projects/${client.org}/${encodeURIComponent(e.project)}/events/${encodeURIComponent(e.eventId)}/`))); }
    catch (err) { if (!(err instanceof SentryError) || err.status === 401 || err.status === 429) throw err; }
  }
  return {
    count: events.length, window: win || { statsPeriod }, events, detailed,
    note: events.length ? undefined : "No errors for this player in the window. Browser errors carry the account id only from the game release that added it (2026-11-15); older reports cannot be matched to a player.",
  };
}

module.exports = { describeCrumb, playerQuery, windowFor, playerErrors, SentryError, createClient, shapeIssue, shapeEvent, normaliseRef, matchEventPrefix, listIssues, getIssue, lookupEvent, newSince };
