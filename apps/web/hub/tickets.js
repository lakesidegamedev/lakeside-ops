"use strict";

// hub/tickets.js: the Ticket hub, built around how support runs now: Keir
// owns every ticket as a job, works it, waits for the next turn or the player,
// and closes after a grace period. Three tabs:
//   Live         Keir's status (sprite, what it is doing, models, sensors) and
//                one card per open ticket with Keir's own summary, refreshed
//                every 20 seconds without a reload.
//   History      every ticket, searchable.
//   Performance  Keir's 30-day results, daily activity and an hourly tracker
//                that persists across releases.
// Ticket detail stays at /tickets/<n> inside the same hub bar.

const { icon } = require("../ui-kit");
const { esc } = require("./shell");
const keir = require("./keir");

const DONE = ["resolved", "closed", "rejected"];

const STATUS = {
  open: { label: "Open", color: "#d29922" },
  investigating: { label: "Investigating", color: "#58a6ff" },
  in_progress: { label: "In progress", color: "#a371f7" },
  awaiting_player: { label: "Waiting on player", color: "#db8a3a" },
  reopened: { label: "Reopened", color: "#f85149" },
  resolved: { label: "Resolved", color: "#3fb950" },
  closed: { label: "Closed", color: "#6c747e" },
  rejected: { label: "Rejected", color: "#8b949e" },
};

// Keir job states, in words a newcomer understands.
const JOB = {
  running: { label: "Working now", color: "#4cc2d4", sprite: "working" },
  executing: { label: "Working now", color: "#4cc2d4", sprite: "working" },
  queued: { label: "Up next", color: "#a371f7", sprite: "thinking" },
  waiting: { label: "Checking back", color: "#58a6ff", sprite: "reading" },
  blocked: { label: "Blocked", color: "#f85149", sprite: "concerned" },
  done: { label: "Done", color: "#3fb950", sprite: "thumbs_up" },
};

function reporterOf(t) {
  return (t.reporter && (t.reporter.characterName || t.reporter.username)) || t.discordDisplayName || t.discordUsername || "Player";
}
// Machine bookkeeping notes are not worth showing.
function readable(text) {
  const t = String(text || "").trim();
  if (!t || /^[a-z0-9_-]+(:[\w.-]+)+$/i.test(t) || /^discord-[a-z-]+/i.test(t)) return "";
  return t;
}
const ms = (d) => (d ? new Date(d).getTime() : 0);

async function loadMongo(db) {
  const col = db.collection("tickets");
  const since14 = new Date(Date.now() - 14 * 864e5);
  const light = { messages: 0, embedding: 0, imageUrls: 0, contextRequest: 0, conversationHistory: 0, description: 0, "intake.interactions": 0, "intake.interactionIds": 0 };
  const [active, closed] = await Promise.all([
    col.find({ status: { $nin: DONE } }, { projection: light }).sort({ updatedAt: -1 }).limit(60).toArray(),
    col.find({ status: { $in: DONE }, $or: [{ closedAt: { $gte: since14 } }, { resolvedAt: { $gte: since14 } }] }, { projection: { ticketNumber: 1, title: 1, status: 1, category: 1, closedAt: 1, resolvedAt: 1, createdAt: 1, prNumber: 1, "reporter.characterName": 1, "reporter.username": 1, discordDisplayName: 1 } })
      .sort({ closedAt: -1 }).limit(12).toArray(),
  ]);
  return { active, closed };
}

