"use strict";
// Ranks feed events: collapse duplicates by (source, id), then order for display.
function identity(e){
 return JSON.stringify([e.source,e.id]);
}
function before(a,b){
 if(a.e.score!==b.e.score)return a.e.score>b.e.score;
 if(a.e.ts!==b.e.ts)return a.e.ts<b.e.ts;
 return a.i<b.i;
}
function rankEvents(events){
 const out=[];
 for(let i=0;i<events.length;i++){
  const e=events[i],key=identity(e);
  const j=out.findIndex(x=>identity(x.e)===key);
  if(j>=0){
   if(e.seq>out[j].e.seq)out.splice(j,1);
   else continue;
  }
  const item={e,i};
  let p=0;
  while(p<out.length&&!before(item,out[p]))p++;
  out.splice(p,0,item);
 }
 return out.map(x=>x.e);
}
module.exports={rankEvents};
