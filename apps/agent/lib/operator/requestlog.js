"use strict";
// Keir 10 (W3): the reporter's recent API requests, from the game's own access log.
//
// What exists: the game writes `apiAccessLog` rows (path, method, account id,
// status when known, time) for requests that pass its API authentication and for
// the public API, kept for a bounded time. What does not exist: durations, and
// requests that never reach an authenticated API route. The Caddy edge on the
// production web host has no access log at all. So this answers "did this
// player's calls fail" (status >= 400, 429 rate limits) and "what did they call
// and how often", not "what was slow".
// The read is a purpose-built projection (method, path, status, time): ip,
// userAgent and key fields are never requested.

const HEX24 = /^[0-9a-f]{24}$/;
const PROJECTION = { method: 1, path: 1, status: 1, timestamp: 1 };

function createRequestLog({ mcp, resolveIdentity, now = () => Date.now() }) {
  async function call(job, input, signal) {
    if (job.role === "player") throw new Error("players cannot read request logs through Keir");
    if (!job.ticket) throw new Error("request_log needs an assigned ticket: it reads the reporter only");
    const who = await resolveIdentity(job, signal);
    if (!who?.matched || !HEX24.test(who.private?.userId || "")) return { matched: false, note: "The reporter's account could not be tied to this ticket (see resolve_reporter), so no requests can be read." };
    const hours = Math.min(Math.max(Number(input.hours) || 24, 1), 24);
    const since = new Date(now() - hours * 3600000).toISOString();
    const res = await mcp.call("heal-ops", "heal_query", { env: "prod", collection: "apiAccessLog", filter: { $expr: { $and: [{ $eq: [{ $toString: "$userId" }, who.private.userId] }, { $gte: [{ $toString: "$timestamp" }, since] }] } }, projection: PROJECTION, sort: { timestamp: -1 }, limit: 50 }, false, signal);
    const docs = res?.docs || [];
    const failed = docs.filter((r) => Number(r.status) >= 400);
    const groups = new Map();
    for (const r of docs) {
      const path = String(r.path || "").replace(/\/[0-9a-f]{24}(?=\/|$)/g, "/:id").replace(/\/\d{3,}(?=\/|$)/g, "/:n").slice(0, 120);
      const key = `${r.method} ${path} ${r.status ?? "?"}`;
      const g = groups.get(key) || { method: r.method, path, status: r.status ?? null, count: 0, last: null };
      g.count++; g.last = g.last || r.timestamp; groups.set(key, g);
    }
    return { matched: true, hours, returned: docs.length, truncated: Boolean(res?.truncated) || docs.length >= 50,
      failed: failed.slice(0, 15).map((r) => ({ at: r.timestamp, method: r.method, path: String(r.path || "").slice(0, 120), status: r.status })),
      calls: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 20),
      note: "Only requests through the game's authenticated and public API routes are logged, with a status when known and no duration. Page loads and slow requests are not visible here. An empty result does not prove the player made no requests.",
      instruction: docs.length ? "Use failed first. A burst of 429 means rate limiting; 401 or 403 means the session or permission failed." : "No logged API requests in the window." };
  }
  return { call };
}

module.exports = { createRequestLog };
