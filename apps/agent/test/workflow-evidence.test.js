"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),cp=require("node:child_process");
const {createLedger}=require("../lib/operator/store"),{createWorkflowEvidence}=require("../lib/operator/workflow-evidence"),{createBroker}=require("../lib/operator/broker");
test('the broker registers a whole arithmetic chain atomically and retains evidence checks',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'keir-calc-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const ledger=createLedger(dir+'/ledger.json'),broker=createBroker({ledger,config:{ownerId:'owner',staffIds:[],stateDir:dir,repositories:{}},sandbox:{},mcp:{servers:()=>[]},discord:async()=>{throw Error('unexpected external action')}});
 const job=ledger.createJob('arithmetic',{kind:'command',role:'owner',actorId:'owner',internalProbe:true,source:{}});job.state='running';job.evidence=[.2,.3,10000];
 const result=await broker.tool(job,'calculate',{steps:[{id:'share',expression:'.2+.3'},{id:'cost',expression:'$share*10000'}]});
 assert.equal(result.steps[1].value,5000);assert.ok(job.evidence.includes(5000));
 const before=[...job.evidence];
 await assert.rejects(broker.tool(job,'calculate',{steps:[{id:'share',expression:'.2+.3'},{id:'invented',expression:'123456.7*2'}]}),/not in anything you read/);
 assert.deepEqual(job.evidence,before);
 await assert.rejects(broker.tool(job,'calculate',{expression:'1+1',steps:[{id:'x',expression:'1'}]}),/not both/);
});
test('compact source evidence preserves every numbered line and hash with less transport overhead',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'keir-compact-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const {queryWorkspace}=require('../lib/operator/workspace-evidence');
 const root=path.resolve(__dirname,'../../cli/bench/fixtures/01-reconcile-deliveries');
 const query={op:'read',path:'source/src/lib/military/defenceLotEconomics.ts',line:61,lines:120};
 const raw=queryWorkspace(root,[query]);
 const ledger=createLedger(dir+'/ledger.json'),job=ledger.createJob('compact',{kind:'command',role:'owner'});
 const deps={stateDir:dir,ledger,sandbox:{run:async()=>({code:0,output:JSON.stringify(raw)})}};
 const response=await createWorkflowEvidence(deps).collect(job,{queries:[query]});
 const result=response.results[0];assert.equal(result.encoding,'numbered-source-v1');
 const decoded=result.excerpt.split('\n').map(row=>{const split=row.indexOf('|');return{line:Number(row.slice(0,split)),text:row.slice(split+1)};});
 assert.deepEqual(decoded,raw.results[0].lines);assert.equal(result.sha256,raw.results[0].sha256);
 for(const key of ['path','totalLines','nextLine','truncated','outline'])assert.deepEqual(result[key],raw.results[0][key]);
 assert.ok(Buffer.byteLength(JSON.stringify(result))<Buffer.byteLength(JSON.stringify(raw.results[0]))*.85);
 const reopened=await createWorkflowEvidence(deps).collect(job,{queries:[{op:'receipt',receipt:response.receipt}]});
 assert.deepEqual(reopened.results[0].results,response.results);
});
test("one sandbox execution batches independent source reads and durable receipts reopen after reload",async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"keir-workflow-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(dir+"/repo");fs.writeFileSync(dir+"/repo/test.js","const slots = 4;\nconst cost = 10;\n");
 const ledger=createLedger(dir+"/ledger.json"),job=ledger.createJob("fixture",{kind:"command",role:"owner"});job.state="running";let executions=0;
 const deps={stateDir:dir,ledger,sandbox:{run:async(_id,command)=>{executions++;return{code:0,output:cp.execFileSync("bash",["--noprofile","--norc","-c",command],{cwd:dir,encoding:"utf8"})}}}};
 const response=await createWorkflowEvidence(deps).collect(job,{queries:[{op:"read",path:"test.js",line:1,lines:1},{op:"read",path:"test.js",line:2,lines:1},{op:"search",terms:["slots"]}]});
 assert.equal(executions,1);assert.equal(response.results.length,3);assert.match(response.results[0].excerpt,/^1\|const slots = 4;/);
 const loaded=createLedger(dir+"/ledger.json"),restored=loaded.data.jobs[job.id];
 const prior=await createWorkflowEvidence({...deps,ledger:loaded}).collect(restored,{queries:[{op:"receipt",receipt:response.receipt}]});
 assert.equal(executions,1);assert.equal(prior.results[0].historical,true);assert.deepEqual(prior.results[0].results,response.results);
 const foreign=await createWorkflowEvidence(deps).collect(job,{queries:[{op:"receipt",receipt:"../../ledger"}]});assert.match(foreign.results[0].error,/outside this task/);
});
test("batched service reads preserve broker and child-worker scope restrictions",async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"keir-workflow-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const ledger=createLedger(dir+"/ledger.json");let external=0;
 const broker=createBroker({ledger,config:{ownerId:"owner",staffIds:[],stateDir:dir,repositories:{}},sandbox:{},discord:async()=>{external++;throw Error("unexpected")},mcp:{servers:()=>[],call:async()=>{external++;throw Error("unexpected")}}});
 const job=ledger.createJob("fixture",{kind:"command",role:"support",actorId:"owner",internalProbe:true,source:{}});job.state="running";
 const result=await broker.tool(job,"evidence_batch",{queries:[{op:"service",server:"support",tool:"support_reply",args:{text:"unauthorized"}}]});assert.ok(result.results[0].error);assert.equal(external,0);
 job.role="owner";job.codingParent=ledger.createJob("parent",{kind:"command",role:"owner",actorId:"owner",source:{}}).id;
 const child=await broker.tool(job,"evidence_batch",{queries:[{op:"service",server:"gamestate",tool:"game_overview"}]});assert.match(child.results[0].error,/Coding subworkers/);assert.equal(external,0);
 job.role="player";await assert.rejects(broker.tool(job,"evidence_batch",{queries:[{op:"catalog",server:"gamestate"}]}));assert.equal(external,0);
});

