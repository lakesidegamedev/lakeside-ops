"use strict";
/**
 * Keir evidence pages (Keir 11.1), served beside the public ticket form:
 *
 *   GET /support/evidence/<id>            dated report or 24 h tracker page
 *   GET /support/evidence/<id>/chart.png  the same chart Keir attached in Discord
 *
 * Keir (apps/agent/lib/operator/evidencepages.js) writes each page from game
 * reads it received: meta.json once, write-once numbered snapshots, the chart,
 * and archived.json when the tracker ends. This file only reads them and
 * renders escaped HTML itself; no stored HTML, URL or script is ever served.
 *
 * Access (fail closed: a page that is not exactly one of these is not found):
 * - "public_aggregate": a one-off market_history report from a public ping.
 *   Its files name no ticket, reporter or audience, it is never a tracker.
 *   Anyone with the link.
 * - "ticket": every page opened from a ticket, trackers included, even when
 *   the data is a public aggregate. meta.audience pins the ticket's original
 *   reporter at creation (ticket createdAt and reporter character, from the
 *   support service's ticket row). On every request the viewer must hold a
 *   Lakeside session (the web ticket form's check) and ALL of:
 *     1. the live ticket row is still the pinned one (same createdAt) and
 *        still names the pinned reporter character;
 *     2. the viewer is the live row's reporter (linked Discord id or AHD user);
 *     3. the pinned character belongs to the viewer's own AHD account.
 *   So a reassigned or re-created ticket never shows the earlier reporter's
 *   data to anyone but staff. Staff (verified Discord ids) are a separate path.
 *
 * Responses are no-store, noindex, and carry a CSP that allows only this
 * page's own chart image and inline styles.
 */

const fs = require("node:fs");
const path = require("node:path");
const { ObjectId } = require("mongodb");

const ID = /^[a-f0-9]{32}$/;
const SIGN_IN_URL = "https://lakesidegames.net/account";
const MAX_SNAPSHOTS = 48;
const CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const human = (key) => String(key).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
const fmtNumber = (n) => Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2 });
const fmtDate = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toISOString().replace("T", " ").slice(0, 16) + " UTC"; };

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

const PUBLIC_TOOLS = new Set(["market_history", "commodity_market"]);
const ISO = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const isoOf = (v) => v instanceof Date ? (Number.isNaN(v.getTime()) ? null : v.toISOString()) : ISO(v);
// The character a game profile link names (same rule as Keir's evidencepages.js).
function characterOfProfile(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:" || !/^(?:www\.)?ahousedividedgame\.com$/i.test(u.hostname) || u.search || u.hash) return null;
    return /^\/character\/([1-9]\d{0,8})\/?$/.exec(u.pathname)?.[1] || null;
  } catch { return null; }
}
// "public", "ticket" or null. Anything unknown, inconsistent or half-written is null.
function classify(meta, id) {
  if (!meta || typeof meta !== "object" || meta.id !== id || meta.product !== "ahd") return null;
  if (meta.visibility === "public_aggregate") {
    const clean = meta.kind === "report" && meta.ticket == null && meta.audience === undefined && meta.expiresAt == null && PUBLIC_TOOLS.has(meta.tool);
    return clean ? "public" : null;
  }
  if (meta.visibility === "ticket") {
    const t = meta.ticket, a = meta.audience;
    if (!Number.isSafeInteger(t) || t <= 0 || !["report", "tracker"].includes(meta.kind)) return null;
    if (meta.kind === "tracker" && !ISO(meta.expiresAt)) return null;
    if (!a || typeof a !== "object" || a.v !== 1 || a.kind !== "ticket_reporter" || a.ticket !== t || !ISO(a.ticketCreatedAt) || !/^[1-9]\d{0,8}$/.test(String(a.character || ""))) return null;
    return "ticket";
  }
  return null;
}

