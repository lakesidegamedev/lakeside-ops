const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openHistory,observations}=require('./history');
const {makeExplorerBody}=require('./explorer');
const {METRICS}=require('./metrics');
const turn=(n)=>({macro:{growth:n,infl:n/2,countries:{US:{growth:n,gdpA:n*100}},prices:{food:n*10},supplyDemand:{food:n/10},realRel:{food:n/20}},corp:{net:n,rev:n*2,nActive:100,byFam:{Industry:{net:n,rev:n*2}}},wealth:{median:n*100,n:20,top10:[['PRIVATE_PLAYER_ID',100]]},flows:{corp_revenue:[-n,n*2]},ptrades:{pids:['PRIVATE_PLAYER_ID']}});
const fixture=(id='iteration-1',last=6)=>({history:{worldId:id,completedThrough:last,turns:Object.fromEntries(Array.from({length:last+2},(_,n)=>[n,turn(n)]))},feed:{worldId:id,completedThrough:last,generatedAt:'2026-11-03T12:00:00Z',game:{startingYear:1991,iteration:{type:'Iteration',number:id==='iteration-1'?1:2}},scores:{health:[[1,50],[last,80]]},resets:[3],deploys:[{t:2,commit:'abcdef0123456789'}],gates:[],fixes:[]}});
const params=v=>new URLSearchParams({tab:'macro',range:'all',...v});
function memory(fn){const s=openHistory(':memory:');try{return fn(s)}finally{s.close()}}