test('broker batch literal reuse preserves provenance and atomic failure',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'keir-calc-prior-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const ledger=createLedger(dir+'/ledger.json'),broker=createBroker({ledger,config:{ownerId:'owner',staffIds:[],stateDir:dir,repositories:{}},sandbox:{},mcp:{servers:()=>[]},discord:async()=>{throw Error('unexpected external action')}});
 const job=ledger.createJob('prior arithmetic',{kind:'command',role:'owner',actorId:'owner',internalProbe:true,source:{}});job.state='running';job.evidence=[10000,2500];
 const steps=[{id:'profit',expression:'10000-2500'},{id:'total',expression:'7500+10000'}];
 await assert.rejects(broker.tool(job,'calculate',{steps:[...steps,{id:'bad',expression:'999999+1'}]}),/not in anything/);
 assert.deepEqual(job.evidence,[10000,2500]);
 const result=await broker.tool(job,'calculate',{steps});
 assert.equal(result.steps[1].value,17500);assert.equal(result.steps[1].literalDerivations[0].sourceStep,'profit');
 assert.deepEqual([...new Set(job.evidence)],[10000,2500,7500,17500]);
});
test("workspace evidence without a snapshot loads one first, and says so plainly when it cannot",async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"keir-workflow-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const ledger=createLedger(dir+"/ledger.json");let runs=0,attached=false;
 const broker=createBroker({ledger,config:{ownerId:"owner",staffIds:[],stateDir:dir,repositories:{}},sandbox:{hasRepository:()=>attached,run:async()=>{runs++;return{code:0,output:JSON.stringify({results:[{op:"list",paths:[]}]})}}},discord:async()=>{throw Error("unexpected")},mcp:{servers:()=>[],call:async()=>{throw Error("unexpected")}}});
 const job=ledger.createJob("fixture",{kind:"command",role:"owner",actorId:"owner",internalProbe:true,source:{}});job.state="running";
 await assert.rejects(broker.tool(job,"evidence_batch",{queries:[{op:"list",paths:["src"]}]}),/need a repository snapshot[\s\S]*unknown repository/);
 assert.equal(runs,0);
 attached=true;
 const ok=await broker.tool(job,"evidence_batch",{queries:[{op:"list",paths:["src"]}]});
 assert.equal(runs,1);assert.equal(ok.results[0].op,"list");
});
test("a failed workspace batch reports the sandbox's error, not a size problem",async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"keir-workflow-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const ledger=createLedger(dir+"/ledger.json"),job=ledger.createJob("fixture",{kind:"command",role:"owner"});
 const deps={stateDir:dir,ledger,sandbox:{run:async()=>({code:1,output:"bash: cd: repo: No such file or directory"})}};
 await assert.rejects(createWorkflowEvidence(deps).collect(job,{queries:[{op:"list"}]}),/failed: bash: cd: repo/);
});