// Merge Mongo tickets with Keir's job view into the live payload.
function buildLive({ active, closed }, hub) {
  const byTicket = new Map(((hub && hub.tickets) || []).map((t) => [t.number, t]));
  const workers = new Map();
  for (const w of (hub && hub.workers) || []) if (w.ticket && !workers.has(w.ticket)) workers.set(w.ticket, w);
  const cards = active.map((t) => {
    const k = byTicket.get(t.ticketNumber) || {};
    const w = workers.get(t.ticketNumber);
    const jobState = (w && w.state) || (k.active && k.active.state) || null;
    const lastUpdate = (t.publicUpdates || []).filter((u) => u.at).sort((a, b) => ms(b.at) - ms(a.at))[0];
    const summary = readable(w && w.summary) || readable(lastUpdate && lastUpdate.message) || "";
    const prs = (k.prs || []).map((p) => ({ n: p.number, state: p.state || (p.merged ? "merged" : "") }));
    if (t.prNumber && !prs.some((p) => p.n === t.prNumber)) prs.push({ n: t.prNumber, state: "" });
    return {
      n: t.ticketNumber, title: t.title || "Untitled ticket", status: t.status, category: t.category || "", player: reporterOf(t),
      created: ms(t.createdAt), updated: ms(t.updatedAt),
      job: jobState, wakeAt: (w && w.wakeAt) || (k.active && k.active.wakeAt) || null,
      summary: summary.slice(0, 600), model: keir.modelName(w && w.model), rounds: (w && w.rounds) || 0, attempts: k.attempts || 0,
      decision: !!k.decisionPending, lastKeirAt: k.lastKeirAt || (w && w.updatedAt) || null,
      lastUpdateAt: lastUpdate ? ms(lastUpdate.at) : null, prs,
    };
  });
  // Decisions first, then working, up next, checking back, blocked, no job.
  const order = { running: 0, executing: 0, queued: 1, waiting: 2, blocked: 3 };
  cards.sort((a, b) => (a.decision === b.decision ? 0 : a.decision ? -1 : 1) || (order[a.job] ?? 4) - (order[b.job] ?? 4) || b.updated - a.updated);
  const r = (hub && hub.routing) || {};
  const sensors = ((hub && hub.watch && hub.watch.sensors) || []).map((s) => ({ label: s.label, ok: !s.error && s.status === "active", last: s.lastSuccessAt || null }));
  return {
    at: Date.now(),
    keir: hub ? {
      mood: keir.keirMood(hub), version: hub.release && hub.release.version, paused: !!hub.paused, kpis: hub.kpis || {},
      models: [
        { role: "Tickets", name: keir.modelName(r.worker) },
        { role: "Quick answers", name: keir.modelName(r.quick) },
        { role: "Code changes", name: keir.modelName(r.coding) },
        { role: "Images", name: keir.modelName(r.vision) },
      ].filter((m) => m.name),
      sensors,
    } : null,
    cards,
    feed: ((hub && hub.stream && hub.stream.feed) || []).slice(0, 10).map((f) => ({ at: f.at, text: f.text, ticket: f.ticket, model: keir.modelName(f.model) })),
    closed: closed.map((t) => ({ n: t.ticketNumber, title: t.title, status: t.status, at: ms(t.resolvedAt || t.closedAt), player: reporterOf(t), pr: t.prNumber || null, open: ms(t.createdAt) })),
  };
}

async function loadHistory(db) {
  const rows = await db.collection("tickets").find({}, { projection: { ticketNumber: 1, title: 1, status: 1, category: 1, createdAt: 1, closedAt: 1, resolvedAt: 1, prNumber: 1, tags: 1, "reporter.characterName": 1, "reporter.username": 1, discordDisplayName: 1, discordUsername: 1 } })
    .sort({ ticketNumber: -1 }).limit(5000).toArray();
  return rows.map((t) => ({
    n: t.ticketNumber, t: t.title || "", s: t.status, c: t.category || "", r: reporterOf(t),
    o: t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 10) : "", d: (t.resolvedAt || t.closedAt) ? new Date(t.resolvedAt || t.closedAt).toISOString().slice(0, 10) : "",
    p: t.prNumber || 0, g: (Array.isArray(t.tags) ? t.tags : []).slice(0, 4).map(String),
  }));
}

// Daily opened and closed counts from ticket history.
function closureSeries(hist, { days = 42, now = Date.now() } = {}) {
  const day = 864e5;
  const start = Math.floor(now / day) * day - (days - 1) * day;
  const rows = Array.from({ length: days }, (_, i) => ({ day: new Date(start + i * day).toISOString().slice(0, 10), opened: 0, closed: 0 }));
  const idx = (s) => (s ? Math.floor((Date.parse(s + "T00:00:00Z") - start) / day) : -1);
  for (const h of hist) {
    const o = idx(h.o), d = idx(h.d);
    if (o >= 0 && o < days) rows[o].opened++;
    if (d >= 0 && d < days) rows[d].closed++;
  }
  return rows;
}

