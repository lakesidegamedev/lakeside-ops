// A House Divided - Technical Docs. Curated viewer over the shared knowledge
// store's `docs` collection: only entries tagged `docs-site` are served, and
// the nav is built from `docs:<section>` tags.
//
// Standalone HTTP server (port 9726). Serves docs.ahousedividedgame.com and
// docs.lakesidegames.net from the same process. Reuses ../knowledge-store and
// the dashboard's node_modules (express, mongodb, @xenova, dotenv).
//
// Run:  MONGODB_URI=... node docs-app/server.js

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const express = require("express");
const store = require("../knowledge-store");
const { opsStaffRole } = require("../ops-staff-role");
const { renderShell } = require("../ops-shell");

const OPS_BASE = (process.env.OPS_PUBLIC_URL || "https://ops.ahousedividedgame.com").replace(/\/+$/, "");
const DOCS_ACTIVE = "https://docs.ahousedividedgame.com";
const GAME_LOGIN_URL = process.env.GAME_LOGIN_URL || "https://ahousedividedgame.com/login";

// Game identity is checked by its issuer, then staff authorization is local.
const { verifyProductionGameSession } = require("../game-session-client");
async function gameCookieStrategy(db, req) {
  let checked;
  try { checked = await verifyProductionGameSession(req.headers.cookie); }
  catch { return null; }
  if (!checked) return null;
  const { ObjectId } = require("mongodb");
  let user;
  try {
    user = await db.collection("users").findOne({ _id: new ObjectId(checked.identity.id) },
      { projection: { email: 1, isAdmin: 1, isModerator: 1, opsRole: 1, isBanned: 1, authRevokedAt: 1 } });
  } catch { return null; }
  if (!user || user.isBanned === true) return null;
  if (user.authRevokedAt && user.authRevokedAt.getTime() >= checked.issuedAt * 1000) return null;
  const role = opsStaffRole(user);
  return role ? { email: user.email, role } : null;
}

// Ops-dashboard session. The dashboard mints `ops_session` scoped to the parent
// domain, so one sign-in at ops.lakesidegames.net now also authenticates
// docs.lakesidegames.net. Sessions are persisted by
// the dashboard to .sessions.json; we read them, never write.
const SESSIONS_FILE = require("path").join(__dirname, "..", ".sessions.json");
const OPS_SESSION_TTL_MS = 86400 * 1000;
let _sessCache = { mtime: 0, map: null };
function readOpsSessions() {
  const fs = require("fs");
  try {
    const st = fs.statSync(SESSIONS_FILE);
    if (_sessCache.map && st.mtimeMs === _sessCache.mtime) return _sessCache.map;
    const map = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    _sessCache = { mtime: st.mtimeMs, map };
    return map;
  } catch { return null; }
}
const { authorizeOpsSession, sessionToken, localUsers } = require("../ops-session-policy");
const OPS_AUTH_MODE = process.env.OPS_AUTH_MODE || require("../src/core/config").getConfig().auth?.mode || "password";
async function opsSessionStrategy(db, req) {
  const token = sessionToken(req);
  if (!token) return null;
  const map = readOpsSessions();
  const session = map && Object.hasOwn(map, token) ? map[token] : null;
  return authorizeOpsSession(session, { getDb: async () => db, users: localUsers(), allowLocal: OPS_AUTH_MODE === "password" });
}

const STRATEGIES = OPS_AUTH_MODE === "sso" ? [opsSessionStrategy] : [opsSessionStrategy, gameCookieStrategy];
async function resolveSession(db, req) {
  for (const s of STRATEGIES) {
    const sess = await s(db, req);
    if (sess) return sess;
  }
  return null;
}