test('history retains separate iterations with repeated turns and survives reopening',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'economy-history-')),file=path.join(dir,'history.sqlite');
 let store=openHistory(file);
 try{store.ingest(fixture());store.ingest(fixture('iteration-2'));store.close();store=openHistory(file);
  assert.equal(store.worlds().length,2);assert.equal(store.worlds().filter(w=>w.active).length,1);
  for(const id of ['iteration-1','iteration-2'])assert.equal(store.select(params({world:id})).points.at(-1).value,6);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true})}
});
test('completed-turn boundary excludes future and incomplete turns; identity mismatch rolls back',()=>memory(s=>{
 s.ingest(fixture());assert.equal(s.worlds()[0].last_turn,6);
 const input=fixture('wrong');input.feed.worldId='other';assert.throws(()=>s.ingest(input),/identities/);assert.equal(s.worlds().length,1);
 assert.throws(()=>s.ingest({history:{worldId:'bad',turns:{}},feed:{worldId:'bad'}}),/Completed-turn/);
}));
test('only numeric aggregate observations are captured, without player identity lists',()=>{
 const rows=observations(turn(4));assert.ok(rows.length>10);assert.ok(!JSON.stringify(rows).includes('PRIVATE_PLAYER_ID'));
 assert.ok(!observations({corp:{runway:999}}).length);
});
test('ingest is idempotent, retains revisions, and can restore an earlier observed value',()=>memory(s=>{
 const f=fixture();s.ingest(f);const n=s.db.prepare('SELECT COUNT(*) n FROM revisions').get().n;
 assert.equal(s.ingest(f).inserted,0);
 f.history.turns[2].macro.growth=50;s.ingest(f);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM revisions').get().n,n+1);
 assert.equal(s.select(params({from:'2',to:'2'})).recent[0].value,50);
 f.history.turns[2].macro.growth=2;s.ingest(f);assert.equal(s.select(params({from:'2',to:'2'})).recent[0].value,2);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM revisions').get().n,n+1);
}));
test('same label with a new epoch or backwards turn clock does not overwrite old captures',()=>memory(s=>{
 s.ingest(fixture());s.ingest(fixture('iteration-1',2));assert.equal(s.worlds().length,2);
 s.ingest({...fixture('iteration-1'),epoch:'new-epoch'});assert.equal(s.worlds().length,3);
 assert.equal(s.select(params({world:'iteration-1'})).world.last_turn,6);
}));
test('reset boundaries and gaps split lines; custom windows and stocks/flows aggregate correctly',()=>memory(s=>{
 const f=fixture();delete f.history.turns[4];s.ingest(f);
 const m=s.select(params());assert.notEqual(m.points.find(p=>p.turn===2).segment,m.points.find(p=>p.turn===3).segment);
 assert.notEqual(m.points.find(p=>p.turn===3).segment,m.points.find(p=>p.turn===5).segment);
 const x=s.select(params({from:'1',to:'2',step:'4'}));assert.equal(x.points.length,1);assert.equal(x.points[0].value,1.5);assert.equal(x.points[0].low,1);assert.equal(x.points[0].high,2);assert.equal(x.points[0].count,2);assert.ok(x.customRange);
 const flow=s.select(params({tab:'flows',entity:'corp_revenue',metric:'net',from:'1',to:'2',step:'4'}));assert.equal(flow.points[0].value,3);
 const html=makeExplorerBody(m).body;assert.match(html,/Reset in window/);assert.match(html,/Detected economy reset/);
}));
test('entity drilldowns stay within the chosen window, comparison aligns reset ages',()=>memory(s=>{
 const a=fixture('iteration-1',4);s.ingest(a);
 const b=fixture('iteration-2',9);b.feed.resets=[7];s.ingest(b);
 const m=s.select(new URLSearchParams({world:'iteration-2',tab:'macro',compare:'iteration-1',range:'reset'}));
 assert.equal(m.from,7);assert.equal(m.comparison.points[0].sourceTurn,3);assert.equal(m.comparison.points[0].turn,7);
 const c=s.select(params({world:'iteration-1',tab:'countries',entity:'US',from:'1',to:'2'}));assert.equal(c.scope,'country');assert.equal(c.recent[0].turn,2);assert.equal(c.summaries[0].turn,2);
}));
test('query inputs are bounded and unknown views and metric names fall back safely',()=>memory(s=>{
 s.ingest(fixture());const m=s.select(params({world:"';DROP TABLE samples;--",tab:'bad',metric:'bad',step:'-100',from:'-1',to:'999999999'}));
 assert.equal(m.view.id,'overview');assert.equal(m.from,0);assert.equal(m.to,6);assert.equal(m.step,1);assert.equal(s.worlds().length,1);
}));
test('all focused views render one chart at most, escape data, and preserve custom export links',()=>memory(s=>{
 const f=fixture();f.history.turns[1].macro.countries['<script>']={growth:1};s.ingest(f);
 for(const tab of ['overview','macro','markets','companies','players','countries','flows','history','fixes']){
  const m=s.select(params({tab,from:'1',to:'2'}));const html=makeExplorerBody(m).body;
  assert.ok((html.match(/class="ex-chart"/g)||[]).length<=1,tab);assert.ok(!html.includes('<script>'));assert.ok(!/[–—]/.test(html));
  if(!['history','fixes'].includes(tab)){assert.match(html,/economy\.csv\?/);assert.match(html,/from=1/);assert.match(html,/to=2/);}
 }
}));
test('coarse charts remain bounded with sparse history and do not invent missing values',()=>memory(s=>{
 const f=fixture('long',0);f.history.completedThrough=5000;f.history.turns={};
 for(let i=0;i<=5000;i+=2)f.history.turns[i]={macro:{growth:i}};
 f.feed.completedThrough=5000;f.feed.resets=[];s.ingest(f);const m=s.select(params());
 assert.ok(m.points.length<=601);assert.equal(m.points.reduce((n,p)=>n+p.count,0),2501);assert.ok(m.points.some(p=>p.gap));
 assert.equal(METRICS['macro.growth'].aggregation,'mean');
}));
test('confirmed annotations override inferred resets and historical windows stop before later resets',()=>memory(s=>{
 const f=fixture();f.history.events=[{kind:'economy_reset',turn:3,label:'Operator reset receipt',confidence:'confirmed: test receipt'}];s.ingest(f);
 const reset=s.select(params()).events.find(e=>e.kind==='economy_reset');assert.equal(reset.label,'Operator reset receipt');assert.match(reset.confidence,/confirmed/);
 const old=s.select(new URLSearchParams({tab:'macro',to:'2'}));assert.equal(old.from,0);assert.equal(old.to,2);assert.equal(old.recent[0].turn,2);
}));