const TK_CSS = `
${keir.SPRITE_CSS}
.tk{max-width:1500px;margin:0 auto;padding:20px 24px 64px}
.kh{display:grid;grid-template-columns:auto minmax(0,1fr);gap:18px;align-items:center;padding:16px 18px;margin-bottom:12px}
.kh-sprite{position:relative;width:96px;height:96px;border-radius:14px;display:grid;place-items:center;background:radial-gradient(circle at 50% 62%,color-mix(in srgb,var(--accent) 16%,transparent),transparent 70%),var(--bg-1);border:1px solid var(--border)}
.kh-sprite .on{position:absolute;right:7px;bottom:7px;width:9px;height:9px;border-radius:50%;background:var(--c,var(--green));box-shadow:0 0 0 3px color-mix(in srgb,var(--c,var(--green)) 22%,transparent)}
.kh-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kh-top h2{margin:0;font-size:17px;font-weight:600;letter-spacing:-.02em}
.kh-sub{margin-top:3px;color:var(--text-2);font-size:12.5px}
.kh-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;align-items:center}
.kh-model{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);font-size:11.5px;color:var(--text-3)}
.kh-model b{color:var(--text);font-weight:520}
.kh-sens{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text-3);margin-right:8px}
.tk .statbar{margin-bottom:6px}
.lane-scroll{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(330px,360px);gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding:2px 2px 12px;scrollbar-width:thin}
.lane-btns{display:flex;gap:4px}
.tc{scroll-snap-align:start;position:relative;display:flex;flex-direction:column;gap:8px;min-height:260px;padding:13px 14px 12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);transition:border-color var(--t),background var(--t)}
.tc::before{content:"";position:absolute;inset:0 0 auto 0;height:2px;border-radius:12px 12px 0 0;background:var(--c);opacity:.85}
.tc:hover{border-color:var(--border-2);background:var(--surface-2)}
.tc-top{display:flex;align-items:center;gap:7px}
.tc-num{font:500 12px var(--mono);color:var(--text-2)}
.tc-age{margin-left:auto;font-size:11px;color:var(--text-3);white-space:nowrap}
.tc h3{margin:0;font-size:14px;font-weight:560;letter-spacing:-.015em;line-height:1.35}
.tc-who{font-size:11.5px;color:var(--text-3);display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.tc-keir{display:flex;gap:9px;align-items:flex-start;padding:9px 10px;border-radius:var(--r-md);background:rgb(var(--ink)/.03);border:1px solid var(--border);flex:1}
.tc-keir p{margin:0;font-size:12px;line-height:1.5;color:var(--text);display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.tc-keir .none{color:var(--text-3)}
.tc-foot{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:11px;color:var(--text-3)}
.tc-foot .sp{flex:1}
.tc.decision{border-color:color-mix(in srgb,var(--amber) 45%,var(--border))}
.tk-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-top:6px}
.feed{padding:2px 0}
.fi{display:grid;grid-template-columns:56px minmax(0,1fr);gap:10px;padding:7px 14px;font-size:12.5px;border-top:1px solid var(--border)}
.fi:first-child{border-top:0}
.fi time{color:var(--text-3);font:11px var(--mono);padding-top:1px}
.fi span{color:var(--text-2)}
.fi a{color:var(--text)}
.fi small{color:var(--text-3)}
.tk-empty{padding:28px 16px;text-align:center;color:var(--text-3);font-size:12.5px}
.ht-tools{display:flex;flex-wrap:wrap;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border)}
.ht-tools input,.ht-tools select{height:30px;padding:0 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg-1);color:var(--text);font-size:12.5px}
.ht-tools input{flex:1;min-width:220px}
table.ht{width:100%;border-collapse:collapse;font-size:12.5px}
.ht th{text-align:left;font-weight:520;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3);padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap;background:var(--surface);position:sticky;top:0;cursor:pointer}
.ht td{padding:8px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
.ht tbody tr{cursor:pointer;transition:background var(--t)}
.ht tbody tr:hover{background:rgb(var(--ink)/.022)}
.ht td.n{font:11.5px var(--mono);color:var(--text-2)}
.ht td.t{max-width:520px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.ht td.d{color:var(--text-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.ht-scroll{max-height:70vh;overflow:auto}
.ht-more{display:flex;justify-content:center;padding:10px;border-top:1px solid var(--border)}
.pf-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}
.pf-chart{padding:12px 14px 10px}
.pf-chart h3{margin:0 0 8px;font-size:12px;font-weight:540;color:var(--text-2)}
.pf-chart svg{display:block;width:100%;height:150px}
.pf-chart .axis{fill:var(--text-3);font-size:9px;font-family:var(--font)}
.pf-chart .grid-line{stroke:rgb(var(--ink)/.05)}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--text-2);margin-top:6px}
.legend span{display:inline-flex;align-items:center;gap:5px}
.legend i{width:7px;height:7px;border-radius:2px;display:inline-block}
.pf-note{font-size:11.5px;color:var(--text-3);margin-top:8px;line-height:1.5}
.pf-models>div{display:grid;grid-template-columns:minmax(0,1fr) 70px;gap:10px;align-items:center;padding:7px 14px;font-size:12.5px;border-top:1px solid var(--border)}
.pf-models>div:first-child{border-top:0}
.bar{height:4px;background:rgb(var(--ink)/.06);border-radius:999px;overflow:hidden;margin-top:4px}
.bar>i{display:block;height:100%;background:var(--accent);border-radius:inherit}
@media(max-width:1000px){.tk-cols,.pf-grid{grid-template-columns:1fr}.kh{grid-template-columns:1fr}}
@media(max-width:600px){.tk{padding:14px 12px 40px}.lane-scroll{grid-auto-columns:86%}.kh{grid-template-columns:auto minmax(0,1fr);gap:12px;padding:12px}.kh-sprite{width:64px;height:64px}.kh-sprite .ksprite{--ks:56px!important}.kh-sub,.kh-row{display:none}.kh-top h2{font-size:14px}}
`;

