"use strict";

// Keir hub routes (/keir, /api/keir/hub). Admin only, read-only. One dispatch
// line in server.js:
//
//   if (await handleKeirHubRoute(req, res, pathname, ctx)) return;
//
// Signed-out visitors go to "/"; a signed-in non-admin gets a plain 404,
// matching the Keir inbox.

const { makeKeirHubBody } = require("./keir-hub-page");
const data = require("./keir-hub-data");
const { buildHubState } = data;

function isKeirHubPath(pathname) { return pathname === "/keir" || pathname === "/api/keir/hub" || pathname.startsWith("/api/keir/hub/"); }

function sameOrigin(req) {
  if (req.headers["x-requested-with"] !== "ops-dashboard") return false;
  const host = req.headers.host || "";
  const origin = req.headers.origin;
  if (origin === `https://${host}`) return true;
  return origin === `http://${host}` && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
}
async function readBody(req, limit = 8 * 1024) {
  let raw = ""; for await (const c of req) { raw += c; if (raw.length > limit) throw Object.assign(new Error("Body too large"), { status: 413 }); }
  try { return JSON.parse(raw || "{}"); } catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

async function handleKeirHubRoute(req, res, pathname, { resolveSession, addSecurityHeaders, renderShell, build = buildHubState, actions = data }) {
  if (!isKeirHubPath(pathname)) return false;
  const isWrite = req.method === "POST" && (pathname === "/api/keir/hub/merge" || pathname === "/api/keir/hub/probe");
  if (req.method !== "GET" && req.method !== "HEAD" && !isWrite) { res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return true; }
  const session = await resolveSession(req);
  if (!session) {
    if (pathname.startsWith("/api/")) { addSecurityHeaders(res); res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end('{"error":"sign in"}'); return true; }
    res.writeHead(302, { Location: "/" }); res.end(); return true;
  }
  if (session.role !== "admin") { addSecurityHeaders(res); res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); res.end("Not found"); return true; }
  addSecurityHeaders(res);
  const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); return true; };
  if (["/api/keir/hub/performance", "/api/keir/hub/efficiency"].includes(pathname)) {
    const days = Number(new URL(req.url, "http://localhost").searchParams.get("days") || 30);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) return json(400, { error: "Invalid days" });
    try { return json(200, await (pathname.endsWith("/efficiency") ? actions.releaseEfficiency : actions.ticketPerformance)({ days })); }
    catch { return json(503, { error: "Ticket performance unavailable. The operator must support performance tracking." }); }
  }
  if (isWrite) {
    if (!sameOrigin(req)) return json(403, { error: "cross-origin write refused" });
    let body; try { body = await readBody(req); } catch (e) { return json(e.status || 400, { error: e.message }); }
    try {
      if (pathname === "/api/keir/hub/merge") {
        const source = Number(body.source), target = Number(body.target);
        if (!Number.isInteger(source) || !Number.isInteger(target) || source <= 0 || target <= 0) return json(400, { error: "source and target ticket numbers are required" });
        const reason = String(body.reason || "").trim();
        if (reason.length < 4) return json(400, { error: "say why it is the same problem" });
        return json(200, await actions.mergeTicket({ source, target, reason, by: `ops:${session.user || session.email || session.name || "admin"}` }));
      }
      return json(202, await actions.probeKeir());
    } catch (e) { return json(502, { error: String(e.message || e).slice(0, 300) }); }
  }
  const attempt = /^\/api\/keir\/hub\/attempt\/([\w-]{6,80})$/.exec(pathname);
  if (attempt) { const a = actions.readAttempt(data.PATHS.harness, attempt[1]); return a ? json(200, a) : json(404, { error: "no such attempt" }); }
  const probe = /^\/api\/keir\/hub\/probe\/([a-f0-9]{6,32})$/.exec(pathname);
  if (probe) return json(200, actions.probeState(data.PATHS.ledger, probe[1]));
  if (pathname === "/api/keir/hub") {
    let state;
    try { state = await build(); } catch (e) { res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: String(e.message || e).slice(0, 300) })); return true; }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? "" : JSON.stringify(state));
    return true;
  }
  const { extraCss, body } = makeKeirHubBody();
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  res.end(req.method === "HEAD" ? "" : renderShell({ title: "Keir hub", active: "/keir", role: session.role, extraCss, body }));
  return true;
}

module.exports = { handleKeirHubRoute, isKeirHubPath };
