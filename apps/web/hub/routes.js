"use strict";

// hub/routes.js: HTTP routes for the Ops hub. One dispatch line in server.js:
//
//   if (await handleHubRoute(req, res, url, ctx)) return;
//
// Ops is three views: the work board (/kanban, served by kanban-routes.js),
// the library (/library, /library/doc/<name>, /reports/<slug>) and the ticket
// hub (/tickets). The older dashboard pages are retired: an admin who opens
// one is sent to the library. Public pages (status, player suggestion pages,
// ticket receipt links, shared report links) are untouched.

const fs = require("fs");
const path = require("path");
const { renderHubPage } = require("./shell");
const library = require("./library");
const tickets = require("./tickets");
const { renderMarkdown } = require("./markdown");

// Admin-only dashboard pages folded into the three views.
const RETIRED = new Set([
  "/engine", "/observatory", "/events", "/games", "/navair", "/ideas", "/community-voice",
  "/finder", "/pr-reviews", "/db", "/backups", "/wiki-export", "/skills", "/memories", "/learn",
  "/keir", "/inbox", "/scheduler", "/worktrees", "/apps", "/agents", "/tracker", "/reset-board",
  "/worldsim", "/replay", "/costs", "/code", "/observability", "/knowledge", "/knowledge/graph",
]);
const SLUG_RE = /^\/reports\/([a-z0-9][a-z0-9-]{1,79})$/;
const DOC_RE = /^\/library\/doc\/([^/]{1,120})$/;

function isHubPath(p) {
  return p === "/" || p === "/library" || p.startsWith("/library/") || p === "/reports" || SLUG_RE.test(p)
    || p === "/tickets" || p.startsWith("/api/hub/") || RETIRED.has(p);
}

let countsCache = { at: 0, v: null };
let ticketCache = { at: 0, v: null };

async function handleHubRoute(req, res, url, ctx) {
  try {
    return await route(req, res, url, ctx);
  } catch (e) {
    console.error("[hub]", url.pathname, e && e.message);
    if (res.headersSent) { try { res.end(); } catch { /* closed */ } return true; }
    ctx.addSecurityHeaders(res);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("Something went wrong loading this page. Try again in a moment.");
    return true;
  }
}