function makeTicketHubBody(live) {
  const body = `<div class="tk">
<div class="page-h"><div><h1>Tickets</h1><div class="sub">What players reported, what Keir is doing about it, and how it went.</div></div></div>
<div class="tabs" id="tkTabs"><button class="on" data-tab="live">${icon("activity", { size: 14 })}Live</button><button data-tab="history">${icon("clock", { size: 14 })}History</button><button data-tab="perf">${icon("bar-chart", { size: 14 })}Keir performance</button></div>
<div id="tab-live">
  <section class="hcard kh" id="kHead"></section>
  <div class="statbar" id="kStats"></div>
  <div class="sec-h"><h2>Open tickets</h2><span class="count" id="laneCount"></span><div class="actions"><span id="liveAt" style="font-size:11px;color:var(--text-3)"></span><div class="lane-btns"><button class="hub-btn ghost" type="button" id="laneL" aria-label="Scroll left">${icon("arrow-left", { size: 13 })}</button><button class="hub-btn ghost" type="button" id="laneR" aria-label="Scroll right">${icon("arrow-right", { size: 13 })}</button></div></div></div>
  <div class="lane-scroll" id="lane"></div>
  <div class="tk-cols">
    <section class="hcard"><div class="hcard-head"><h3>What Keir did lately</h3></div><div class="feed" id="kFeed"></div></section>
    <section class="hcard"><div class="hcard-head"><h3>Closed in the last 14 days</h3></div><div class="feed" id="kClosed"></div></section>
  </div>
</div>
<div id="tab-history" hidden>
  <section class="hcard"><div class="ht-tools"><input id="htQ" type="search" placeholder="Search by number, title, player or tag" autocomplete="off">
  <select id="htS"><option value="">Any status</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}</select>
  <select id="htC"><option value="">Any category</option></select>
  <select id="htP"><option value="">With or without a PR</option><option value="1">Has a PR</option><option value="0">No PR</option></select></div>
  <div class="ht-scroll"><table class="ht"><thead><tr><th data-k="n">#</th><th data-k="t">Title</th><th data-k="s">Status</th><th data-k="c">Category</th><th data-k="r">Player</th><th data-k="o">Opened</th><th data-k="d">Closed</th><th data-k="p">PR</th></tr></thead><tbody id="htBody"><tr><td colspan="8" class="d" style="text-align:center;padding:24px">Loading ticket history…</td></tr></tbody></table></div>
  <div class="ht-more" id="htMore" hidden><button class="hub-btn ghost" type="button">Show more</button></div></section>
</div>
<div id="tab-perf" hidden><div class="tk-empty">Loading Keir performance…</div></div>
</div>
<script type="application/json" id="tkLive">${JSON.stringify(live).replace(/</g, "\\u003c")}</script>
<script type="application/json" id="tkMeta">${JSON.stringify({ st: STATUS, job: JOB }).replace(/</g, "\\u003c")}</script>
<script>${TK_JS}</script>${keir.SPRITE_JS}`;
  return { extraCss: TK_CSS, body };
}

