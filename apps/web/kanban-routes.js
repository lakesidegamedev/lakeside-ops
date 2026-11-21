"use strict";

// HTTP routes for the admin product kanban. Kept out of server.js so the
// dashboard only needs one dispatch line:
//
//   if (await handleKanbanRoute(req, res, pathname, ctx)) return;
//
// Admins manage the board; Junior Developers claim and report their own work.
// Signed-out visitors are sent to "/" (the sign-in page);
// a signed-in non-admin gets a plain 404, so the page does not advertise
// itself. Writes additionally require X-Requested-With: ops-dashboard and a
// same-origin Origin header (the same check as event replay).

const { sharedKanban } = require("./kanban-store");
const { makeKanbanBody } = require("./kanban-page");
const { decorateItem, decorateList, decorateBrief, runReconcile, lastTimerRun, reconcileTimerSettings } = require("./kanban-tickets");

const ITEM_RE = /^\/api\/kanban\/items\/(\d+)$/;
const REPORT_RE = /^\/api\/kanban\/items\/(\d+)\/report$/;
const COLLABORATE_RE = /^\/api\/kanban\/items\/(\d+)\/collaborate$/;
// The reconcile pass (tickets, pull requests, alerts); the first pass's path still works.
const RECONCILE_PATHS = new Set(["/api/kanban/reconcile", "/api/kanban/ticket-reconcile"]);
const COUNTERS_PATH = "/api/kanban/counters";
const PROMOTE_PATH = "/api/kanban/counters/promote";

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

// ticketStatus: a kanban-tickets reader; linked cards show the live ticket
// status from it, or "ticket status unknown" without it.
async function handleKanbanRoute(req, res, pathname, { resolveSession, addSecurityHeaders, renderShell, store = sharedKanban, ticketStatus = null, prReader = null, alertReader = null }) {
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
  if (!["admin", "junior_dev"].includes(session.role)) return isPage ? notFound() : send(404, { error: "Not found" });

  const readOnly = session.role === "junior_dev";
  const collaborationMatch = pathname.match(COLLABORATE_RE);
  if (readOnly && !["GET", "HEAD"].includes(req.method) && !(req.method === "POST" && collaborationMatch))
    return send(403, { error: "Junior Developers can claim tasks and report their own work" });
  if (readOnly && !session.email) return send(403, { error: "A signed-in identity is required" });

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
      try { board = await decorateList(store().board(), ticketStatus); } catch (e) { error = e.message; }
      const { extraCss, body } = makeKanbanBody({ board, error, readOnly, collaborator: readOnly ? actor : "" });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Work board", active: "/kanban", role: session.role, extraCss, body }));
      return true;
    }
    if (req.method === "GET" && pathname === "/api/kanban") return send(200, await decorateList(store().board(), ticketStatus));
    if (req.method === "GET" && pathname === "/api/kanban/brief") return send(200, await decorateBrief(store().brief({}), ticketStatus));
    const itemMatch = pathname.match(ITEM_RE);
    if (req.method === "GET" && itemMatch) return send(200, await decorateItem(store().get(Number(itemMatch[1]), { events: 60 }), ticketStatus));
    // Reconcile: GET is the dry run (changes nothing), POST applies. Admin only.
    if (RECONCILE_PATHS.has(pathname)) {
      if (session.role !== "admin") return send(404, { error: "Not found" });
      const readers = { reader: ticketStatus, prReader, alertReader };
      if (req.method === "GET") {
        const out = await runReconcile({ store: store(), ...readers, dryRun: true });
        return send(200, { ...out, last_timer_run: lastTimerRun(store()), automatic_apply: reconcileTimerSettings().autoApply });
      }
      if (req.method === "POST") {
        if (!sameOrigin(req)) return send(403, { error: "Invalid request origin" });
        const body = await readJson(req);
        const out = await runReconcile({ store: store(), ...readers, dryRun: body.dry_run !== false, limit: body.limit });
        if (!out.dry_run) store().recordReconcileRun(out, { trigger: "route" });
        return send(200, out);
      }
    }
    // Automatic counts, and promoting one to a card. Admin only.
    if (pathname === COUNTERS_PATH || pathname === PROMOTE_PATH) {
      if (session.role !== "admin") return send(404, { error: "Not found" });
      if (req.method === "GET" && pathname === COUNTERS_PATH) return send(200, store().counters.list({ limit: 300 }));
      if (req.method === "POST" && pathname === PROMOTE_PATH) {
        if (!sameOrigin(req)) return send(403, { error: "Invalid request origin" });
        const body = await readJson(req);
        return send(200, store().counters.promote({ signature: body.signature, title: body.title, detail: body.detail, impact: body.impact, lane: body.lane, actor }));
      }
    }

    if (req.method === "POST") {
      if (!sameOrigin(req)) return send(403, { error: "Invalid request origin" });
      const body = await readJson(req);
      if (collaborationMatch) {
        if (!body || typeof body !== "object" || Array.isArray(body)) return send(400, { error: "Expected an object" });
        const allowed = new Set(["action", "summary", "evidence_url"]);
        if (Object.keys(body).some(key => !allowed.has(key))) return send(400, { error: "Unsupported collaboration field" });
        return send(200, store().collaborate({ id: Number(collaborationMatch[1]), action: body.action,
          summary: body.summary, evidence_url: body.evidence_url, actor }));
      }
      if (pathname === "/api/kanban/items") return send(201, await decorateItem(store().add(body, { actor }), ticketStatus));
      if (itemMatch) return send(200, await decorateItem(store().update(Number(itemMatch[1]), body, { actor }), ticketStatus));
      const reportMatch = pathname.match(REPORT_RE);
      if (reportMatch) return send(200, store().report({ ...body, id: Number(reportMatch[1]), actor }));
    }
    return send(404, { error: "Not found" });
  } catch (error) {
    return fail(error);
  }
}

module.exports = { handleKanbanRoute, isKanbanPath };
