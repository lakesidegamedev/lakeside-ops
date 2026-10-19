"use strict";
// Ranks feed events: collapse duplicates by (source, id), then order for display.
function rankEvents(events){
 const kept=new Map();
 for(let i=0;i<events.length;i++){
  const e=events[i];
  let bySource=kept.get(e.source);
  if(!bySource)kept.set(e.source,bySource=new Map());
  const prev=bySource.get(e.id);
  if(!prev||e.seq>prev.e.seq)bySource.set(e.id,{e,i});
 }
 const out=[];
 for(const bySource of kept.values())for(const item of bySource.values())out.push(item);
 out.sort((a,b)=>b.e.score-a.e.score||a.e.ts-b.e.ts||a.i-b.i);
 return out.map(x=>x.e);
}
module.exports={rankEvents};
