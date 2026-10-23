// Report Publishing MCP — lets report-building agents (e.g. Danica's) publish a
// finished report to the ops dashboard WITHOUT shell / VPS access. It writes the
// report HTML into the dashboard's published-reports directory, records it in a
// manifest that the /reports library scans. The dashboard reads both from disk
// per request, so publishing is live immediately and must not restart Ops.
//
// Streamable HTTP + the SAME shared scoped bearer token as the rest of the fleet
// (agent-tokens). Publishing is a privileged action, so publish/unpublish/restart
// require a WRITE-scoped token (the full-access token generated from the ops dash);
// listing is allowed for any valid token.
//   node mcp/report-publish-server.js   (default :9738)
require("dotenv").config({ quiet: true, path: require("path").join(__dirname, "..", ".env") });
const { z } = require("zod");
const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { createServer } = require("../packages/mcp-server");
const store = require("../knowledge-store");
const tokens = require("../agent-tokens");
const { activatePublishedReports } = require("./report-activation");

const PORT = parseInt(process.env.REPORT_MCP_PORT || "9738", 10);
const DASH_ROOT = path.join(__dirname, "..");
// The dashboard serves reports from PUBLISHED_REPORTS_DIR, so a publisher must
// write exactly there. Inside the ops-knowledge server this runs from a pinned
// release whose own reports/ is a build-time copy, which is why the env wins.
const PUBLISHED_DIR = path.resolve(process.env.PUBLISHED_REPORTS_DIR || path.join(DASH_ROOT, "reports", "published"));
const ASSETS_DIR = path.join(PUBLISHED_DIR, "assets");
const MANIFEST = path.join(PUBLISHED_DIR, "manifest.json");
const DASH_SERVICE = process.env.REPORT_MCP_DASH_SERVICE || "ahd-ops-dashboard.service";
const PUBLIC_BASE = process.env.REPORT_MCP_PUBLIC_BASE || "https://ops.lakesidegames.net";

// Slugs already claimed by hardcoded routes in server.js — published reports may
// not shadow them (the hardcoded route would win anyway; reject early for clarity).
const RESERVED_SLUGS = new Set([
  "extraction-capacity", "election-post-mortem", "election-post-mortem-1992",
  "demographics", "index", "knowledge-synthesis", "frontier-audit-2026-07",
  "state-of-the-game-t856", "market-growth-monetization-t858",
  "sandbox-economy-audit", "production-economy-audit",
]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,79}$/;
const ASSET_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const IMAGE_TYPES = new Map([
  ["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/webp", ".webp"],
  ["image/gif", ".gif"], ["image/avif", ".avif"],
]);

function ensureDir() {
  fs.mkdirSync(PUBLISHED_DIR, { recursive: true });
}
function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return []; }
}
function writeManifest(list) {
  ensureDir();
  fs.writeFileSync(MANIFEST, JSON.stringify(list, null, 2));
}

function reportFile(slug) {
  const file = path.join(PUBLISHED_DIR, `${slug}.html`);
  if (!file.startsWith(PUBLISHED_DIR + path.sep)) throw new Error("invalid slug path");
  return file;
}

function assetFile(slug, filename) {
  const dir = path.join(ASSETS_DIR, slug);
  const file = path.join(dir, filename);
  if (!file.startsWith(dir + path.sep)) throw new Error("invalid asset path");
  return { dir, file };
}

function titleFromDocument(html, fallback) {
  const match = /<title[^>]*>([^<]{1,160})<\/title>/i.exec(html);
  return match ? match[1].trim() : fallback;
}

