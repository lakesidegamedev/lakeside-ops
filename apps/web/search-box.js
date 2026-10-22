// search-box.js — Vercel-mobile-inspired intelligent search for the dashboard.
// Instant client-side keyword filter on keystroke, then overlays a DeepSeek
// (Ollama) semantic rerank + one-line answer from /api/search.
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

const SEARCH_CSS = `
.osearch{position:relative;margin-bottom:16px;max-width:680px}
.osearch-field{display:flex;align-items:center;gap:9px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:0 12px;height:46px;transition:border-color .14s}
.osearch-field:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}
.osearch-field svg{flex-shrink:0;color:var(--text-3)}
.osearch-field input{flex:1;border:none;background:none;outline:none;color:var(--text);font:inherit;font-size:.95rem}
.osearch-field input::placeholder{color:var(--text-3)}
.osearch-kbd{font-size:.66rem;color:var(--text-3);border:1px solid var(--border);border-radius:6px;padding:2px 6px;font-family:ui-monospace,monospace}
.osearch-panel{position:absolute;top:52px;left:0;right:0;z-index:60;background:var(--surface);border:1px solid var(--border);border-radius:13px;box-shadow:0 16px 48px rgba(0,0,0,.35);overflow:hidden;max-height:64vh;overflow-y:auto}
.osearch-answer{padding:11px 14px;font-size:.85rem;line-height:1.5;color:var(--text-2);background:color-mix(in srgb,var(--accent) 7%,var(--surface));border-bottom:1px solid var(--border)}
.osearch-item{display:flex;align-items:center;gap:11px;padding:10px 13px;text-decoration:none;color:inherit;border-bottom:1px solid color-mix(in srgb,var(--border) 55%,transparent)}
.osearch-item:last-child{border-bottom:none}
.osearch-item.on,.osearch-item:hover{background:var(--surface-2,color-mix(in srgb,var(--accent) 9%,var(--surface)))}
.osearch-mono{width:30px;height:30px;flex-shrink:0;border-radius:8px;background:color-mix(in srgb,var(--accent) 16%,var(--surface));color:var(--accent);font-weight:700;display:flex;align-items:center;justify-content:center;font-size:.9rem}
.osearch-meta{flex:1;min-width:0;display:flex;flex-direction:column}
.osearch-name{font-size:.9rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.osearch-desc{font-size:.78rem;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.osearch-grp{font-size:.66rem;color:var(--text-3);border:1px solid var(--border);border-radius:999px;padding:1px 8px;flex-shrink:0}
.osearch-empty{padding:16px 14px;color:var(--text-3);font-size:.85rem}
.osearch-field.glow{border-color:var(--accent);animation:osGlow 1.8s ease-in-out infinite}
@keyframes osGlow{0%,100%{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 11%,transparent),0 0 14px -2px color-mix(in srgb,var(--accent) 30%,transparent)}50%{box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 22%,transparent),0 0 26px 0 color-mix(in srgb,var(--accent) 48%,transparent)}}
.osearch-sugg-h{padding:10px 14px 4px;font-size:.64rem;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3)}
.osearch-sugg{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;color:var(--text-2);font-size:.88rem;border-bottom:1px solid color-mix(in srgb,var(--border) 50%,transparent)}
.osearch-sugg:last-child{border-bottom:none}
.osearch-sugg:hover{background:var(--surface-2,color-mix(in srgb,var(--accent) 9%,var(--surface)));color:var(--text)}
.osearch-sugg .ic{color:var(--accent);opacity:.8}
`;

const SEARCH_ICON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.3-4.3"></path></svg>';

