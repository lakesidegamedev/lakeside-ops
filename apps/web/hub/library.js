"use strict";

// hub/library.js: the Library view. One catalogue of everything the studio
// has written down: published analyses and audits, older built-in report
// pages, and knowledge base docs.
//
// Report metadata comes from two files next to the published reports:
//   manifest.json  written by the report-publishing MCP (raw title, category)
//   library.json   curated overlay: plain title, canonical category, type and
//                  labels. Kept separate so a republish never wipes curation.
// Reports with no curated entry still appear, filed by a keyword fallback.

const fs = require("fs");
const path = require("path");
const { icon } = require("../ui-kit");
const { esc } = require("./shell");

const CATEGORIES = [
  { id: "economy", label: "Economy & Markets", color: "#34d399", icon: "coins", blurb: "Markets, corporations, sectors, macro and the money chain." },
  { id: "elections", label: "Elections & Politics", color: "#fb7185", icon: "vote", blurb: "Election models, recaps, forecasts and political balance." },
  { id: "worldsims", label: "World Simulations", color: "#38bdf8", icon: "globe", blurb: "Sandbox world runs, grand sims and their audits." },
  { id: "world", label: "World & Eras", color: "#a78bfa", icon: "map", blurb: "Seeds, eras, country tiers and live-world audits." },
  { id: "design", label: "Game Design", color: "#fbbf24", icon: "wand", blurb: "Proposals, reworks and interface reviews." },
  { id: "engine", label: "Engine & Infrastructure", color: "#22d3ee", icon: "cpu", blurb: "Turn performance, architecture, hosting and integrity." },
  { id: "players", label: "Players & Community", color: "#fb923c", icon: "message-circle", blurb: "Surveys, complaints, sentiment and moderation." },
  { id: "tickets", label: "Tickets", color: "#f472b6", icon: "life-buoy", blurb: "Support analyses and ticket performance." },
  { id: "keir", label: "Keir & Agents", color: "#818cf8", icon: "bot", blurb: "Keir audits, benchmarks and agent operations." },
  { id: "studio", label: "Studio & Strategy", color: "#e879f9", icon: "briefcase", blurb: "Launches, research program, brand and market." },
  { id: "guides", label: "Guides", color: "#a3e635", icon: "graduation-cap", blurb: "How-tos and reference for the team and community." },
  { id: "kb", label: "Knowledge Base", color: "#cbd5e1", icon: "book-open", blurb: "Runbooks, design docs and decisions agents keep current." },
];
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