// Reads one presentation. Snapshots count only as an unbroken run from 1. An
// archived page shows only the snapshots it had when it ended, and a tracker
// never shows a snapshot taken at or after its absolute deadline, so nothing
// written afterwards can change it.
function loadPage(dir, id) {
  if (!ID.test(id)) return null;
  const base = path.join(path.resolve(dir), id);
  const meta = readJson(path.join(base, "meta.json"));
  const access = classify(meta, id);
  if (!access) return null;
  const archived = readJson(path.join(base, "archived.json"));
  const limit = Math.min(MAX_SNAPSHOTS, meta.kind === "report" ? 1 : archived && Number.isInteger(archived.snapshots) ? archived.snapshots : MAX_SNAPSHOTS);
  const deadline = meta.kind === "tracker" ? Date.parse(meta.expiresAt) : Infinity;
  const snapshots = [];
  for (let n = 1; n <= limit; n++) {
    const s = readJson(path.join(base, `snap-${String(n).padStart(4, "0")}.json`));
    if (!s || s.n !== n || !Array.isArray(s.rows) || !(Date.parse(s.at) < deadline)) break;
    snapshots.push(s);
  }
  snapshots.reverse();
  return { meta, access, archived, snapshots, chart: path.join(base, "chart.png") };
}

function state(page, now) {
  const { meta, archived } = page;
  if (meta.kind !== "tracker") return { live: false, label: `Report, ${fmtDate(meta.createdAt)}` };
  if (archived) return { live: false, label: `Archived ${fmtDate(archived.at)}${archived.reason ? ` (${reasonText(archived.reason)})` : ""}. This page no longer changes.` };
  const expires = Date.parse(meta.expiresAt);
  if (!Number.isFinite(expires) || now >= expires) return { live: false, label: `Tracking ended ${fmtDate(meta.expiresAt)}. This page no longer changes.` };
  return { live: true, label: `Tracking until ${fmtDate(meta.expiresAt)}. Keir adds a new table here when its later checks find a change. Nothing is posted to your ticket.` };
}
function reasonText(r) {
  return { expired: "24 hours passed", ticket_closed: "the ticket closed", takeover: "staff took the ticket over", paused: "the ticket was paused",
    keir_stopped: "Keir was stopped", stopped_by_request: "stopped on request", task_ended: "the conversation ended" }[r] || "ended";
}

