"use strict";

// kanban-page.js: the admin product kanban (/kanban).
//
// Data lives in kanban-store.js (SQLite, OPS_KANBAN_DB), shared with the
// ops-knowledge MCP tools agents use. The server embeds the board JSON; the
// client renders it and talks to /api/kanban for edits, then re-renders from
// the response. Owner decisions are pulled out of their lanes into one
// "Needs owner" section so they are never scattered.
//
// Returns { extraCss, body } like every other page here.

const KANBAN_CSS = `
.kb-wrap{max-width:1500px;margin:0 auto;padding:var(--s-5,24px) var(--s-4,16px);display:flex;flex-direction:column;gap:16px}
.kb-head{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:10px}
.kb-head h1{font-size:1.4rem;font-weight:700;letter-spacing:-.02em;margin:0}
.kb-sub{color:var(--text-3);font-size:.82rem}
.kb-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.kb-bar select,.kb-bar input[type=search]{padding:.42rem .7rem;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);font:500 .82rem var(--font)}
.kb-bar input[type=search]{min-width:220px}
.kb-btn{padding:.42rem .85rem;border:1px solid var(--border);border-radius:var(--r-full,999px);background:var(--surface);color:var(--text-2);font:600 .8rem var(--font);cursor:pointer}
.kb-btn:hover{color:var(--text)}
.kb-btn.on,.kb-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent,#fff)}
.kb-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.kb-stat{border:1px solid var(--border);border-radius:12px;background:var(--surface);padding:10px 13px}
.kb-stat .n{font-size:1.35rem;font-weight:700;font-variant-numeric:tabular-nums}
.kb-stat .l{color:var(--text-3);font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.kb-stat.warn .n{color:var(--warn,#b07700)}
.kb-section{border:1px solid var(--border);border-radius:13px;background:var(--surface);padding:12px}
.kb-section.owner{border-color:color-mix(in srgb,var(--amber,#b07700) 45%,var(--border))}
.kb-section > h2,.kb-lane > h2{font-size:.78rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text-2);margin:0 0 10px;display:flex;gap:8px;align-items:center}
.kb-section > h2 .c,.kb-lane > h2 .c{color:var(--text-3);font-variant-numeric:tabular-nums}
.kb-owner-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px}
.kb-lanes{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:start}
.kb-lane{border:1px solid var(--border);border-radius:13px;background:var(--surface);padding:10px;display:flex;flex-direction:column;gap:8px;max-height:78vh;overflow:auto}
.kb-card{border:1px solid var(--border);border-radius:10px;background:var(--bg,transparent);padding:9px 10px;display:flex;flex-direction:column;gap:6px}
.kb-card.stale{border-left:3px solid var(--amber,#b07700)}
.kb-card .t{background:none;border:0;padding:0;text-align:left;color:var(--text);font:600 .84rem/1.35 var(--font);cursor:pointer}
.kb-card .t:hover{color:var(--accent)}
.kb-meta{display:flex;gap:5px;flex-wrap:wrap;align-items:center;font-size:.7rem;color:var(--text-3)}
.kb-chip{padding:1px 7px;border-radius:999px;border:1px solid var(--border);font-size:.66rem;font-weight:700;white-space:nowrap;color:var(--text-2)}
.kb-chip.high{color:var(--danger,#dc4444);border-color:color-mix(in srgb,var(--danger,#dc4444) 45%,var(--border));background:var(--red-soft,transparent)}
.kb-chip.low{color:var(--text-3)}
.kb-chip.stale{color:var(--warn,#b07700);border-color:color-mix(in srgb,var(--amber,#b07700) 50%,var(--border));background:var(--amber-soft,transparent)}
.kb-chip.lane{color:var(--accent)}
.kb-meta a{color:var(--text-2);font-weight:700}
.kb-meta a:hover{color:var(--text)}
.kb-move{margin-left:auto;padding:1px 4px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-3);font:600 .68rem var(--font)}
.kb-empty{color:var(--text-3);font-size:.8rem;padding:6px 2px}
.kb-err{border:1px solid color-mix(in srgb,var(--danger,#dc4444) 45%,var(--border));background:var(--red-soft,transparent);color:var(--danger,#dc4444);padding:10px 13px;border-radius:10px;font-size:.84rem}
dialog.kb-dlg{width:min(760px,94vw);border:1px solid var(--border);border-radius:14px;background:var(--surface);color:var(--text);padding:18px}
dialog.kb-dlg::backdrop{background:rgba(0,0,0,.55)}
.kb-form{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.kb-form label{display:flex;flex-direction:column;gap:4px;font-size:.72rem;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em}
.kb-form label.wide{grid-column:1/-1}
.kb-form label.check{flex-direction:row;align-items:center;gap:8px}
.kb-form input,.kb-form select,.kb-form textarea{padding:.45rem .6rem;border:1px solid var(--border);border-radius:8px;background:var(--bg,var(--surface));color:var(--text);font:500 .85rem var(--font);text-transform:none;letter-spacing:0}
.kb-form textarea{min-height:120px;resize:vertical}
.kb-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:12px}
.kb-hist{margin-top:14px;border-top:1px solid var(--border);padding-top:10px;max-height:240px;overflow:auto;font-size:.78rem}
.kb-hist div{padding:4px 0;border-bottom:1px solid var(--border);color:var(--text-2)}
.kb-hist b{color:var(--text)}
.kb-hist time{color:var(--text-3);font-variant-numeric:tabular-nums}
.kb-progress{font-size:.74rem;color:var(--text-3);line-height:1.4;max-height:3.2em;overflow:hidden}
@media(max-width:1100px){.kb-lanes{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:640px){.kb-lanes{grid-template-columns:1fr}.kb-form{grid-template-columns:1fr}}
`;

