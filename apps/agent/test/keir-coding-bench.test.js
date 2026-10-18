'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {evaluate,CASES}=require('../../cli/bench/coding.cjs');
const correct={
 '01-lease-queue':`function claim(jobs,now,leaseMs,token){const j=jobs.filter(j=>(j.state==='queued'||j.state==='running'&&j.leaseUntil<=now)&&(j.deadline===undefined||j.deadline>now)&&(j.maxAttempts===undefined||(j.attempts||0)<j.maxAttempts)&&(!j.requiresApproval||j.approval?.verified===true)).sort((a,b)=>(b.priority||0)-(a.priority||0)||(a.createdAt-b.createdAt)||a.id.localeCompare(b.id))[0];if(!j)return null;Object.assign(j,{state:'running',attempts:(j.attempts||0)+1,leaseUntil:now+leaseMs,leaseToken:token});return j}function complete(jobs,id,token,result){const j=jobs.find(j=>j.id===id);if(!j||j.state!=='running'||j.leaseToken!==token)return false;j.state='done';j.result=result;return true}module.exports={claim,complete};`,
 '02-evidence-cache':`function createEvidenceCache({load,ttlMs,now=Date.now}){const entries=new Map();function get(key){const e=entries.get(key);if(e&&(e.pending||now()<e.until))return e.promise;const next={pending:true};const p=Promise.resolve().then(()=>load(key)).then(value=>{if(entries.get(key)===next){next.pending=false;next.until=now()+ttlMs}return value},error=>{if(entries.get(key)===next)entries.delete(key);throw error});next.promise=p;entries.set(key,next);return p}return{get,invalidate:key=>entries.delete(key),clear:()=>entries.clear()}}module.exports={createEvidenceCache};`
};
test('coding evaluator rejects seeded defects and accepts general fixes on isolated hidden race checks',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'keir-coding-eval-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const spec of CASES){const file=spec.editable[0],files=Object.fromEntries(spec.editable.map(p=>[p,fs.readFileSync(path.resolve(__dirname,'../../cli/bench/coding-fixtures',spec.id,p),'utf8')]));
  const badDir=root+'/'+spec.id+'-bad',goodDir=root+'/'+spec.id+'-good';fs.mkdirSync(badDir);fs.mkdirSync(goodDir);
  const bad=await evaluate(spec,files,badDir);assert.equal(bad.passed,false);assert.equal(bad.tests,spec.checks,bad.output);assert.ok(bad.pass<bad.tests);
  const good=await evaluate(spec,{...files,[file]:spec.quality?fs.readFileSync(path.resolve(__dirname,'../../cli/bench/coding-private/03-durable-outbox.reference.cjs'),'utf8'):correct[spec.id]??fs.readFileSync(path.resolve(__dirname,'../../cli/bench/coding-private',spec.id+'.reference',file),'utf8')},goodDir);assert.equal(good.passed,true,good.output);assert.equal(good.pass,spec.checks);
 }
});
test('prepared coding trial crosses the real broker edit, finish and hidden-grading boundary',async t=>{
 const helpers=require('../../cli/bench/run.cjs'),{trial}=require('../../cli/bench/coding.cjs'),original=helpers.bounded;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'keir-coding-trial-'));t.after(()=>{helpers.bounded=original;fs.rmSync(root,{recursive:true,force:true})});
 helpers.bounded=async(cmd,args,opts)=>{if(!args.some(a=>String(a).endsWith('/bin/activation.cjs')))return original(cmd,args,opts);
  const request=JSON.parse(opts.input);assert.match(request.prompt,/Prepared coding context/);const call=async(name,input)=>{const response=await fetch(request.url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:input}})}).then(r=>r.json());assert.equal(response.result.isError,undefined,JSON.stringify(response));};
  const oldText=fs.readFileSync(path.resolve(__dirname,'../../cli/bench/coding-fixtures/01-lease-queue/src/queue.cjs'),'utf8');await call('finish_patch',{edits:[{path:'src/queue.cjs',oldText,newText:correct['01-lease-queue']}],summary:'patch verified'});const receipt=await fetch(request.completionUrl).then(r=>r.json());assert.equal(receipt.state,'done');assert.match(receipt.validationDigest,/^[a-f0-9]{64}$/);return{code:0,out:JSON.stringify({subtype:'success',is_error:false,result:'patch verified'}),err:'',timeout:false};
 };
 const result=await trial(['fixture','test fixture','claude','fixture-model'],CASES[0],'optimized','root',root);assert.equal(result.qualified,true,result.error);assert.ok(result.preparationMs>0);assert.equal(result.validation.pass,14);
});
test('coding report and chart retain failed trials and mark absent usage unknown',()=>{
 const {metrics}=require('../../cli/bench/coding-report.cjs'),{charts}=require('../../cli/bench/coding-charts.cjs');
 const g=metrics([{qualified:true,wallMs:10000},{qualified:false,wallMs:1}]);assert.equal(g.recorded,2);assert.equal(g.qualified,1);assert.equal(g.medianSeconds,10);assert.equal(g.priced,0);
 const svg=charts({models:[{label:'Fixture',groups:{native:g,old:g,optimized:g}}]});assert.match(svg,/data-value="unknown"/);assert.doesNotMatch(svg,/data-value="0"/);
});