const TK_JS = `(function(){
var M=JSON.parse(document.getElementById('tkMeta').textContent),ST=M.st,JOB=M.job,live=JSON.parse(document.getElementById('tkLive').textContent);
var $=function(id){return document.getElementById(id)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function rel(t){if(!t)return'';var s=Math.round((Date.now()-t)/1000);if(s<0){s=-s;return s<3600?'in '+Math.max(1,Math.round(s/60))+'m':'in '+Math.round(s/3600)+'h'}if(s<60)return'just now';if(s<3600)return Math.round(s/60)+'m ago';if(s<86400)return Math.round(s/3600)+'h ago';return Math.round(s/86400)+'d ago'}
function hm(t){return new Date(t).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}
function dur(ms){if(ms==null)return'n/a';var h=ms/36e5;if(h<1)return Math.max(1,Math.round(ms/6e4))+'m';if(h<48)return h.toFixed(h<10?1:0)+'h';return(h/24).toFixed(1)+'d'}
function pill(label,c){return'<span class="pill" style="--c:'+c+'"><span class="dot"></span>'+esc(label)+'</span>'}
function jobPill(c){if(c.decision)return pill('Needs your decision','#d29922');var j=JOB[c.job];if(!j)return'<span class="pill quiet">No Keir job</span>';var l=j.label;if(c.job==='waiting'&&c.wakeAt)l='Checks back '+rel(c.wakeAt);return pill(l,j.color)}
function card(c){var j=JOB[c.job]||{color:'#6c747e',sprite:'idle'};var col=c.decision?'#d29922':j.color;
var prs=(c.prs||[]).map(function(p){return'<span class="tag">PR #'+esc(p.n)+(p.state?' '+esc(p.state):'')+'</span>'}).join('');
return'<a class="tc'+(c.decision?' decision':'')+'" href="/tickets/'+c.n+'" style="--c:'+col+'"><div class="tc-top"><span class="tc-num">#'+c.n+'</span>'+jobPill(c)+'<span class="tc-age">opened '+rel(c.created)+'</span></div>'+
'<h3>'+esc(c.title)+'</h3><div class="tc-who">'+esc(c.player)+(c.category?'<span class="tag">'+esc(c.category)+'</span>':'')+(ST[c.status]?'<span class="tag">'+esc(ST[c.status].label)+'</span>':'')+'</div>'+
'<div class="tc-keir"><div class="ksprite m" data-state="'+(c.decision?'alert':j.sprite)+'" style="--ks:32px"></div>'+(c.summary?'<p>'+esc(c.summary)+'</p>':'<p class="none">Keir has not written anything on this ticket yet.</p>')+'</div>'+
'<div class="tc-foot">'+(c.model?'<span class="tag">'+esc(c.model)+'</span>':'')+(c.rounds?'<span>'+c.rounds+' steps</span>':'')+prs+'<span class="sp"></span>'+(c.lastKeirAt?'<span>Keir '+rel(c.lastKeirAt)+'</span>':'')+'</div></a>'}
function head(k){if(!k){$('kHead').innerHTML='<div class="kh-sprite"><div class="ksprite" data-state="sleeping" style="--ks:80px"></div></div><div><div class="kh-top"><h2>Keir status is unavailable</h2></div><div class="kh-sub">The ticket list below still comes straight from the database.</div></div>';$('kStats').innerHTML='';return}
var tone={good:'#3fb950',warn:'#d29922',quiet:'#6c747e'}[k.mood.tone]||'#6c747e';
var models=(k.models||[]).map(function(m){return'<span class="kh-model">'+esc(m.role)+' <b>'+esc(m.name)+'</b></span>'}).join('');
var sens=(k.sensors||[]).map(function(s){return'<span class="kh-sens"><span class="dot" style="--c:'+(s.ok?'#3fb950':'#d29922')+'"></span>'+esc(s.label)+'</span>'}).join('');
$('kHead').innerHTML='<div class="kh-sprite" style="--c:'+tone+'"><div class="ksprite" data-state="'+esc(k.mood.state)+'" style="--ks:80px"></div><span class="on"></span></div><div style="min-width:0"><div class="kh-top"><h2>'+esc(k.mood.label)+'</h2>'+(k.version?'<span class="tag">Keir '+esc(k.version)+'</span>':'')+(k.paused?pill('Paused','#d29922'):pill('Running','#3fb950'))+'</div><div class="kh-sub">Keir is the studio\\'s support agent. It reads every ticket, investigates, ships fixes and replies to players.</div><div class="kh-row">'+models+'</div>'+(sens?'<div class="kh-row">'+sens+'</div>':'')+'</div>';
var p=k.kpis||{};var sr=p.successRate24h!=null?Math.round(p.successRate24h*100)+'%':'n/a';var dec=live.cards.filter(function(c){return c.decision}).length;
$('kStats').innerHTML='<div class="stat"><div class="k">Open tickets</div><div class="v">'+live.cards.length+'</div><div class="s">'+(dec?'<span class="warn">'+dec+' need a decision</span>':'no decisions waiting')+'</div></div>'+
'<div class="stat"><div class="k">Working now</div><div class="v">'+(p.running||0)+'</div><div class="s">'+(p.queued||0)+' up next</div></div>'+
'<div class="stat"><div class="k">Checking back</div><div class="v">'+(p.waiting||0)+'</div><div class="s">waiting on a turn or a player</div></div>'+
'<div class="stat"><div class="k">Blocked</div><div class="v">'+(p.blocked||0)+'</div><div class="s">'+((p.blocked||0)?'<span class="warn">needs attention</span>':'none')+'</div></div>'+
'<div class="stat"><div class="k">Keir runs, 24h</div><div class="v">'+(p.activations24h||0)+'</div><div class="s">'+sr+' finished cleanly</div></div>'+
'<div class="stat"><div class="k">Typical run</div><div class="v">'+dur(p.medianActivationMs)+'</div><div class="s">slow runs '+dur(p.p90ActivationMs)+'</div></div>'}
function renderLive(){head(live.keir);
$('laneCount').textContent=live.cards.length;$('liveAt').textContent='Updated '+hm(live.at);
$('lane').innerHTML=live.cards.length?live.cards.map(card).join(''):'<div class="tk-empty">No open tickets. Nice.</div>';
$('kFeed').innerHTML=(live.feed||[]).length?live.feed.map(function(f){return'<div class="fi"><time>'+hm(f.at)+'</time><span>'+(f.ticket?'<a href="/tickets/'+f.ticket+'">#'+f.ticket+'</a> ':'')+esc(String(f.text||'').replace(/^Worked on ticket \\d+ /,'worked '))+(f.model?' <small>· '+esc(f.model)+'</small>':'')+'</span></div>'}).join(''):'<div class="tk-empty">Nothing in the last few hours.</div>';
$('kClosed').innerHTML=(live.closed||[]).length?live.closed.map(function(c){var s=ST[c.status]||{label:c.status};return'<div class="fi"><time>'+rel(c.at).replace(' ago','')+'</time><span><a href="/tickets/'+c.n+'">#'+c.n+' '+esc(c.title)+'</a> <small>· '+esc(s.label)+(c.at&&c.open?' after '+dur(c.at-c.open):'')+'</small></span></div>'}).join(''):'<div class="tk-empty">No tickets closed in 14 days.</div>';
if(window.keirSprites)window.keirSprites()}
function refresh(){if(document.hidden||$('tab-live').hidden)return;fetch('/api/hub/tickets/live',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d){var x=$('lane').scrollLeft;live=d;renderLive();$('lane').scrollLeft=x}}).catch(function(){})}
renderLive();setInterval(refresh,20000);document.addEventListener('visibilitychange',refresh);
$('laneL').addEventListener('click',function(){$('lane').scrollBy({left:-370,behavior:'smooth'})});$('laneR').addEventListener('click',function(){$('lane').scrollBy({left:370,behavior:'smooth'})});
var loaded={};function show(t){['live','history','perf'].forEach(function(x){$('tab-'+x).hidden=x!==t});document.querySelectorAll('#tkTabs button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-tab')===t)});history.replaceState(null,'',t==='live'?location.pathname:'#'+t);if(t==='history'&&!loaded.h){loaded.h=1;loadHistory()}if(t==='perf'&&!loaded.p){loaded.p=1;loadPerf()}if(t==='live')refresh()}
$('tkTabs').addEventListener('click',function(e){var b=e.target.closest('button');if(b)show(b.getAttribute('data-tab'))});
var rows=[],limit=100,sortK='n',dir=-1;
function chip(s){var m=ST[s]||{label:s,color:'#8b949e'};return pill(m.label,m.color)}
function renderHist(){var q=$('htQ').value.trim().toLowerCase(),s=$('htS').value,c=$('htC').value,p=$('htP').value;
var list=rows.filter(function(r){if(s&&r.s!==s)return false;if(c&&r.c!==c)return false;if(p==='1'&&!r.p)return false;if(p==='0'&&r.p)return false;if(q){var h=('#'+r.n+' '+r.t+' '+r.r+' '+(r.g||[]).join(' ')+' '+r.c).toLowerCase();var w=q.split(/\\s+/);for(var i=0;i<w.length;i++)if(h.indexOf(w[i])<0)return false}return true});
list.sort(function(a,b){var x=a[sortK],y=b[sortK];if(typeof x==='number')return(x-y)*dir;return String(x||'').localeCompare(String(y||''))*dir});
$('htBody').innerHTML=list.slice(0,limit).map(function(r){return'<tr data-n="'+r.n+'"><td class="n">#'+r.n+'</td><td class="t" title="'+esc(r.t)+'">'+esc(r.t)+'</td><td>'+chip(r.s)+'</td><td>'+esc(r.c)+'</td><td>'+esc(r.r)+'</td><td class="d">'+esc(r.o)+'</td><td class="d">'+esc(r.d)+'</td><td class="d">'+(r.p?'#'+r.p:'')+'</td></tr>'}).join('')||'<tr><td colspan="8" class="d" style="text-align:center;padding:24px">No tickets match.</td></tr>';
$('htMore').hidden=list.length<=limit}
function loadHistory(){fetch('/api/hub/tickets/history',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(d){rows=d.items||[];var cats={};rows.forEach(function(r){if(r.c)cats[r.c]=1});$('htC').innerHTML='<option value="">Any category</option>'+Object.keys(cats).sort().map(function(c){return'<option>'+esc(c)+'</option>'}).join('');renderHist()})}
['htQ','htS','htC','htP'].forEach(function(id){$(id).addEventListener(id==='htQ'?'input':'change',function(){limit=100;renderHist()})});
$('htMore').addEventListener('click',function(){limit+=300;renderHist()});
$('htBody').addEventListener('click',function(e){var tr=e.target.closest('tr[data-n]');if(tr)location.href='/tickets/'+tr.getAttribute('data-n')});
document.querySelector('.ht thead').addEventListener('click',function(e){var th=e.target.closest('th');if(!th)return;var k=th.getAttribute('data-k');if(sortK===k)dir=-dir;else{sortK=k;dir=k==='n'||k==='o'||k==='d'?-1:1}renderHist()});
function bars(series,keys,colors,every){var W=600,H=150,P=20,n=series.length,bw=(W-P)/n,max=1;series.forEach(function(r){var t=0;keys.forEach(function(k){t+=r[k]||0});max=Math.max(max,t)});
var g='';for(var i=0;i<=2;i++){var y=6+(H-P-6)*i/2;g+='<line class="grid-line" x1="'+P+'" x2="'+W+'" y1="'+y+'" y2="'+y+'"/><text class="axis" x="0" y="'+(y+3)+'">'+Math.round(max*(1-i/2))+'</text>'}
series.forEach(function(r,i){var y=H-P;keys.forEach(function(k,j){var h=(r[k]||0)/max*(H-P-6);y-=h;g+='<rect x="'+(P+i*bw+bw*.15)+'" y="'+y+'" width="'+(bw*.7)+'" height="'+h+'" rx="1.5" fill="'+colors[j]+'"><title>'+esc(r.day)+': '+(r[k]||0)+' '+k+'</title></rect>'});if(i%every===0)g+='<text class="axis" x="'+(P+i*bw)+'" y="'+(H-4)+'">'+esc(r.day.slice(5))+'</text>'});
return'<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+g+'</svg>'}
function line(pts,color,fmt){var W=600,H=150,P=24;if(pts.length<2)return'<div class="tk-empty">The tracker saves one point an hour. The trend line appears after a couple of hours.</div>';var xs=pts.map(function(p){return p.at}),x0=Math.min.apply(null,xs),x1=Math.max.apply(null,xs),max=Math.max.apply(null,pts.map(function(p){return p.v}).concat([1]));
var d=pts.map(function(p,i){var x=P+(p.at-x0)/(x1-x0||1)*(W-P),y=H-P-(p.v/max)*(H-P-8);return(i?'L':'M')+x.toFixed(1)+' '+y.toFixed(1)}).join(' ');
var g='';for(var i=0;i<=2;i++){var y=8+(H-P-8)*i/2;g+='<line class="grid-line" x1="'+P+'" x2="'+W+'" y1="'+y+'" y2="'+y+'"/><text class="axis" x="0" y="'+(y+3)+'">'+fmt(max*(1-i/2))+'</text>'}
return'<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+g+'<path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>'}
function loadPerf(){fetch('/api/hub/tickets/performance',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(d){var p=d.perf||{},r=p.resolved||{},a=p.assisted||{};
var h='<div class="statbar"><div class="stat"><div class="k">Resolved by Keir, 30d</div><div class="v">'+(r.tickets!=null?r.tickets:'n/a')+'</div><div class="s">'+(a.tickets||0)+' more with Keir helping</div></div>'+
'<div class="stat"><div class="k">Time to resolve</div><div class="v">'+dur(r.resolutionMs&&r.resolutionMs.median)+'</div><div class="s">typical; slow ones '+dur(r.resolutionMs&&r.resolutionMs.p90)+'</div></div>'+
'<div class="stat"><div class="k">Keir runs per ticket</div><div class="v">'+(r.activations&&r.activations.median!=null?Math.round(r.activations.median):'n/a')+'</div><div class="s">typical resolved ticket</div></div>'+
'<div class="stat"><div class="k">Still open</div><div class="v">'+(p.pending!=null?p.pending:'n/a')+'</div><div class="s">'+(p.reopenedTickets||0)+' reopened in 30d</div></div>'+
'<div class="stat"><div class="k">Closed, 7 days</div><div class="v">'+d.closed7+'</div><div class="s">all tickets</div></div></div>';
h+='<div class="pf-grid"><section class="hcard pf-chart"><h3>Keir runs per day</h3>'+bars(d.usage,['ok','failed'],['#4cc2d4','#f85149'],2)+'<div class="legend"><span><i style="background:#4cc2d4"></i>Finished</span><span><i style="background:#f85149"></i>Failed or cut off</span></div></section>'+
'<section class="hcard pf-chart"><h3>Tickets opened and closed per day</h3>'+bars(d.closures,['opened','closed'],['#f472b6','#3fb950'],7)+'<div class="legend"><span><i style="background:#f472b6"></i>Opened</span><span><i style="background:#3fb950"></i>Closed</span></div></section>'+
'<section class="hcard pf-chart"><h3>Open tickets over time</h3>'+line(d.tracker.map(function(t){return{at:t.at,v:t.open||0}}),'#d29922',function(v){return Math.round(v)})+'<div class="pf-note">From the hourly tracker. It keeps 90 days and survives restarts and new releases.</div></section>'+
'<section class="hcard pf-chart"><h3>Clean finish rate, 24h rolling</h3>'+line(d.tracker.filter(function(t){return t.success24h!=null}).map(function(t){return{at:t.at,v:Math.round(t.success24h*100)}}),'#3fb950',function(v){return Math.round(v)+'%'})+'</section></div>';
var models=d.models||[];if(models.length){var top=models[0].n||1;h+='<section class="hcard" style="margin-top:12px"><div class="hcard-head"><h3>Which models did the work, 14 days</h3></div><div class="pf-models">'+models.map(function(m){return'<div><div>'+esc(m.name)+'<div class="bar"><i style="width:'+(m.n/top*100)+'%"></i></div></div><span style="text-align:right;color:var(--text-2)">'+m.n+' runs</span></div>'}).join('')+'</div></section>'}
h+='<div class="pf-note">"Resolved by Keir" counts tickets where Keir is the recorded resolver. "Helping" means Keir worked the ticket but someone else closed it. A run is one Keir work session, not a player message.</div>';
$('tab-perf').innerHTML=h}).catch(function(){$('tab-perf').innerHTML='<div class="tk-empty">Keir performance is unavailable right now.</div>'})}
var start=(location.hash||'').slice(1);if(start==='history'||start==='perf')show(start);
})();`;

module.exports = { loadMongo, buildLive, loadHistory, closureSeries, makeTicketHubBody, DONE, STATUS, JOB, readable };