// The client script. Every string that reaches innerHTML passes through esc(),
// and only http(s) URLs become links.
const KANBAN_JS = `
(function(){
const LANES=[["now","Now"],["next","Next"],["blocked","Blocked"],["backlog","Backlog"]];
const ALL_LANES=LANES.concat([["done","Done"]]);
let board=JSON.parse(document.getElementById('kb-data').textContent);
const readOnly=document.getElementById('kb-data').dataset.readOnly==='true';
const collaborator=JSON.parse(document.getElementById('kb-collab-actor').textContent);
const st={product:'',stale:false,q:''};
const $=s=>document.querySelector(s);
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl=u=>/^https?:\\/\\//i.test(String(u||''))?String(u):null;
const ago=iso=>{const ms=Date.now()-Date.parse(iso);if(!isFinite(ms))return '';const d=Math.floor(ms/864e5);if(d>0)return d+'d ago';const h=Math.floor(ms/36e5);return h>0?h+'h ago':'just now'};
const productName=slug=>{const p=board.products.find(p=>p.slug===slug);return p?p.name:slug};
async function api(method,url,body){
  const r=await fetch(url,{method,headers:{'Content-Type':'application/json','X-Requested-With':'ops-dashboard'},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});
  const data=await r.json().catch(()=>({error:'HTTP '+r.status}));
  if(!r.ok)throw new Error(data.error||('HTTP '+r.status));
  return data;
}
function flash(msg){const e=$('#kb-msg');e.textContent=msg||'';e.hidden=!msg}
async function reload(){board=await api('GET','/api/kanban');render()}
function visible(){
  const q=st.q.toLowerCase();
  return board.items.filter(i=>(!st.product||i.product===st.product)&&(!st.stale||i.stale)&&(!q||(i.title+' '+(i.detail_excerpt||'')+' '+(i.progress_summary||'')).toLowerCase().includes(q)));
}
function card(i,showLane){
  const gh=i.github&&safeUrl(i.github.url);
  const ev=safeUrl(i.evidence_url);
  const moves=ALL_LANES.map(([k,l])=>'<option value="'+k+'"'+(k===i.lane?' selected':'')+'>'+l+'</option>').join('');
  return '<div class="kb-card'+(i.stale?' stale':'')+'" data-id="'+i.id+'">'
   +'<button class="t" data-open="'+i.id+'">'+esc(i.title)+'</button>'
   +(i.progress_summary?'<div class="kb-progress">'+esc(i.progress_summary)+'</div>':'')
   +'<div class="kb-meta">'
   +(showLane?'<span class="kb-chip lane">'+esc(i.lane)+'</span>':'')
   +(st.product?'':'<span class="kb-chip">'+esc(productName(i.product))+'</span>')
   +(i.impact!=='medium'?'<span class="kb-chip '+esc(i.impact)+'">'+esc(i.impact)+'</span>':'')
   +(i.stale?'<span class="kb-chip stale" title="'+esc(i.stale_reason)+'">stale</span>':'')
   +(gh?'<a href="'+esc(gh)+'" target="_blank" rel="noopener">'+esc(i.github.repo.split('/')[1])+'#'+esc(i.github.number)+'</a>':'')
   +(ev?'<a href="'+esc(ev)+'" target="_blank" rel="noopener">evidence</a>':'')
   +(i.assigned_to?'<span>'+esc(i.assigned_to)+'</span>':'')
   +'<span title="'+esc(i.updated_at)+'">'+esc(ago(i.updated_at))+'</span>'
   +(readOnly?'':'<select class="kb-move" data-move="'+i.id+'" aria-label="Move">'+moves+'</select>')
   +'</div></div>';
}
function render(){
  const items=visible();
  const owner=items.filter(i=>i.needs_owner);
  const rest=items.filter(i=>!i.needs_owner);
  const n=k=>rest.filter(i=>i.lane===k).length;
  const stale=items.filter(i=>i.stale).length;
  const statsHtml=[['Needs owner',owner.length,owner.length?'warn':''],['Now',n('now')],['Blocked',n('blocked')],['Next',n('next')],['Backlog',n('backlog')],['Stale',stale,stale?'warn':'']]
    .map(([l,v,c])=>'<div class="kb-stat '+esc(c||'')+'"><div class="n">'+esc(v)+'</div><div class="l">'+esc(l)+'</div></div>').join('');
  $('#kb-stats').innerHTML=statsHtml;
  // card() escapes every item field; the rest are constants and counts.
  const ownerHtml='<h2>Needs owner <span class="c">'+esc(owner.length)+'</span></h2>'+(owner.length?'<div class="kb-owner-grid">'+owner.map(i=>card(i,true)).join('')+'</div>':'<div class="kb-empty">Nothing waiting on the owner.</div>');
  $('#kb-owner').innerHTML=ownerHtml;
  const lanesHtml=LANES.map(([k,l])=>{const list=rest.filter(i=>i.lane===k);return '<section class="kb-lane" data-lane="'+esc(k)+'"><h2>'+esc(l)+' <span class="c">'+esc(list.length)+'</span></h2>'+(list.length?list.map(i=>card(i,false)).join(''):'<div class="kb-empty">Empty</div>')+'</section>'}).join('');
  $('#kb-lanes').innerHTML=lanesHtml;
  const sync=(board.github_sources||[]).filter(s=>s.enabled);
  const last=sync.map(s=>s.last_sync_at).filter(Boolean).sort().pop();
  const errs=sync.filter(s=>s.last_error);
  $('#kb-sync').textContent=(last?'GitHub sync '+ago(last):'GitHub sync has not run')+(errs.length?' ('+errs.length+' repo errors)':'')+' . stale = in Now with no update for '+board.stale_days+'+ days';
}
function productOptions(sel){return board.products.map(p=>'<option value="'+esc(p.slug)+'"'+(p.slug===sel?' selected':'')+'>'+esc(p.name)+'</option>').join('')}
async function openItem(id){
  flash('');
  let item;
  try{item=await api('GET','/api/kanban/items/'+id)}catch(e){return flash(e.message)}
  const f=$('#kb-edit-form');
  f.dataset.id=item.id;
  f.elements.title.value=item.title;f.elements.detail.value=item.detail||'';
  f.elements.product.innerHTML=productOptions(item.product);
  f.elements.lane.value=item.lane;f.elements.impact.value=item.impact;
  f.elements.needs_owner.checked=item.needs_owner;f.elements.assigned_to.value=item.assigned_to||'';
  f.elements.github.value=item.github?item.github.url:'';f.elements.evidence_url.value=item.evidence_url||'';
  f.elements.note.value='';
  const headHtml='#'+esc(item.id)+(item.stale?' <span class="kb-chip stale">stale: '+esc(item.stale_reason)+'</span>':'')+(item.aliases&&item.aliases.length?' <span class="kb-sub">merged from '+item.aliases.map(a=>'#'+esc(a.alias_id)).join(', ')+'</span>':'');
  $('#kb-edit-head').innerHTML=headHtml;
  const histHtml=(item.events||[]).map(e=>'<div><time>'+esc((e.created_at||'').slice(0,16).replace('T',' '))+'</time> <b>'+esc(e.event_type)+'</b> '+esc(e.actor)+': '+esc(e.summary)+(safeUrl(e.evidence_url)?' <a href="'+esc(e.evidence_url)+'" target="_blank" rel="noopener">evidence</a>':'')+'</div>').join('')||'<div>No history.</div>';
  $('#kb-hist').innerHTML=histHtml;
  f.querySelectorAll('input,select,textarea,button[type=submit]').forEach(el=>{el.disabled=readOnly});
  const own=item.assigned_to===collaborator;
  const available=!item.assigned_to||own;
  const active=item.lane!=='done'&&item.kind!=='monitor';
  document.querySelectorAll('[data-collaborate]').forEach(el=>{
    el.hidden=!collaborator||!active||(el.dataset.collaborate==='claim'?!available:!own);
  });
  $('#kb-collab-note').value='';$('#kb-collab-evidence').value='';
  $('#kb-collab-note').disabled=!own;$('#kb-collab-evidence').disabled=!own;
  $('#kb-edit').showModal();
}
document.addEventListener('click',e=>{const t=e.target.closest('[data-open]');if(t)openItem(t.dataset.open)});
document.querySelectorAll('[data-collaborate]').forEach(button=>button.addEventListener('click',async()=>{
  const id=$('#kb-edit-form').dataset.id;
  const action=button.dataset.collaborate;
  const summary=$('#kb-collab-note').value.trim();
  const evidence_url=$('#kb-collab-evidence').value.trim()||undefined;
  if(action!=='claim'&&!summary)return alert('Add a progress or handoff note first.');
  button.disabled=true;
  try{
    await api('POST','/api/kanban/items/'+id+'/collaborate',{action,summary:summary||'Claimed task',evidence_url});
    $('#kb-edit').close();await reload();
  }catch(error){alert(error.message)}finally{button.disabled=false}
}));
document.addEventListener('change',async e=>{
  const m=e.target.closest('[data-move]');if(!m)return;
  try{await api('POST','/api/kanban/items/'+m.dataset.move,{lane:m.value});await reload();flash('')}catch(err){flash(err.message)}
});
$('#kb-edit-form').addEventListener('submit',async e=>{
  e.preventDefault();if(readOnly)return;const f=e.target;const id=f.dataset.id;
  try{
    await api('POST','/api/kanban/items/'+id,{title:f.elements.title.value,detail:f.elements.detail.value,product:f.elements.product.value,lane:f.elements.lane.value,impact:f.elements.impact.value,needs_owner:f.elements.needs_owner.checked,assigned_to:f.elements.assigned_to.value,github:f.elements.github.value,evidence_url:f.elements.evidence_url.value});
    if(f.elements.note.value.trim())await api('POST','/api/kanban/items/'+id+'/report',{event:'progress',summary:f.elements.note.value});
    $('#kb-edit').close();await reload();
  }catch(err){alert(err.message)}
});
$('#kb-add-btn').addEventListener('click',()=>{const f=$('#kb-add-form');f.reset();f.elements.product.innerHTML=productOptions(st.product||'a-house-divided');$('#kb-add').showModal()});
$('#kb-add-form').addEventListener('submit',async e=>{
  e.preventDefault();const f=e.target;
  try{await api('POST','/api/kanban/items',{product:f.elements.product.value,title:f.elements.title.value,detail:f.elements.detail.value,lane:f.elements.lane.value,impact:f.elements.impact.value,needs_owner:f.elements.needs_owner.checked,github:f.elements.github.value||undefined});$('#kb-add').close();await reload()}
  catch(err){alert(err.message)}
});
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
const pf=$('#kb-product');const productFilterHtml='<option value="">All products</option>'+productOptions('');pf.innerHTML=productFilterHtml;
pf.addEventListener('change',()=>{st.product=pf.value;render()});
$('#kb-stale').addEventListener('click',e=>{st.stale=!st.stale;e.target.classList.toggle('on',st.stale);render()});
$('#kb-q').addEventListener('input',e=>{st.q=e.target.value;render()});
$('#kb-refresh').addEventListener('click',()=>reload().catch(error=>flash(error.message)));
render();
})();
`;

