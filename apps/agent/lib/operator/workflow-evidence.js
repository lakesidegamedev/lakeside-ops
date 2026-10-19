"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {evidenceCommand}=require("./workspace-evidence");
function createWorkflowEvidence({sandbox,read,readTools,stateDir,ledger,now=Date.now}){
 async function collect(job,input,signal){
  const queries=input.queries;
  if(!Array.isArray(queries)||!queries.length||queries.length>8)throw Error("Supply 1-8 independent evidence queries");
  const dir=path.join(stateDir,"evidence",crypto.createHash("sha256").update(job.id).digest("hex").slice(0,24));
  const workspace=queries.map((q,i)=>({q,i})).filter(({q})=>["list","read","search"].includes(q.op));
  const results=new Array(queries.length);let workspaceResult;
  if(workspace.length){
   const r=await sandbox.run(job.id,evidenceCommand(workspace.map(x=>x.q),{format:'numbered'}),signal,{timeoutMs:15000});
   if(r.truncated)throw Error("Workspace evidence exceeded its bounded output; narrow the query");
   if(r.code!==0)throw Error("Workspace evidence failed: "+String(r.output||"").trim().slice(-300));
   workspaceResult=JSON.parse(r.output);workspace.forEach(({i},j)=>{
    const value=workspaceResult.results[j];
    // Keep the source bytes and line numbers; avoid repeating JSON keys for
    // every source line. This is data encoding, never source summarization.
    if(value?.op==='read'&&Array.isArray(value.lines)){
     const {lines,...metadata}=value;
     results[i]={...metadata,encoding:'numbered-source-v1',excerpt:lines.map(row=>row.line+'|'+row.text).join('\n')};
    }else results[i]=value;
   });
  }
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,queries.length)},async()=>{
   while(cursor<queries.length){const i=cursor++,q=queries[i];if(results[i]!==undefined)continue;
    try{
     if(q.op==="service")results[i]=await read(job,{server:q.server,tool:q.tool,args:q.args||{}},signal);
     else if(q.op==="catalog")results[i]=await readTools(job,{server:q.server},signal);
     else if(q.op==="receipt"){
      if(!job.evidenceBatches?.some(r=>r.id===q.receipt))throw Error("Receipt is outside this task's evidence index");
      results[i]={historical:true,warning:"Prior observations may be stale; verify current state before acting",...JSON.parse(fs.readFileSync(path.join(dir,q.receipt+".json"),"utf8"))};
     }else throw Error("Unknown evidence query operation");
    }catch(error){results[i]={op:q.op,error:error.message};}
   }
  }));
  let bytes=0;const bounded=results.map(value=>{const text=JSON.stringify(value??null),size=Buffer.byteLength(text);if(bytes+size>18000)return{truncated:true,error:"Batch output budget reached; narrow or separate this query"};bytes+=size;return value;});
  const id=crypto.randomBytes(12).toString("hex"),at=now(),response={receipt:id,observedAt:at,trust:"evidence-only",results:bounded};
  fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,id+".json"),JSON.stringify(response),{mode:0o600});
  job.evidenceBatches=[...(job.evidenceBatches||[]),{id,at,queries:queries.map(q=>({op:q.op,path:q.path,server:q.server,tool:q.tool})),sha256:crypto.createHash("sha256").update(JSON.stringify(response)).digest("hex")}].slice(-12);
  ledger.audit("evidence_batch",{job:job.id,receipt:id,queries:queries.length,bytes});ledger.save();return response;
 }
 return{collect};
}
module.exports={createWorkflowEvidence};
