"use strict";

// ─── /security ROUTE ──────────────────────────────────────────────────────
// Page + JSON API for the host security posture.
//
// Path note: Caddy already reserves /security/* for the Semgrep security MCP
// (strip_prefix -> localhost:9733), so this page must be exactly /security and
// its data exactly /api/security. Anything beneath /security/ never reaches the
// dashboard. See /etc/caddy/Caddyfile.

const { makeSecurityBody } = require("./security-page");
const service = require("./security-service");

function isSecurityPath(pathname) {
  return pathname === "/security" || pathname === "/api/security" || pathname === "/api/security/reprobe";
}

// Same-origin check for state-changing requests, matching kanban-routes.js.
function sameOrigin(req) {
  if (req.headers["x-requested-with"] !== "ops-dashboard") return false;
  const host = req.headers.host || "";
  const origin = req.headers.origin;
  if (origin === `https://${host}`) return true;
  return origin === `http://${host}` && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
}

function sendJson(res, addSecurityHeaders, status, data) {
  addSecurityHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
  return true;
}

function notFound(res, addSecurityHeaders) {
  addSecurityHeaders(res);
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end("Not found");
  return true;
}

async function handleSecurityRoute(req, res, pathname, ctx) {
  if (!isSecurityPath(pathname)) return false;
  const {
    resolveSession,
    addSecurityHeaders,
    renderShell,
    snapshot = service.snapshot,
    reprobe = service.reprobe,
  } = ctx;

  const session = await resolveSession(req);
  const isPage = pathname === "/security";

  if (!session) {
    if (!isPage) return sendJson(res, addSecurityHeaders, 401, { error: "Sign in required" });
    addSecurityHeaders(res);
    res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
    res.end();
    return true;
  }
  // Host hardening detail is admin-only. Moderators get a 404, not a hint.
  if (session.role !== "admin") {
    return isPage ? notFound(res, addSecurityHeaders) : sendJson(res, addSecurityHeaders, 404, { error: "Not found" });
  }

  if ((req.method === "GET" || req.method === "HEAD") && isPage) {
    const { extraCss, body } = makeSecurityBody();
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(
      req.method === "HEAD"
        ? ""
        : renderShell({ title: "Security", active: "/security", role: session.role, extraCss, body }),
    );
    return true;
  }

  if (req.method === "GET" && pathname === "/api/security") {
    try {
      return sendJson(res, addSecurityHeaders, 200, await snapshot());
    } catch (error) {
      return sendJson(res, addSecurityHeaders, 500, { error: String(error.message || error) });
    }
  }

  if (req.method === "POST" && pathname === "/api/security/reprobe") {
    if (!sameOrigin(req)) return sendJson(res, addSecurityHeaders, 403, { error: "Invalid request origin" });
    try {
      return sendJson(res, addSecurityHeaders, 200, await reprobe());
    } catch (error) {
      return sendJson(res, addSecurityHeaders, 500, { error: String(error.message || error) });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
    return sendJson(res, addSecurityHeaders, 405, { error: "Method not allowed" });
  }

  return sendJson(res, addSecurityHeaders, 404, { error: "Not found" });
}

module.exports = { handleSecurityRoute, isSecurityPath, sameOrigin };
