// ─── DASHBOARD METRICS ───────────────────────────────────────────────
// Each source is failure-tolerant: it returns { ok:false, reason } instead of
// throwing, so one slow/broken integration never takes the dashboard down.
// All network calls are time-boxed.

const { engineHealth } = require("./engine-health");
const { recentEvents } = require("./platform-events");
const { getWorldIntelligence } = require("./world-intelligence");
const { fetchUnresolvedIssues } = require("./sentry-api");

async function pingHealth(url, ms = 3000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: "manual" });
    return { ok: r.status >= 200 && r.status < 400, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e && e.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}

const KUMA_URL = process.env.KUMA_URL || "http://127.0.0.1:3002";
const KUMA_SLUG = process.env.KUMA_SLUG || "ahd";

// Read live monitor status from the Uptime Kuma status-page JSON feed. Kuma is
// the single source of truth for service health (it monitors everything,
// keeps history, and alerts). Returns normalized monitors.
async function getKumaStatus() {
  const [pageR, hbR] = await Promise.all([
    fetch(`${KUMA_URL}/api/status-page/${KUMA_SLUG}`, { signal: AbortSignal.timeout(4000) }),
    fetch(`${KUMA_URL}/api/status-page/heartbeat/${KUMA_SLUG}`, { signal: AbortSignal.timeout(4000) }),
  ]);
  if (!pageR.ok || !hbR.ok) throw new Error("kuma feed " + pageR.status + "/" + hbR.status);
  const page = await pageR.json(), hb = await hbR.json();
  const u = hb.uptimeList || {}, hbl = hb.heartbeatList || {};
  const out = [];
  (page.publicGroupList || []).forEach((g) => (g.monitorList || []).forEach((m) => {
    const beats = hbl[m.id] || [];
    const last = beats.length ? beats[beats.length - 1] : null;
    const pct = (arr) => (arr.length ? Math.round((arr.filter((b) => b.status === 1).length / arr.length) * 10000) / 100 : null);
    out.push({
      id: m.id, name: m.name,
      ok: last ? last.status === 1 : null,
      ms: last && last.ping != null ? last.ping : null,
      reason: last && last.status !== 1 ? (last.msg || "down") : undefined,
      uptime24: u[`${m.id}_24`] != null ? Math.round(u[`${m.id}_24`] * 10000) / 100 : pct(beats),
      beats: beats.map((b) => ({ up: b.status === 1, ts: b.time, ms: b.ping })),
    });
  }));
  return out;
}

async function getUptime(db) {
  try {
    const k = await getKumaStatus();
    if (k.length) return k.map((s) => ({ name: s.name, ok: s.ok, ms: s.ms, reason: s.reason, uptime24: s.uptime24 }));
  } catch { /* Kuma unreachable → direct fallback below */ }
  const selfPort = process.env.PORT || 9724;
  const [game, ops, mongo] = await Promise.all([
    pingHealth("https://ahousedividedgame.com/api/health", 3500),
    pingHealth("http://127.0.0.1:" + selfPort + "/api/health", 1500),
    (async () => {
      const t0 = Date.now();
      try { await db.command({ ping: 1 }); return { ok: true, ms: Date.now() - t0 }; }
      catch { return { ok: false, reason: "unreachable" }; }
    })(),
  ]);
  return [
    { name: "Game (ahousedividedgame.com)", ...game },
    { name: "Ops dashboard", ...ops },
    { name: "MongoDB", ...mongo },
  ];
}