async function route(req, res, url, ctx) {
  const pathname = url.pathname;
  if (!(req.method === "GET" || req.method === "HEAD")) return false;
  if (!isHubPath(pathname)) return false;
  const { resolveSession, addSecurityHeaders, getDb, knowledgeStore, publishedDir, legacyDir, kanban, getConfig } = ctx;
  const dirs = { publishedDir, legacyDir };
  const session = await resolveSession(req);
  const isAdmin = !!(session && session.role === "admin");

  const send = (status, type, bodyText, extra = {}) => {
    addSecurityHeaders(res);
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? "" : bodyText);
    return true;
  };
  const html = (page) => send(200, "text/html; charset=utf-8", page);
  const json = (status, data) => send(status, "application/json", JSON.stringify(data));
  const redirect = (to) => { addSecurityHeaders(res); res.writeHead(302, { Location: to, "Cache-Control": "no-store" }); res.end(); return true; };

  // ── Framed report body (the viewer's iframe). Admins, or anyone for a
  // report shared by link. Everything else falls through to the 403 page.
  const slugMatch = SLUG_RE.exec(pathname);
  if (slugMatch && url.searchParams.get("embed") === "1") {
    const slug = slugMatch[1];
    const item = library.findReport(slug, dirs);
    const file = item && item.legacy ? path.join(legacyDir, `${slug}.html`) : path.join(publishedDir, `${slug}.html`);
    if (!file.startsWith(publishedDir + path.sep) && !file.startsWith(legacyDir + path.sep)) return false;
    if (!isAdmin && !(item && item.public)) return false;
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch { return false; }
    // Same-origin framing only, for the hub's own viewer.
    addSecurityHeaders(res);
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    const csp = res.getHeader("Content-Security-Policy");
    if (csp) res.setHeader("Content-Security-Policy", `${csp} frame-ancestors 'self';`);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? "" : library.embedHtml(raw));
    return true;
  }

  // Public pages keep their current behavior for everyone who is not an admin.
  if (!isAdmin) {
    if (pathname.startsWith("/api/hub/")) return json(session ? 403 : 401, { error: session ? "Admin only" : "Sign in required" });
    if (pathname === "/library" || pathname.startsWith("/library/") || pathname === "/reports") {
      if (!session) return redirect(`/auth/game?next=${encodeURIComponent(`https://${req.headers.host}${pathname}`)}`);
      return send(403, "text/plain; charset=utf-8", "Ops is admin only.");
    }
    return false; // "/", "/tickets", shared report links, retired paths: existing handlers decide.
  }

  if (pathname === "/" || pathname === "/reports") return redirect("/library");
  if (RETIRED.has(pathname)) return redirect("/library");

  if (pathname === "/api/hub/me") {
    const cfg = getConfig() || {};
    const hubCfg = cfg.hub || {};
    const allow = (hubCfg.consoleUsers || []).map(String);
    const consoleLink = (cfg.externalLinks || []).find((l) => l.id === "console");
    const mayConsole = allow.length && (allow.includes(String(session.userId || "")) || allow.includes(String(session.email || "").toLowerCase()));
    let name = session.name || "";
    if (!name && session.userId && /^[a-f0-9]{24}$/i.test(session.userId)) name = await userName(getDb, session.userId);
    return json(200, {
      name: name || (session.email || "").replace(/@.*/, ""), email: session.email || "", role: session.role,
      consoleUrl: mayConsole && consoleLink ? consoleLink.href : null,
      counts: await hubCounts({ getDb, kanban, dirs }),
    });
  }

  if (pathname === "/api/hub/search") {
    return json(200, { groups: await search(url.searchParams.get("q") || "", { getDb, knowledgeStore, kanban, dirs }) });
  }

  if (pathname === "/library") {
    const reports = library.loadReports(dirs);
    const docs = await library.loadDocs(getDb, knowledgeStore);
    const { extraCss, body } = library.makeLibraryBody({ reports, docs });
    return html(renderHubPage({ title: "Library", active: "library", extraCss, body }));
  }

  const docMatch = DOC_RE.exec(pathname);
  if (docMatch) {
    let name;
    try { name = decodeURIComponent(docMatch[1]); } catch { return false; }
    const db = await getDb();
    const doc = await knowledgeStore.get(db, "docs", name).catch(() => null);
    if (!doc) return send(404, "text/html; charset=utf-8", renderHubPage({ title: "Not found", active: "library", body: `<div class="lib" style="padding:80px 24px;text-align:center"><h1>That doc does not exist</h1><p style="color:var(--text-3)">It may have been renamed or removed. <a style="color:var(--accent)" href="/library#cat=kb">Back to the knowledge base</a></p></div>`, extraCss: library.LIB_CSS }));
    const related = await knowledgeStore.neighbors(db, "docs", doc.name, { limit: 12 }).then((r) => (r && r.outgoing ? r.outgoing : Array.isArray(r) ? r : []).filter((x) => x && x.kind === "docs").slice(0, 12)).catch(() => []);
    const { extraCss, body } = library.makeDocBody(doc, { renderMarkdown, related });
    return html(renderHubPage({ title: doc.title && doc.title !== doc.name ? doc.title : doc.name, active: "library", extraCss, body }));
  }

  if (slugMatch) {
    const slug = slugMatch[1];
    const all = library.loadReports(dirs);
    const idx = all.findIndex((x) => x.id === slug);
    if (idx < 0) return false; // built-in live reports keep their own routes
    const item = all[idx];
    const sameCat = all.filter((x) => x.category === item.category);
    const ci = sameCat.findIndex((x) => x.id === slug);
    const { extraCss, body } = library.makeViewerBody(item, { prev: sameCat[ci - 1], next: sameCat[ci + 1], src: `/reports/${slug}?embed=1` });
    return html(renderHubPage({ title: item.title, active: "library", extraCss, body }));
  }

  if (pathname === "/tickets") {
    if (!ticketCache.v || Date.now() - ticketCache.at > 30_000) ticketCache = { at: Date.now(), v: await tickets.loadTicketHub(await getDb()) };
    const data = ticketCache.v;
    const { extraCss, body } = tickets.makeTicketHubBody(data);
    return html(renderHubPage({ title: "Tickets", active: "tickets", extraCss, body }));
  }

  return false;
}

const nameCache = new Map();
async function userName(getDb, id) {
  if (nameCache.has(id)) return nameCache.get(id);
  let n = "";
  try {
    const { ObjectId } = require("mongodb");
    const db = await getDb();
    const u = await db.collection("users").findOne({ _id: new ObjectId(id) }, { projection: { username: 1 }, maxTimeMS: 4000 });
    n = (u && u.username) || "";
  } catch { /* fall back to email */ }
  nameCache.set(id, n);
  return n;
}

