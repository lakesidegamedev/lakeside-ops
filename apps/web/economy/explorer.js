"use strict";
const { VIEWS, METRICS, human }=require("./metrics");
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const formatters=new Map();
function num(v,unit="") {
  if(!Number.isFinite(v))return "No reading";
  const digits=Math.abs(v)<1?4:2,notation=Math.abs(v)>=1e6?"compact":"standard",key=digits+notation;
  if(!formatters.has(key))formatters.set(key,new Intl.NumberFormat("en-US",{maximumFractionDigits:digits,notation}));
  return formatters.get(key).format(v)+(unit==="%"?"%":unit==="x"?"x":"");
}
const unitLabel=unit=>unit==="anchor"?"Anchor currency":unit==="price"?"Published price units":unit||"Count / index";
const CSS=`
.ex{max-width:1280px;margin:auto;padding:24px;display:grid;gap:20px}.ex h1,.ex h2,.ex h3{margin:0}.ex h1{font-size:27px;letter-spacing:-.04em}.ex h2{font-size:17px}.ex p{margin:8px 0;color:var(--text-2);line-height:1.65}.ex a{color:var(--accent)}.ex-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.ex-kicker{color:var(--accent);font-size:11px;letter-spacing:.1em;text-transform:uppercase;font-weight:700}.ex-muted{color:var(--text-3);font-size:12px}.ex-tabs,.ex-ranges{display:flex;gap:6px;flex-wrap:wrap}.ex-tabs{border-bottom:1px solid var(--border);padding-bottom:12px}.ex-tabs a,.ex-ranges a{padding:7px 12px;border-radius:7px;text-decoration:none;font-size:12px;color:var(--text-2)}.ex-tabs a.on,.ex-ranges a.on{background:var(--accent-soft);color:var(--accent);font-weight:700}.ex-card{padding:20px;background:var(--surface);border:1px solid var(--border);border-radius:12px;min-width:0}.ex-toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:end}.ex label{display:grid;gap:6px;font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em}.ex select,.ex input{max-width:100%;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:9px;font:inherit;letter-spacing:0;text-transform:none;font-size:13px}.ex button,.ex-button{color:var(--on-accent,#04262c);background:var(--accent);border:0;border-radius:7px;padding:10px 16px;font-weight:650;cursor:pointer}.ex-three{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.ex-stat b{display:block;font-size:25px;letter-spacing:-.03em;margin:7px 0}.ex-stat span{font-size:12px;color:var(--text-3)}.ex-chart{width:100%;height:auto;min-height:220px;display:block}.ex-chart text{font-family:var(--mono,monospace);font-size:11px;fill:var(--text-3)}.ex-chart .point{fill:var(--accent);opacity:0;outline:none}.ex-chart .point:hover,.ex-chart .point:focus{opacity:1;stroke:var(--surface);stroke-width:2}.ex-legend{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;margin-top:12px;color:var(--text-2)}.ex-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-right:7px}.ex-dot.other{background:var(--blue,#58a6ff)}.ex-attention{display:grid;gap:1px}.ex-attention a{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);text-decoration:none}.ex-scroll{overflow:auto}.ex table{width:100%;border-collapse:collapse;font-size:12px}.ex th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);padding:10px}.ex td{padding:10px;border-top:1px solid var(--border);font-variant-numeric:tabular-nums}.ex td a{text-decoration:none}.ex-event{border-left:2px solid var(--accent);padding:8px 14px;margin:10px 0}.ex-event.reset{border-color:var(--amber,#d29922)}.ex-event p{font-size:12px;margin:3px 0}.ex details>summary{cursor:pointer;font-weight:650}.ex details[open]>summary{margin-bottom:14px}.ex-note{border-left:3px solid var(--accent);padding:10px 15px;font-size:12px;color:var(--text-2);background:var(--accent-soft)}.ex-empty{padding:50px 16px;text-align:center;color:var(--text-3)}.ex-world{display:grid;gap:10px}.ex-world a{font-size:12px}.ex-title-row{display:flex;justify-content:space-between;gap:12px;align-items:center}.ex-badge{font-size:10px;background:var(--accent-soft);color:var(--accent);padding:4px 7px;border-radius:4px}.ex-raw{font-family:var(--mono,monospace);white-space:nowrap}@media(max-width:700px){.ex{padding:14px;gap:14px}.ex-head{display:block}.ex-toolbar>*{flex:1;min-width:130px}.ex-three{grid-template-columns:1fr}.ex-card{padding:15px}.ex-chart{min-height:180px}.ex-stat b{font-size:21px}}
`;
function link(model,over={}) {
  const p=new URLSearchParams({world:model.world.id,tab:model.view.id,scope:model.scope,entity:model.entity,metric:model.spec.key,range:model.range,step:String(model.step)});
  if(model.from!=null && model.customRange) p.set("from",model.from);
  if(model.customRange) p.set("to",model.to);
  if(model.comparison) p.set("compare",model.comparison.world.id);
  for(const [k,v] of Object.entries(over)) {if(v==null)p.delete(k);else p.set(k,String(v));}
  return "/economy?"+esc(p.toString());
}
function option(value,label,current){return `<option value="${esc(value)}"${value===current?" selected":""}>${esc(label)}</option>`;}
function drawChart(m) {
  const all=[...m.points,...(m.comparison?.points||[])];
  if(!all.length) return '<div class="ex-empty">No observations for this measure in the selected window. Choose another measure or widen the range.</div>';
  const W=1000,H=300,L=72,R=22,T=27,B=40;
  const x=t=>L+(t-m.from)/Math.max(1,m.to-m.from)*(W-L-R);
  let lo=Math.min(...all.map(p=>Math.min(p.value,m.spec.aggregation==="mean"?p.low:p.value))),hi=Math.max(...all.map(p=>Math.max(p.value,m.spec.aggregation==="mean"?p.high:p.value)));
  const pad=(hi-lo||Math.abs(hi)*.1||1)*.08;lo-=pad;hi+=pad;
  const y=v=>T+(hi-v)/(hi-lo)*(H-T-B);
  let out=`<svg class="ex-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.spec.label)} from turn ${m.from} to ${m.to}. Exact values are also available in the readings table.">`;
  for(let i=0;i<=4;i++){const v=lo+(hi-lo)*i/4,yy=y(v);out+=`<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" stroke="var(--border)"/><text x="${L-9}" y="${yy+4}" text-anchor="end">${esc(num(v))}</text>`;}
  for(let i=0;i<=4;i++){const t=Math.round(m.from+(m.to-m.from)*i/4);out+=`<text x="${x(t)}" y="${H-12}" text-anchor="middle">t${t}</text>`;}
  for(const e of m.events.filter(e=>e.kind!=="deployment"&&e.turn>=m.from&&e.turn<=m.to))out+=`<line x1="${x(e.turn)}" x2="${x(e.turn)}" y1="${T}" y2="${H-B}" stroke="var(--amber,#d29922)" stroke-dasharray="5 5"><title>${esc(e.label)} at t${e.turn}. ${esc(e.confidence)}</title></line>`;
  function line(points,color,compare=false) {
    const segments=[];
    for(const p of points){if(!segments.length||segments.at(-1).segment!==p.segment)segments.push({segment:p.segment,pts:[]});segments.at(-1).pts.push(p);}
    let s="";
    for(const seg of segments){
      if(m.step>1&&m.spec.aggregation==="mean") s+=`<polygon points="${seg.pts.map(p=>`${x(p.turn)},${y(p.high)}`).concat([...seg.pts].reverse().map(p=>`${x(p.turn)},${y(p.low)}`)).join(" ")}" fill="${color}" opacity=".1"/>`;
      s+=`<polyline points="${seg.pts.map(p=>`${x(p.turn)},${y(p.value)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
      for(const p of seg.pts)s+=`<circle class="point" tabindex="0" cx="${x(p.turn)}" cy="${y(p.value)}" r="5"><title>${compare?esc(m.comparison.world.label)+" / ":""}Turn ${p.sourceTurn??p.turn}${p.end>p.turn?" to "+(p.sourceTurn!=null?p.sourceTurn+p.end-p.turn:p.end):""}: ${esc(num(p.value,m.spec.unit))}. ${p.count} observation(s); minimum ${esc(num(p.low,m.spec.unit))}, maximum ${esc(num(p.high,m.spec.unit))}.</title></circle>`;
    }
    return s;
  }
  if(m.comparison)out+=line(m.comparison.points,"var(--blue,#58a6ff)",true);
  out+=line(m.points,"var(--accent)");
  return out+"</svg>";
}
function controls(m) {
  const scopeControls=m.view.id==="companies"?`<label>Breakdown<select name="scope">${["corp","family","industry","owner","company_country","index","trades"].map(s=>option(s,{corp:"All companies",family:"Sector family",industry:"Industry",owner:"Owner group",company_country:"Company country",index:"Market index",trades:"Share trading"}[s],m.scope)).join("")}</select></label>`:`<input type="hidden" name="scope" value="${esc(m.scope)}">`;
  return `<form method="get" action="/economy" class="ex-toolbar"><input type="hidden" name="tab" value="${m.view.id}"><input type="hidden" name="world" value="${esc(m.world.id)}"><input type="hidden" name="range" value="${esc(m.range)}">${scopeControls}
<label>Measure<select name="metric">${m.specs.map(s=>option(s.key,s.label,m.spec.key)).join("")}</select></label>
${m.entities.length>1?`<label>${m.scope==="country"?"Country":m.scope==="commodity"?"Commodity":"Group"}<select name="entity">${m.entities.map(e=>option(e,human(e),m.entity)).join("")}</select></label>`:`<input type="hidden" name="entity" value="${esc(m.entity)}">`}
<label>Resolution<select name="step">${(![1,4,12,48].includes(m.step)?[m.step,1,4,12,48]:[1,4,12,48]).map(s=>option(String(s),s===1?"Each recorded turn":`${s} turns per bucket`,String(m.step))).join("")}</select></label><label>From turn<input name="from" type="number" min="${m.world.first_turn}" max="${m.to}" value="${m.from}"></label><label>To turn<input name="to" type="number" min="${m.from}" max="${m.world.last_turn}" value="${m.to}"></label><button>Apply</button></form>`;
}
function chartSection(m) {
  const first=m.firstReading,last=m.recent[0];
  const crossesReset=first&&last&&m.events.some(e=>e.kind==="economy_reset"&&e.turn>first.turn&&e.turn<=last.turn);
  const change=first&&last&&!crossesReset?last.value-first.value:null;
  const missing=m.points.length?Math.max(0,m.to-m.from+1-m.points.reduce((a,p)=>a+p.count,0)):m.to-m.from+1;
  const reset=m.events.filter(e=>e.kind==="economy_reset"&&e.turn>=m.from&&e.turn<=m.to);
  return `<section class="ex-card"><div class="ex-title-row"><div><span class="ex-kicker">${esc(m.entity==="world"?m.view.label:human(m.entity))}</span><h2>${esc(m.spec.label)}</h2></div><span class="ex-muted">${esc(unitLabel(m.spec.unit))}</span></div>
<div style="margin-top:18px">${controls(m)}</div>
<div class="ex-ranges" style="margin:16px 0">${[["reset","Since economy reset"],["24","Last 24 turns"],["96","Last 96 turns"],["240","Last 240 turns"],["all","Whole iteration"]].map(([r,l])=>`<a class="${m.range===r&&!m.customRange?"on":""}" href="${link(m,{range:r,from:null,to:null})}">${l}</a>`).join("")}</div>
<div class="ex-three" style="margin-bottom:12px"><div class="ex-stat"><span>Last exact reading${last?" / t"+last.turn:""}</span><b>${esc(num(last?.value,m.spec.unit))}</b></div><div class="ex-stat"><span>Change in per-turn readings</span><b>${change==null?(crossesReset?"Reset in window":"No comparison"):esc((change>0?"+":"")+num(change,m.spec.unit))}</b></div><div class="ex-stat"><span>Observation coverage</span><b>${m.to>=m.from?Math.round(100*(m.to-m.from+1-missing)/(m.to-m.from+1)):0}%</b></div></div>
${drawChart(m)}<div class="ex-legend"><span><i class="ex-dot"></i>${esc(m.world.label)}</span>${m.comparison?`<span><i class="ex-dot other"></i>${esc(m.comparison.world.label)} / aligned by ${m.range==="reset"?"age since reset":"iteration age"}</span>`:""}<span>${m.step===1?"Exact recorded turns":`${m.step}-turn buckets: ${m.spec.aggregation==="sum"?"sum of recorded flows":"mean, with min/max shading"}`}</span></div>
<p class="ex-muted">${missing?`${missing} turn(s) have no observation for this measure. Missing values are not zero. `:""}Lines break at collection gaps and economy resets. ${reset.length?`${reset.length} reset boundary/boundaries in this window. `:""}Hover or focus a point for values and sample counts.</p>
${m.worlds.length>1?`<form method="get" action="/economy" class="ex-toolbar"><input type="hidden" name="world" value="${esc(m.world.id)}"><input type="hidden" name="tab" value="${m.view.id}"><input type="hidden" name="scope" value="${m.scope}"><input type="hidden" name="entity" value="${esc(m.entity)}"><input type="hidden" name="metric" value="${esc(m.spec.key)}"><input type="hidden" name="range" value="${esc(m.range)}"><label>Compare another iteration<select name="compare"><option value="">No comparison</option>${m.worlds.filter(w=>w.id!==m.world.id).map(w=>option(w.id,w.label,m.comparison?.world.id)).join("")}</select></label><button>Compare</button></form>`:""}
</section>`;
}
function readingTable(m) {
  const csv=link(m).replace("/economy?","/economy.csv?");
  return `<details class="ex-card"><summary>Exact readings and export</summary><p>Latest ${m.recent.length} recorded turns in this window. The CSV contains unaggregated numeric readings, up to 10,000 per export.</p><p><a href="${csv}">Download selected series as CSV</a></p><div class="ex-scroll"><table><thead><tr><th>Turn</th><th>${esc(m.spec.label)} (${esc(unitLabel(m.spec.unit))})</th></tr></thead><tbody>${m.recent.map(r=>`<tr><td>t${r.turn}</td><td class="ex-raw">${esc(r.value)}</td></tr>`).join("")}</tbody></table></div></details>`;
}
function entityTable(m) {
  if(m.summaries.length<2)return "";
  const sorted=[...m.summaries].sort((a,b)=>m.scope==="commodity"&&m.spec.key==="sd"?a.value-b.value:b.value-a.value);
  return `<details class="ex-card"><summary>Compare ${m.summaries.length} ${m.scope==="country"?"countries":m.scope==="commodity"?"commodities":"groups"} for this measure</summary><p>Latest available reading inside the selected window. Open a row to inspect its history.</p><div class="ex-scroll"><table><thead><tr><th>Entity</th><th>${esc(m.spec.label)}</th><th>Observed at</th></tr></thead><tbody>${sorted.map(r=>`<tr><td><a href="${link(m,{entity:r.entity})}">${esc(human(r.entity))}</a></td><td>${esc(num(r.value,m.spec.unit))}</td><td>t${r.turn}</td></tr>`).join("")}</tbody></table></div></details>`;
}
function overview(m) {
  const cells=Object.entries({health:"Economic health",gameplay:"Gameplay",commodities:"Commodity health"}).map(([key,label])=>{
    const points=(m.feed?.scores?.[key]||[]).filter(p=>p[0]>=m.from&&p[0]<=m.to);const last=points.at(-1);
    return `<div class="ex-card ex-stat"><span>${label}</span><b>${esc(num(last?.[1],"%"))}</b><span>${last?"Scored at t"+last[0]:"No score captured"}</span></div>`;
  }).join("");
  const seen=new Set();
  const attention=(m.to===m.world.last_turn?(m.feed?.gates||[]):[]).filter(g=>["red","amber"].includes(g.status)).filter(g=>{const k=g.src+g.field;if(seen.has(k))return false;seen.add(k);return true}).sort((a,b)=>(a.status==="red"?0:1)-(b.status==="red"?0:1)).slice(0,6);
  return `<div class="ex-three">${cells}</div><details class="ex-card"><summary>Needs attention (${attention.length} highlighted)</summary><p class="ex-muted">Latest captured assessment. Expand a measure to investigate its history.</p><div class="ex-attention">${attention.map(g=>{
    const scope={c:"corp",m:"macro",w:"wealth"}[g.src];const spec=METRICS[`${scope}.${g.field}`];
    const tab=scope==="corp"?"companies":scope==="wealth"?"players":"macro";
    const content=`<span>${esc(g.label)}</span><b>${esc(num(g.now,g.unit))}</b>`;
    return spec?`<a href="${link(m,{tab,scope,metric:spec.key,entity:"world"})}">${content}</a>`:`<div style="display:flex;justify-content:space-between;gap:12px;padding:12px 0">${content}</div>`;
  }).join("")||'<p>No current assessment is shown for this historical window. Inspect the recorded measures below.</p>'}</div></details>`;
}
function companySnapshot(m) {
  if(m.view.id!=="companies" || m.to!==m.world.last_turn || !m.feed)return "";
  const top=(m.feed.topCorps||[]).slice(0,20);
  const rows=top.map(c=>`<tr><td>${esc(c.name)}<br><span class="ex-muted">${esc(c.country)} / ${esc(c.family)}</span></td><td>${esc(c.owner)}</td>${[c.mcap,c.rev,c.net,c.cash].map(v=>`<td>${esc(num(v,"anchor"))}</td>`).join("")}<td>${esc(c.rating)}</td></tr>`).join("");
  const movers=[...(m.feed.movers?.up||[]),...(m.feed.movers?.down||[])].map(r=>`<tr><td>${esc(r[0])}</td><td>${esc(r[4])}</td><td>${esc(num(r[5],"%"))}</td><td>${esc(num(r[6],"anchor"))}</td></tr>`).join("");
  return `<details class="ex-card"><summary>Latest company snapshot</summary><p>Captured at t${esc(m.feed.completedThrough)}. These rankings describe the latest feed, not every historical turn.</p><div class="ex-scroll"><table><thead><tr><th>Largest companies</th><th>Owner</th><th>Market cap</th><th>Revenue</th><th>Net income</th><th>Cash</th><th>Rating</th></tr></thead><tbody>${rows}</tbody></table></div>${movers?`<h3 style="margin-top:20px">12-turn share price movers</h3><div class="ex-scroll"><table><thead><tr><th>Company</th><th>Owner</th><th>Return</th><th>Market cap</th></tr></thead><tbody>${movers}</tbody></table></div>`:""}</details>`;
}
function timeline(m) {
  const boundaries=m.events.filter(e=>e.kind!=="deployment");const deploys=m.events.filter(e=>e.kind==="deployment").slice(-30).reverse();
  const entries=rows=>rows.map(e=>`<div class="ex-event ${e.kind==="economy_reset"?"reset":""}"><b>t${e.turn}: ${esc(e.label)}</b><p>${esc(e.confidence)}</p></div>`).join("");
  return `<section class="ex-card"><h2>Iteration and reset timeline</h2>${entries(boundaries)}<p class="ex-muted">Iteration identity and economic resets are separate boundaries. An inferred reset is a detected company-count discontinuity, not an operator-confirmed reset receipt.</p><details><summary>Recent deployment markers (${deploys.length})</summary>${entries(deploys)}<p class="ex-muted">Deployment timing describes when code changed. It does not prove causation.</p></details></section>`;
}
function historyView(m) {
  return `<div class="ex-three">${m.worlds.map(w=>`<section class="ex-card ex-world"><div class="ex-title-row"><h2>${esc(w.label)}</h2><span class="ex-badge">${w.active?"Current":"Archived"}</span></div><p>${w.turns} observed turns / t${w.first_turn} to t${w.last_turn}</p><span class="ex-muted">${esc(w.source_world)}${w.epoch?" / epoch recorded":" / collector world identity"}</span><span class="ex-muted">${w.metric_count} metric types / ${w.series_count} entity series</span><span class="ex-muted">${w.revisions} retained aggregate revision(s)</span><a href="${link(m,{world:w.id,tab:"macro",from:null,to:null,range:"all",compare:null})}">Explore this iteration</a></section>`).join("")}</div>${timeline(m)}<section class="ex-card"><h2>What is retained</h2><p>Recorded aggregates live outside game collections and application releases. Iterations use separate world identities, so reused turn numbers do not overwrite earlier iterations. Economy resets keep the same iteration history and add boundaries.</p><p>Coverage reflects what the collector actually retained. Earlier turns with missing metrics remain missing. Historical imports are reconstructed aggregates; they are not newly observed production events.</p></section>`;
}
function fixes(m) {
  return `<section class="ex-card"><h2>Tracked changes</h2><p>Change status comes from the collector's last captured feed for this iteration.</p><div class="ex-scroll"><table><thead><tr><th>Change</th><th>Area</th><th>Status</th><th>First live turn</th></tr></thead><tbody>${(m.feed?.fixes||[]).slice(0,150).map(f=>`<tr><td>${esc(f.title)}</td><td>${esc(f.area)}</td><td>${esc(f.status)}</td><td>${f.liveTurn==null?"Not recorded":"t"+esc(f.liveTurn)}</td></tr>`).join("")}</tbody></table></div></section>${timeline(m)}`;
}
function makeExplorerBody(m) {
  const selector=`<form method="get" action="/economy" class="ex-toolbar"><input type="hidden" name="tab" value="${m.view.id}"><input type="hidden" name="range" value="reset"><label>Iteration<select name="world">${m.worlds.map(w=>option(w.id,w.label+(w.active?" (current)":" (archived)"),m.world.id)).join("")}</select></label><button>Open</button></form>`;
  const tabs=`<nav class="ex-tabs" aria-label="Economy views">${VIEWS.map(v=>`<a class="${v.id===m.view.id?"on":""}" href="${link(m,{tab:v.id,scope:null,metric:null,entity:null})}">${v.label}</a>`).join("")}</nav>`;
  const content=m.view.id==="history"?historyView(m):m.view.id==="fixes"?fixes(m):`${m.view.id==="overview"?overview(m):""}${chartSection(m)}${entityTable(m)}${companySnapshot(m)}${readingTable(m)}`;
  return {extraCss:CSS,body:`<div class="ex"><header class="ex-head"><div><span class="ex-kicker">Economy observatory</span><h1>${m.view.label}</h1><p>${m.view.description}</p><span class="ex-muted">${esc(m.world.label)} / recorded t${m.world.first_turn} to t${m.world.last_turn} / ${m.world.turns} observed turns</span></div>${selector}</header>${tabs}<div class="ex-note">${m.world.active?"Current iteration":"Archived iteration"}. Last captured ${esc(m.feed?.generatedAt||m.world.updated_at)}. ${m.feed?.completedThrough!=null?"Completed through t"+esc(m.feed.completedThrough)+".":""} Missing observations are shown as gaps.</div>${content}</div>`};
}
module.exports={makeExplorerBody,drawChart,link,num};
