"use strict";

// Read-only Sentry.io access for the dashboard, its metrics and the issue
// poller. GlitchTip is retired; the token is SENTRY_AUTH_TOKEN (the unit loads
// /etc/lakeside-platform/sentry-read.env). Never log the token.

const SENTRY_ORG = () => process.env.SENTRY_ORG_SLUG || "lakeside-games";
const SENTRY_WEB = () => `https://sentry.io/organizations/${SENTRY_ORG()}`;

function sentryConfigured() { return Boolean(process.env.SENTRY_AUTH_TOKEN); }

// Unresolved issues, newest activity first. Returns { ok, issues } or { ok:false, reason }.
async function fetchUnresolvedIssues({ limit = 25, query = "is:unresolved", statsPeriod = "24h", timeoutMs = 8000 } = {}) {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) return { ok: false, reason: "not configured" };
  try {
    const url = new URL(`https://sentry.io/api/0/organizations/${SENTRY_ORG()}/issues/`);
    url.searchParams.set("query", query);
    url.searchParams.set("statsPeriod", statsPeriod);
    url.searchParams.set("sort", "date");
    url.searchParams.set("limit", String(limit));
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 401) return { ok: false, reason: "token rejected (401)" };
    if (r.status === 429) return { ok: false, reason: "rate limited (429)" };
    if (!r.ok) return { ok: false, reason: "http " + r.status };
    const issues = await r.json();
    return { ok: true, issues: Array.isArray(issues) ? issues : [] };
  } catch (e) {
    return { ok: false, reason: e && e.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}

module.exports = { SENTRY_ORG, SENTRY_WEB, sentryConfigured, fetchUnresolvedIssues };
