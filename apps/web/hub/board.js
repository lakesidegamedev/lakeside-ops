"use strict";

// hub/board.js: the Work board. Same data and edit API as before
// (kanban-store.js, /api/kanban), laid out around what people need to see:
//   a monitor line for always-on agent cards (heartbeats, not work),
//   what shipped this week, what is stuck, what is in progress,
//   in-progress work grouped by who holds it, then Next, Blocked and Done,
//   with automatic intake and the backlog collapsed underneath.
// Raw JSON status text never reaches a card face. Lane moves live in the card
// dialog, not on every card.

const { icon } = require("../ui-kit");

const DAY = 864e5;
const QUIET_DAYS = 5;

// Actor strings drift (token names, model suffixes, casing). Show people a name.
function ownerName(s) {
  const v = String(s || "").trim();
  if (!v) return "";
  if (/^platform-agents-write/i.test(v)) return "Agent (unnamed)";
  if (/@/.test(v)) return v.replace(/@.*/, "").replace(/^discord_\d+$/, "Owner");
  if (/^claude|^(opus|sonnet|haiku|fable)/i.test(v)) return "Claude";
  if (/^codex/i.test(v)) return "Codex";
  if (/^keir/i.test(v)) return "Keir";
  if (/^muse/i.test(v)) return "Muse";
  if (/^(deepseek|opencode)/i.test(v)) return "DeepSeek";
  return v.length > 24 ? v.slice(0, 24) : v;
}
function cleanProgress(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  if (/^[{[]/.test(t) || /^\w[\w ]{0,30}:\s*\{/.test(t) || /"\w+":/.test(t.slice(0, 80))) return "";
  return t.replace(/\s+/g, " ").slice(0, 240);
}
const ms = (s) => (s ? Date.parse(s) : 0);

function buildBoard(store) {
  const { items } = store.list({ limit: 1000 });
  const now = Date.now();
  const since7 = new Date(now - 7 * DAY).toISOString();
  const db = store.db;
  const done = db.prepare(`SELECT id FROM kanban_items WHERE lane = 'done' AND closed_at >= ? ORDER BY closed_at DESC LIMIT 200`).all(since7)
    .map((r) => store.get(r.id, { events: 0 })).filter(Boolean);
  const created = new Map(db.prepare(`SELECT item_id, actor FROM kanban_events WHERE event_type = 'created'`).all().map((r) => [r.item_id, r.actor]));
  const touched = new Set(db.prepare(`SELECT DISTINCT item_id FROM kanban_events WHERE event_type IN ('started','progress','blocked','completed')`).all().map((r) => r.item_id));
  const beats = new Map(db.prepare(`SELECT item_id, COUNT(*) AS n, MAX(created_at) AS last FROM kanban_events WHERE event_type = 'progress' AND created_at >= ? GROUP BY item_id`)
    .all(new Date(now - 3 * DAY).toISOString()).map((r) => [r.item_id, r]));
  const shippedByDay = Array.from({ length: 7 }, (_, i) => ({ day: new Date(now - (6 - i) * DAY).toISOString().slice(0, 10), n: 0 }));
  for (const d of done) { const k = String(d.closed_at || "").slice(0, 10); const b = shippedByDay.find((x) => x.day === k); if (b) b.n++; }

  const card = (it) => {
    const lastAt = Math.max(ms(it.last_progress_at), ms(it.updated_at));
    return {
      id: it.id, title: it.title, product: it.product, lane: it.lane, impact: it.impact, kind: it.kind,
      owner: ownerName(it.assigned_to), rawOwner: it.assigned_to || "", progress: cleanProgress(it.progress_summary),
      quietDays: lastAt ? Math.floor((now - lastAt) / DAY) : null, lastAt, closedAt: ms(it.closed_at),
      github: it.github ? { n: it.github.number, url: it.github.url, repo: it.github.repo } : null,
      evidence: it.evidence_url || null, by: ownerName(created.get(it.id)), source: it.source,
    };
  };
  const monitors = [], progress = [], next = [], inbox = [], blocked = [], backlog = [];
  for (const it of items) {
    const b = beats.get(it.id);
    const c = card(it);
    if (it.lane === "now" && (it.kind === "monitor" || (b && b.n >= 30))) { monitors.push({ ...c, beats: b ? b.n : 0, lastBeat: b ? ms(b.last) : c.lastAt }); continue; }
    if (it.lane === "now") progress.push(c);
    else if (it.lane === "blocked") blocked.push(c);
    else if (it.lane === "backlog") backlog.push(c);
    else if (it.lane === "next") (it.assigned_to || touched.has(it.id) ? next : inbox).push(c);
  }
  const byQuiet = (a, b) => (a.quietDays ?? 0) - (b.quietDays ?? 0);
  progress.sort(byQuiet);
  blocked.sort((a, b) => (b.quietDays ?? 0) - (a.quietDays ?? 0));
  next.sort((a, b) => b.lastAt - a.lastAt);
  inbox.sort((a, b) => b.lastAt - a.lastAt);
  backlog.sort((a, b) => b.lastAt - a.lastAt);
  const stuck = progress.filter((c) => (c.quietDays ?? 0) >= QUIET_DAYS);
  return {
    at: now, quietDays: QUIET_DAYS,
    products: store.products().filter((p) => !p.archived).map((p) => ({ slug: p.slug, name: p.name })),
    monitors, progress, next, inbox, blocked, backlog,
    done: done.map(card).sort((a, b) => b.closedAt - a.closedAt),
    shippedByDay, counts: { shipped: done.length, progress: progress.length, stuck: stuck.length + blocked.length, next: next.length, inbox: inbox.length, backlog: backlog.length },
    sync: (db.prepare("SELECT MAX(last_sync_at) AS at FROM kanban_github_sources WHERE enabled = 1").get() || {}).at || null,
  };
}

const BOARD_CSS = `
.wb{max-width:1640px;margin:0 auto;padding:20px 24px 64px}
.wb-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.wb-tools select,.wb-tools input{height:28px;padding:0 9px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text);font-size:12px}
.wb-tools input{width:220px}
.wb-mon{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 12px;font-size:11.5px;color:var(--text-3)}
.wb-mon .m{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-2);cursor:pointer}
.wb-mon .m:hover{border-color:var(--border-2);color:var(--text)}
.wb-spark{display:flex;align-items:flex-end;gap:3px;height:20px;margin-top:4px}
.wb-spark i{flex:1;border-radius:2px 2px 0 0;background:color-mix(in srgb,var(--green) 60%,transparent);min-height:2px}
.wb .statbar{margin-bottom:16px}
.wb-attn{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;margin-bottom:14px}
.wb-cols{display:grid;grid-template-columns:minmax(0,1.35fr) repeat(3,minmax(0,1fr));gap:12px;align-items:start}
.col{background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-lg);display:flex;flex-direction:column;max-height:calc(100vh - 250px);min-height:200px}
.col-h{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border)}
.col-h h2{margin:0;font-size:12px;font-weight:560;letter-spacing:.06em;text-transform:uppercase;color:var(--text-2);display:flex;align-items:center;gap:7px}
.col-h .count{font-size:11.5px;color:var(--text-3);font-variant-numeric:tabular-nums}
.col-h .hint{margin-left:auto;font-size:11px;color:var(--text-3)}
.col-b{overflow:auto;padding:8px;display:flex;flex-direction:column;gap:6px}
.grp{font-size:10.5px;font-weight:560;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);padding:8px 4px 2px;display:flex;align-items:center;gap:7px}
.grp .av{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:8.5px;font-weight:650;background:var(--surface-3);color:var(--text-2);border:1px solid var(--border-2);text-transform:none;letter-spacing:0}
.kc{position:relative;display:flex;flex-direction:column;gap:5px;padding:9px 10px 8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);cursor:pointer;text-align:left;width:100%;transition:border-color var(--t),background var(--t)}
.kc::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:2px;border-radius:0 2px 2px 0;background:var(--pc)}
.kc:hover{border-color:var(--border-2);background:var(--surface-2)}
.kc b{font-size:12.5px;font-weight:540;line-height:1.35;color:var(--text)}
.kc p{margin:0;font-size:11.5px;color:var(--text-2);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.kc .meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--text-3)}
.kc .meta .pn{color:var(--pc)}
.kc .meta .sp{flex:1}
.kc .quiet{color:var(--amber)}
.kc.attn{min-width:280px;max-width:320px}
.wb-more{margin-top:16px}
.wb-more details{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);margin-bottom:10px}
.wb-more summary{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;list-style:none;font-size:12px;font-weight:560;color:var(--text-2);text-transform:uppercase;letter-spacing:.06em}
.wb-more summary::-webkit-details-marker{display:none}
.wb-more summary .count{font-weight:400;color:var(--text-3);letter-spacing:0}
.wb-more summary .hint{margin-left:auto;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-3)}
.wb-list .r{display:grid;grid-template-columns:3px minmax(0,1fr) 140px 120px 80px;gap:12px;align-items:center;padding:7px 14px 7px 0;border-top:1px solid var(--border);font-size:12.5px;cursor:pointer}
.wb-list .r:hover{background:rgb(var(--ink)/.022)}
.wb-list .r i{height:18px;background:var(--pc);border-radius:0 2px 2px 0}
.wb-list .r span{color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wb-list .r b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wb-empty{padding:18px 8px;text-align:center;color:var(--text-3);font-size:12px}
dialog.wb-dlg{width:min(720px,94vw);max-height:86vh;border:1px solid var(--border-2);border-radius:var(--r-lg);background:var(--surface);color:var(--text);padding:0;box-shadow:var(--e3)}
dialog.wb-dlg::backdrop{background:rgba(0,0,0,.55)}
.dlg-h{display:flex;gap:10px;align-items:flex-start;padding:14px 16px;border-bottom:1px solid var(--border)}
.dlg-h h3{margin:0;font-size:15px;font-weight:600;letter-spacing:-.015em;line-height:1.35}
.dlg-b{padding:14px 16px;overflow:auto;max-height:calc(86vh - 140px);display:flex;flex-direction:column;gap:12px}
.dlg-b .detail{white-space:pre-wrap;font-size:12.5px;color:var(--text-2);line-height:1.55;max-height:200px;overflow:auto;padding:10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-1)}
.dlg-f{display:flex;gap:6px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--border);align-items:center}
.dlg-f .sp{flex:1}
.dlg-row{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px;font-size:12.5px}
.dlg-row span{color:var(--text-3)}
.ev{display:grid;grid-template-columns:94px minmax(0,1fr);gap:10px;padding:6px 0;border-top:1px solid var(--border);font-size:12px}
.ev time{color:var(--text-3);font:11px var(--mono)}
.ev b{font-weight:520}
.ev p{margin:2px 0 0;color:var(--text-2);white-space:pre-wrap;word-break:break-word}
.form{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.form label{display:flex;flex-direction:column;gap:4px;font-size:10.5px;font-weight:560;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em}
.form label.wide{grid-column:1/-1}
.form input,.form select,.form textarea{height:30px;padding:0 9px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg-1);color:var(--text);font-size:12.5px;text-transform:none;letter-spacing:0}
.form textarea{height:90px;padding:8px 9px;resize:vertical}
.wb-err{color:var(--red);font-size:12px}
@media(max-width:1200px){.wb-cols{grid-template-columns:1fr 1fr}.col{max-height:none}}
@media(max-width:700px){.wb{padding:14px 12px 40px}.wb-cols{grid-template-columns:1fr}.wb-list .r{grid-template-columns:3px minmax(0,1fr) 80px}.wb-list .r .h{display:none}}
`;

function makeBoardBody(board) {
  const body = `<div class="wb">
<div class="page-h"><div><h1>Work board</h1><div class="sub" id="wbSub"></div></div>
<div class="actions wb-tools"><select id="wbProduct" aria-label="Product"><option value="">All products</option></select><input id="wbQ" type="search" placeholder="Filter cards" autocomplete="off"><button class="hub-btn" type="button" id="wbAdd">${icon("plus", { size: 13 })}Add card</button></div></div>
<div class="wb-mon" id="wbMon"></div>
<div class="statbar" id="wbStats"></div>
<div id="wbAttnWrap"></div>
<div class="wb-cols">
<section class="col"><div class="col-h"><h2>In progress</h2><span class="count" id="cProgress"></span><span class="hint">grouped by who holds it</span></div><div class="col-b" id="lProgress"></div></section>
<section class="col"><div class="col-h"><h2>Next</h2><span class="count" id="cNext"></span><span class="hint">committed</span></div><div class="col-b" id="lNext"></div></section>
<section class="col"><div class="col-h"><h2>Blocked</h2><span class="count" id="cBlocked"></span><span class="hint">oldest first</span></div><div class="col-b" id="lBlocked"></div></section>
<section class="col"><div class="col-h"><h2>Done</h2><span class="count" id="cDone"></span><span class="hint">last 7 days</span></div><div class="col-b" id="lDone"></div></section>
</div>
<div class="wb-more">
<details id="dInbox"><summary>Inbox<span class="count" id="cInbox"></span><span class="hint">filed automatically, nobody has picked these up yet</span></summary><div class="wb-list" id="lInbox"></div></details>
<details id="dBacklog"><summary>Backlog<span class="count" id="cBacklog"></span><span class="hint">most recently touched first</span></summary><div class="wb-list" id="lBacklog"></div></details>
</div>
</div>
<dialog class="wb-dlg" id="wbDlg"></dialog>
<script type="application/json" id="wbData">${JSON.stringify(board).replace(/</g, "\\u003c")}</script>
<script>${BOARD_JS}</script>`;
  return { extraCss: BOARD_CSS, body };
}

const BOARD_JS = `(function(){
var B=JSON.parse(document.getElementById('wbData').textContent);var $=function(id){return document.getElementById(id)};
var PC={'a-house-divided':'#f85149','corporate-warfare':'#d29922','margin-of-victory':'#58a6ff','metroforge':'#3fb950','grand-century':'#a371f7','verdigris':'#2dd4bf','foreshore':'#f472b6','lakeside-mcp':'#4cc2d4'};
var PN={};B.products.forEach(function(p){PN[p.slug]=p.name});
var st={product:'',q:''};try{st.product=localStorage.getItem('wb-product')||''}catch(e){}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function rel(t){if(!t)return'';var s=Math.round((Date.now()-t)/1000);if(s<60)return'just now';if(s<3600)return Math.round(s/60)+'m ago';if(s<86400)return Math.round(s/3600)+'h ago';return Math.round(s/86400)+'d ago'}
function ini(n){var p=String(n||'?').split(/[\\s._-]+/).filter(Boolean);return((p[0]||'?')[0]+(p[1]?p[1][0]:'')).toUpperCase()}
function ok(c){if(st.product&&c.product!==st.product)return false;if(st.q){var h=(c.title+' '+c.progress+' '+c.owner+' '+(PN[c.product]||'')).toLowerCase();var w=st.q.toLowerCase().split(/\\s+/);for(var i=0;i<w.length;i++)if(h.indexOf(w[i])<0)return false}return true}
function card(c,extra){var q=c.lane==='now'&&c.quietDays>=B.quietDays;return'<button class="kc'+(extra?' '+extra:'')+'" type="button" data-id="'+c.id+'" style="--pc:'+(PC[c.product]||'#8b949e')+'"><b>'+esc(c.title)+'</b>'+(c.progress?'<p>'+esc(c.progress)+'</p>':'')+'<div class="meta"><span class="pn">'+esc(PN[c.product]||c.product)+'</span>'+(c.impact==='high'?'<span class="pill" style="--c:#f85149;height:18px">high</span>':'')+(c.github?'<span>#'+c.github.n+'</span>':'')+(c.evidence&&c.lane==='done'?'<span>evidence</span>':'')+'<span class="sp"></span>'+(q?'<span class="quiet">quiet '+c.quietDays+'d</span>':'<span>'+rel(c.lane==='done'?c.closedAt:c.lastAt)+'</span>')+'</div></button>'}
function row(c){return'<div class="r" data-id="'+c.id+'" style="--pc:'+(PC[c.product]||'#8b949e')+'"><i></i><b>'+esc(c.title)+'</b><span class="h">'+esc(PN[c.product]||c.product)+'</span><span class="h">'+(c.by?'filed by '+esc(c.by):'')+'</span><span>'+rel(c.lastAt)+'</span></div>'}
function list(arr,id,empty){var a=arr.filter(ok);$(id).innerHTML=a.length?a.map(function(c){return card(c)}).join(''):'<div class="wb-empty">'+empty+'</div>';return a.length}
function render(){
var sel=$('wbProduct');if(sel.options.length<2)sel.innerHTML+=B.products.map(function(p){return'<option value="'+esc(p.slug)+'">'+esc(p.name)+'</option>'}).join('');sel.value=st.product;
$('wbSub').textContent='What shipped, what is stuck and who is on what.'+(B.sync?' GitHub synced '+rel(Date.parse(B.sync))+'.':'');
$('wbMon').innerHTML=B.monitors.length?'<span>Always-on agents</span>'+B.monitors.map(function(m){var fresh=Date.now()-m.lastBeat<3*3600e3;return'<span class="m" data-id="'+m.id+'"><span class="dot" style="--c:'+(fresh?'#3fb950':'#d29922')+'"></span>'+esc(m.title.replace(/:.*$/,''))+' · '+rel(m.lastBeat)+'</span>'}).join(''):'';
var k=B.counts,mx=Math.max.apply(null,B.shippedByDay.map(function(d){return d.n}).concat([1]));
$('wbStats').innerHTML='<div class="stat"><div class="k">Shipped this week</div><div class="v">'+k.shipped+'</div><div class="wb-spark">'+B.shippedByDay.map(function(d){return'<i style="height:'+Math.max(8,d.n/mx*100)+'%" title="'+d.day+': '+d.n+'"></i>'}).join('')+'</div></div>'+
'<div class="stat"><div class="k">In progress</div><div class="v">'+k.progress+'</div><div class="s">across '+Object.keys(B.progress.reduce(function(o,c){o[c.owner||'?']=1;return o},{})).length+' owners</div></div>'+
'<div class="stat"><div class="k">Stuck</div><div class="v">'+k.stuck+'</div><div class="s">'+(k.stuck?'<span class="warn">blocked or quiet '+B.quietDays+'+ days</span>':'nothing stuck')+'</div></div>'+
'<div class="stat"><div class="k">Next</div><div class="v">'+k.next+'</div><div class="s">picked, not started</div></div>'+
'<div class="stat"><div class="k">Inbox</div><div class="v">'+k.inbox+'</div><div class="s">filed, not picked up</div></div>';
var quiet=B.progress.filter(function(c){return c.quietDays>=B.quietDays&&ok(c)});
$('wbAttnWrap').innerHTML=quiet.length?'<div class="sec-h" style="margin-top:0"><h2>Gone quiet</h2><span class="count">'+quiet.length+'</span><span style="font-size:11.5px;color:var(--text-3)">in progress but no update for '+B.quietDays+'+ days. Open one to move it back to Next.</span></div><div class="wb-attn">'+quiet.map(function(c){return card(c,'attn')}).join('')+'</div>':'';
var prog=B.progress.filter(function(c){return ok(c)&&!(c.quietDays>=B.quietDays)});var groups={};prog.forEach(function(c){var o=c.owner||'Unassigned';(groups[o]=groups[o]||[]).push(c)});
var names=Object.keys(groups).sort(function(a,b){return groups[b].length-groups[a].length});
$('lProgress').innerHTML=names.length?names.map(function(n){return'<div class="grp"><span class="av">'+esc(ini(n))+'</span>'+esc(n)+' · '+groups[n].length+'</div>'+groups[n].map(function(c){return card(c)}).join('')}).join(''):'<div class="wb-empty">Nothing in progress.</div>';
$('cProgress').textContent=prog.length;
$('cNext').textContent=list(B.next,'lNext','Nothing queued.');$('cBlocked').textContent=list(B.blocked,'lBlocked','Nothing blocked.');$('cDone').textContent=list(B.done,'lDone','Nothing shipped this week yet.');
var ib=B.inbox.filter(ok),bl=B.backlog.filter(ok);$('cInbox').textContent=ib.length;$('cBacklog').textContent=bl.length;
$('lInbox').innerHTML=ib.slice(0,300).map(row).join('')||'<div class="wb-empty">Inbox is empty.</div>';$('lBacklog').innerHTML=bl.slice(0,300).map(row).join('')||'<div class="wb-empty">Backlog is empty.</div>'}
render();
$('wbProduct').addEventListener('change',function(){st.product=this.value;try{localStorage.setItem('wb-product',st.product)}catch(e){}render()});
var t;$('wbQ').addEventListener('input',function(){var v=this.value;clearTimeout(t);t=setTimeout(function(){st.q=v.trim();render()},90)});
function api(method,url,body){return fetch(url,{method:method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-Requested-With':'ops-dashboard'},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d})})}
function reload(){fetch('/api/hub/board',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(d){B=d;render()})}
var dlg=$('wbDlg');
function openCard(id){dlg.innerHTML='<div class="dlg-b"><div class="wb-empty">Loading…</div></div>';dlg.showModal();api('GET','/api/kanban/items/'+id).then(function(it){
var lanes=['now','next','blocked','backlog','done'],LN={now:'In progress',next:'Next',blocked:'Blocked',backlog:'Backlog',done:'Done'};
var ev=(it.events||[]).filter(function(e){return !(e.event_type==='progress'&&/^[{[]|"\\w+":/.test(String(e.summary||'').slice(0,80)))}).slice(0,25).map(function(e){return'<div class="ev"><time>'+esc(String(e.created_at||'').slice(5,16).replace('T',' '))+'</time><div><b>'+esc(e.event_type)+'</b> <span style="color:var(--text-3)">'+esc(e.actor||'')+'</span>'+(e.summary?'<p>'+esc(String(e.summary).slice(0,600))+'</p>':'')+(e.evidence_url?'<p><a class="link" style="color:var(--accent)" href="'+esc(e.evidence_url)+'" target="_blank" rel="noopener">evidence</a></p>':'')+'</div></div>'}).join('');
dlg.innerHTML='<div class="dlg-h"><div style="flex:1;min-width:0"><div style="font-size:11px;color:var(--text-3);margin-bottom:4px">'+esc(PN[it.product]||it.product)+' · #'+it.id+' · '+esc(LN[it.lane]||it.lane)+'</div><h3>'+esc(it.title)+'</h3></div><button class="hub-icon-btn" type="button" data-close aria-label="Close">'+'✕'+'</button></div>'+
'<div class="dlg-b"><div class="dlg-row"><span>Held by</span><div>'+esc(it.assigned_to||'Nobody')+'</div></div><div class="dlg-row"><span>Impact</span><div>'+esc(it.impact)+' · '+esc(it.kind||'')+'</div></div>'+(it.github?'<div class="dlg-row"><span>GitHub</span><div><a style="color:var(--accent)" href="'+esc(it.github.url)+'" target="_blank" rel="noopener">'+esc(it.github.repo)+'#'+it.github.number+'</a></div></div>':'')+(it.evidence_url?'<div class="dlg-row"><span>Evidence</span><div><a style="color:var(--accent)" href="'+esc(it.evidence_url)+'" target="_blank" rel="noopener">link</a></div></div>':'')+
(it.detail?'<div class="detail">'+esc(it.detail)+'</div>':'')+'<div class="form"><label class="wide">Add a note<textarea id="dNote" placeholder="What changed? Visible to agents and people."></textarea></label></div><div>'+(ev||'<div class="wb-empty">No history.</div>')+'</div><div class="wb-err" id="dErr"></div></div>'+
'<div class="dlg-f"><span style="font-size:11px;color:var(--text-3)">Move to</span>'+lanes.filter(function(l){return l!==it.lane}).map(function(l){return'<button class="hub-btn ghost" type="button" data-lane="'+l+'">'+LN[l]+'</button>'}).join('')+'<span class="sp"></span><button class="hub-btn ghost" type="button" data-release>Release</button><button class="hub-btn" type="button" data-note>Save note</button></div>';
dlg.querySelector('[data-close]').onclick=function(){dlg.close()};
function err(e){$('dErr').textContent=e.message}
dlg.querySelectorAll('[data-lane]').forEach(function(b){b.onclick=function(){api('POST','/api/kanban/items/'+it.id,{lane:b.getAttribute('data-lane')}).then(function(){dlg.close();reload()}).catch(err)}});
dlg.querySelector('[data-release]').onclick=function(){api('POST','/api/kanban/items/'+it.id,{lane:'next',assigned_to:''}).then(function(){dlg.close();reload()}).catch(err)};
dlg.querySelector('[data-note]').onclick=function(){var v=$('dNote').value.trim();if(!v)return;api('POST','/api/kanban/items/'+it.id+'/report',{event:'progress',summary:v}).then(function(){dlg.close();reload()}).catch(err)}}).catch(function(e){dlg.innerHTML='<div class="dlg-b"><div class="wb-err">'+esc(e.message)+'</div></div>'})}
document.addEventListener('click',function(e){var c=e.target.closest('[data-id]');if(c&&!dlg.contains(c))openCard(c.getAttribute('data-id'))});
dlg.addEventListener('click',function(e){if(e.target===dlg)dlg.close()});
$('wbAdd').addEventListener('click',function(){dlg.innerHTML='<div class="dlg-h"><h3 style="flex:1">Add a card</h3><button class="hub-icon-btn" type="button" data-close>✕</button></div><div class="dlg-b"><div class="form"><label class="wide">Title<input id="aT" maxlength="300"></label><label>Product<select id="aP">'+B.products.map(function(p){return'<option value="'+esc(p.slug)+'"'+(p.slug===st.product?' selected':'')+'>'+esc(p.name)+'</option>'}).join('')+'</select></label><label>Lane<select id="aL"><option value="next">Next</option><option value="now">In progress</option><option value="backlog">Backlog</option><option value="blocked">Blocked</option></select></label><label>Impact<select id="aI"><option>medium</option><option>high</option><option>low</option></select></label><label class="wide">Detail<textarea id="aD"></textarea></label></div><div class="wb-err" id="aE"></div></div><div class="dlg-f"><span class="sp"></span><button class="hub-btn" type="button" id="aGo">Add</button></div>';dlg.showModal();
dlg.querySelector('[data-close]').onclick=function(){dlg.close()};
$('aGo').onclick=function(){var t=$('aT').value.trim();if(!t){$('aE').textContent='Give it a title.';return}api('POST','/api/kanban/items',{title:t,product:$('aP').value,lane:$('aL').value,impact:$('aI').value,detail:$('aD').value}).then(function(){dlg.close();reload()}).catch(function(e){$('aE').textContent=e.message})}});
setInterval(function(){if(!document.hidden&&!dlg.open)reload()},60000);
})();`;

module.exports = { buildBoard, makeBoardBody, ownerName, cleanProgress };