// Fallback filing for reports published after curation, from their raw
// category and title. First match wins.
const FALLBACK = [
  [/ticket|support/i, "tickets"],
  [/keir|agent|bench/i, "keir"],
  [/worldsim|world sim|simulation|grand sim/i, "worldsims"],
  [/election|vote|senate|house|presiden|parliament|party|parties|politic/i, "elections"],
  [/econom|market|commodit|corp|sector|bank|fiscal|tax|trade|price|bond/i, "economy"],
  [/seed|era|1953|1991|2019|country|world/i, "world"],
  [/turn|engine|perf|architect|infra|hosting|security|rust/i, "engine"],
  [/communit|player|survey|moderat|discord|sentiment/i, "players"],
  [/design|rework|proposal|ux|redesign|preview/i, "design"],
  [/guide|how to|setup/i, "guides"],
];
function fallbackCategory(m) {
  const hay = `${m.category || ""} ${m.title || ""} ${m.slug || ""}`;
  for (const [re, id] of FALLBACK) if (re.test(hay)) return id;
  return "studio";
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function cleanText(s) {
  // Raw manifest titles sometimes carry run-on chart labels or entities.
  return String(s || "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

let cache = { key: "", items: null };

// All report items (published + legacy), newest first. Cached on file mtimes.
function loadReports({ publishedDir, legacyDir }) {
  const mf = path.join(publishedDir, "manifest.json");
  const lf = path.join(publishedDir, "library.json");
  let key = "";
  try { key = `${fs.statSync(mf).mtimeMs}:${fs.existsSync(lf) ? fs.statSync(lf).mtimeMs : 0}`; } catch { key = String(Date.now()); }
  if (cache.key === key && cache.items) return cache.items;
  const manifest = readJson(mf, []);
  const curated = (readJson(lf, {}).items) || {};
  const items = [];
  for (const m of Array.isArray(manifest) ? manifest : []) {
    if (!m || !m.slug || m.category === "Daily Reports") continue;
    const c = curated[m.slug] || {};
    if (c.hidden) continue;
    if (!fs.existsSync(path.join(publishedDir, `${m.slug}.html`))) continue;
    const category = CAT[c.category] ? c.category : fallbackCategory(m);
    items.push({
      id: m.slug, kind: "report", href: `/reports/${m.slug}`,
      title: c.title || cleanText(m.title) || m.slug,
      original: cleanText(m.title),
      summary: cleanText(m.summary).slice(0, 400),
      category, type: c.type || "Report", labels: c.labels || [],
      date: m.updatedAt || m.publishedAt || "", published: m.publishedAt || "",
      author: m.author || "", public: m.public === true, curated: !!c.title,
    });
  }
  for (const [k, c] of Object.entries(curated)) {
    if (!k.startsWith("legacy:") || c.hidden) continue;
    const slug = k.slice(7);
    const file = path.join(legacyDir, `${slug}.html`);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (items.some((x) => x.id === slug)) continue;
    items.push({
      id: slug, kind: "report", href: `/reports/${slug}`, legacy: true,
      title: c.title, original: "", summary: "", category: CAT[c.category] ? c.category : "studio",
      type: c.type || "Report", labels: c.labels || [], date: st.mtime.toISOString(), published: st.mtime.toISOString(),
      author: "", public: false, curated: true,
    });
  }
  items.sort((a, b) => String(b.published).localeCompare(String(a.published)));
  cache = { key, items };
  return items;
}

function findReport(slug, dirs) {
  return loadReports(dirs).find((x) => x.id === slug) || null;
}

// Many docs carry only a slug name; make those readable.
function docTitle(d) {
  const t = cleanText(d.title);
  if (t && t !== d.name) return t;
  const words = String(d.name || "").split("-").filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ") || "Untitled doc";
}

let docCache = { at: 0, v: null };
async function loadDocs(getDb, knowledgeStore) {
  if (docCache.v && Date.now() - docCache.at < 60_000) return docCache.v;
  try {
    const db = await getDb();
    const docs = [];
    for (let offset = 0; offset < 20000; offset += 1000) {
      const page = await knowledgeStore.list(db, "docs", { limit: 1000, offset, order: "name" });
      docs.push(...page);
      if (page.length < 1000) break;
    }
    const out = docs.map((d) => ({
      id: d.name, kind: "doc", href: `/library/doc/${encodeURIComponent(d.name)}`,
      title: docTitle(d), summary: cleanText(d.description).slice(0, 300),
      category: "kb", type: "Doc", labels: (d.tags || []).slice(0, 6).map(String),
      project: d.project || "", date: d.updatedAt ? new Date(d.updatedAt).toISOString() : "", public: false,
    }));
    docCache = { at: Date.now(), v: out };
    return out;
  } catch { return docCache.v || []; }
}

// Monthly publishing counts for the hero chart (last 8 months).
function monthly(items) {
  const now = new Date();
  const months = [];
  for (let k = 7; k >= 0; k--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    months.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }), n: 0 });
  }
  for (const it of items) {
    const m = months.find((x) => x.key === String(it.published || it.date).slice(0, 7));
    if (m) m.n++;
  }
  return months;
}