async function getUsers(db) {
  try {
    const users = db.collection("users");
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const [total, admins, banned, new7d, active7d] = await Promise.all([
      users.estimatedDocumentCount(),
      users.countDocuments({ isAdmin: true }),
      users.countDocuments({ isBanned: true }),
      users.countDocuments({ createdAt: { $gte: weekAgo } }),
      users.countDocuments({ lastLogin: { $gte: weekAgo } }),
    ]);
    return { ok: true, total, admins, banned, new7d, active7d };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Cheap game-world counts for the dashboard (estimated counts are O(1)).
async function getGame(db) {
  try {
    const count = (n) => db.collection(n).estimatedDocumentCount().catch(() => null);
    const [characters, corporations, states, elections] = await Promise.all([
      count("characters"),
      count("corporations"),
      count("states"),
      count("elections"),
    ]);
    return { ok: true, characters, corporations, states, elections };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function getRailway() {
  const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_PAT_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (!token || !projectId) return { ok: false, reason: "not configured" };
  const query =
    "query($p:String!){ project(id:$p){ services{edges{node{id name deployments(first:1){edges{node{status createdAt}}}}}} } }";
  try {
    const r = await fetch("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { p: projectId } }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    if (j.errors) return { ok: false, reason: j.errors[0]?.message || "api error" };
    const edges = j.data?.project?.services?.edges || [];
    const services = edges
      .map((e) => {
        const d = e.node.deployments?.edges?.[0]?.node;
        return { name: e.node.name, status: d?.status || "NONE", at: d?.createdAt || null };
      })
      // hide the DB service from the build list — it has no app deployments
      .filter((s) => !/(^|\s)DB($|\s)/i.test(s.name));
    return { ok: true, services };
  } catch (e) {
    return { ok: false, reason: e && e.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}

async function getSentry() {
  const r = await fetchUnresolvedIssues({ limit: 10, statsPeriod: "24h", timeoutMs: 5000 });
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, count: r.issues.length, issues: r.issues.slice(0, 5).map((i) => ({ title: i.title, level: i.level, seen: Number(i.count) || 0 })) };
}

// Site traffic from Cloudflare's GraphQL Analytics API (the domain is proxied,
// so CF already has unique visitors + page views — no GA / beacon needed).
async function getCloudflare() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return { ok: false, reason: "not configured" };
  const auth = { Authorization: "Bearer " + token };
  try {
    let zoneId = process.env.CLOUDFLARE_ZONE_ID;
    if (!zoneId) {
      const name = process.env.CLOUDFLARE_ZONE_NAME || "ahousedividedgame.com";
      const zr = await fetch("https://api.cloudflare.com/client/v4/zones?name=" + name, { headers: auth, signal: AbortSignal.timeout(8000) });
      const zj = await zr.json();
      zoneId = zj && zj.result && zj.result[0] && zj.result[0].id;
      if (!zoneId) return { ok: false, reason: zj && zj.errors && zj.errors[0] ? "auth: " + zj.errors[0].message : "no zone" };
    }
    const since = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const query =
      "query($z:String!,$s:String!){viewer{zones(filter:{zoneTag:$z}){httpRequests1dGroups(limit:7,filter:{date_geq:$s},orderBy:[date_ASC]){dimensions{date} sum{requests pageViews cachedRequests} uniq{uniques}}}}}";
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { z: zoneId, s: since } }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    if (j.errors) {
      const msg = (j.errors[0] && j.errors[0].message) || "api error";
      if (/permission/i.test(msg)) return { ok: false, reason: "token needs Zone·Analytics·Read" };
      return { ok: false, reason: msg.slice(0, 60) };
    }
    const groups = (j.data && j.data.viewer && j.data.viewer.zones && j.data.viewer.zones[0] && j.data.viewer.zones[0].httpRequests1dGroups) || [];
    if (!groups.length) return { ok: false, reason: "no data" };
    const series = groups.map((g) => ({ date: g.dimensions.date, uniques: g.uniq.uniques || 0, pageViews: g.sum.pageViews || 0, requests: g.sum.requests || 0, cached: g.sum.cachedRequests || 0 }));
    const last = series[series.length - 1];
    const requests7d = series.reduce((a, s) => a + s.requests, 0);
    const cached7d = series.reduce((a, s) => a + s.cached, 0);
    return {
      ok: true,
      uniquesToday: last.uniques,
      pageViewsToday: last.pageViews,
      uniques7d: series.reduce((a, s) => a + s.uniques, 0),
      pageViews7d: series.reduce((a, s) => a + s.pageViews, 0),
      requests7d,
      requestsToday: last.requests,
      cacheHit: requests7d ? Math.round((cached7d / requests7d) * 1000) / 10 : null,
      series,
    };
  } catch (e) {
    return { ok: false, reason: e && e.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}

// Human-friendly duration from milliseconds (e.g. "2d 4h", "3h 12m", "8m").
function fmtDuration(ms) {
  if (!ms || ms < 0 || !isFinite(ms)) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  const d = Math.floor(h / 24);
  return d + "d " + (h % 24) + "h";
}

// Community triage KPIs: outstanding suggestions/tickets, completed tickets, and
// mean ticket resolution time. Cheap counts + one small aggregation; fully
// defensive so a missing/empty collection never errors the dashboard.
async function getTickets(db) {
  try {
    const closedStatuses = ["resolved", "closed"];
    const doneStatuses = ["resolved", "closed", "wont_fix"];
    const since24h = new Date(Date.now() - 24 * 3600 * 1000);
    const [
      outstandingSuggestions, outstandingTickets, completedTickets, avgAgg,
      newTickets24h, newSuggestions24h,
    ] = await Promise.all([
      db.collection("suggestions").countDocuments({ status: "not_reviewed" }).catch(() => 0),
      db.collection("tickets").countDocuments({ status: { $nin: doneStatuses } }).catch(() => 0),
      db.collection("tickets").countDocuments({ status: { $in: closedStatuses } }).catch(() => 0),
      db
        .collection("tickets")
        .aggregate([
          { $match: { status: { $in: closedStatuses }, createdAt: { $ne: null } } },
          { $project: { dur: { $subtract: [{ $ifNull: ["$closedAt", "$updatedAt"] }, "$createdAt"] } } },
          { $match: { dur: { $gt: 0 } } },
          { $group: { _id: null, avg: { $avg: "$dur" }, n: { $sum: 1 } } },
        ])
        .toArray()
        .catch(() => []),
      // New-in-the-last-24h counts, for the daily executive digest — the
      // outstanding/completed counts above are snapshots, not deltas.
      db.collection("tickets").countDocuments({ createdAt: { $gte: since24h } }).catch(() => 0),
      db.collection("suggestions").countDocuments({ createdAt: { $gte: since24h } }).catch(() => 0),
    ]);
    const avgMs = avgAgg && avgAgg[0] ? avgAgg[0].avg : null;
    return {
      ok: true,
      outstandingSuggestions,
      outstandingTickets,
      completedTickets,
      avgDuration: avgMs != null ? fmtDuration(avgMs) : "—",
      newTickets24h,
      newSuggestions24h,
    };
  } catch (e) {
    return { ok: false, reason: e.message, outstandingSuggestions: 0, outstandingTickets: 0, completedTickets: 0, avgDuration: "—", newTickets24h: 0, newSuggestions24h: 0 };
  }
}

// LLM token usage over the last 7 days, grouped Kimi vs Ollama, from the
// `llm_usage` collection that llm.js writes to. Fully defensive: a missing or
// empty collection returns zeros rather than erroring the dashboard.
async function getLlmUsage(db) {
  const empty = () => ({ kimi: { calls: 0, totalTokens: 0 }, ollama: { calls: 0, totalTokens: 0 }, windowDays: 7 });
  try {
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const rows = await db
      .collection("llm_usage")
      .aggregate([
        { $match: { day: { $gte: since } } },
        { $group: { _id: "$provider", calls: { $sum: "$calls" }, totalTokens: { $sum: "$totalTokens" } } },
      ])
      .toArray();
    const out = empty();
    for (const r of rows) {
      if (r._id === "kimi" || r._id === "ollama") {
        out[r._id] = { calls: r.calls || 0, totalTokens: r.totalTokens || 0 };
      }
    }
    return out;
  } catch {
    return empty();
  }
}

async function getDashboardMetrics(db) {
  const [uptime, users, game, railway, sentry, traffic, tickets, llmUsage, engine, platformEvents] = await Promise.all([
    getUptime(db),
    getUsers(db),
    getGame(db),
    getRailway(),
    getSentry(),
    getCloudflare(),
    getTickets(db),
    getLlmUsage(db),
    engineHealth(db).catch((error) => ({ ok: false, reason: error.message })),
    recentEvents(12).catch(() => []),
  ]);
  const world = await getWorldIntelligence(db, engine);
  return { uptime, users, game, railway, sentry, traffic, tickets, llmUsage, engine, platformEvents, world, at: new Date().toISOString() };
}

module.exports = { getDashboardMetrics, getLlmUsage, getKumaStatus };
