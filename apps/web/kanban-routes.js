"use strict";

// HTTP routes for the admin product kanban. Kept out of server.js so the
// dashboard only needs one dispatch line:
//
//   if (await handleKanbanRoute(req, res, pathname, ctx)) return;
//
// Access: admins only. Signed-out visitors are sent to "/" (the sign-in page);
// a signed-in non-admin gets a plain 404, so the page does not advertise
// itself. Writes additionally require X-Requested-With: ops-dashboard and a
// same-origin Origin header (the same check as event replay).

const { sharedKanban } = require("./kanban-store");
const { makeKanbanBody } = require("./kanban-page");

const ITEM_RE = /^\/api\/kanban\/items\/(\d+)$/;
const REPORT_RE = /^\/api\/kanban\/items\/(\d+)\/report$/;

function isKanbanPath(pathname) {
  return pathname === "/kanban" || pathname === "/api/kanban" || pathname.startsWith("/api/kanban/");
}

function sameOrigin(req) {
  if (req.headers["x-requested-with"] !== "ops-dashboard") return false;
  const host = req.headers.host || "";
  const origin = req.headers.origin;
  if (origin === `https://${host}`) return true;
  // Plain http only for loopback hosts (local development and smoke tests).
  return origin === `http://${host}` && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
}

async function readJson(req, limit = 64 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) { const e = new Error("Body too large"); e.status = 413; throw e; }
  }
  try { return JSON.parse(raw || "{}"); } catch { const e = new Error("Invalid JSON"); e.status = 400; throw e; }
}

async function handleKanbanRoute(req, res, pathname, { resolveSession, addSecurityHeaders, renderShell, store = sharedKanban }) {
  if (!isKanbanPath(pathname)) return false;

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
  const isPage = pathname === "/kanban";
  if (!session) {
    if (!isPage) return send(401, { error: "Sign in required" });
    addSecurityHeaders(res);
    res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
    res.end();
    return true;
  }
  if (session.role !== "admin") return isPage ? notFound() : send(404, { error: "Not found" });

  const actor = String(session.email || "admin").slice(0, 120);
  const fail = (error) => {
    if (error.code === "BAD_INPUT") return send(400, { error: error.message });
    if (error.code === "NOT_FOUND") return send(404, { error: error.message });
    if (error.status) return send(error.status, { error: error.message });
    console.error("[kanban]", error);
    return send(500, { error: error.message });
  };

  try {
    if ((req.method === "GET" || req.method === "HEAD") && isPage) {
      let board = null;
      let error = null;
      try { board = store().board(); } catch (e) { error = e.message; }
      const { extraCss, body } = makeKanbanBody({ board, error });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Work board", active: "/kanban", role: session.role, extraCss, body }));
      return true;
    }
    if (req.method === "GET" && pathname === "/api/kanban") return send(200, store().board());
    if (req.method === "GET" && pathname === "/api/kanban/brief") return send(200, store().brief({}));
    const itemMatch = pathname.match(ITEM_RE);
    if (req.method === "GET" && itemMatch) return send(200, store().get(Number(itemMatch[1]), { events: 60 }));

    if (req.method === "POST") {
      if (!sameOrigin(req)) return send(403, { error: "Invalid request origin" });
      const body = await readJson(req);
      if (pathname === "/api/kanban/items") return send(201, store().add(body, { actor }));
      if (itemMatch) return send(200, store().update(Number(itemMatch[1]), body, { actor }));
      const reportMatch = pathname.match(REPORT_RE);
      if (reportMatch) return send(200, store().report({ ...body, id: Number(reportMatch[1]), actor }));
    }
    return send(404, { error: "Not found" });
  } catch (error) {
    return fail(error);
  }
}

module.exports = { handleKanbanRoute, isKanbanPath };