const LIB_CSS = `
.lib{max-width:1480px;margin:0 auto;padding:28px 24px 64px}
.lib-hero{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:22px;align-items:stretch;margin-bottom:22px}
.lib-hero-main{position:relative;overflow:hidden;padding:26px 28px;border:1px solid var(--border);border-radius:20px;background:radial-gradient(120% 140% at 0% 0%,color-mix(in srgb,var(--accent) 14%,transparent),transparent 55%),radial-gradient(90% 120% at 100% 100%,color-mix(in srgb,var(--accent-2) 12%,transparent),transparent 60%),var(--surface);box-shadow:var(--e2),var(--hi)}
.lib-eyebrow{font:700 .68rem var(--font);letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
.lib-hero h1{margin:6px 0 8px;font-size:clamp(1.8rem,3.4vw,2.6rem);line-height:1.05;letter-spacing:-.035em;font-weight:800}
.lib-hero p{margin:0;color:var(--text-2);max-width:560px;font-size:.95rem}
.lib-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:22px}
.lib-kpi{padding:12px 14px;border:1px solid var(--border);border-radius:14px;background:color-mix(in srgb,var(--bg-0) 45%,transparent)}
.lib-kpi b{display:block;font-size:1.5rem;font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.lib-kpi span{font:700 .64rem var(--font);letter-spacing:.09em;text-transform:uppercase;color:var(--text-3)}
.lib-chart{padding:20px 22px;border:1px solid var(--border);border-radius:20px;background:var(--surface);box-shadow:var(--e2),var(--hi);display:flex;flex-direction:column}
.lib-chart h3{margin:0;font-size:.8rem;color:var(--text-2);font-weight:700;display:flex;justify-content:space-between}
.lib-chart h3 span{color:var(--text-3);font-weight:600}
.lib-bars{flex:1;display:flex;align-items:flex-end;gap:8px;min-height:120px;margin-top:14px}
.lib-bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end}
.lib-bar i{display:block;width:100%;border-radius:7px 7px 3px 3px;background:linear-gradient(180deg,var(--accent),color-mix(in srgb,var(--accent) 35%,transparent));min-height:3px;position:relative}
.lib-bar i::after{content:attr(data-n);position:absolute;top:-17px;left:0;right:0;text-align:center;font:700 .66rem var(--font);color:var(--text-2)}
.lib-bar.now i{background:linear-gradient(180deg,var(--accent-2),color-mix(in srgb,var(--accent-2) 35%,transparent))}
.lib-bar em{font:600 .66rem var(--font);font-style:normal;color:var(--text-3)}
.lib-mix{display:flex;height:8px;border-radius:999px;overflow:hidden;margin-top:16px;background:var(--glass-2)}
.lib-mix i{display:block;height:100%}
.lib-cats{display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:10px;margin-bottom:22px}
.lib-cat{position:relative;display:flex;flex-direction:column;gap:6px;padding:14px 14px 13px;border:1px solid var(--border);border-radius:15px;background:var(--surface);cursor:pointer;text-align:left;color:var(--text);transition:transform var(--t),border-color var(--t),box-shadow var(--t);overflow:hidden}
.lib-cat::before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--c)}
.lib-cat:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--c) 45%,var(--border));box-shadow:0 14px 30px -18px var(--c)}
.lib-cat.on{border-color:var(--c);background:color-mix(in srgb,var(--c) 9%,var(--surface))}
.lib-cat-top{display:flex;align-items:center;gap:9px}
.lib-cat-ic{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;color:var(--c);background:color-mix(in srgb,var(--c) 14%,transparent)}
.lib-cat b{font-size:.86rem;font-weight:700}
.lib-cat .n{margin-left:auto;font:800 1.05rem var(--font);font-variant-numeric:tabular-nums}
.lib-cat p{margin:0;font-size:.74rem;color:var(--text-3);line-height:1.4}
.lib-tools{position:sticky;top:var(--hub-h);z-index:50;display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:12px 0;margin-bottom:6px;background:linear-gradient(var(--bg-0) 75%,transparent)}
.lib-q{flex:1;min-width:240px;display:flex;align-items:center;gap:9px;height:42px;padding:0 14px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--text-3)}
.lib-q:focus-within{border-color:var(--accent);box-shadow:var(--ring)}
.lib-q input{flex:1;border:0;outline:0;background:none;color:var(--text);font:500 .92rem var(--font)}
.lib-seg{display:flex;padding:3px;border:1px solid var(--border);border-radius:11px;background:var(--surface)}
.lib-seg button{height:34px;padding:0 12px;border:0;border-radius:8px;background:none;color:var(--text-2);font:600 .8rem var(--font);cursor:pointer}
.lib-seg button.on{background:var(--surface-3);color:var(--text)}
.lib-sel{height:42px;padding:0 12px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--text);font:600 .82rem var(--font)}
.lib-chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 16px}
.lib-chip{height:28px;padding:0 11px;border:1px solid var(--border);border-radius:999px;background:var(--glass-1);color:var(--text-2);font:600 .75rem var(--font);cursor:pointer}
.lib-chip:hover{color:var(--text);border-color:var(--border-2)}
.lib-chip.on{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 55%,transparent);color:var(--text)}
.lib-chip .c{color:var(--text-3);margin-left:4px;font-variant-numeric:tabular-nums}
.lib-sum{display:flex;align-items:center;justify-content:space-between;margin:0 0 12px;color:var(--text-3);font-size:.8rem}
.lib-sum button{border:0;background:none;color:var(--accent);font:600 .8rem var(--font);cursor:pointer}
.lib-section{margin:26px 0 12px;display:flex;align-items:center;gap:10px}
.lib-section h2{margin:0;font-size:1rem;font-weight:800;letter-spacing:-.02em}
.lib-section .dot{width:10px;height:10px;border-radius:3px;background:var(--c)}
.lib-section .c{color:var(--text-3);font-size:.8rem;font-weight:600}
.lib-section .ln{flex:1;height:1px;background:var(--border)}
.lib-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.lib-card{position:relative;display:flex;flex-direction:column;gap:9px;min-height:172px;padding:16px 16px 14px;border:1px solid var(--border);border-radius:16px;background:var(--surface);box-shadow:var(--e1),var(--hi);transition:transform var(--t),border-color var(--t),box-shadow var(--t);overflow:hidden}
.lib-card::before{content:"";position:absolute;left:0;top:0;right:0;height:2px;background:linear-gradient(90deg,var(--c),transparent 80%);opacity:.9}
.lib-card:hover{transform:translateY(-3px);border-color:color-mix(in srgb,var(--c) 45%,var(--border));box-shadow:0 20px 40px -24px var(--c),var(--hi)}
.lib-card-top{display:flex;align-items:center;gap:7px;font:700 .64rem var(--font);letter-spacing:.08em;text-transform:uppercase;color:var(--c)}
.lib-type{margin-left:auto;padding:2px 8px;border-radius:999px;border:1px solid var(--border);color:var(--text-2);letter-spacing:.04em}
.lib-card h3{margin:0;font-size:1rem;line-height:1.3;font-weight:700;letter-spacing:-.02em;color:var(--text)}
.lib-card p{margin:0;font-size:.8rem;line-height:1.5;color:var(--text-2);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.lib-card-foot{margin-top:auto;display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:.7rem;color:var(--text-3)}
.lib-lab{padding:1px 7px;border-radius:6px;background:var(--glass-2);color:var(--text-2);font-weight:600}
.lib-pub{padding:1px 7px;border-radius:6px;background:color-mix(in srgb,var(--green) 16%,transparent);color:var(--green);font-weight:700}
.lib-date{margin-left:auto;font-variant-numeric:tabular-nums}
.lib-orig{font-size:.7rem;color:var(--text-3);font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lib-list{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:16px;overflow:hidden;background:var(--surface)}
.lib-row{display:grid;grid-template-columns:10px minmax(0,1fr) 150px 92px 96px;gap:14px;align-items:center;padding:11px 16px;border-top:1px solid var(--border);font-size:.82rem}
.lib-row:first-child{border-top:0}
.lib-row:hover{background:var(--glass-2)}
.lib-row .k{width:10px;height:10px;border-radius:3px;background:var(--c)}
.lib-row b{font-weight:650;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lib-row span{color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lib-empty{padding:60px 20px;text-align:center;color:var(--text-3)}
.lib-live{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-bottom:8px}
.lib-live a{display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid var(--border);border-radius:13px;background:var(--surface);font-weight:650;font-size:.84rem}
.lib-live a:hover{border-color:var(--border-2)}
.lib-pulse{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 var(--green);animation:libp 2s infinite}
@keyframes libp{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--green) 60%,transparent)}70%{box-shadow:0 0 0 8px transparent}100%{box-shadow:0 0 0 0 transparent}}
@media(max-width:1100px){.lib-hero{grid-template-columns:1fr}.lib-row{grid-template-columns:10px minmax(0,1fr) 92px}.lib-row .h1,.lib-row .h2{display:none}}
@media(max-width:600px){.lib{padding:18px 14px 40px}.lib-kpis{grid-template-columns:repeat(2,1fr)}.lib-grid{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.lib-card,.lib-cat{transition:none}.lib-pulse{animation:none}}
`;

