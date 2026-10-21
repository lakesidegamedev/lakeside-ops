"use strict";
// Runs jobs with a per-attempt timeout and exponential backoff between retries.
function createRunner({clock,timeoutMs,maxAttempts,backoffMs,onSuccess=()=>{},onFailure=()=>{}}){
 function run(job){
  return new Promise(resolve=>{
   let attempt=0;
   const fail=error=>{
    if(attempt>=maxAttempts){onFailure(job.id,error);resolve({status:'failed',error,attempts:attempt});}
    else clock.setTimeout(go,backoffMs*2**(attempt-1));
   };
   const go=()=>{
    attempt++;
    const timer=clock.setTimeout(()=>fail(new Error('timeout')),timeoutMs);
    Promise.resolve().then(()=>job.execute(attempt)).then(value=>{
     clock.clearTimeout(timer);
     job.apply(value);
     onSuccess(job.id,value);
     resolve({status:'ok',value,attempts:attempt});
    },error=>{
     clock.clearTimeout(timer);
     fail(error);
    });
   };
   go();
  });
 }
 return {run};
}
module.exports={createRunner};