// Sign-in goes through the ops dashboard, which owns the session. It bounces to
// the game for identity, mints ops_session scoped to the parent domain, then
// returns here via the ?next= it parked. Docs never mints a session itself, so
// there is exactly one session owner and no write race on .sessions.json.
function opsOriginFor(req) {
  const host = String((req && req.headers && req.headers.host) || "").split(":")[0].toLowerCase();
  if (host === "lakesidegames.net" || host.endsWith(".lakesidegames.net")) return "https://ops.lakesidegames.net";
  return OPS_BASE;
}
function loginPage(req) {
  const host = String((req && req.headers && req.headers.host) || "docs.lakesidegames.net").split(":")[0];
  const here = "https://" + host + (req && req.originalUrl ? req.originalUrl : "/");
  const signIn = opsOriginFor(req) + "/auth/game?next=" + encodeURIComponent(here);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Lakeside Docs - sign in</title>
<style>:root{color-scheme:dark}
body{margin:0;min-height:100svh;display:flex;align-items:center;justify-content:center;background:#0c0d10;color:#e7e8ea;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
.c{text-align:center;max-width:420px}.c h1{font-weight:800;letter-spacing:-.02em;margin:0 0 .4em}.c p{color:#a4a8b2;line-height:1.6;margin:0}
.c a{display:inline-block;margin-top:18px;padding:.7rem 1.4rem;border-radius:10px;background:linear-gradient(135deg,#7aa2ff,#a78bfa);color:#0c0d10;font-weight:700;text-decoration:none;min-height:44px;box-sizing:border-box}
.n{margin-top:22px;font-size:.8rem;color:#6b6f7a}</style>
</head><body><div class="c"><h1>Lakeside Docs</h1><p>Staff only. Sign in to continue.</p>
<a href="${esc(signIn)}">Sign in</a>
<p class="n">You will be returned to this page afterwards.</p></div></body></html>`;
}

const PORT = parseInt(process.env.DOCS_PORT || "9726", 10);
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error("ERROR: MONGODB_URI required"); process.exit(1); }

let _pipe = null, _pipeFailed = false;
async function embed(text) {
  if (_pipeFailed) return null;
  try {
    if (!_pipe) {
      const { pipeline } = await import("@xenova/transformers");
      _pipe = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5");
      console.log("[docs] embed pipeline ready");
    }
    const out = await _pipe("Represent this sentence for searching relevant passages: " + String(text).slice(0, 7500), { pooling: "mean", normalize: true });
    return Array.from(out.data);
  } catch (e) { _pipeFailed = true; console.log("[docs] embed unavailable, keyword-only:", e.message); return null; }
}

const DOC_FIELDS = { name: 1, title: 1, description: 1, project: 1, tags: 1, "metadata.section": 1, "metadata.path": 1, updatedAt: 1, createdAt: 1, version: 1, hits: 1 };
function shape(d) {
  return {
    name: d.name, title: d.title, description: d.description || "",
    project: d.project || "shared", tags: Array.isArray(d.tags) ? d.tags : [],
    section: (d.metadata && d.metadata.section) || null,
    path: d.metadata && d.metadata.path,
    updatedAt: d.updatedAt, createdAt: d.createdAt,
    version: d.version, hits: d.hits || 0,
  };
}

async function main() {
  const db = await store.getDb(MONGODB_URI);
  await store.ensureIndexes(db);
  const app = express();
  const C = () => db.collection(store.COLLECTION);
  // Every read path is scoped to the curated docs-site set, server-side.
  const BASE = { kind: "docs", deletedAt: null, tags: "docs-site" };
  const isPublished = (d) => Array.isArray(d.tags) && d.tags.includes("docs-site");

  app.get("/healthz", (_q, r) => r.json({ ok: true, service: "lakeside-docs" }));

  app.use(async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    res.vary("Cookie");
    const sess = await resolveSession(db, req);
    if (!sess) { res.status(401).set("Content-Type", "text/html").send(loginPage(req)); return; }
    req.opsSession = sess;
    next();
  });

  app.get("/api/tree", async (_q, res) => {
    const docs = await C().find(BASE, { projection: DOC_FIELDS }).sort({ project: 1, title: 1 }).toArray();
    res.json({ docs: docs.map(shape) });
  });

  app.get("/api/doc", async (req, res) => {
    const d = await store.get(db, "docs", String(req.query.name || ""));
    if (!d || !isPublished(d)) return res.status(404).json({ error: "not found" });
    const out = shape(d);
    out.body = d.body;
    // Related: nearest semantic neighbours, same collection.
    try {
      if (d.embedding) {
        const rows = await C().find({ ...BASE, name: { $ne: d.name }, embedding: { $ne: null } },
          { projection: { name: 1, title: 1, project: 1, embedding: 1 } }).limit(1200).toArray();
        const v = Float32Array.from(d.embedding);
        out.related = rows.map((r) => ({ name: r.name, title: r.title, project: r.project || "shared", score: store.cosine(v, Float32Array.from(r.embedding)) }))
          .filter((r) => r.score > 0.55).sort((a, b) => b.score - a.score).slice(0, 6)
          .map((r) => ({ name: r.name, title: r.title, project: r.project, score: Number(r.score.toFixed(3)) }));
      } else out.related = [];
    } catch { out.related = []; }
    res.json(out);
  });

  app.get("/api/search", async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ results: [] });
    const qEmbed = await embed(q);
    // store.query has no tag filter; over-fetch and keep only published docs.
    const raw = await store.query(db, { kind: "docs", text: q, queryEmbedding: qEmbed, limit: 60 });
    const results = raw.filter(isPublished).slice(0, 14);
    res.json({
      semantic: !!qEmbed,
      results: results.map((r) => ({
        name: r.name, title: r.title, description: r.description,
        project: r.project || "shared", tags: Array.isArray(r.tags) ? r.tags.slice(0, 4) : [],
        updatedAt: r.updatedAt, score: r.score,
      })),
    });
  });

  app.get("/", (req, res) => {
    const role = (req.opsSession && req.opsSession.role) || "moderator";
    res.set("Content-Type", "text/html");
    res.send(renderShell({ title: "A House Divided - Technical Docs", active: DOCS_ACTIVE, role, base: OPS_BASE, extraCss: DOCS_CSS, body: DOCS_BODY }));
  });

  app.listen(PORT, process.env.BIND_HOST || "127.0.0.1", () => console.log(`[docs] A House Divided - Technical Docs on :${PORT}`));
}

// ─── Styles ─────────────────────────────────────────────────────────────────
// Chart ink and series colors come from the validated data-viz palette; the
// three categorical slots pass every gate in both modes (see dataviz skill).
const DOCS_CSS = `
.dx{--s1:#3987e5;--s2:#d95926;--s3:#199e70;
  --ok:#0ca30c;--warn:#fab219;--serious:#ec835a;--crit:#d03b3b;
  --grid:#2c2c2a;--axis:#383835;--muted:#898781;
  display:flex;gap:30px;align-items:flex-start}
.dx-tree{position:sticky;top:64px;width:250px;flex-shrink:0;max-height:calc(100vh - 96px);overflow-y:auto;padding-right:4px}
.dx-search{position:relative;margin-bottom:10px}
.dx-search input{width:100%;padding:.55rem .8rem;border-radius:var(--r-md,10px);border:1px solid var(--border,#24262e);background:var(--surface-2,#1a1c22);color:var(--text,#e7e8ea);font:inherit;font-size:.85rem;outline:none}
.dx-search input:focus{border-color:var(--accent,#7aa2ff)}
.dx-results{position:absolute;left:0;right:0;top:calc(100% + 4px);background:var(--surface,#131418);border:1px solid var(--border,#24262e);border-radius:var(--r-md,10px);box-shadow:var(--e3,0 18px 50px rgba(0,0,0,.5));overflow:hidden;display:none;z-index:60;max-height:66vh;overflow-y:auto}
.dx-results.on{display:block}
.dx-res{padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--border,#24262e)}
.dx-res:last-child{border-bottom:none}
.dx-res:hover,.dx-res.sel{background:var(--accent-soft,rgba(122,162,255,.14))}
.dx-res .rt{font-size:.84rem;font-weight:600;color:var(--text,#e7e8ea)}
.dx-res .rd{font-size:.72rem;color:var(--text-3,#6b6f7a);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dx-res .rs{float:right;font-size:.64rem;color:var(--accent,#7aa2ff);font-weight:700;font-variant-numeric:tabular-nums}
.dx-navbtn{display:flex;align-items:center;gap:7px;width:100%;margin-bottom:6px;padding:.5rem .7rem;border-radius:var(--r-md,10px);border:1px solid var(--border,#24262e);background:var(--surface-2,#1a1c22);color:var(--text,#e7e8ea);font:inherit;font-size:.82rem;font-weight:600;cursor:pointer;text-align:left}
.dx-navbtn:hover{border-color:var(--accent,#7aa2ff)}
.dx-navbtn.active{border-color:color-mix(in srgb,var(--accent,#7aa2ff) 45%,transparent);background:var(--accent-soft,rgba(122,162,255,.16));color:var(--accent,#7aa2ff)}
.dx-tagbar{display:flex;flex-wrap:wrap;gap:4px;margin:10px 0 6px}
.dx-tag{font-size:.68rem;padding:.16rem .48rem;border-radius:999px;border:1px solid var(--border,#24262e);background:var(--surface-2,#1a1c22);color:var(--text-2,#a4a8b2);cursor:pointer;user-select:none;font-weight:600}
.dx-tag:hover{border-color:var(--accent,#7aa2ff);color:var(--text,#e7e8ea)}
.dx-tag.on{background:var(--accent-soft,rgba(122,162,255,.18));border-color:color-mix(in srgb,var(--accent,#7aa2ff) 45%,transparent);color:var(--accent,#7aa2ff)}
.dx-sec{margin-top:8px}
.dx-sec-h{font-size:.64rem;text-transform:uppercase;letter-spacing:.08em;color:var(--text-3,#6b6f7a);font-weight:700;padding:8px 10px 4px;display:flex;justify-content:space-between;cursor:pointer;user-select:none}
.dx-doc{display:block;padding:.38rem .65rem;margin:1px 0;border-radius:var(--r-sm,7px);color:var(--text-2,#a4a8b2);font-size:.82rem;cursor:pointer;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid transparent}
.dx-doc:hover{background:var(--surface-2,#1a1c22);color:var(--text,#e7e8ea)}
.dx-doc.active{background:var(--accent-soft,rgba(122,162,255,.16));color:var(--accent,#7aa2ff);border-color:color-mix(in srgb,var(--accent,#7aa2ff) 30%,transparent);font-weight:600}
.dx-sec.collapsed .dx-doc{display:none}
.dx-loading{padding:14px 10px;color:var(--text-3,#6b6f7a);font-size:.82rem}
.dx-reader{flex:1;min-width:0;max-width:820px}
.dx-crumb{font-size:.7rem;color:var(--text-3,#6b6f7a);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
/* badges */
.dx-badges{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 18px}
.dx-b{display:inline-flex;align-items:center;gap:5px;font-size:.7rem;font-weight:700;padding:.2rem .55rem;border-radius:999px;border:1px solid var(--border,#24262e);background:var(--surface-2,#1a1c22);color:var(--text-2,#a4a8b2)}
.dx-b i{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dx-b.proj{color:var(--accent,#7aa2ff);border-color:color-mix(in srgb,var(--accent,#7aa2ff) 35%,transparent)}
.dx-b.t{cursor:pointer}.dx-b.t:hover{color:var(--text,#e7e8ea);border-color:var(--accent,#7aa2ff)}
.dx-reader h1{font-size:1.9rem;font-weight:800;letter-spacing:-.025em;margin:.1em 0 .35em;line-height:1.15}
.dx-reader h2{font-size:1.32rem;font-weight:700;margin:1.5em 0 .5em;padding-bottom:.3em;border-bottom:1px solid var(--border,#24262e);letter-spacing:-.01em}
.dx-reader h3{font-size:1.08rem;font-weight:700;margin:1.3em 0 .4em}
.dx-reader h2 .anch,.dx-reader h3 .anch{opacity:0;margin-left:.4em;font-size:.7em;color:var(--text-3,#6b6f7a);text-decoration:none}
.dx-reader h2:hover .anch,.dx-reader h3:hover .anch{opacity:1}
.dx-reader p,.dx-reader li{line-height:1.72;color:var(--text,#e7e8ea);font-size:.95rem}
.dx-reader a{color:var(--accent,#7aa2ff);text-decoration:none}.dx-reader a:hover{text-decoration:underline}
.dx-reader a.wl{border-bottom:1px dotted color-mix(in srgb,var(--accent,#7aa2ff) 55%,transparent)}
.dx-reader a.wl.dead{color:var(--text-3,#6b6f7a);border-bottom-style:dashed;cursor:not-allowed}
.dx-reader code{font-family:var(--mono,ui-monospace,Menlo,monospace);font-size:.85em;background:var(--surface-2,#1a1c22);padding:.12em .4em;border-radius:5px;color:#e7c89a}
.dx-reader pre{background:var(--surface,#131418)!important;border:1px solid var(--border,#24262e);border-radius:var(--r-md,10px);padding:15px 17px;overflow-x:auto;margin:1.1em 0}
.dx-reader pre code{background:none;padding:0;color:inherit;font-size:.83rem;line-height:1.6}
.dx-reader table{border-collapse:collapse;width:100%;margin:1.1em 0;font-size:.88rem}
.dx-reader th,.dx-reader td{border:1px solid var(--border,#24262e);padding:7px 11px;text-align:left}.dx-reader th{background:var(--surface,#131418);font-weight:700}
.dx-reader blockquote{border-left:3px solid var(--accent,#7aa2ff);margin:1.1em 0;padding:.3em 1em;color:var(--text-2,#a4a8b2);background:var(--surface,#131418);border-radius:0 8px 8px 0}
.dx-reader hr{border:none;border-top:1px solid var(--border,#24262e);margin:2em 0}
.dx-welcome{color:var(--text-3,#6b6f7a);padding:60px 10px}.dx-welcome h2{color:var(--text-2,#a4a8b2);font-weight:700;border:none}
/* figures: charts + mermaid */
.dx-fig{margin:1.4em 0;border:1px solid var(--border,#24262e);border-radius:var(--r-md,10px);background:var(--surface,#131418);padding:16px 18px;overflow-x:auto}
.dx-fig .cap{font-size:.82rem;font-weight:700;color:var(--text,#e7e8ea);margin-bottom:2px}
.dx-fig .sub{font-size:.72rem;color:var(--text-3,#6b6f7a);margin-bottom:12px}
.dx-fig .legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;font-size:.72rem;color:var(--text-2,#a4a8b2)}
.dx-fig .legend span{display:inline-flex;align-items:center;gap:6px}
.dx-fig .legend i{width:10px;height:2px;border-radius:1px}
.dx-fig .err{color:var(--crit,#d03b3b);font-size:.78rem;font-family:var(--mono,monospace)}
.dx-fig table{margin:10px 0 0;font-size:.8rem}
.dx-bar-row{display:grid;grid-template-columns:minmax(90px,26%) 1fr auto;gap:10px;align-items:center;margin:5px 0;font-size:.8rem}
.dx-bar-row .lbl{color:var(--text-2,#a4a8b2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dx-bar-row .track{height:12px;border-radius:0 4px 4px 0;background:linear-gradient(90deg,var(--surface-2,#1a1c22),var(--surface-2,#1a1c22));position:relative;overflow:hidden}
.dx-bar-row .fill{height:100%;border-radius:0 4px 4px 0}
.dx-bar-row .val{color:var(--text,#e7e8ea);font-variant-numeric:tabular-nums;font-weight:700;min-width:34px;text-align:right}
.dx-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 22px}
.dx-tile{border:1px solid var(--border,#24262e);border-radius:var(--r-md,10px);background:var(--surface,#131418);padding:14px 16px}
.dx-tile .k{font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3,#6b6f7a);font-weight:700}
.dx-tile .v{font-size:1.75rem;font-weight:800;letter-spacing:-.02em;margin-top:4px;color:var(--text,#e7e8ea)}
.dx-tile .s{font-size:.72rem;color:var(--text-2,#a4a8b2);margin-top:2px;display:flex;align-items:center;gap:5px}
.dx-rel{margin-top:2.4em;border-top:1px solid var(--border,#24262e);padding-top:14px}
.dx-rel h4{font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;color:var(--text-3,#6b6f7a);margin:0 0 8px;font-weight:700}
.dx-rel a{display:block;padding:.3rem 0;font-size:.85rem}
.dx-glegend{display:flex;gap:16px;margin-bottom:10px;font-size:.74rem;color:var(--text-3,#6b6f7a);flex-wrap:wrap}
.dx-glegend span{display:inline-flex;align-items:center;gap:6px}.dx-glegend i{width:10px;height:10px;border-radius:50%}
.dx-gwrap{width:100%;height:calc(100vh - 170px);min-height:420px;border:1px solid var(--border,#24262e);border-radius:var(--r-md,10px);overflow:hidden;background:radial-gradient(circle at 50% 40%,color-mix(in srgb,var(--accent,#7aa2ff) 7%,transparent),transparent 60%)}
/* ---- table of contents rail ---- */
.dx-toc{position:sticky;top:64px;width:200px;flex-shrink:0;max-height:calc(100vh - 96px);overflow-y:auto;font-size:.8rem}
.dx-toc .toc-h{font-size:.62rem;text-transform:uppercase;letter-spacing:.09em;color:var(--text-3,#6b6f7a);font-weight:700;margin-bottom:8px}
.dx-toc a{display:block;padding:.3rem .6rem;border-left:2px solid var(--border,#24262e);color:var(--text-3,#6b6f7a);text-decoration:none;line-height:1.35}
.dx-toc a.toc-h3{padding-left:1.3rem;font-size:.76rem}
.dx-toc a:hover{color:var(--text,#e7e8ea)}
.dx-toc a.on{color:var(--accent,#7aa2ff);border-left-color:var(--accent,#7aa2ff);background:var(--accent-soft,rgba(122,162,255,.10))}
/* wide content scrolls in its own box, never the page */
.dx-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}
.dx-scroll:focus-visible{outline:2px solid var(--accent,#7aa2ff);outline-offset:2px}
.dx-reader img{max-width:100%;height:auto}
.dx-reader pre{-webkit-overflow-scrolling:touch}
.dx-fig .mermaid svg{max-width:100%;height:auto}
/* keyboard users get a visible focus ring everywhere */
.dx a:focus-visible,.dx button:focus-visible,.dx input:focus-visible,.dx .dx-tag:focus-visible{outline:2px solid var(--accent,#7aa2ff);outline-offset:2px;border-radius:6px}
@media(prefers-reduced-motion:reduce){.dx *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
.dx-toggle{display:none}
@media(max-width:1180px){
  .dx-toc{display:none}
}
@media(max-width:760px){
  .dx{flex-direction:column;gap:14px}
  /* comfortable hit targets: 44px is the accessibility floor for touch */
  .dx-doc{padding:.6rem .7rem;font-size:.9rem;min-height:44px;display:flex;align-items:center}
  .dx-tag{padding:.35rem .7rem;font-size:.75rem;min-height:32px;display:inline-flex;align-items:center}
  .dx-navbtn{min-height:44px;font-size:.9rem}
  .dx-res{padding:12px}
  .dx-search input{font-size:16px;padding:.7rem .8rem} /* 16px stops iOS zooming the page on focus */
  .dx-results{max-height:50vh}
  .dx-reader h1{font-size:1.5rem}
  .dx-reader h2{font-size:1.18rem}
  .dx-reader p,.dx-reader li{font-size:1rem}
  /* heading anchors have no hover on touch, so keep them visible */
  .dx-reader h2 .anch,.dx-reader h3 .anch{opacity:.45}
  /* stacked bars: the label needs the full width on a narrow screen */
  .dx-bar-row{grid-template-columns:1fr auto;gap:4px 10px}
  .dx-bar-row .lbl{grid-column:1/-1;white-space:normal}
  .dx-tiles{grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
  .dx-fig{padding:13px 12px}
  .dx-toggle{display:inline-flex;align-items:center;gap:7px;margin-bottom:10px;padding:.5rem .9rem;border-radius:var(--r-md,10px);border:1px solid var(--border,#24262e);background:var(--surface-2,#1a1c22);color:var(--text,#e7e8ea);font:inherit;font-size:.85rem;font-weight:600;cursor:pointer}
  .dx-tree{display:none;position:static;width:100%;max-height:none;border-bottom:1px solid var(--border,#24262e);padding-bottom:10px;margin-bottom:6px}
  .dx.tree-open .dx-tree{display:block}
  .dx-reader{max-width:none}
}
@media print{
  .dx-tree,.dx-toc,.dx-toggle,.dx-badges .dx-b.t{display:none}
  .dx-reader{max-width:none}
  .dx-fig,.dx-reader pre,.dx-scroll{break-inside:avoid}
  .dx-reader a{color:inherit;text-decoration:underline}
}
`;

const DOCS_BODY = `
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<div class="dx">
  <button class="dx-toggle" id="dxToggle">Browse docs</button>
  <aside class="dx-tree">
    <div class="dx-search">
      <input id="dq" type="text" placeholder="Search by meaning...  ( / )" autocomplete="off">
      <div class="dx-results" id="results"></div>
    </div>
    <button class="dx-navbtn" id="dxHome">Overview</button>
    <nav id="tree"><div class="dx-loading">Loading...</div></nav>
  </aside>
  <article class="dx-reader" id="reader"><div class="dx-welcome">Loading...</div></article>
  <aside class="dx-toc" id="toc" hidden></aside>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>
(function(){
  var tree=document.getElementById('tree'),reader=document.getElementById('reader'),q=document.getElementById('dq'),
      results=document.getElementById('results');
  var docs=[],byName={},mermaidReady=null;
  var SECTIONS=[
    ['platform','Platform and architecture'],
    ['auth','Auth and access'],
    ['tooling','Development tooling'],
    ['economy','Economy systems'],
    ['politics','Political systems'],
    ['engine','Turn engine'],
    ['ops','Operations'],
    ['other','Other']
  ];
  function sectionOf(d){
    var tags=d.tags||[];
    for(var i=0;i<tags.length;i++){
      var m=/^docs:(.+)$/.exec(tags[i]);
      if(m&&SECTIONS.some(function(s){return s[0]===m[1];}))return m[1];
    }
    return 'other';
  }
  var S1='#3987e5',S2='#d95926',S3='#199e70';
  var FRESH=[
    {k:'fresh',    label:'Fresh',    max:30,  color:'#0ca30c', mark:'\\u25CF'},
    {k:'aging',    label:'Aging',    max:90,  color:'#fab219', mark:'\\u25D0'},
    {k:'stale',    label:'Stale',    max:180, color:'#ec835a', mark:'\\u25D1'},
    {k:'outdated', label:'Outdated', max:1e9, color:'#d03b3b', mark:'\\u25CB'}
  ];
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];});}
  function days(d){return (Date.now()-new Date(d).getTime())/864e5;}
  function fresh(d){var a=days(d);for(var i=0;i<FRESH.length;i++){if(a<FRESH[i].max)return FRESH[i];}return FRESH[3];}
  function ago(d){var a=Math.floor(days(d));if(a<1)return'today';if(a===1)return'yesterday';if(a<30)return a+' days ago';
    if(a<60)return'a month ago';if(a<365)return Math.round(a/30)+' months ago';return Math.round(a/365)+' years ago';}
  function loadScript(src){return new Promise(function(res,rej){if(document.querySelector('script[data-src="'+src+'"]')){res();return;}
    var s=document.createElement('script');s.setAttribute('data-src',src);s.src=src;s.onload=res;s.onerror=rej;document.head.appendChild(s);});}

  if(window.marked)marked.setOptions({highlight:function(c,l){try{return l&&hljs.getLanguage(l)?hljs.highlight(c,{language:l}).value:hljs.highlightAuto(c).value;}catch(e){return c;}},breaks:false,gfm:true});

  // ---- figures ------------------------------------------------------------
  // Single-series horizontal bars: label + value are always visible, so the
  // light-mode contrast relief rule is satisfied without relying on hue.
  function barChart(spec){
    var rows=spec.data||[],max=0;
    rows.forEach(function(r){if(+r.value>max)max=+r.value;});
    if(!max)max=1;
    var color=spec.color||S1;
    var body=rows.map(function(r){
      var pct=Math.max(1.5,(+r.value/max)*100);
      return '<div class="dx-bar-row"><div class="lbl" title="'+esc(r.label)+'">'+esc(r.label)+'</div>'+
        '<div class="track"><div class="fill" style="width:'+pct+'%;background:'+esc(r.color||color)+'"></div></div>'+
        '<div class="val">'+esc(r.value)+'</div></div>';
    }).join('');
    return fig(spec,body);
  }
  function fig(spec,body){
    return '<div class="dx-fig">'+(spec.title?'<div class="cap">'+esc(spec.title)+'</div>':'')+
      (spec.subtitle?'<div class="sub">'+esc(spec.subtitle)+'</div>':'')+body+'</div>';
  }
  // chart fences: same JSON convention as the changelog diaries, 3-series cap.
  function renderChartFence(json){
    var spec;
    try{spec=JSON.parse(json);}catch(e){return '<div class="dx-fig"><div class="err">chart: invalid JSON - '+esc(e.message)+'</div></div>';}
    if(Array.isArray(spec.series)&&spec.series.length>3)
      return '<div class="dx-fig"><div class="err">chart: '+spec.series.length+' series exceeds the 3-series cap. Split into separate charts or facet.</div></div>';
    if(spec.series&&spec.series.length){
      var palette=[S1,S2,S3];
      var rows=[],legend='';
      spec.series.forEach(function(s,i){
        (s.data||[]).forEach(function(p){rows.push({label:s.name+' - '+p.label,value:p.value,color:palette[i]});});
      });
      legend='<div class="legend">'+spec.series.map(function(s,i){
        return '<span><i style="background:'+palette[i]+'"></i>'+esc(s.name)+'</span>';}).join('')+'</div>';
      return fig(spec,rows.map(function(r){
        var max=Math.max.apply(null,rows.map(function(x){return +x.value;}))||1;
        return '<div class="dx-bar-row"><div class="lbl">'+esc(r.label)+'</div><div class="track"><div class="fill" style="width:'+
          Math.max(1.5,(+r.value/max)*100)+'%;background:'+r.color+'"></div></div><div class="val">'+esc(r.value)+'</div></div>';
      }).join('')+legend);
    }
    return barChart(spec);
  }

  function renderMarkdown(md,ctx){
    // wikilinks resolve against the doc index before markdown runs
    md=String(md||'').replace(/\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]/g,function(_,tgt,alias){
      var key=tgt.trim(),label=(alias||tgt).trim();
      var hit=byName[key]||byName[key.replace(/\\s+/g,'-').toLowerCase()];
      if(hit)return '<a class="wl" href="#'+esc(hit.name)+'" data-doc="'+esc(hit.name)+'">'+esc(label)+'</a>';
      return '<a class="wl dead" title="No doc named '+esc(key)+'">'+esc(label)+'</a>';
    });
    var figs=[];
    md=md.replace(/\`\`\`(chart|mermaid)\\n([\\s\\S]*?)\`\`\`/g,function(_,kind,payload){
      var i=figs.length;
      figs.push(kind==='chart'?renderChartFence(payload):'<div class="dx-fig"><pre class="mermaid">'+esc(payload)+'</pre></div>');
      return '\\n\\nFIGPLACEHOLDER'+i+'\\n\\n';
    });
    var html=window.marked?marked.parse(md):esc(md);
    html=html.replace(/<p>FIGPLACEHOLDER(\\d+)<\\/p>/g,function(_,i){return figs[+i]||'';});
    html=html.replace(/FIGPLACEHOLDER(\\d+)/g,function(_,i){return figs[+i]||'';});
    return html;
  }
  function enhance(root){
    root.querySelectorAll('h2,h3').forEach(function(h){
      var id=(h.textContent||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      if(!id)return; h.id=id;
      var a=document.createElement('a');a.className='anch';a.href='#'+encodeURIComponent(location.hash.slice(1).split('::')[0])+'::'+id;a.textContent='#';h.appendChild(a);
    });
    root.querySelectorAll('a[data-doc]').forEach(function(a){a.onclick=function(e){e.preventDefault();open(a.getAttribute('data-doc'));};});
    // Wide content scrolls inside its own box. Without this a single long
    // table gives the whole page a horizontal scrollbar on a phone.
    root.querySelectorAll('table').forEach(function(t){
      if(t.parentNode&&t.parentNode.classList.contains('dx-scroll'))return;
      var w=document.createElement('div');w.className='dx-scroll';w.setAttribute('tabindex','0');
      w.setAttribute('role','region');w.setAttribute('aria-label','Table, scrolls horizontally');
      t.parentNode.insertBefore(w,t);w.appendChild(t);});
    root.querySelectorAll('img').forEach(function(i){i.loading='lazy';i.decoding='async';});
    buildToc(root);
    if(root.querySelector('pre.mermaid')){
      if(!mermaidReady)mermaidReady=loadScript('https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js')
        .then(function(){mermaid.initialize({startOnLoad:false,theme:'dark',themeVariables:{fontFamily:'system-ui,-apple-system,Segoe UI,sans-serif',primaryColor:'#1a1c22',primaryTextColor:'#e7e8ea',lineColor:'#898781'}});});
      mermaidReady.then(function(){try{mermaid.run({nodes:root.querySelectorAll('pre.mermaid')});}catch(e){}}).catch(function(){});
    }
  }

  function buildToc(root){
    var el=document.getElementById('toc');if(!el)return;
    var hs=[].slice.call(root.querySelectorAll('h2[id],h3[id]'));
    if(hs.length<3){el.hidden=true;el.innerHTML='';return;}
    el.hidden=false;
    el.innerHTML='<div class="toc-h">On this page</div><nav>'+hs.map(function(h){
      return '<a href="#'+h.id+'" data-h="'+h.id+'" class="toc-'+h.tagName.toLowerCase()+'">'+esc(h.textContent.replace(/#$/,''))+'</a>';
    }).join('')+'</nav>';
    el.querySelectorAll('a[data-h]').forEach(function(a){a.onclick=function(e){
      e.preventDefault();var t=document.getElementById(a.getAttribute('data-h'));
      if(t)t.scrollIntoView({behavior:reduceMotion()?'auto':'smooth',block:'start'});};});
    if(window._tocObs)window._tocObs.disconnect();
    if('IntersectionObserver' in window){
      window._tocObs=new IntersectionObserver(function(entries){
        entries.forEach(function(en){ if(!en.isIntersecting)return;
          el.querySelectorAll('a[data-h]').forEach(function(a){a.classList.toggle('on',a.getAttribute('data-h')===en.target.id);});});
      },{rootMargin:'-72px 0px -70% 0px'});
      hs.forEach(function(h){window._tocObs.observe(h);});
    }
  }
  function reduceMotion(){return window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;}

  // ---- views --------------------------------------------------------------
  function grouped(){
    var groups={};docs.forEach(function(d){var s=sectionOf(d);(groups[s]=groups[s]||[]).push(d);});
    Object.keys(groups).forEach(function(k){groups[k].sort(function(a,b){return String(a.title).localeCompare(String(b.title));});});
    return groups;
  }
  function showHome(){
    hideToc();setNav('home');history.replaceState(null,'','#overview');
    var groups=grouped();
    var note='<p style="color:var(--text-2,#a4a8b2);max-width:64ch">This documentation covers the A House Divided platform. '+
      'Running the platform requires the proprietary Lakeside Ops auth system (game-cookie SSO via ops.lakesidegames.net), '+
      'and development is conducted with a proprietary MCP tool fleet. Both may be opened publicly later.</p>';
    var body=SECTIONS.map(function(s){
      var list=groups[s[0]]||[];
      if(s[0]==='other'&&!list.length)return '';
      var items=list.length?list.map(function(d){
        return '<a href="#'+esc(d.name)+'" data-doc="'+esc(d.name)+'" style="display:block;padding:.3rem 0;font-size:.9rem">'+esc(d.title)+'</a>';
      }).join(''):'<p style="color:var(--text-3,#6b6f7a);font-size:.85rem">No docs in this section yet.</p>';
      return '<h2>'+esc(s[1])+'</h2>'+items;
    }).join('');
    reader.innerHTML='<div class="dx-crumb">Overview</div><h1>A House Divided - Technical Docs</h1>'+note+body;
    reader.querySelectorAll('a[data-doc]').forEach(function(a){a.onclick=function(e){e.preventDefault();open(a.getAttribute('data-doc'));};});
  }
  function hideToc(){var el=document.getElementById('toc');if(el){el.hidden=true;el.innerHTML='';}}
  function setNav(which){
    document.getElementById('dxHome').classList.toggle('active',which==='home');
    if(which!=='doc')tree.querySelectorAll('.dx-doc').forEach(function(a){a.classList.remove('active');});
  }

  function renderTree(){
    if(!docs.length){tree.innerHTML='<div class="dx-loading">No docs published yet.</div>';return;}
    var groups=grouped();
    tree.innerHTML=SECTIONS.map(function(s){
      var list=groups[s[0]]||[];
      if(!list.length)return '';
      var items=list.map(function(d){
        var fr=fresh(d.updatedAt);
        return '<a class="dx-doc" data-name="'+esc(d.name)+'" href="#'+esc(d.name)+'" title="'+esc(d.title)+' - updated '+ago(d.updatedAt)+'"><span style="color:'+fr.color+'">'+fr.mark+'</span> '+esc(d.title)+'</a>';
      }).join('');
      return '<div class="dx-sec"><div class="dx-sec-h">'+esc(s[1])+'<span>'+list.length+'</span></div>'+items+'</div>';
    }).join('');
    tree.querySelectorAll('.dx-sec-h').forEach(function(h){h.onclick=function(){h.parentNode.classList.toggle('collapsed');};});
    tree.querySelectorAll('.dx-doc').forEach(function(a){a.onclick=function(e){e.preventDefault();open(a.getAttribute('data-name'));};});
  }

  function open(name){
    var anchor=null,parts=String(name).split('::');
    if(parts.length>1){name=parts[0];anchor=parts[1];}
    history.replaceState(null,'','#'+name+(anchor?'::'+anchor:''));
    setNav('doc');
    tree.querySelectorAll('.dx-doc').forEach(function(a){a.classList.toggle('active',a.getAttribute('data-name')===name);});
    var act=tree.querySelector('.dx-doc.active'); if(act){var s=act.closest('.dx-sec'); if(s)s.classList.remove('collapsed');}
    var dx=document.querySelector('.dx'); if(dx)dx.classList.remove('tree-open');
    reader.innerHTML='<div class="dx-welcome">Loading...</div>';
    fetch('/api/doc?name='+encodeURIComponent(name)).then(function(r){return r.json();}).then(function(d){
      if(d.error){reader.innerHTML='<div class="dx-welcome">Not found.</div>';return;}
      var fr=fresh(d.updatedAt);
      var badges='<div class="dx-badges">'+
        '<span class="dx-b proj">'+esc(d.project)+'</span>'+
        '<span class="dx-b" title="Last updated '+esc(new Date(d.updatedAt).toISOString().slice(0,10))+'"><i style="background:'+fr.color+'"></i>'+fr.label+' \\u00b7 updated '+esc(ago(d.updatedAt))+'</span>'+
        (d.version?'<span class="dx-b">v'+esc(d.version)+'</span>':'')+
        (d.hits?'<span class="dx-b">'+esc(d.hits)+' reads</span>':'')+
        d.tags.map(function(t){return '<span class="dx-b t" data-t="'+esc(t)+'">'+esc(t)+'</span>';}).join('')+
      '</div>';
      var rel=(d.related&&d.related.length)?'<div class="dx-rel"><h4>Related</h4>'+d.related.map(function(r){
        return '<a href="#'+esc(r.name)+'" data-doc="'+esc(r.name)+'">'+esc(r.title)+' <span style="color:var(--text-3,#6b6f7a);font-size:.75rem">'+r.project+'</span></a>';}).join('')+'</div>':'';
      reader.innerHTML='<div class="dx-crumb">'+esc(d.project)+(d.section?' / '+esc(d.section):'')+'</div>'+badges+renderMarkdown(d.body,d)+rel;
      enhance(reader);
      if(anchor){var t=document.getElementById(anchor);if(t){t.scrollIntoView();return;}}
      window.scrollTo(0,0);
    });
    closeResults();
  }

  var t=null,sel=-1,cur=[];
  q.addEventListener('input',function(){clearTimeout(t);var v=q.value.trim();if(!v){closeResults();return;}t=setTimeout(function(){search(v);},200);});
  function search(v){fetch('/api/search?q='+encodeURIComponent(v)).then(function(r){return r.json();}).then(function(d){
    cur=d.results||[];sel=-1;
    if(!cur.length){results.innerHTML='<div class="dx-res"><div class="rd">No matches.</div></div>';results.classList.add('on');return;}
    results.innerHTML=cur.map(function(r,i){
      var fr=fresh(r.updatedAt);
      return '<div class="dx-res" data-i="'+i+'"><span class="rs">'+Math.min(100,Math.round((r.score||0)*100))+'%</span>'+
        '<div class="rt"><span style="color:'+fr.color+'">'+fr.mark+'</span> '+esc(r.title)+'</div>'+
        '<div class="rd">'+esc(r.project)+(r.tags.length?' \\u00b7 '+esc(r.tags.join(', ')):'')+'</div></div>';}).join('');
    results.classList.add('on');
    results.querySelectorAll('.dx-res').forEach(function(el){el.onclick=function(){var i=el.getAttribute('data-i');if(cur[i])open(cur[i].name);};});
  });}
  function closeResults(){results.classList.remove('on');sel=-1;}
  q.addEventListener('keydown',function(e){
    if(e.key==='ArrowDown'){e.preventDefault();sel=Math.min(sel+1,cur.length-1);paintSel();}
    else if(e.key==='ArrowUp'){e.preventDefault();sel=Math.max(sel-1,0);paintSel();}
    else if(e.key==='Enter'&&sel>=0&&cur[sel]){open(cur[sel].name);}
    else if(e.key==='Escape'){closeResults();q.blur();}
  });
  function paintSel(){results.querySelectorAll('.dx-res').forEach(function(el,i){el.classList.toggle('sel',i===sel);if(i===sel)el.scrollIntoView({block:'nearest'});});}
  document.addEventListener('keydown',function(e){if(e.key==='/'&&document.activeElement!==q&&!/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)){e.preventDefault();q.focus();}});
  document.addEventListener('click',function(e){if(!e.target.closest('.dx-search'))closeResults();});
  window.addEventListener('hashchange',function(){var h=decodeURIComponent(location.hash.slice(1));var base=h.split('::')[0];
    if(h==='overview')showHome();else if(base&&byName[base])open(h);});
  document.getElementById('dxHome').onclick=showHome;
  var dxToggle=document.getElementById('dxToggle');
  if(dxToggle)dxToggle.onclick=function(){document.querySelector('.dx').classList.toggle('tree-open');};

  fetch('/api/tree').then(function(r){return r.json();}).then(function(res){
    docs=res.docs||[];byName={};docs.forEach(function(x){byName[x.name]=x;});
    renderTree();
    var h=decodeURIComponent(location.hash.slice(1)),base=h.split('::')[0];
    if(base&&byName[base])open(h);else showHome();
  }).catch(function(){tree.innerHTML='<div class="dx-loading">Failed to load.</div>';reader.innerHTML='<div class="dx-welcome">Failed to load.</div>';});
})();
</script>
`;

main().catch((e) => { console.error("[docs] fatal:", e); process.exit(1); });