function jsonForScript(v) {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function makeLibraryBody({ reports, docs }) {
  const all = reports.concat(docs);
  const months = monthly(reports);
  const max = Math.max(1, ...months.map((m) => m.n));
  const thisMonth = months[months.length - 1].n;
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
  for (const it of all) counts[it.category] = (counts[it.category] || 0) + 1;
  const mixTotal = reports.length || 1;
  const mix = CATEGORIES.filter((c) => c.id !== "kb").map((c) =>
    `<i style="width:${((counts[c.id] || 0) / mixTotal) * 100}%;background:${c.color}" title="${esc(c.label)}: ${counts[c.id] || 0}"></i>`).join("");
  const bars = months.map((m, i) => `<div class="lib-bar${i === months.length - 1 ? " now" : ""}"><i data-n="${m.n}" style="height:${Math.max(3, (m.n / max) * 100)}%"></i><em>${m.label}</em></div>`).join("");
  const cats = CATEGORIES.filter((c) => counts[c.id]).map((c) =>
    `<button class="lib-cat" type="button" data-cat="${c.id}" style="--c:${c.color}"><div class="lib-cat-top"><span class="lib-cat-ic">${icon(c.icon, { size: 16 })}</span><b>${esc(c.label)}</b><span class="n">${counts[c.id]}</span></div><p>${esc(c.blurb)}</p></button>`).join("");
  const live = reports.filter((r) => r.type === "Tracker").slice(0, 8).map((r) =>
    `<a href="${esc(r.href)}" style="--c:${CAT[r.category].color}"><span class="lib-pulse"></span>${esc(r.title)}</a>`).join("");
  const body = `<div class="lib">
<section class="lib-hero">
  <div class="lib-hero-main"><div class="lib-eyebrow">Library</div><h1>Everything we have learned,<br>in one place.</h1>
  <p>Analyses, audits, postmortems, sims and the knowledge base agents keep current. Admin only. Press <b>/</b> to search anything.</p>
  <div class="lib-kpis"><div class="lib-kpi"><b>${reports.length}</b><span>Reports</span></div><div class="lib-kpi"><b>${docs.length}</b><span>Docs</span></div><div class="lib-kpi"><b>${CATEGORIES.filter((c) => counts[c.id]).length}</b><span>Categories</span></div><div class="lib-kpi"><b>${thisMonth}</b><span>This month</span></div></div></div>
  <div class="lib-chart"><h3>Reports published <span>last 8 months</span></h3><div class="lib-bars">${bars}</div><div class="lib-mix">${mix}</div></div>
</section>
${live ? `<div class="lib-section" style="--c:var(--green)"><span class="dot"></span><h2>Live trackers</h2><span class="ln"></span></div><div class="lib-live">${live}</div>` : ""}
<div class="lib-section" style="--c:var(--accent)"><span class="dot"></span><h2>Browse by category</h2><span class="ln"></span></div>
<div class="lib-cats" id="libCats">${cats}</div>
<div class="lib-tools"><label class="lib-q">${icon("search", { size: 16 })}<input id="libQ" type="search" placeholder="Filter by title, summary, label or original title" autocomplete="off"></label>
<div class="lib-seg" id="libKind"><button class="on" data-k="all">All</button><button data-k="report">Reports</button><button data-k="doc">Docs</button></div>
<select class="lib-sel" id="libSort" aria-label="Sort"><option value="new">Newest first</option><option value="old">Oldest first</option><option value="az">A to Z</option></select>
<div class="lib-seg" id="libView"><button class="on" data-v="grid" aria-label="Grid">${icon("layers", { size: 15 })}</button><button data-v="list" aria-label="List">${icon("menu", { size: 15 })}</button></div></div>
<div class="lib-chips" id="libTypes"></div>
<div class="lib-sum" id="libSum"></div>
<div id="libOut"></div>
</div>
<script type="application/json" id="libData">${jsonForScript({ items: all, cats: CATEGORIES })}</script>
<script>${LIB_JS}</script>`;
  return { extraCss: LIB_CSS, body };
}

const LIB_JS = `(function(){
var D=JSON.parse(document.getElementById('libData').textContent),items=D.items,CAT={};D.cats.forEach(function(c){CAT[c.id]=c});
var st={q:'',cat:'',kind:'all',type:'',label:'',sort:'new',view:localStorage.getItem('lib-view')||'grid'};
try{var h=new URLSearchParams(location.hash.slice(1));['q','cat','kind','type','label','sort'].forEach(function(k){if(h.get(k))st[k]=h.get(k)})}catch(e){}
var $=function(id){return document.getElementById(id)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function fmt(d){if(!d)return'';var x=new Date(d);return isNaN(x)?'':x.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
function match(it){if(st.cat&&it.category!==st.cat)return false;if(st.kind!=='all'&&it.kind!==st.kind)return false;if(st.type&&it.type!==st.type)return false;if(st.label&&(it.labels||[]).indexOf(st.label)<0)return false;
if(st.q){var q=st.q.toLowerCase().split(/\\s+/);var hay=(it.title+' '+(it.summary||'')+' '+(it.original||'')+' '+(it.labels||[]).join(' ')+' '+it.type+' '+(CAT[it.category]||{}).label+' '+(it.project||'')).toLowerCase();for(var i=0;i<q.length;i++)if(hay.indexOf(q[i])<0)return false}return true}
function sorted(a){var s=a.slice();if(st.sort==='az')s.sort(function(x,y){return x.title.localeCompare(y.title)});else if(st.sort==='old')s.sort(function(x,y){return String(x.date).localeCompare(String(y.date))});else s.sort(function(x,y){return String(y.date).localeCompare(String(x.date))});return s}
function card(it){var c=CAT[it.category]||{color:'#999',label:''};var labs=(it.labels||[]).slice(0,3).map(function(l){return'<span class="lib-lab">'+esc(l)+'</span>'}).join('');
return'<a class="lib-card" href="'+esc(it.href)+'" style="--c:'+c.color+'"><div class="lib-card-top">'+esc(c.label)+'<span class="lib-type">'+esc(it.type)+'</span></div><h3>'+esc(it.title)+'</h3>'+(it.summary?'<p>'+esc(it.summary)+'</p>':'')+(it.original&&it.original!==it.title?'<div class="lib-orig" title="'+esc(it.original)+'">Originally: '+esc(it.original)+'</div>':'')+'<div class="lib-card-foot">'+labs+(it.public?'<span class="lib-pub">Shared link</span>':'')+'<span class="lib-date">'+fmt(it.date)+'</span></div></a>'}
function row(it){var c=CAT[it.category]||{color:'#999',label:''};return'<a class="lib-row" href="'+esc(it.href)+'" style="--c:'+c.color+'"><span class="k"></span><b title="'+esc(it.original||it.title)+'">'+esc(it.title)+'</b><span class="h1">'+esc(c.label)+'</span><span class="h2">'+esc(it.type)+'</span><span>'+fmt(it.date)+'</span></a>'}
function chips(list){var types={},labels={};list.forEach(function(it){types[it.type]=(types[it.type]||0)+1;(it.labels||[]).forEach(function(l){labels[l]=(labels[l]||0)+1})});
var h=Object.keys(types).sort(function(a,b){return types[b]-types[a]}).map(function(t){return'<button class="lib-chip'+(st.type===t?' on':'')+'" data-type="'+esc(t)+'">'+esc(t)+'<span class="c">'+types[t]+'</span></button>'}).join('');
var ls=Object.keys(labels).filter(function(l){return labels[l]>1||st.label===l}).sort(function(a,b){return labels[b]-labels[a]}).slice(0,14);
if(ls.length)h+='<span style="width:1px;background:var(--border);margin:0 4px"></span>'+ls.map(function(l){return'<button class="lib-chip'+(st.label===l?' on':'')+'" data-label="'+esc(l)+'">'+esc(l)+'<span class="c">'+labels[l]+'</span></button>'}).join('');
$('libTypes').innerHTML=h}
function render(){
var base=items.filter(function(it){var t=st.type,l=st.label;st.type='';st.label='';var ok=match(it);st.type=t;st.label=l;return ok});chips(base);
var list=sorted(items.filter(match));
document.querySelectorAll('.lib-cat').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-cat')===st.cat)});
document.querySelectorAll('#libKind button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-k')===st.kind)});
document.querySelectorAll('#libView button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-v')===st.view)});
$('libSort').value=st.sort;if($('libQ').value!==st.q)$('libQ').value=st.q;
var filtered=st.q||st.cat||st.type||st.label||st.kind!=='all';
$('libSum').innerHTML='<span>'+list.length+' of '+items.length+' items'+(st.cat?' in '+esc(CAT[st.cat].label):'')+'</span>'+(filtered?'<button id="libClear">Clear filters</button>':'');
var out='';
if(!list.length)out='<div class="lib-empty">Nothing matches those filters.</div>';
else if(st.view==='list')out='<div class="lib-list">'+list.map(row).join('')+'</div>';
else if(!filtered){D.cats.forEach(function(c){var g=list.filter(function(it){return it.category===c.id});if(!g.length)return;var more=g.length>6;out+='<div class="lib-section" style="--c:'+c.color+'"><span class="dot"></span><h2>'+esc(c.label)+'</h2><span class="c">'+g.length+'</span><span class="ln"></span>'+(more?'<button class="lib-chip" data-cat-more="'+c.id+'">See all</button>':'')+'</div><div class="lib-grid">'+g.slice(0,6).map(card).join('')+'</div>'})}
else out='<div class="lib-grid">'+list.map(card).join('')+'</div>';
$('libOut').innerHTML=out;
var hs=new URLSearchParams();['q','cat','type','label'].forEach(function(k){if(st[k])hs.set(k,st[k])});if(st.kind!=='all')hs.set('kind',st.kind);if(st.sort!=='new')hs.set('sort',st.sort);var s=hs.toString();history.replaceState(null,'',s?'#'+s:location.pathname)}
$('libCats').addEventListener('click',function(e){var b=e.target.closest('.lib-cat');if(!b)return;var c=b.getAttribute('data-cat');st.cat=st.cat===c?'':c;st.type='';st.label='';render();$('libQ').scrollIntoView({behavior:'smooth',block:'center'})});
$('libKind').addEventListener('click',function(e){var b=e.target.closest('button');if(b){st.kind=b.getAttribute('data-k');render()}});
$('libView').addEventListener('click',function(e){var b=e.target.closest('button');if(b){st.view=b.getAttribute('data-v');try{localStorage.setItem('lib-view',st.view)}catch(x){}render()}});
$('libSort').addEventListener('change',function(){st.sort=this.value;render()});
var t;$('libQ').addEventListener('input',function(){var v=this.value;clearTimeout(t);t=setTimeout(function(){st.q=v.trim();render()},90)});
document.addEventListener('click',function(e){var b=e.target.closest('[data-type],[data-label],[data-cat-more],#libClear');if(!b)return;
if(b.id==='libClear'){st={q:'',cat:'',kind:'all',type:'',label:'',sort:st.sort,view:st.view};render();return}
if(b.hasAttribute('data-cat-more')){st.cat=b.getAttribute('data-cat-more');render();window.scrollTo({top:$('libCats').offsetTop,behavior:'smooth'});return}
if(b.hasAttribute('data-type')){var v=b.getAttribute('data-type');st.type=st.type===v?'':v}else{var l=b.getAttribute('data-label');st.label=st.label===l?'':l}render()});
render();
})();`;

// ── Report viewer: hub bar + context strip + the report in a same-origin frame.
const VIEWER_CSS = `
body.hub{overflow:hidden}
.rv{position:fixed;inset:var(--hub-h) 0 0 0;display:flex;flex-direction:column}
.rv-bar{display:flex;align-items:center;gap:12px;min-height:50px;padding:8px 18px;border-bottom:1px solid var(--border);background:var(--bg-1)}
.rv-crumb{display:flex;align-items:center;gap:8px;min-width:0;font-size:.8rem;color:var(--text-3)}
.rv-crumb a:hover{color:var(--text)}
.rv-crumb .cat{display:inline-flex;align-items:center;gap:6px;color:var(--c);font-weight:700}
.rv-crumb .cat i{width:8px;height:8px;border-radius:2px;background:var(--c)}
.rv-title{font-weight:750;color:var(--text);font-size:.92rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.015em}
.rv-chip{flex:none;padding:2px 8px;border-radius:999px;border:1px solid var(--border);font:700 .66rem var(--font);color:var(--text-2)}
.rv-chip.pub{border-color:color-mix(in srgb,var(--green) 45%,transparent);color:var(--green)}
.rv-sp{flex:1}
.rv-act{display:flex;gap:6px;flex:none}
.rv-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 11px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text-2);font:600 .76rem var(--font);cursor:pointer}
.rv-btn:hover{color:var(--text);border-color:var(--border-2)}
.rv-btn[aria-disabled="true"]{opacity:.35;pointer-events:none}
.rv-frame{flex:1;position:relative;background:#fff}
.rv-frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#0b0f1a}
.rv-load{position:absolute;inset:0;display:grid;place-items:center;background:var(--bg-0);color:var(--text-3);font-size:.85rem;transition:opacity .25s}
.rv-load.done{opacity:0;pointer-events:none}
@media(max-width:900px){.rv{bottom:calc(62px + env(safe-area-inset-bottom))}.rv-crumb .lib,.rv-btn span,.rv-chip{display:none}}
`;

function makeViewerBody(item, { prev, next, src }) {
  const c = CAT[item.category] || CAT.studio;
  const nav = (x, dir) => x
    ? `<a class="rv-btn" href="${esc(x.href)}" title="${esc(x.title)}">${icon(dir === "prev" ? "arrow-left" : "arrow-right", { size: 14 })}<span>${dir === "prev" ? "Newer" : "Older"}</span></a>`
    : `<span class="rv-btn" aria-disabled="true">${icon(dir === "prev" ? "arrow-left" : "arrow-right", { size: 14 })}</span>`;
  const body = `<div class="rv">
<div class="rv-bar" style="--c:${c.color}">
  <div class="rv-crumb"><a class="lib" href="/library">Library</a>${icon("chevron-right", { size: 12 })}<a class="cat" href="/library#cat=${c.id}"><i></i>${esc(c.label)}</a>${icon("chevron-right", { size: 12 })}<span class="rv-title" title="${esc(item.original || item.title)}">${esc(item.title)}</span></div>
  <span class="rv-chip">${esc(item.type)}</span>${item.public ? '<span class="rv-chip pub" title="Anyone with the link can open this report">Shared link</span>' : ""}
  <div class="rv-sp"></div>
  <div class="rv-act">${nav(prev, "prev")}${nav(next, "next")}
  <button class="rv-btn" type="button" id="rvCopy">${icon("copy", { size: 14 })}<span>Copy link</span></button>
  <a class="rv-btn" href="${esc(src)}" target="_blank" rel="noopener">${icon("external-link", { size: 14 })}<span>Full page</span></a></div>
</div>
<div class="rv-frame"><iframe id="rvFrame" src="${esc(src)}" title="${esc(item.title)}"></iframe><div class="rv-load" id="rvLoad">Opening report…</div></div>
</div>
<script>(function(){var f=document.getElementById('rvFrame'),l=document.getElementById('rvLoad');f.addEventListener('load',function(){l.classList.add('done')});
document.getElementById('rvCopy').addEventListener('click',function(){var b=this;navigator.clipboard.writeText(location.origin+location.pathname).then(function(){b.lastChild.textContent='Copied';setTimeout(function(){b.lastChild.textContent='Copy link'},1500)})});
document.addEventListener('keydown',function(e){if(/INPUT|TEXTAREA/.test(e.target.tagName))return;if(e.key==='['){var p=document.querySelector('.rv-act a.rv-btn');if(p&&p.href)location.href=p.href}});})();</script>`;
  return { extraCss: VIEWER_CSS, body };
}

// Script injected into a framed report: same-origin navigation moves the whole
// hub to the new page (so the bar stays), external links open a new tab,
// in-page anchors keep working.
const EMBED_JS = `<script>(function(){if(window.top===window)return;document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a||e.defaultPrevented||e.metaKey||e.ctrlKey||e.shiftKey)return;var h=a.getAttribute('href')||'';if(!h||h.charAt(0)==='#'||/^javascript:/i.test(h))return;if(a.target&&a.target!=='_self'&&a.target!=='_top')return;var u;try{u=new URL(a.href,location.href)}catch(x){return}e.preventDefault();if(u.origin===location.origin){u.searchParams.delete('embed');window.top.location.href=u.pathname+u.search+u.hash}else window.open(u.href,'_blank','noopener')},true)})();</script>`;

function embedHtml(html) {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${EMBED_JS}</body>`) : html + EMBED_JS;
}

// ── Knowledge base doc page.
const DOC_CSS = `
.doc{max-width:1180px;margin:0 auto;padding:28px 24px 64px;display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:34px}
.doc-crumb{grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:.8rem;color:var(--text-3)}
.doc-crumb a:hover{color:var(--text)}
.doc-head h1{margin:6px 0 8px;font-size:clamp(1.6rem,3vw,2.2rem);letter-spacing:-.03em;line-height:1.12}
.doc-head p{margin:0;color:var(--text-2)}
.doc-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;font-size:.74rem}
.doc-body{margin-top:22px;font-size:.95rem;line-height:1.7;color:var(--text)}
.doc-body h2{margin:30px 0 10px;font-size:1.3rem;letter-spacing:-.02em;scroll-margin-top:80px}
.doc-body h3{margin:24px 0 8px;font-size:1.05rem;scroll-margin-top:80px}
.doc-body h4,.doc-body h5{margin:18px 0 6px;font-size:.95rem}
.doc-body p{margin:0 0 12px}
.doc-body a{color:var(--accent)}
.doc-body ul,.doc-body ol{margin:0 0 14px;padding-left:22px}
.doc-body li{margin:3px 0}
.doc-body code{font:500 .84em var(--mono);padding:1px 6px;border-radius:5px;background:var(--glass-3)}
.doc-body pre{margin:0 0 16px;padding:14px 16px;border:1px solid var(--border);border-radius:12px;background:var(--bg-1);overflow:auto}
.doc-body pre code{padding:0;background:none;font-size:.82rem}
.doc-body blockquote{margin:0 0 14px;padding:10px 14px;border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 10px 10px 0;color:var(--text-2)}
.doc-body hr{border:0;border-top:1px solid var(--border);margin:24px 0}
.md-table{overflow:auto;margin:0 0 16px;border:1px solid var(--border);border-radius:12px}
.md-table table{border-collapse:collapse;width:100%;font-size:.84rem}
.md-table th,.md-table td{padding:8px 12px;border-top:1px solid var(--border);text-align:left;vertical-align:top}
.md-table th{border-top:0;background:var(--surface-2);font-weight:700}
.doc-side{position:sticky;top:calc(var(--hub-h) + 24px);align-self:start;display:flex;flex-direction:column;gap:14px}
.doc-box{padding:14px;border:1px solid var(--border);border-radius:14px;background:var(--surface)}
.doc-box h4{margin:0 0 8px;font:700 .64rem var(--font);letter-spacing:.1em;text-transform:uppercase;color:var(--text-3)}
.doc-box a{display:block;padding:4px 0;font-size:.8rem;color:var(--text-2)}
.doc-box a:hover{color:var(--text)}
.doc-box a.l3{padding-left:12px;font-size:.76rem}
@media(max-width:1000px){.doc{grid-template-columns:1fr}.doc-side{position:static}}
`;

function makeDocBody(doc, { renderMarkdown, related }) {
  const { html, toc } = renderMarkdown(doc.body || "");
  const labels = (doc.tags || []).map((t) => `<span class="lib-lab">${esc(t)}</span>`).join("");
  const tocHtml = toc.length ? `<div class="doc-box"><h4>On this page</h4>${toc.slice(0, 30).map((t) => `<a class="${t.level === 3 ? "l3" : ""}" href="#${esc(t.id)}">${esc(t.text)}</a>`).join("")}</div>` : "";
  const rel = (related || []).length ? `<div class="doc-box"><h4>Linked docs</h4>${related.map((r) => `<a href="/library/doc/${encodeURIComponent(r.name)}">${esc(r.title || r.name)}</a>`).join("")}</div>` : "";
  const updated = doc.updatedAt ? new Date(doc.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
  const body = `<article class="doc">
<div class="doc-crumb"><a href="/library">Library</a>${icon("chevron-right", { size: 12 })}<a href="/library#cat=kb">Knowledge Base</a></div>
<div><header class="doc-head"><div class="lib-eyebrow">Knowledge base doc</div><h1>${esc(docTitle(doc))}</h1>${doc.description ? `<p>${esc(doc.description)}</p>` : ""}
<div class="doc-meta">${labels}${doc.project ? `<span class="lib-lab">${esc(doc.project)}</span>` : ""}${updated ? `<span class="lib-lab">Updated ${esc(updated)}</span>` : ""}${doc.version ? `<span class="lib-lab">v${esc(doc.version)}</span>` : ""}</div></header>
<div class="doc-body">${html}</div></div>
<aside class="doc-side">${tocHtml}${rel}</aside></article>`;
  return { extraCss: LIB_CSS + DOC_CSS, body };
}

module.exports = {
  CATEGORIES, CAT, loadReports, findReport, loadDocs, makeLibraryBody, makeViewerBody, makeDocBody,
  embedHtml, fallbackCategory, LIB_CSS,
};
