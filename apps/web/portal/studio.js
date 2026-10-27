"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

// Keir-only surface on the existing studio server. The full operator still
// authenticates the original owner's cookie and owns every effect policy.
async function handleStudioPortal(req, res, pathname, { resolveSession, authMode, loginOrigins = [], upstream = "http://127.0.0.1:9768" }) {
  const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  if (req.method === "GET" && pathname === "/api/portal/config") { json(200, { mode: "lakeside", auth: authMode, loginOrigins }); return true; }
  const assets = { "/keir/app": ["index.html", "text/html; charset=utf-8"], "/portal.js": ["portal.js", "text/javascript"], "/portal.css": ["portal.css", "text/css"], "/keir/keir-mark.svg": ["keir-mark.svg", "image/svg+xml"], "/keir/keir-apple-touch-icon.png": ["keir-apple-touch-icon.png", "image/png"] };
  if (req.method === "GET" && assets[pathname]) {
    res.writeHead(200, { "Content-Type": assets[pathname][1], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
    res.end(fs.readFileSync(path.join(__dirname, "public", assets[pathname][0]))); return true;
  }
  if (!pathname.startsWith("/api/keir/app/")) return false;
  const session = await resolveSession(req);
  if (!session || session.role !== "admin") { json(session ? 403 : 401, { error: "Owner sign-in required" }); return true; }
  if (req.method !== "GET") {
    if (!(pathname === "/api/keir/app/uploads" && req.method === "POST") && req.method !== "DELETE" && !req.headers["content-type"]?.startsWith("application/json")) { json(415, { error: "JSON required" }); return true; }
    if (req.headers.origin && req.headers.origin !== `https://${req.headers.host}`) { json(403, { error: "Unexpected origin" }); return true; }
  }
  const target = new URL(upstream);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username || target.password) throw new Error("Keir upstream must be local HTTP");
  const proxy = http.request(new URL(pathname + new URL(req.url, "http://request.local").search, target), { method: req.method, headers: { cookie: req.headers.cookie || "", "Content-Type": req.headers["content-type"] || "application/json", Accept: req.headers.accept || "application/json", ...(req.headers["x-filename"] ? { "X-Filename": req.headers["x-filename"] } : {}), ...(req.headers["x-keir-thread"] ? { "X-Keir-Thread": req.headers["x-keir-thread"] } : {}) }, timeout: 32000 }, response => {
    res.writeHead(response.statusCode, { "Content-Type": response.headers["content-type"] || "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(response.headers["content-disposition"] ? { "Content-Disposition": response.headers["content-disposition"] } : {}) }); response.pipe(res);
  });
  proxy.on("timeout", () => proxy.destroy());
  proxy.on("error", () => { if (!res.headersSent) json(503, { error: "Keir is temporarily unavailable" }); else res.destroy(); });
  res.on("close", () => proxy.destroy()); req.pipe(proxy);
  return true;
}
module.exports = { handleStudioPortal };
