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
    const category = CAT[c.category] ? c.category : CAT[m.libraryCategory] ? m.libraryCategory : fallbackCategory(m);
    items.push({
      id: m.slug, kind: "report", href: `/reports/${m.slug}`,
      title: c.title || cleanText(m.title) || m.slug,
      original: cleanText(m.title),
      summary: (c.what || cleanText(m.summary)).slice(0, 400),
      takeaway: (c.takeaway || cleanText(m.takeaway)).slice(0, 400),
      category, type: c.type || m.reportType || "Report", labels: c.labels || [],
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
      title: c.title, original: "", summary: c.what || "", takeaway: c.takeaway || "", category: CAT[c.category] ? c.category : "studio",
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
let countCache = { at: 0, v: 0 };
// Count only, for the first paint; the docs themselves load on demand.
async function docCount(getDb, knowledgeStore) {
  if (docCache.v) return docCache.v.length;
  if (countCache.at && Date.now() - countCache.at < 300_000) return countCache.v;
  try {
    const db = await getDb();
    countCache = { at: Date.now(), v: await db.collection(knowledgeStore.COLLECTION || "ops_knowledge").countDocuments({ kind: "docs", deletedAt: null }, { maxTimeMS: 4000 }) };
  } catch { /* keep the last count */ }
  return countCache.v;
}
async function loadDocs(getDb, knowledgeStore) {
  if (docCache.v && Date.now() - docCache.at < 300_000) return docCache.v;
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

// Monthly publishing counts for the stat strip (last 8 months).
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

// Report types get a fixed color so a card's kind reads at a glance.
const TYPES = {
  Audit: "#d29922", Forensics: "#f85149", Postmortem: "#f85149", Plan: "#58a6ff", Proposal: "#a371f7",
  Research: "#4cc2d4", Report: "#a3aab3", Data: "#8b949e", Tracker: "#3fb950", Recap: "#f472b6",
  Forecast: "#a371f7", Briefing: "#58a6ff", Benchmark: "#4cc2d4", Guide: "#a3e635", Reference: "#8b949e",
  Preview: "#f472b6", Checkpoint: "#38bdf8", "Sim run": "#38bdf8", Doc: "#8b949e",
};

const LIB_CSS = `
.lib{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:calc(100vh - var(--hub-h))}
.lib-side{position:sticky;top:var(--hub-h);align-self:start;height:calc(100vh - var(--hub-h));overflow:auto;padding:16px 10px 24px;border-right:1px solid var(--border);background:var(--bg-1)}
.lib-side h4{margin:14px 9px 6px;font-size:10.5px;font-weight:560;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3)}
.lib-side h4:first-child{margin-top:2px}
.lib-nav{display:flex;align-items:center;gap:9px;width:100%;height:30px;padding:0 9px;border:0;border-radius:var(--r-sm);background:none;color:var(--text-2);font-size:13px;text-align:left;cursor:pointer;transition:background var(--t),color var(--t)}
.lib-nav:hover{background:rgb(var(--ink)/.04);color:var(--text)}
.lib-nav.on{background:rgb(var(--ink)/.065);color:var(--text);font-weight:500}
.lib-nav .sw{width:8px;height:8px;border-radius:2px;background:var(--c,var(--text-3));flex:none}
.lib-nav .icon{color:var(--text-3)}
.lib-nav.on .icon{color:var(--accent)}
.lib-nav .n{margin-left:auto;font-size:11.5px;color:var(--text-3);font-variant-numeric:tabular-nums}
.lib-main{min-width:0;padding:20px 24px 64px;max-width:1500px}
.lib-spark{display:flex;align-items:flex-end;gap:3px;height:22px;margin-top:4px}
.lib-spark i{flex:1;min-width:4px;border-radius:2px 2px 0 0;background:color-mix(in srgb,var(--accent) 55%,transparent)}
.lib-spark i.now{background:var(--accent)}
.lib-tools{position:sticky;top:var(--hub-h);z-index:40;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 0 10px;margin:4px 0 4px;background:linear-gradient(var(--bg-0) 80%,transparent)}
.lib-q{flex:1;min-width:240px;display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-3)}
.lib-q:focus-within{border-color:color-mix(in srgb,var(--accent) 55%,var(--border))}
.lib-q input{flex:1;border:0;outline:0;background:none;color:var(--text);font-size:13px}
.lib-seg{display:flex;padding:2px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface)}
.lib-seg button{height:26px;padding:0 10px;border:0;border-radius:5px;background:none;color:var(--text-2);font-size:12px;cursor:pointer}
.lib-seg button.on{background:var(--surface-3);color:var(--text)}
.lib-sel{height:32px;padding:0 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-2);font-size:12px}
.lib-chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px}
.lib-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-2);font-size:11.5px;cursor:pointer;transition:border-color var(--t),color var(--t)}
.lib-chip:hover{border-color:var(--border-2);color:var(--text)}
.lib-chip.on{border-color:color-mix(in srgb,var(--c,var(--accent)) 50%,transparent);background:color-mix(in srgb,var(--c,var(--accent)) 10%,var(--surface));color:var(--text)}
.lib-chip i{width:6px;height:6px;border-radius:2px;background:var(--c,var(--text-3))}
.lib-chip .c{color:var(--text-3);font-variant-numeric:tabular-nums}
.lib-sum{display:flex;align-items:center;gap:10px;margin:0 0 10px;color:var(--text-3);font-size:12px}
.lib-sum button{border:0;background:none;color:var(--accent);font-size:12px;cursor:pointer;padding:0}
.lib-latest{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.lib-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px}
.lcard{position:relative;display:flex;flex-direction:column;gap:8px;padding:13px 14px 12px 17px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);transition:border-color var(--t),background var(--t);min-height:150px}
.lcard::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:0 2px 2px 0;background:var(--c)}
.lcard:hover{border-color:var(--border-2);background:var(--surface-2)}
.lcard-top{display:flex;align-items:center;gap:7px;min-width:0}
.lcard-cat{font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lcard-date{margin-left:auto;font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.lcard h3{margin:0;font-size:14px;font-weight:560;letter-spacing:-.015em;line-height:1.35;color:var(--text)}
.lcard .what{margin:0;font-size:12px;line-height:1.5;color:var(--text-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lcard .take{display:flex;gap:8px;padding:7px 9px;border-radius:var(--r-sm);background:rgb(var(--ink)/.035);border:1px solid var(--border);font-size:12px;line-height:1.45;color:var(--text)}
.lcard .take b{flex:none;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--c);padding-top:1px}
.lcard .take span{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.lcard-foot{margin-top:auto;display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.lcard-foot .by{margin-left:auto;font-size:11px;color:var(--text-3)}
.lcard.big{min-height:200px;padding:16px 16px 14px 19px}
.lcard.big h3{font-size:15.5px}
.lcard.big .what{-webkit-line-clamp:3}
.lib-list{border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden;background:var(--surface)}
.lrow{display:grid;grid-template-columns:3px minmax(0,1.5fr) minmax(0,2fr) 92px 86px;gap:12px;align-items:center;padding:8px 12px 8px 0;border-top:1px solid var(--border);font-size:12.5px}
.lrow:first-child{border-top:0}
.lrow:hover{background:rgb(var(--ink)/.022)}
.lrow .k{height:22px;background:var(--c);border-radius:0 2px 2px 0}
.lrow b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lrow span{color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lib-empty{padding:60px 20px;text-align:center;color:var(--text-3)}
.lib-more{display:flex;justify-content:center;margin-top:12px}
@media(max-width:1200px){.lib-latest{grid-template-columns:1fr 1fr}}
@media(max-width:900px){.lib{grid-template-columns:1fr}.lib-side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--border);display:flex;gap:4px;overflow-x:auto;padding:8px 12px}.lib-side h4{display:none}.lib-nav{width:auto;white-space:nowrap;flex:none}.lib-nav .n{margin-left:4px}.lib-main{padding:14px 12px 40px}.lib-latest{grid-template-columns:1fr}.lrow{grid-template-columns:3px minmax(0,1fr) 86px}.lrow .h1,.lrow .h2{display:none}}
`;

function jsonForScript(v) {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// Client payload: only what the cards show, so the page stays small.
function slim(it) {
  return { id: it.id, k: it.kind === "doc" ? 1 : 0, h: it.href, t: it.title, o: it.original && it.original !== it.title ? it.original : "", w: it.summary || "", f: it.takeaway || "",
    c: it.category, y: it.type, l: it.labels || [], d: String(it.date || "").slice(0, 10), p: it.public ? 1 : 0, a: it.author || "", j: it.project || "" };
}

function makeLibraryBody({ reports, docCount }) {
  const months = monthly(reports);
  const max = Math.max(1, ...months.map((m) => m.n));
  const thisMonth = months[months.length - 1].n;
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
  for (const it of reports) counts[it.category] = (counts[it.category] || 0) + 1;
  counts.kb = docCount;
  const shared = reports.filter((r) => r.public).length;
  const described = reports.filter((r) => r.summary).length;
  const spark = months.map((m, i) => `<i class="${i === months.length - 1 ? "now" : ""}" style="height:${Math.max(8, (m.n / max) * 100)}%" title="${esc(m.label)}: ${m.n}"></i>`).join("");
  const nav = CATEGORIES.filter((c) => counts[c.id] && c.id !== "kb").map((c) =>
    `<button class="lib-nav" type="button" data-cat="${c.id}" style="--c:${c.color}"><span class="sw"></span>${esc(c.label)}<span class="n">${counts[c.id]}</span></button>`).join("");
  const body = `<div class="lib">
<aside class="lib-side" id="libSide"><h4>Library</h4>
<button class="lib-nav on" type="button" data-cat="">${icon("book-open", { size: 15 })}Everything<span class="n">${reports.length + docCount}</span></button>
<button class="lib-nav" type="button" data-cat="@reports">${icon("file-text", { size: 15 })}Reports<span class="n">${reports.length}</span></button>
<button class="lib-nav" type="button" data-cat="kb">${icon("layers", { size: 15 })}Knowledge base<span class="n">${docCount}</span></button>
<h4>Categories</h4>${nav}</aside>
<section class="lib-main">
<div class="page-h"><div><h1>Library</h1><div class="sub">Every analysis, audit and postmortem the studio has written, plus the docs agents keep current.</div></div></div>
<div class="statbar"><div class="stat"><div class="k">Reports</div><div class="v">${reports.length}</div><div class="s">${described} with a description</div></div>
<div class="stat"><div class="k">Knowledge base</div><div class="v">${docCount}</div><div class="s">docs and runbooks</div></div>
<div class="stat"><div class="k">This month</div><div class="v">${thisMonth}</div><div class="lib-spark">${spark}</div></div>
<div class="stat"><div class="k">Shared by link</div><div class="v">${shared}</div><div class="s">open without an ops login</div></div></div>
<div class="lib-tools"><label class="lib-q">${icon("search", { size: 14 })}<input id="libQ" type="search" placeholder="Filter by title, finding, label or original title" autocomplete="off"></label>
<select class="lib-sel" id="libSort" aria-label="Sort"><option value="new">Newest first</option><option value="old">Oldest first</option><option value="az">A to Z</option></select>
<div class="lib-seg" id="libView"><button class="on" data-v="grid" aria-label="Cards">${icon("layers", { size: 14 })}</button><button data-v="list" aria-label="List">${icon("menu", { size: 14 })}</button></div></div>
<div class="lib-chips" id="libTypes"></div>
<div class="lib-sum" id="libSum"></div>
<div id="libOut"></div>
</section></div>
<script type="application/json" id="libData">${jsonForScript({ items: reports.map(slim), cats: CATEGORIES, types: TYPES })}</script>
<script>${LIB_JS}</script>`;
  return { extraCss: LIB_CSS, body };
}

const LIB_JS = `(function(){
function setHtml(el,h){el.innerHTML=h}
var D=JSON.parse(document.getElementById('libData').textContent),items=D.items,CAT={},TY=D.types,docs=null,docsLoading=false;D.cats.forEach(function(c){CAT[c.id]=c});
var st={q:'',cat:'',type:'',label:'',sort:'new',view:'grid',limit:60};
try{st.view=localStorage.getItem('lib-view')||'grid';var h=new URLSearchParams(location.hash.slice(1));['q','cat','type','label','sort'].forEach(function(k){if(h.get(k))st[k]=h.get(k)})}catch(e){}
var $=function(id){return document.getElementById(id)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function fmt(d){if(!d)return'';var x=new Date(d+'T00:00:00Z');return isNaN(x)?'':x.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})}
function loadDocs(){if(docs||docsLoading)return;docsLoading=true;fetch('/api/hub/library/docs',{credentials:'same-origin'}).then(function(r){return r.ok?r.json():{items:[]}}).then(function(d){docs=d.items||[];docsLoading=false;render()}).catch(function(){docs=[];docsLoading=false;render()})}
function pool(){if(st.cat==='kb')return docs||[];if(st.cat==='@reports'||!st.q)return items;return items.concat(docs||[])}
function match(it){if(st.cat&&st.cat!=='@reports'&&st.cat!=='kb'&&it.c!==st.cat)return false;if(st.type&&it.y!==st.type)return false;if(st.label&&it.l.indexOf(st.label)<0)return false;
if(st.q){var q=st.q.toLowerCase().split(/\\s+/);var hay=(it.t+' '+it.w+' '+it.f+' '+it.o+' '+it.l.join(' ')+' '+it.y+' '+(CAT[it.c]||{}).label+' '+it.j).toLowerCase();for(var i=0;i<q.length;i++)if(hay.indexOf(q[i])<0)return false}return true}
function sorted(a){var s=a.slice();if(st.sort==='az')s.sort(function(x,y){return x.t.localeCompare(y.t)});else if(st.sort==='old')s.sort(function(x,y){return x.d.localeCompare(y.d)});else s.sort(function(x,y){return y.d.localeCompare(x.d)});return s}
function pill(t){var c=TY[t]||'#8b949e';return'<span class="pill" style="--c:'+c+'"><span class="dot"></span>'+esc(t)+'</span>'}
function card(it,big){var c=CAT[it.c]||{color:'#8b949e',label:''};var labs=it.l.slice(0,3).map(function(l){return'<span class="tag">'+esc(l)+'</span>'}).join('');
return'<a class="lcard'+(big?' big':'')+'" href="'+esc(it.h)+'" style="--c:'+c.color+'"><div class="lcard-top">'+pill(it.y)+'<span class="lcard-cat">'+esc(c.label)+'</span><span class="lcard-date">'+fmt(it.d)+'</span></div><h3>'+esc(it.t)+'</h3>'+(it.w?'<p class="what">'+esc(it.w)+'</p>':'')+(it.f?'<div class="take"><b>'+(it.k?'Doc':'Finding')+'</b><span>'+esc(it.f)+'</span></div>':'')+'<div class="lcard-foot">'+labs+(it.p?'<span class="pill" style="--c:#3fb950">Shared link</span>':'')+(it.a?'<span class="by">'+esc(it.a)+'</span>':'')+'</div></a>'}
function row(it){var c=CAT[it.c]||{color:'#8b949e',label:''};return'<a class="lrow" href="'+esc(it.h)+'" style="--c:'+c.color+'"><span class="k"></span><b title="'+esc(it.o||it.t)+'">'+esc(it.t)+'</b><span class="h1">'+esc(it.f||it.w)+'</span><span class="h2">'+esc(it.y)+'</span><span>'+fmt(it.d)+'</span></a>'}
function chips(list){var types={},labels={};list.forEach(function(it){types[it.y]=(types[it.y]||0)+1;it.l.forEach(function(l){labels[l]=(labels[l]||0)+1})});
var h=Object.keys(types).sort(function(a,b){return types[b]-types[a]}).map(function(t){return'<button class="lib-chip'+(st.type===t?' on':'')+'" data-type="'+esc(t)+'" style="--c:'+(TY[t]||'#8b949e')+'"><i></i>'+esc(t)+'<span class="c">'+types[t]+'</span></button>'}).join('');
var ls=Object.keys(labels).filter(function(l){return labels[l]>1||st.label===l}).sort(function(a,b){return labels[b]-labels[a]}).slice(0,10);
if(ls.length)h+=ls.map(function(l){return'<button class="lib-chip'+(st.label===l?' on':'')+'" data-label="'+esc(l)+'">'+esc(l)+'<span class="c">'+labels[l]+'</span></button>'}).join('');
$('libTypes').innerHTML=h}
function render(){
if(st.cat==='kb'||st.q)loadDocs();
var all=pool();var base=all.filter(function(it){var t=st.type,l=st.label;st.type='';st.label='';var ok=match(it);st.type=t;st.label=l;return ok});chips(base);
var list=sorted(all.filter(match));
document.querySelectorAll('.lib-nav').forEach(function(b){b.classList.toggle('on',(b.getAttribute('data-cat')||'')===st.cat)});
document.querySelectorAll('#libView button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-v')===st.view)});
$('libSort').value=st.sort;if($('libQ').value!==st.q)$('libQ').value=st.q;
var filtered=st.q||st.cat||st.type||st.label;
var waiting=(st.cat==='kb'||st.q)&&!docs;
setHtml($('libSum'),'<span>'+(waiting?'Loading the knowledge base…':list.length+' item'+(list.length===1?'':'s'))+'</span>'+(filtered?'<button id="libClear">Clear filters</button>':''));
var out='';
if(!list.length&&!waiting)out='<div class="lib-empty">Nothing matches those filters.</div>';
else if(st.view==='list')out='<div class="lib-list">'+list.slice(0,st.limit*4).map(row).join('')+'</div>';
else if(!filtered){var latest=list.slice(0,3);out+='<div class="sec-h"><h2>Latest</h2></div><div class="lib-latest">'+latest.map(function(it){return card(it,true)}).join('')+'</div>';
D.cats.forEach(function(c){var g=list.filter(function(it){return it.c===c.id&&latest.indexOf(it)<0});if(!g.length)return;out+='<div class="sec-h"><h2><span class="dot" style="--c:'+c.color+';width:8px;height:8px;border-radius:2px"></span>'+esc(c.label)+'</h2><span class="count">'+g.length+'</span><div class="actions">'+(g.length>6?'<button class="lib-chip" data-cat-more="'+c.id+'">See all</button>':'')+'</div></div><div class="lib-grid">'+g.slice(0,6).map(function(it){return card(it)}).join('')+'</div>'})}
else{out='<div class="lib-grid">'+list.slice(0,st.limit).map(function(it){return card(it)}).join('')+'</div>'+(list.length>st.limit?'<div class="lib-more"><button class="hub-btn ghost" id="libMore">Show more</button></div>':'')}
$('libOut').innerHTML=out;
var hs=new URLSearchParams();['q','cat','type','label'].forEach(function(k){if(st[k])hs.set(k,st[k])});if(st.sort!=='new')hs.set('sort',st.sort);var s=hs.toString();history.replaceState(null,'',s?'#'+s:location.pathname)}
$('libSide').addEventListener('click',function(e){var b=e.target.closest('.lib-nav');if(!b)return;st.cat=b.getAttribute('data-cat')||'';st.type='';st.label='';st.limit=60;render();window.scrollTo({top:0})});
$('libView').addEventListener('click',function(e){var b=e.target.closest('button');if(b){st.view=b.getAttribute('data-v');try{localStorage.setItem('lib-view',st.view)}catch(x){}render()}});
$('libSort').addEventListener('change',function(){st.sort=this.value;render()});
var t;$('libQ').addEventListener('input',function(){var v=this.value;clearTimeout(t);t=setTimeout(function(){st.q=v.trim();st.limit=60;render()},90)});
document.addEventListener('click',function(e){var b=e.target.closest('[data-type],[data-label],[data-cat-more],#libClear,#libMore');if(!b)return;
if(b.id==='libClear'){st.q='';st.cat='';st.type='';st.label='';render();return}
if(b.id==='libMore'){st.limit+=90;render();return}
if(b.hasAttribute('data-cat-more')){st.cat=b.getAttribute('data-cat-more');render();window.scrollTo({top:0});return}
if(b.hasAttribute('data-type')){var v=b.getAttribute('data-type');st.type=st.type===v?'':v}else{var l=b.getAttribute('data-label');st.label=st.label===l?'':l}render()});
render();
})();`;

// ── Report viewer: hub bar + context strip + the report in a same-origin frame.
const VIEWER_CSS = `
body.hub{overflow:hidden}
.rv{position:fixed;inset:var(--hub-h) 0 0 0;display:flex;flex-direction:column}
.rv-bar{display:flex;align-items:center;gap:10px;min-height:44px;padding:6px 16px;border-bottom:1px solid var(--border);background:var(--bg-1)}
.rv-crumb{display:flex;align-items:center;gap:8px;min-width:0;font-size:.8rem;color:var(--text-3)}
.rv-crumb a:hover{color:var(--text)}
.rv-crumb .cat{display:inline-flex;align-items:center;gap:6px;color:var(--c);font-weight:700}
.rv-crumb .cat i{width:8px;height:8px;border-radius:2px;background:var(--c)}
.rv-title{font-weight:550;color:var(--text);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.015em}
.rv-chip{flex:none;display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:5px;border:1px solid var(--border);background:var(--surface-2);font-size:11px;color:var(--text-2)}
.rv-chip.pub{border-color:color-mix(in srgb,var(--green) 45%,transparent);color:var(--green)}
.rv-sp{flex:1}
.rv-act{display:flex;gap:6px;flex:none}
.rv-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--border-2);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text);font-size:12px;cursor:pointer}
.rv-btn:hover{color:var(--text);border-color:var(--border-2)}
.rv-btn[aria-disabled="true"]{opacity:.35;pointer-events:none}
.rv-take{display:flex;gap:10px;align-items:baseline;padding:7px 16px;border-bottom:1px solid var(--border);background:var(--surface);font-size:12.5px;color:var(--text)}
.rv-take b{flex:none;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--c)}
.rv-frame{flex:1;position:relative;background:var(--bg-0)}
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
${item.takeaway ? `<div class="rv-take" style="--c:${c.color}"><b>Finding</b><span>${esc(item.takeaway)}</span></div>` : ""}
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
.doc-eyebrow{font-size:10.5px;font-weight:560;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.doc{max-width:1180px;margin:0 auto;padding:28px 24px 64px;display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:34px}
.doc-crumb{grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:.8rem;color:var(--text-3)}
.doc-crumb a:hover{color:var(--text)}
.doc-head h1{margin:6px 0 8px;font-size:26px;font-weight:600;letter-spacing:-.03em;line-height:1.15}
.doc-head p{margin:0;color:var(--text-2)}
.doc-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;font-size:.74rem}
.doc-body{margin-top:22px;font-size:14px;line-height:1.7;color:var(--text)}
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
  const labels = (doc.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  const tocHtml = toc.length ? `<div class="doc-box"><h4>On this page</h4>${toc.slice(0, 30).map((t) => `<a class="${t.level === 3 ? "l3" : ""}" href="#${esc(t.id)}">${esc(t.text)}</a>`).join("")}</div>` : "";
  const rel = (related || []).length ? `<div class="doc-box"><h4>Linked docs</h4>${related.map((r) => `<a href="/library/doc/${encodeURIComponent(r.name)}">${esc(r.title || r.name)}</a>`).join("")}</div>` : "";
  const updated = doc.updatedAt ? new Date(doc.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
  const body = `<article class="doc">
<div class="doc-crumb"><a href="/library">Library</a>${icon("chevron-right", { size: 12 })}<a href="/library#cat=kb">Knowledge Base</a></div>
<div><header class="doc-head"><div class="doc-eyebrow">Knowledge base doc</div><h1>${esc(docTitle(doc))}</h1>${doc.description ? `<p>${esc(doc.description)}</p>` : ""}
<div class="doc-meta">${labels}${doc.project ? `<span class="tag">${esc(doc.project)}</span>` : ""}${updated ? `<span class="tag">Updated ${esc(updated)}</span>` : ""}${doc.version ? `<span class="tag">v${esc(doc.version)}</span>` : ""}</div></header>
<div class="doc-body">${html}</div></div>
<aside class="doc-side">${tocHtml}${rel}</aside></article>`;
  return { extraCss: DOC_CSS, body };
}

module.exports = {
  slim, TYPES, docCount, CATEGORIES, CAT, loadReports, findReport, loadDocs, makeLibraryBody, makeViewerBody, makeDocBody,
  embedHtml, fallbackCategory, LIB_CSS,
};