const LANE_OPTIONS = '<option value="now">Now</option><option value="next">Next</option><option value="blocked">Blocked</option><option value="backlog">Backlog</option>';
const IMPACT_OPTIONS = '<option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>';

function makeKanbanBody({ board, error = null, readOnly = false, collaborator = "" }) {
  // JSON inside <script type="application/json">: escape "<" so no value can
  // close the element.
  const data = JSON.stringify(board || { products: [], items: [], github_sources: [], stale_days: 5 }).replace(/</g, "\\u003c");
  const body = `<div class="kb-wrap">
  <div class="kb-head"><div><h1>Work board${readOnly && !collaborator ? ' (read-only)' : ''}</h1><div class="kb-sub" id="kb-sync"></div></div>
    <div class="kb-bar"><select id="kb-product" aria-label="Product"></select><input type="search" id="kb-q" placeholder="Filter" aria-label="Filter"><button class="kb-btn" id="kb-refresh" type="button">Refresh</button><button class="kb-btn" id="kb-stale" type="button">Stale only</button><button class="kb-btn primary" id="kb-add-btn" type="button" ${readOnly ? 'hidden disabled' : ''}>Add item</button></div></div>
  ${error ? `<div class="kb-err">Kanban store unavailable: ${String(error).replace(/[&<>"']/g, "")}</div>` : ""}
  <div class="kb-err" id="kb-msg" hidden></div>
  <div class="kb-stats" id="kb-stats"></div>
  <section class="kb-section owner" id="kb-owner"></section>
  <div class="kb-lanes" id="kb-lanes"></div>
</div>
<dialog class="kb-dlg" id="kb-edit"><form id="kb-edit-form" method="dialog">
  <div class="kb-sub" id="kb-edit-head" style="margin-bottom:10px"></div>
  <div class="kb-form">
    <label class="wide">Title<input name="title" required maxlength="300"></label>
    <label>Product<select name="product"></select></label>
    <label>Lane<select name="lane">${LANE_OPTIONS}<option value="done">Done</option></select></label>
    <label>Impact<select name="impact">${IMPACT_OPTIONS}</select></label>
    <label>Assigned to<input name="assigned_to" maxlength="120"></label>
    <label>GitHub issue<input name="github" placeholder="owner/repo#N or URL"></label>
    <label>Evidence URL<input name="evidence_url" placeholder="https://..."></label>
    <label class="check wide"><input type="checkbox" name="needs_owner"> Needs owner decision</label>
    <label class="wide">Detail<textarea name="detail"></textarea></label>
    <label class="wide">Add a progress note<input name="note" maxlength="4000" placeholder="Optional"></label>
  </div>
  <div class="kb-actions"><button class="kb-btn" type="button" data-close>Cancel</button><button class="kb-btn primary" type="submit">Save</button></div>
  <section id="kb-collaboration" ${collaborator ? '' : 'hidden'}>
    <p>Claim an unassigned task before coding. Add a note for progress, blockers or handoff; completion requires an evidence link.</p>
    <div class="kb-form"><label class="wide">Progress or handoff note<textarea id="kb-collab-note" maxlength="4000"></textarea></label>
    <label class="wide">Evidence URL<input id="kb-collab-evidence" type="url" placeholder="https://..."></label></div>
    <div class="kb-actions">${["claim", "progress", "blocked", "resume", "release", "completed"].map(action => `<button class="kb-btn" type="button" data-collaborate="${action}">${({ claim: "Claim task", progress: "Post progress", blocked: "Mark blocked", resume: "Resume", release: "Release task", completed: "Complete" })[action]}</button>`).join("")}</div>
  </section>
  <div class="kb-hist" id="kb-hist"></div>
</form></dialog>
<dialog class="kb-dlg" id="kb-add"><form id="kb-add-form" method="dialog">
  <div class="kb-form">
    <label class="wide">Title<input name="title" required maxlength="300"></label>
    <label>Product<select name="product"></select></label>
    <label>Lane<select name="lane">${LANE_OPTIONS}</select></label>
    <label>Impact<select name="impact">${IMPACT_OPTIONS.replace('value="medium"', 'value="medium" selected')}</select></label>
    <label>GitHub issue<input name="github" placeholder="owner/repo#N or URL"></label>
    <label class="check wide"><input type="checkbox" name="needs_owner"> Needs owner decision</label>
    <label class="wide">Detail<textarea name="detail"></textarea></label>
  </div>
  <div class="kb-actions"><button class="kb-btn" type="button" data-close>Cancel</button><button class="kb-btn primary" type="submit">Add</button></div>
</form></dialog>
<script type="application/json" id="kb-data" data-read-only="${readOnly}">${data}</script>
<script type="application/json" id="kb-collab-actor">${JSON.stringify(collaborator).replace(/</g, "\\u003c")}</script>
<script>${KANBAN_JS}</script>`;
  return { extraCss: KANBAN_CSS, body };
}

module.exports = { makeKanbanBody, KANBAN_CSS };
