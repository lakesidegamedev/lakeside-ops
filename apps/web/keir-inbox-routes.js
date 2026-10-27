"use strict";

// HTTP routes for Keir's DM inbox (/inbox, /api/keir/inbox/*). The data and
// the claim rules live in keir-inbox.service (lakeside-operator); this side is
// the admin view and a server-side proxy to its loopback admin API, so the
// inbox token never reaches a browser. One dispatch line in server.js:
//
//   if (await handleKeirInboxRoute(req, res, pathname, ctx)) return;
//
// Access: admins only. Signed-out visitors are sent to "/"; a signed-in
// non-admin gets a plain 404. Writes need X-Requested-With: ops-dashboard and
// a same-origin Origin, like the kanban. The bot's poke and the health check
// are routed to the inbox service by Caddy and never reach this handler.

const { makeKeirInboxBody } = require("./keir-inbox-page");

const API = process.env.KEIR_INBOX_ADMIN_URL || "http://127.0.0.1:9767";
const PREFIX = "/api/keir/inbox";

const GET_ROUTES = [/^\/stats$/, /^\/alerts$/, /^\/threads$/, /^\/threads\/\d{15,22}$/, /^\/claims$/, /^\/attachments\/[\w.-]+$/];
const POST_ROUTES = [/^\/threads\/\d{15,22}\/(read|reply|sync)$/, /^\/claims\/\d+\/(approve|reject|recheck)$/];

function isKeirInboxPath(pathname) {
  return pathname === "/inbox" || pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

function sameOrigin(req) {
  if (req.headers["x-requested-with"] !== "ops-dashboard") return false;
  const host = req.headers.host || "";
  const origin = req.headers.origin;
  if (origin === `https://${host}`) return true;
  return origin === `http://${host}` && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
}

async function readJson(req, limit = 16 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) { const e = new Error("Body too large"); e.status = 413; throw e; }
  }
  try { return JSON.parse(raw || "{}"); } catch { const e = new Error("Invalid JSON"); e.status = 400; throw e; }
}

async function handleKeirInboxRoute(req, res, pathname, { resolveSession, addSecurityHeaders, renderShell, fetchImpl = fetch, token = process.env.KEIR_INBOX_ADMIN_TOKEN }) {
  if (!isKeirInboxPath(pathname)) return false;

  const send = (status, data) => {
    addSecurityHeaders(res);
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
    return true;
  };
  const notFound = () => {
    addSecurityHeaders(res);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("Not found");
    return true;
  };

  const session = await resolveSession(req);
  const isPage = pathname === "/inbox";
  if (!session) {
    if (!isPage) return send(401, { error: "Sign in required" });
    addSecurityHeaders(res);
    res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
    res.end();
    return true;
  }
  if (session.role !== "admin") return isPage ? notFound() : send(404, { error: "Not found" });

  if ((req.method === "GET" || req.method === "HEAD") && isPage) {
    const { extraCss, body } = makeKeirInboxBody({ configured: Boolean(token) });
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? "" : renderShell({ title: "Keir inbox", active: "/inbox", role: session.role, extraCss, body, product: "keir" }));
    return true;
  }

  const sub = pathname.slice(PREFIX.length);
  const url = new URL(req.url, "http://localhost");
  if (!token) return send(503, { error: "Inbox is not configured on this dashboard" });

  try {
    let init;
    if (req.method === "GET" && GET_ROUTES.some((re) => re.test(sub))) {
      init = { method: "GET" };
    } else if (req.method === "POST" && POST_ROUTES.some((re) => re.test(sub))) {
      if (!sameOrigin(req)) return send(403, { error: "Invalid request origin" });
      const body = await readJson(req);
      // The acting admin comes from the session, never the browser.
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, by: String(session.email || "admin").slice(0, 120) }) };
    } else {
      return send(404, { error: "Not found" });
    }
    const upstream = await fetchImpl(`${API}${sub}${url.search}`, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(sub.endsWith("/approve") || sub.endsWith("/recheck") ? 180000 : 30000),
    });
    if (sub.startsWith("/attachments/") && upstream.ok) {
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": upstream.headers.get("content-type") || "application/octet-stream", "Cache-Control": "private, no-store" });
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return true;
    }
    return send(upstream.status, await upstream.json().catch(() => ({ error: `Inbox answered ${upstream.status}` })));
  } catch (error) {
    if (error.status) return send(error.status, { error: error.message });
    console.error("[keir-inbox]", error.message);
    return send(502, { error: "Inbox service unavailable" });
  }
}

module.exports = { handleKeirInboxRoute, isKeirInboxPath };