async function hubCounts({ getDb, kanban, dirs }) {
  if (countsCache.v && Date.now() - countsCache.at < 30_000) return countsCache.v;
  const v = { ticketsOpen: null, ticketsWaiting: 0, boardNow: null, boardOwner: 0, libraryNew: 0 };
  try {
    const db = await getDb();
    const col = db.collection("tickets");
    const [open, waiting] = await Promise.all([
      col.countDocuments({ status: { $nin: tickets.DONE } }, { maxTimeMS: 4000 }),
      col.countDocuments({ status: { $nin: tickets.DONE }, $or: [{ status: "awaiting_player" }, { "intake.awaitingReply": { $nin: [null, false] } }] }, { maxTimeMS: 4000 }),
    ]);
    v.ticketsOpen = open; v.ticketsWaiting = waiting;
  } catch { /* leave null */ }
  try {
    const k = kanban();
    const items = (x) => (Array.isArray(x) ? x : (x && x.items) || []);
    v.boardNow = items(k.list({ lane: "now", limit: 500 })).length;
    v.boardOwner = items(k.list({ needs_owner: true, limit: 500 })).length;
  } catch { /* kanban unavailable */ }
  const week = Date.now() - 7 * 864e5;
  v.libraryNew = library.loadReports(dirs).filter((r) => r.published && new Date(r.published).getTime() > week).length;
  countsCache = { at: Date.now(), v };
  return v;
}

async function search(q, { getDb, knowledgeStore, kanban, dirs }) {
  const query = String(q || "").trim().toLowerCase().slice(0, 120);
  const words = query.split(/\s+/).filter(Boolean);
  const hit = (s) => words.every((w) => s.toLowerCase().includes(w));
  const groups = [];
  const nav = [
    { title: "Work board", href: "/kanban", meta: "View", color: "var(--accent)" },
    { title: "Library", href: "/library", meta: "View", color: "var(--accent)" },
    { title: "Tickets", href: "/tickets", meta: "View", color: "var(--accent)" },
  ];
  if (!words.length) {
    const recent = library.loadReports(dirs).slice(0, 6).map((r) => ({ title: r.title, href: r.href, meta: library.CAT[r.category].label, color: library.CAT[r.category].color }));
    return [{ label: "Go to", items: nav }, { label: "Recent reports", items: recent }];
  }
  const navHits = nav.filter((n) => hit(n.title));
  if (navHits.length) groups.push({ label: "Go to", items: navHits });
  const reps = library.loadReports(dirs).filter((r) => hit(`${r.title} ${r.original} ${r.summary} ${(r.labels || []).join(" ")} ${r.type}`)).slice(0, 8)
    .map((r) => ({ title: r.title, href: r.href, meta: `${library.CAT[r.category].label} · ${r.type}`, color: library.CAT[r.category].color }));
  groups.push({ label: "Reports", items: reps });
  const num = /^#?(\d{1,6})$/.exec(query);
  try {
    const db = await getDb();
    const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const filter = num ? { ticketNumber: +num[1] } : { $and: esc.map((w) => ({ title: { $regex: w, $options: "i" } })) };
    const ts = await db.collection("tickets").find(filter, { projection: { ticketNumber: 1, title: 1, status: 1 }, maxTimeMS: 3000 }).sort({ ticketNumber: -1 }).limit(8).toArray();
    groups.push({ label: "Tickets", items: ts.map((t) => ({ title: `#${t.ticketNumber} ${t.title || ""}`, href: `/tickets/${t.ticketNumber}`, meta: (tickets.STATUS[t.status] || { label: t.status }).label, color: (tickets.STATUS[t.status] || { color: "#94a3b8" }).color })) });
    const docs = await library.loadDocs(getDb, knowledgeStore);
    groups.push({ label: "Docs", items: docs.filter((d) => hit(`${d.title} ${d.summary} ${d.id} ${(d.labels || []).join(" ")}`)).slice(0, 6).map((d) => ({ title: d.title, href: d.href, meta: "Knowledge base", color: library.CAT.kb.color })) });
  } catch { /* database unavailable: reports and cards still search */ }
  try {
    const found = kanban().list({ q: query, limit: 8 });
    const cards = Array.isArray(found) ? found : (found && found.items) || [];
    groups.push({ label: "Work board", items: cards.map((c) => ({ title: c.title, href: `/kanban#item-${c.id}`, meta: `${c.product || ""} · ${c.lane}`, color: c.lane === "now" ? "#34d399" : c.lane === "blocked" ? "#f87171" : "#94a3b8" })) });
  } catch { /* kanban unavailable */ }
  return groups.filter((g) => g.items.length);
}

module.exports = { handleHubRoute, RETIRED, isHubPath };