// Minimal, dependency-free wrap: if the agent supplies a full HTML document we
// store it verbatim; if it supplies a body fragment we wrap it in a clean,
// dashboard-styled standalone page. Reports are authored by a trusted agent and
// served admin-only, so we do not sanitize — we only guarantee a valid document.
function buildDocument({ title, html, isFullDoc }) {
  if (isFullDoc) return html;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0b1120;color:#e2e8f0;font:16px/1.6 Inter,system-ui,sans-serif;padding:32px}
  .wrap{max-width:900px;margin:0 auto}
  h1,h2,h3{color:#f8fafc;line-height:1.25} h1{font-size:1.9rem;margin:.2em 0 .6em}
  a{color:#7dd3fc} code,pre{font-family:JetBrains Mono,ui-monospace,monospace}
  pre{background:#111a2e;padding:14px 16px;border-radius:10px;overflow:auto}
  table{border-collapse:collapse;width:100%;margin:1em 0} th,td{border:1px solid #1e293b;padding:8px 10px;text-align:left}
  th{background:#111a2e} blockquote{border-left:3px solid #334155;margin:1em 0;padding:.2em 1em;color:#94a3b8}
  img{max-width:100%} .rpt-foot{margin-top:2.5em;padding-top:1em;border-top:1px solid #1e293b;color:#64748b;font-size:.85rem}
</style></head>
<body><div class="wrap">
${html}
<div class="rpt-foot">Published via the report MCP.</div>
</div></body></html>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function restartDashboard() { return activatePublishedReports(); }

// The report tools on any MCP server: their own (below) and, since the MCP
// fleet consolidation, the ops-knowledge server, which also answers as
// ops-report-publish at /mcp/report-publish.
function registerReportTools(server, auth) {
  ensureDir();
  const canWrite = !!auth && auth.scopes && auth.scopes.write === true;

  server.tool("publish_report",
    "Publish a finished report to the ops dashboard. Writes the HTML to the published-reports directory and registers it in the live /reports library without restarting Ops. Requires a WRITE-scoped token. Provide EITHER a full HTML document or an HTML body fragment (it will be wrapped in a styled page). Returns the live URL.",
    {
      slug: z.string().regex(SLUG_RE, "lowercase letters, digits and hyphens; 2-80 chars").describe("URL slug, e.g. 'labour-market-audit-t1050'. Served at /reports/<slug>."),
      title: z.string().min(3).max(160).describe("Report title shown in the library and browser tab"),
      html: z.string().min(1).max(8_000_000).describe("Full HTML document (starting with <!doctype or <html) OR an HTML body fragment to be wrapped"),
      summary: z.string().max(600).optional().describe("One-paragraph description for the library card"),
      category: z.string().max(60).optional().default("Published Reports").describe("Library category heading"),
      icon: z.string().max(8).optional().default("📄").describe("Emoji icon for the library card"),
      badge: z.string().max(24).optional().describe("Optional badge label, e.g. 'Live' or a turn number"),
      author: z.string().max(80).optional().describe("Who/what produced the report, e.g. 'danica-agent'"),
      public: z.boolean().optional().describe("Make the report viewable without an admin session (default false = admin-only). Omitting this on a republish preserves the report's existing visibility."),
      restart: z.boolean().optional().default(false).describe("Deprecated compatibility field. Reports are live immediately; Ops is never restarted."),
    },
    async ({ slug, title, html, summary, category, icon, badge, author, public: isPublic, restart }) => {
      if (!canWrite) return jsonResult({ error: "write-scoped token required to publish" });
      if (RESERVED_SLUGS.has(slug)) return jsonResult({ error: `slug '${slug}' is reserved by a built-in report route` });

      const trimmed = html.trimStart();
      const isFullDoc = /^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
      const doc = buildDocument({ title, html, isFullDoc });
      const file = path.join(PUBLISHED_DIR, `${slug}.html`);
      // Guard against traversal even though the slug regex forbids it.
      if (!file.startsWith(PUBLISHED_DIR + path.sep)) return jsonResult({ error: "invalid slug path" });
      fs.writeFileSync(file, doc);

      const manifest = readManifest();
      const existingIdx = manifest.findIndex((m) => m.slug === slug);
      const entry = {
        slug, title,
        summary: summary || "",
        category: category || "Published Reports",
        icon: icon || "📄",
        badge: badge || "Published",
        author: author || (auth && auth.name) || "agent",
        // Explicit param wins; a republish that omits it keeps the prior
        // visibility instead of silently reverting a public report to admin-only.
        public: typeof isPublic === "boolean" ? isPublic : (existingIdx >= 0 && manifest[existingIdx].public === true),
        publishedAt: new Date().toISOString(),
        updated: existingIdx >= 0,
      };
      if (existingIdx >= 0) manifest[existingIdx] = entry; else manifest.push(entry);
      writeManifest(manifest);

      let restartResult = { ok: true, skipped: true };
      if (restart) restartResult = await restartDashboard();

      return jsonResult({
        ok: true,
        action: existingIdx >= 0 ? "updated" : "created",
        slug,
        url: `${PUBLIC_BASE}/reports/${slug}`,
        bytes: doc.length,
        restarted: false,
        restartError: restart && !restartResult.ok ? restartResult.error : undefined,
        note: restartResult.note || "Report is live.",
      });
    });

  server.tool("edit_report",
    "Edit an existing published report's HTML and/or library metadata without resupplying unchanged fields. Omitting visibility preserves it. Requires a WRITE-scoped token.",
    {
      slug: z.string().regex(SLUG_RE),
      html: z.string().min(1).max(8_000_000).optional().describe("Replacement full HTML document or body fragment"),
      title: z.string().min(3).max(160).optional(),
      summary: z.string().max(600).optional(),
      category: z.string().max(60).optional(),
      icon: z.string().max(8).optional(),
      badge: z.string().max(24).optional(),
      author: z.string().max(80).optional(),
      public: z.boolean().optional(),
      restart: z.boolean().optional().default(true),
    },
    async ({ slug, html, title, summary, category, icon, badge, author, public: isPublic, restart }) => {
      if (!canWrite) return jsonResult({ error: "write-scoped token required to edit" });
      const file = reportFile(slug);
      if (!fs.existsSync(file)) return jsonResult({ error: `no published report '${slug}'` });
      const manifest = readManifest();
      const idx = manifest.findIndex((m) => m.slug === slug);
      if (idx < 0) return jsonResult({ error: `report '${slug}' has no manifest entry; use set_report_visibility to register it first` });
      if (html !== undefined) {
        const trimmed = html.trimStart();
        const isFullDoc = /^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
        fs.writeFileSync(file, buildDocument({ title: title || manifest[idx].title || slug, html, isFullDoc }));
      }
      const next = { ...manifest[idx] };
      for (const [key, value] of Object.entries({ title, summary, category, icon, badge, author })) {
        if (value !== undefined) next[key] = value;
      }
      if (typeof isPublic === "boolean") next.public = isPublic;
      next.updated = true;
      next.updatedAt = new Date().toISOString();
      manifest[idx] = next;
      writeManifest(manifest);
      const restartResult = restart ? await restartDashboard() : { ok: true, skipped: true };
      return jsonResult({ ok: true, action: "edited", slug, url: `${PUBLIC_BASE}/reports/${slug}`,
        restarted: restart ? restartResult.ok : false,
        restartError: restart && !restartResult.ok ? restartResult.error : undefined });
    });

  server.tool("upload_report_image",
    "Upload an image for a published report. Returns a stable URL to use in an <img src> tag. Requires a WRITE-scoped token.",
    {
      slug: z.string().regex(SLUG_RE),
      filename: z.string().regex(ASSET_NAME_RE).describe("Safe filename including extension"),
      mediaType: z.enum([...IMAGE_TYPES.keys()]),
      dataBase64: z.string().min(1).max(14_000_000).describe("Base64 image bytes, without a data-URL prefix"),
    },
    async ({ slug, filename, mediaType, dataBase64 }) => {
      if (!canWrite) return jsonResult({ error: "write-scoped token required to upload images" });
      if (!fs.existsSync(reportFile(slug))) return jsonResult({ error: `no published report '${slug}'` });
      const expectedExt = IMAGE_TYPES.get(mediaType);
      const actualExt = path.extname(filename).toLowerCase();
      if (actualExt !== expectedExt && !(mediaType === "image/jpeg" && actualExt === ".jpeg")) {
        return jsonResult({ error: `filename extension must match ${mediaType} (${expectedExt})` });
      }
      let bytes;
      try { bytes = Buffer.from(dataBase64, "base64"); } catch { return jsonResult({ error: "invalid base64 image data" }); }
      if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== dataBase64.replace(/\s/g, "").replace(/=+$/, "")) {
        return jsonResult({ error: "invalid base64 image data" });
      }
      if (bytes.length > 10_000_000) return jsonResult({ error: "image exceeds 10 MB" });
      const target = assetFile(slug, filename);
      fs.mkdirSync(target.dir, { recursive: true });
      fs.writeFileSync(target.file, bytes);
      return jsonResult({ ok: true, slug, filename, bytes: bytes.length,
        url: `${PUBLIC_BASE}/reports/published/assets/${slug}/${encodeURIComponent(filename)}`,
        src: `/reports/published/assets/${slug}/${encodeURIComponent(filename)}` });
    });

  server.tool("set_report_visibility",
    "Make a report public or private. If its HTML file exists but its manifest entry is missing, this registers it so visibility can still be changed. Requires a WRITE-scoped token.",
    {
      slug: z.string().regex(SLUG_RE),
      public: z.boolean(),
      title: z.string().min(3).max(160).optional().describe("Used when registering an existing unlisted HTML file"),
      summary: z.string().max(600).optional(),
      category: z.string().max(60).optional().default("Published Reports"),
      icon: z.string().max(8).optional().default("📄"),
      badge: z.string().max(24).optional(),
      restart: z.boolean().optional().default(true),
    },
    async ({ slug, public: isPublic, title, summary, category, icon, badge, restart }) => {
      if (!canWrite) return jsonResult({ error: "write-scoped token required to change visibility" });
      const file = reportFile(slug);
      if (!fs.existsSync(file)) return jsonResult({ error: `no published report '${slug}'` });
      const manifest = readManifest();
      let idx = manifest.findIndex((m) => m.slug === slug);
      const now = new Date().toISOString();
      if (idx < 0) {
        const html = fs.readFileSync(file, "utf8");
        manifest.push({ slug, title: title || titleFromDocument(html, slug), summary: summary || "",
          category: category || "Published Reports", icon: icon || "📄", badge: badge || "Published",
          author: auth?.name || "agent", public: isPublic, publishedAt: now, updated: false });
        idx = manifest.length - 1;
      } else {
        manifest[idx] = { ...manifest[idx], public: isPublic, updated: true, updatedAt: now };
      }
      writeManifest(manifest);
      const restartResult = restart ? await restartDashboard() : { ok: true, skipped: true };
      return jsonResult({ ok: true, action: isPublic ? "made-public" : "made-private", registered: !manifest[idx].updated,
        slug, url: `${PUBLIC_BASE}/reports/${slug}`, restarted: restart ? restartResult.ok : false,
        restartError: restart && !restartResult.ok ? restartResult.error : undefined });
    });

  server.tool("list_published_reports",
    "List reports published through this MCP (from the manifest): slug, title, category, author, publishedAt, and live URL. Any valid token.",
    {},
    async () => {
      const manifest = readManifest();
      return jsonResult({
        count: manifest.length,
        reports: manifest.map((m) => ({ ...m, url: `${PUBLIC_BASE}/reports/${m.slug}` })),
      });
    });

  server.tool("unpublish_report",
    "Remove a published report. The disk-backed change is live immediately without restarting Ops. Requires a WRITE-scoped token. Only affects reports published through this MCP; built-in reports are untouched.",
    {
      slug: z.string().regex(SLUG_RE).describe("slug of the published report to remove"),
      restart: z.boolean().optional().default(false).describe("Deprecated compatibility field; Ops is never restarted."),
    },
    async ({ slug, restart }) => {
      if (!canWrite) return jsonResult({ error: "write-scoped token required to unpublish" });
      const manifest = readManifest();
      const idx = manifest.findIndex((m) => m.slug === slug);
      const file = path.join(PUBLISHED_DIR, `${slug}.html`);
      if (idx < 0 && !fs.existsSync(file)) return jsonResult({ error: `no published report '${slug}'` });
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      try { fs.rmSync(path.join(ASSETS_DIR, slug), { recursive: true, force: true }); } catch { /* already gone */ }
      if (idx >= 0) { manifest.splice(idx, 1); writeManifest(manifest); }
      let restartResult = { ok: true, skipped: true };
      if (restart) restartResult = await restartDashboard();
      return jsonResult({ ok: true, removed: slug, restarted: false,
        restartError: restart && !restartResult.ok ? restartResult.error : undefined });
    });

  server.tool("restart_dashboard",
    "Deprecated compatibility tool. Reports are live immediately; this tool does not restart Ops.",
    {},
    async () => {
      if (!canWrite) return jsonResult({ error: "write-scoped token required to restart" });
      const r = await restartDashboard();
      return jsonResult(r.ok ? { ok: true, service: DASH_SERVICE, skipped: true, note: r.note } : { ok: false, error: r.error });
    });

  return server;
}

function buildReportServer(auth) {
  const server = new McpServer({ name: "ops-report-publish", version: "1.1.0" });
  registerReportTools(server, auth);
  return server;
}

async function main() {
  const db = await store.getDb(process.env.MONGODB_URI);
  await tokens.ensureIndexes(db);
  ensureDir();
  createServer({
    name: "report-publish-mcp", version: "1.1.0", port: PORT, bind: process.env.MCP_BIND || "127.0.0.1",
    authorize: req => tokens.validate(db, req.headers.authorization), buildServer: buildReportServer,
  });
}
function jsonResult(o) { return { content: [{ type: "text", text: JSON.stringify(o, null, 2) }] }; }

if (require.main === module) {
  main().catch((e) => { console.error("[report-mcp] fatal:", e); process.exit(1); });
}

module.exports = { registerReportTools, buildReportServer, PUBLISHED_DIR };
