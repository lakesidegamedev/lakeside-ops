"use strict";

// cw-telemetry-routes.js: public ingest for Corporate Warfare market-balance snapshots.
//
// POST /api/cw/telemetry with {install_id, app_version, build, snapshot}. The game is public
// open source, so there is no secret to check: the route is write-only, accepts a small body,
// validates every field against the snapshot schema, rate-limits each client address and
// ignores a repeat of the same install, seed and week. Nothing is ever read back through it.

const ROUTE = "/api/cw/telemetry";
const MAX_BODY = 128 * 1024;
const RATE_WINDOW_MS = 3_600_000;
const RATE_LIMIT = 120;

const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const BIG = 1e15;

/** Validate an envelope; returns an error string or null. */
function validate(envelope) {
  if (!envelope || typeof envelope !== "object") return "body must be an object";
  if (!/^[0-9a-f-]{36}$/.test(String(envelope.install_id || ""))) return "install_id must be a uuid";
  for (const key of ["app_version", "build"]) {
    if (typeof envelope[key] !== "string" || envelope[key].length > 24) return `${key} must be a short string`;
  }
  const s = envelope.snapshot;
  if (!s || typeof s !== "object") return "snapshot required";
  // Newer games add fields; every version keeps the schema 1 core checked below.
  if (!isInt(s.schema, 1, 99)) return "unsupported snapshot schema";
  if (typeof s.engine_version !== "string" || s.engine_version.length > 24) return "engine_version invalid";
  if (!/^[0-9a-f]{64}$/.test(String(s.dataset_hash || ""))) return "dataset_hash invalid";
  if (!/^[a-z_]{1,16}$/.test(String(s.scenario || ""))) return "scenario invalid";
  if (!isInt(s.seed, 0, Number.MAX_SAFE_INTEGER)) return "seed invalid";
  if (!isInt(s.week, 1, 100_000) || s.week % 5 !== 0) return "week invalid";
  if (!Array.isArray(s.goods) || s.goods.length > 64) return "goods invalid";
  for (const g of s.goods) {
    if (!g || !/^[a-z_]{1,32}$/.test(String(g.id || ""))) return "good id invalid";
    for (const key of ["made_lots", "sold_lots", "imported_lots", "exported_lots", "stock_lots", "median_ask_cents", "reference_cents", "household_spend_cents"]) {
      if (!isInt(g[key], -BIG, BIG)) return `good ${key} invalid`;
    }
    // Added by newer games: the asking price weighted by what each seller actually sold.
    if (g.sold_ask_cents != null && !isInt(g.sold_ask_cents, -BIG, BIG)) return "good sold_ask_cents invalid";
  }
  const c = s.corridor;
  if (!c || !["firms_operating", "firms_dissolved", "raids"].every((k) => isInt(c[k], 0, 1e6)) || !isInt(c.outside_cash_cents, -BIG, BIG)) {
    return "corridor invalid";
  }
  if (s.player != null) {
    const p = s.player;
    if (!["cash_cents", "revenue_13w_cents", "net_income_13w_cents"].every((k) => isInt(p[k], -BIG, BIG))) return "player invalid";
    if (!isInt(p.divisions, 0, 1e5) || !isInt(p.plants, 0, 1e6)) return "player invalid";
  }
  return null;
}

function makeLimiter({ limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS, now = () => Date.now() } = {}) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const entry = hits.get(key);
    if (!entry || t - entry.start > windowMs) {
      hits.set(key, { start: t, count: 1 });
      if (hits.size > 50_000) hits.clear();
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function isCwTelemetryPath(pathname) {
  return pathname === ROUTE;
}

/** Handle the ingest route. Returns true when it handled the request. */
async function handleCwTelemetryRoute(req, res, pathname, { addSecurityHeaders, store, allow, clientIp }) {
  if (pathname !== ROUTE) return false;
  if (addSecurityHeaders) addSecurityHeaders(res);
  if (req.method !== "POST") {
    send(res, 405, { error: "POST only" });
    return true;
  }
  if (!allow(clientIp(req))) {
    send(res, 429, { error: "slow down" });
    return true;
  }
  let body = "";
  let tooLarge = false;
  await new Promise((resolve) => {
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_BODY) tooLarge = true;
    });
    req.on("end", resolve);
    req.on("error", resolve);
  });
  if (tooLarge) {
    send(res, 413, { error: "too large" });
    return true;
  }
  let envelope;
  try {
    envelope = JSON.parse(body || "null");
  } catch {
    send(res, 400, { error: "invalid json" });
    return true;
  }
  const problem = validate(envelope);
  if (problem) {
    send(res, 400, { error: problem });
    return true;
  }
  try {
    const fresh = store().add(envelope);
    send(res, 202, { ok: true, stored: fresh });
  } catch (error) {
    console.error("[cw-telemetry]", error.message);
    send(res, 500, { error: "store unavailable" });
  }
  return true;
}

module.exports = { handleCwTelemetryRoute, isCwTelemetryPath, validate, makeLimiter, ROUTE, MAX_BODY };