// Headings and units come from the snapshot's columnMeta (written by the
// typed projection). Older snapshots without it fall back to the raw key and a
// per-column unit map. An empty cell is "not recorded", never 0 or blank.
function unitFor(snap, meta, c) {
  if (meta[c] && meta[c].unit) return meta[c].unit;
  return typeof snap.unit === "object" && snap.unit && typeof snap.unit[c] === "string" ? snap.unit[c] : null;
}
function renderTable(snap, table = snap) {
  const meta = table.columnMeta && typeof table.columnMeta === "object" ? table.columnMeta : {};
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const cols = (Array.isArray(table.columns) && table.columns.length ? table.columns : [...new Set(rows.flatMap((r) => Object.keys(r)))]).slice(0, 24);
  const head = cols.map((c) => { const u = unitFor(snap, meta, c); return `<th scope="col">${esc(meta[c]?.label || human(c))}${u ? `<span class="u">${esc(u)}</span>` : ""}</th>`; }).join("");
  const body = rows.map((r) => `<tr>${cols.map((c) => {
    const v = r[c];
    if (v === null || v === undefined) return `<td class="gap">not recorded</td>`;
    if (typeof v === "number") return `<td class="num">${esc(fmtNumber(v))}</td>`;
    if (typeof v === "boolean") return `<td>${v ? "yes" : "no"}</td>`;
    return `<td>${esc(v)}</td>`;
  }).join("")}</tr>`).join("");
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
const scopeText = (scope) => scope && typeof scope === "object" ? Object.values(scope).filter((v) => typeof v === "string" || typeof v === "number").join(", ") : "";
function renderSnapshot(snap, open) {
  const unitLabel = typeof snap.unitLabel === "string" && snap.unitLabel ? snap.unitLabel : typeof snap.unit === "string" ? snap.unit : "";
  const facts = [snap.world ? `world ${snap.world.slice(0, 8)}` : null, scopeText(snap.scope) ? `scope: ${scopeText(snap.scope)}` : null,
    snap.capturedAt ? `settled data read ${snap.capturedAt}` : null, snap.asOfTurn != null ? `as of turn ${snap.asOfTurn}` : null,
    unitLabel ? `values in ${unitLabel}` : null, `checked ${fmtDate(snap.observedAt || snap.at)}`].filter(Boolean).join(" · ");
  const extra = (Array.isArray(snap.tables) ? snap.tables : []).filter((t) => t && Array.isArray(t.rows) && t.rows.length)
    .map((t) => `<h3>${esc(t.title || human(t.id || "More"))}</h3>${renderTable(snap, t)}`).join("");
  const keyFacts = (Array.isArray(snap.facts) ? snap.facts : []).filter((f) => f && typeof f.label === "string")
    .map((f) => `<li>${esc(f.label)}: <strong>${esc(typeof f.value === "number" ? fmtNumber(f.value) : f.value ?? "not recorded")}</strong>${f.unit ? ` ${esc(f.unit)}` : ""}</li>`).join("");
  const caveats = (Array.isArray(snap.caveats) ? snap.caveats : []).filter((c) => typeof c === "string");
  const gaps = (snap.gaps || []).length ? `<h3>What this data cannot show</h3><ul>${snap.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : "";
  const sources = (snap.sources || []).length ? `<p class="muted">Sources: ${snap.sources.map(esc).join("; ")}</p>` : "";
  const truncated = snap.truncated ? `<p class="muted">Only the first rows Keir received are shown.</p>` : "";
  const heading = snap.title ? `<h3>${esc(snap.title)}</h3>` : "";
  const inner = `<p class="muted">${esc(facts)}</p>${heading}${renderTable(snap)}${truncated}${keyFacts ? `<ul>${keyFacts}</ul>` : ""}${extra}${caveats.length ? `<h3>How to read this</h3><ul>${caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}${gaps}${sources}`;
  return open ? `<section><h2>Latest check</h2>${inner}</section>`
    : `<details><summary>Earlier check ${esc(snap.n)}, ${esc(fmtDate(snap.observedAt || snap.at))}</summary>${inner}</details>`;
}
function renderPage(page, { id, now = Date.now() } = {}) {
  const { meta, snapshots } = page;
  const st = state(page, now);
  const title = meta.title || human(meta.metric || "Game data");
  const scope = meta.visibility === "ticket" && meta.ticket ? `Ticket ${esc(meta.ticket)}` : "Public game data";
  const chart = fs.existsSync(page.chart) ? `<img src="/support/evidence/${esc(id)}/chart.png" alt="${esc(`Chart: ${title}`)}" width="640">` : "";
  const latest = snapshots[0] ? renderSnapshot(snapshots[0], true) : `<p>No data has been recorded yet.</p>`;
  const earlier = snapshots.slice(1).map((s) => renderSnapshot(s, false)).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)} | A House Divided support</title>
<style>
body{margin:0;background:#14141c;color:#e8e8ee;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 18px 48px}
h1{font-size:22px;margin:0 0 4px;border-left:3px solid #dc2626;padding-left:10px}
h2{font-size:17px;margin:28px 0 6px}h3{font-size:15px;margin:18px 0 4px}
.muted{color:#8f8f9d;font-size:13px}.state{background:#1d1d2a;border:1px solid #2a2a3d;border-radius:8px;padding:10px 12px;margin:14px 0}
img{max-width:100%;height:auto;border-radius:10px;margin:8px 0}
.scroll{overflow-x:auto;border:1px solid #2a2a3d;border-radius:8px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:6px 10px;border-bottom:1px solid #2a2a3d;text-align:left;white-space:nowrap}
th{background:#1d1d2a;color:#b4b4c2;font-weight:600;position:sticky;top:0}
td.num{text-align:right}td.gap{color:#8f8f9d;font-style:italic}.u{display:block;font-weight:400;color:#8f8f9d;font-size:12px}
details{margin:14px 0}summary{cursor:pointer;color:#b4b4c2}
</style></head><body><main>
<p class="muted">${scope} · A House Divided</p>
<h1>${esc(title)}</h1>
<p class="muted">Created ${esc(fmtDate(meta.createdAt))}${meta.world ? ` · world ${esc(String(meta.world).slice(0, 8))}` : ""}</p>
<div class="state">${esc(st.label)}</div>
${chart}
${latest}
${earlier}
<p class="muted">Figures are what the game recorded when Keir checked. "Not recorded" means the game has no value for that cell; nothing is estimated.</p>
</main></body></html>`;
}

function message(title, body, link) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>body{margin:0;background:#14141c;color:#e8e8ee;font:15px/1.5 system-ui,sans-serif}main{max-width:560px;margin:15vh auto;padding:0 18px}a{color:#7fb0f0}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(body)}</p>${link ? `<p><a href="${esc(link.href)}">${esc(link.text)}</a></p>` : ""}</main></body></html>`;
}

// Live lookups against the game database (same db as the support service).
function createDbLookups(db) {
  const Tickets = db.collection("tickets"), Users = db.collection("users"), Characters = db.collection("characters");
  const hex = (v) => (v == null ? null : /^[a-f0-9]{24}$/i.test(String(v)) ? String(v).toLowerCase() : null);
  return {
    findTicket: (number) => Tickets.findOne({ ticketNumber: number }, { projection: { ticketNumber: 1, discordUserId: 1, userId: 1, category: 1, createdAt: 1, "reporter.profileUrl": 1 } }),
    // Lakeside account ids are either "discord:<id>" or an AHD user id. Both
    // resolve to the Discord id and the AHD user they are linked to, if any.
    async identify(accountId) {
      if (/^discord:\d{5,30}$/.test(accountId)) {
        const discordId = accountId.slice(8);
        const users = await Users.find({ discordId }, { projection: { _id: 1 } }).limit(2).toArray();
        return { discordId, userId: users.length === 1 ? hex(users[0]._id) : null };
      }
      if (/^[a-f0-9]{24}$/i.test(accountId)) {
        const user = await Users.findOne({ _id: new ObjectId(accountId) }, { projection: { discordId: 1 } });
        return { discordId: user?.discordId ? String(user.discordId) : null, userId: user ? accountId.toLowerCase() : null };
      }
      return { discordId: null, userId: null };
    },
    // The AHD user that owns a character, by its public sequential id.
    async characterOwner(character) {
      const c = await Characters.findOne({ sequentialId: Number(character) }, { projection: { userId: 1 } });
      return hex(c?.userId);
    },
  };
}

function createLimiter({ windowMs = 10 * 60000, max = 120, now = () => Date.now() } = {}) {
  const hits = new Map();
  return (key) => {
    const t = now(), list = (hits.get(key) || []).filter((at) => t - at < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(t); hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((at) => t - at < windowMs)) hits.delete(k);
    return true;
  };
}

function registerEvidencePages(app, {
  dir = process.env.EVIDENCE_PAGES_DIR || "/var/lib/lakeside-evidence",
  verifySession, findTicket, identify, characterOwner,
  staffDiscordIds = (process.env.EVIDENCE_STAFF_DISCORD_IDS || "").split(",").map((s) => s.trim()).filter((s) => /^\d{5,30}$/.test(s)),
  logger = console, now = () => Date.now(), allow = createLimiter(), base = "/support/evidence",
} = {}) {
  if (typeof verifySession !== "function" || typeof findTicket !== "function" || typeof identify !== "function" || typeof characterOwner !== "function") {
    throw new Error("registerEvidencePages needs verifySession, findTicket, identify and characterOwner");
  }
  const staff = new Set(staffDiscordIds);
  const headers = (res) => res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": CSP, "X-Frame-Options": "DENY" });
  const send = (res, status, html) => { headers(res); res.status(status).type("html").send(html); };
  const notFound = { status: 404, html: message("Not found", "This page does not exist.") };
  const notYours = { status: 403, html: message("This page is not yours", "Only the player who opened this ticket and support staff can see it. If this is your ticket, sign in with the Lakeside account linked to the same Discord account.") };

  // Returns { ok: true } or { status, html }. Every refusal shows nothing of the page.
  async function authorize(req, page) {
    if (page.access === "public") return { ok: true };
    if (page.access !== "ticket") return notFound;
    const pin = page.meta.audience, number = page.meta.ticket;
    let account;
    try { account = await verifySession(req); } catch (e) {
      logger.warn?.("[evidence-pages] session check failed:", e.message);
      return { status: 503, html: message("Try again shortly", "We could not check your sign-in right now. Please try again in a minute.") };
    }
    if (!account) return { status: 401, html: message("Sign in to view this page", "This page belongs to a support ticket. Sign in with the Lakeside account linked to your Discord, then open the link from your ticket again.", { href: SIGN_IN_URL, text: "Sign in at lakesidegames.net" }) };
    const who = await identify(String(account.accountId || ""));
    // Staff: a separate path, on a verified Discord identity only.
    if (who?.discordId && staff.has(String(who.discordId))) return { ok: true, staff: true };
    const ticket = await findTicket(number);
    if (!ticket) return notFound;
    const refuse = (why) => { logger.log?.(`[evidence-pages] refused ${page.meta.id.slice(0, 8)} for ticket ${number}: ${why}`); return notYours; };
    // 1. The live row is still the ticket and reporter the page was pinned to.
    if (Number(ticket.ticketNumber) !== number || isoOf(ticket.createdAt) !== ISO(pin.ticketCreatedAt)) return refuse("ticket record changed");
    if (characterOfProfile(ticket.reporter?.profileUrl) !== String(pin.character)) return refuse("reporter changed");
    // 2. The viewer is the live row's reporter.
    const userId = who?.userId ? String(who.userId).toLowerCase() : null;
    const ownsByDiscord = Boolean(who?.discordId && ticket.discordUserId && String(who.discordId) === String(ticket.discordUserId));
    const ownsByUser = Boolean(userId && ticket.userId && String(ticket.userId).toLowerCase() === userId);
    if (!ownsByDiscord && !ownsByUser) return refuse("not the reporter");
    // 3. The pinned character is the viewer's own.
    if (!userId) return refuse("no game account");
    const owner = await characterOwner(pin.character);
    if (!owner || String(owner).toLowerCase() !== userId) return refuse("pinned character is not the viewer's");
    return { ok: true, staff: false };
  }

  async function handle(req, res, fn) {
    try {
      const ip = require("./support-web-intake").clientIp(req);
      if (!allow(ip)) { res.set("Retry-After", "60"); return send(res, 429, message("Slow down", "Too many requests. Please wait a minute.")); }
      const id = String(req.params.id || "");
      const page = ID.test(id) ? loadPage(dir, id) : null;
      if (!page) return send(res, 404, message("Not found", "This page does not exist."));
      const auth = await authorize(req, page);
      if (!auth.ok) return send(res, auth.status, auth.html);
      return fn(page, id, auth);
    } catch (e) {
      logger.error?.("[evidence-pages] failed:", e.message);
      return send(res, 500, message("Something went wrong", "This page could not be shown. Please try again later."));
    }
  }

  app.get(`${base}/:id`, (req, res) => handle(req, res, (page, id) => send(res, 200, renderPage(page, { id, now: now() }))));
  app.get(`${base}/:id/chart.png`, (req, res) => handle(req, res, (page) => {
    let png;
    try { png = fs.readFileSync(page.chart); } catch { return send(res, 404, message("Not found", "This chart does not exist.")); }
    headers(res);
    res.status(200).set({ "Content-Type": "image/png", "Content-Disposition": "inline; filename=\"ahd-evidence-chart.png\"" }).send(png);
  }));
}

// For the support service's ticket update delivery: the chart file of a page
// in the known store, only when that page may appear in this ticket's channel.
// Public aggregate pages carry no ticket and may appear in any ticket. Returns
// an absolute path or null; never trusts a caller-supplied path.
function resolveChart(dir, id, { ticket } = {}) {
  const page = ID.test(String(id || "")) ? loadPage(dir, id) : null;
  if (!page || !fs.existsSync(page.chart)) return null;
  if (page.access === "public") return page.chart;
  if (page.access === "ticket" && Number.isSafeInteger(Number(ticket)) && page.meta.ticket === Number(ticket)) return page.chart;
  return null;
}

module.exports = { registerEvidencePages, createDbLookups, loadPage, renderPage, createLimiter, resolveChart, classify, characterOfProfile };