function renderSearchBox(catalog) {
  const slim = (catalog || []).map((c) => ({ id: c.id, name: c.name, desc: c.desc, url: c.url, ext: !!c.ext, group: c.group, keywords: c.keywords || [] }));
  return `
<div class="osearch" id="osearch">
  <div class="osearch-field">${SEARCH_ICON}<input id="osearch-input" type="text" placeholder="Search services, pages, tools…" autocomplete="off" spellcheck="false"><kbd class="osearch-kbd">⌘K</kbd></div>
  <div class="osearch-panel" id="osearch-panel" hidden><div class="osearch-answer" id="osearch-answer" hidden></div><div id="osearch-results"></div></div>
</div>
<script>(function(){
  var CAT=${JSON.stringify(slim)};
  var input=document.getElementById('osearch-input'), panel=document.getElementById('osearch-panel'),
      resBox=document.getElementById('osearch-results'), ansBox=document.getElementById('osearch-answer'),
      field=document.querySelector('#osearch .osearch-field');
  var curList=[], curAnswer=null, sel=-1, timer=null, esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
  function setHtml(el,html){if(!el)return;if(window.OpsDom&&OpsDom.setTrustedHtml)OpsDom.setTrustedHtml(el,html);}
  var SUGG=["where do I see errors","server cpu and memory","player retention","recent deploys","open tickets","today's report","game engine health","session replays","database explorer","community ideas","uptime status","web traffic analytics","launch a code agent","swap / memory pressure","ask about the codebase","failed turns","economy and inflation","agent MCP tokens","database backups","what is down right now"];
  function showSuggestions(){
    var picks=SUGG.slice().sort(function(){return Math.random()-0.5;}).slice(0,3);
    ansBox.hidden=true;
    setHtml(resBox,'<div class="osearch-sugg-h">Try searching</div>'+picks.map(function(s){return '<div class="osearch-sugg" data-q="'+esc(s)+'"><span class="ic">⌕</span>'+esc(s)+'</div>';}).join(''));
    panel.hidden=false;
    resBox.querySelectorAll('.osearch-sugg').forEach(function(el){ el.addEventListener('mousedown',function(ev){ ev.preventDefault(); input.value=el.getAttribute('data-q'); input.focus(); run(); }); });
  }
  function kw(q){ q=q.toLowerCase(); var ts=q.split(/\\s+/).filter(Boolean);
    return CAT.map(function(c){ var hay=(c.name+' '+c.desc+' '+c.keywords.join(' ')).toLowerCase(), s=0;
      ts.forEach(function(t){ if(c.name.toLowerCase().indexOf(t)>=0)s+=5; if(c.keywords.indexOf(t)>=0)s+=4; if(hay.indexOf(t)>=0)s+=2; }); return {c:c,s:s}; })
      .filter(function(x){return x.s>0;}).sort(function(a,b){return b.s-a.s;}).map(function(x){return x.c;}); }
  function paint(){
    if(!input.value.trim()){ panel.hidden=true; return; }
    setHtml(resBox, curList.length ? curList.slice(0,8).map(function(c,i){
      return '<a class="osearch-item'+(i===sel?' on':'')+'" href="'+esc(c.url)+'"'+(c.ext?' target="_blank" rel="noopener"':'')+'>'+
        '<span class="osearch-mono">'+esc(c.name.charAt(0))+'</span><span class="osearch-meta">'+
        '<span class="osearch-name">'+esc(c.name)+(c.ext?' ↗':'')+'</span><span class="osearch-desc">'+esc(c.desc)+'</span></span>'+
        '<span class="osearch-grp">'+esc(c.group)+'</span></a>'; }).join('') : '<div class="osearch-empty">No matches</div>');
    if(curAnswer){ ansBox.textContent='✦ '+curAnswer; ansBox.hidden=false; } else { ansBox.hidden=true; }
    panel.hidden=false;
  }
  function run(){ var q=input.value.trim(); if(!q){panel.hidden=true;return;}
    curList=kw(q); curAnswer=null; sel=-1; paint();
    clearTimeout(timer); timer=setTimeout(function(){ var qq=q;
      fetch('/api/search?q='+encodeURIComponent(qq)).then(function(r){return r.json();}).then(function(d){
        if(input.value.trim()!==qq)return; if(d.results&&d.results.length){curList=d.results;} curAnswer=d.answer||null; sel=-1; paint();
      }).catch(function(){}); }, 320);
  }
  input.addEventListener('input', run);
  input.addEventListener('focus', function(){ field.classList.add('glow'); if(!input.value.trim())showSuggestions(); });
  input.addEventListener('blur', function(){ field.classList.remove('glow'); });
  input.addEventListener('keydown', function(e){
    if(e.key==='ArrowDown'){ sel=Math.min(sel+1,Math.min(curList.length,8)-1); paint(); e.preventDefault(); }
    else if(e.key==='ArrowUp'){ sel=Math.max(sel-1,0); paint(); e.preventDefault(); }
    else if(e.key==='Enter'&&curList[sel]){ var c=curList[sel]; if(c.ext)window.open(c.url,'_blank'); else location.href=c.url; }
    else if(e.key==='Escape'){ panel.hidden=true; input.blur(); }
  });
  document.addEventListener('keydown', function(e){ if((e.metaKey||e.ctrlKey)&&(e.key==='k'||e.key==='K')){ e.preventDefault(); input.focus(); } });
  document.addEventListener('click', function(e){ var o=document.getElementById('osearch'); if(o&&!o.contains(e.target))panel.hidden=true; });
})();</script>`;
}

module.exports = { renderSearchBox, SEARCH_CSS };
