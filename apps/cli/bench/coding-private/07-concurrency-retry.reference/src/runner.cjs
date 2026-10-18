"use strict";
// Runs jobs with a per-attempt timeout and exponential backoff between retries.
function createRunner({clock,timeoutMs,maxAttempts,backoffMs,onSuccess=()=>{},onFailure=()=>{}}){
 const inFlight=new Map();
 function run(job){
  const existing=inFlight.get(job.id);
  if(existing)return existing;
  const promise=new Promise(resolve=>{
   let attempt=0,settled=false;
   const finish=result=>{
    if(settled)return;
    settled=true;inFlight.delete(job.id);
    if(result.status==='ok')onSuccess(job.id,result.value);else onFailure(job.id,result.error);
    resolve(result);
   };
   const fail=error=>{
    if(settled)return;
    if(attempt>=maxAttempts)finish({status:'failed',error,attempts:attempt});
    else clock.setTimeout(go,backoffMs*2**(attempt-1));
   };
   const go=()=>{
    if(settled)return;
    const current=++attempt;let done=false;
    const timer=clock.setTimeout(()=>{if(done)return;done=true;fail(new Error('timeout'));},timeoutMs);
    Promise.resolve().then(()=>job.execute(current)).then(value=>{
     if(done||settled)return;
     done=true;clock.clearTimeout(timer);
     try{job.apply(value);}catch(error){finish({status:'failed',error,attempts:current});return;}
     finish({status:'ok',value,attempts:current});
    },error=>{
     if(done||settled)return;
     done=true;clock.clearTimeout(timer);
     fail(error);
    });
   };
   go();
  });
  inFlight.set(job.id,promise);
  return promise;
 }
 return {run};
}
module.exports={createRunner};
