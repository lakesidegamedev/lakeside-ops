"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {createLedger}=require("../lib/operator/store"),{createAppChannel}=require("../lib/operator/appchannel"),{createBroker}=require("../lib/operator/broker");
const {quickQuestion}=require("../lib/operator/conversation"),{models}=require("../lib/operator/appmodels");
function fixture(t,text="Refresh ticket 100 and coordinate the remaining investigation") {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"keir-feedback-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const ledger=createLedger(path.join(dir,"ledger.json"));const config={ownerId:"333052320252297216",botId:"1479984768194969663",guildId:"guild",staffIds:[],stateDir:dir,repositories:{},model:"claude-opus-5-5",quickProvider:"agy:gemini-3.8-flash@low",workerProvider:"codex:gpt-6.1-sol@medium",taskLifetimeMs:86400000,supportDeferred:()=>false};
 const app=createAppChannel({ledger,config});const job=ledger.data.jobs[app.authenticatedPost(text,undefined,"main",{mode:"new"}).jobId];job.state="running";
 const calls=[];const mcp={servers:()=>["support","ops-knowledge","heal-ops"],list:async()=>[],call:async(server,name,args,write)=>{calls.push({server,name,args,write});if(name==="support_get")return {number:100,category:"mechanics",status:"open",conversation:{channelId:"channel"}};if(name==="support_create_ticket")return {ticketNumber:101,channelId:"created"};return {ok:true};}};
 const broker=createBroker({ledger,config,appChannel:app,mcp,discord:async(method,url)=>url.endsWith("messages?limit=100")?[]:{id:"channel",guild_id:"guild",name:"ticket-fixture-100"},sandbox:{}});
 return {ledger,config,app,job,broker,calls};
}
test("short owner conversation stays in the fast lane; explicit work remains work",()=>{
 for(const s of ["OK let's talk to each other","Test","Hello","Ask me for any remaining blockers pls in English"])assert.equal(quickQuestion(s),true,s);
 for(const s of ["Create a new incident ticket","Deploy the patch","Approve that repair","Investigate the cost calculation"])assert.equal(quickQuestion(s),false,s);
});
test("owner quick status can read the work board without a worker handoff",async t=>{const f=fixture(t);f.job.kind="conversation";await f.broker.tool(f.job,"read_tool",{server:"ops-knowledge",tool:"kanban_brief",args:{}});assert.equal(f.calls[0].write,false);});
test("reviewed heal query is available to the authenticated owner",async t=>{const f=fixture(t);await f.broker.tool(f.job,"read_tool",{server:"heal-ops",tool:"heal_query",args:{env:"sandbox",collection:"corporations",limit:1}});assert.equal(f.calls[0].write,false);});
test("owner guidance reaches the canonical coordinator without approving its effects",async t=>{const f=fixture(t);const target=f.ledger.createJob("ticket:100",{kind:"ticket",ticket:100,role:"support",channelId:"channel",source:{},inbox:[]});target.state="waiting";const r=await f.broker.tool(f.job,"support_directive",{ticket:100});assert.equal(r.coordinatorTaskId,target.id);assert.equal(target.inbox.length,1);assert.equal(Object.keys(f.ledger.data.actions).length,0);assert.equal(f.calls.some(c=>c.write),false);assert.deepEqual(await f.broker.tool(f.job,"support_directive",{ticket:100}),{...r,duplicate:true,currentState:target.state});});
test("an explicit authenticated app incident request retains the owner as reporter and deduplicates",async t=>{const f=fixture(t,"Create a new incident ticket with me as the reporter to compare sector margins");const args={title:"Compare sector margins",description:"Compare sector margins by production method and investigate persistent outliers.",category:"incident"};const a=await f.broker.tool(f.job,"open_ticket",args);const b=await f.broker.tool(f.job,"open_ticket",args);assert.equal(a.number,101);assert.equal(b.number,101);assert.equal(f.calls.filter(c=>c.write).length,1);assert.equal(f.calls.find(c=>c.write).args.discord_user_id,f.config.ownerId);assert.equal(f.calls.find(c=>c.write).args.category,"incident");});
test("studio offers Opus, Sonnet and DeepSeek with clear lane restrictions",()=>{const c={model:"claude-opus-5-5",quickProvider:"codex:gpt-6.1-sol"};const chat=models(c,"conversation");for(const model of ["claude-opus-5-5","claude-sonnet-5-5","deepseek-v4.1-flash"])assert.ok(chat.some(r=>r.model===model&&r.available!==false),model);const code=models(c,"coding").find(r=>r.model==="deepseek-v4.1-flash");assert.equal(code.available,false);assert.ok(code.reason);});
test("Jev chooses effort despite a model route and inherited default effort pin",async()=>{let used=false;const chosen=await require("../lib/operator/effort").activationEffort({provider:{effort:"medium"},effortPin:"medium"},{config:{dynamicEffort:true,chooseEffort:async()=>{used=true;return {effort:"low",via:"jev"};}},quick:true,runner:"codex"});assert.equal(used,true);assert.deepEqual(chosen,{effort:"low",via:"jev"});});
test("app intake cannot turn an inspection into a ticket or change the authenticated reporter",async t=>{const f=fixture(t,"Inspect current ticket status");await assert.rejects(f.broker.tool(f.job,"open_ticket",{title:"A ticket",description:"Create something",category:"bug"}),/explicitly/);assert.equal(f.calls.some(c=>c.write),false);});
test("coordinator guidance retains a pending approval and does not wake through its hold",async t=>{const f=fixture(t);const target=f.ledger.createJob("ticket:100",{kind:"ticket",ticket:100,role:"support",channelId:"channel",source:{},inbox:[]});target.state="waiting";(f.ledger.data.decisions||={}).pending={id:"pending",jobId:target.id,state:"pending",question:"An exact approval"};const r=await f.broker.tool(f.job,"support_directive",{ticket:100});assert.equal(r.outcome,"held");assert.ok(r.remainingBlockers.includes("pending-decision"));assert.equal(target.state,"waiting");assert.equal(f.ledger.data.decisions.pending.state,"pending");});
test("legacy retry creates fresh provenance without reviving old approval or uncertain effects",t=>{
 const f=fixture(t,"Create a new incident ticket for the sector margin investigation");const old=f.job;old.state="blocked";old.pullRequests=["https://github.com/example/project/pull/42"];delete f.ledger.data.ownerMuseOrigins[old.id];
 f.ledger.data.actions.old={id:"old",jobId:old.id,state:"approved"};
 const agent=require("../lib/operator/appagent").createAppAgent({ledger:f.ledger,config:f.config,app:f.app});
 const retried=agent.retry(old.id);const count=Object.keys(f.ledger.data.jobs).length;assert.equal(agent.retry(old.id).taskId,retried.taskId);assert.equal(Object.keys(f.ledger.data.jobs).length,count);assert.equal(retried.restarted,true);assert.notEqual(retried.taskId,old.id);assert.equal(old.state,"cancelled");assert.equal(f.ledger.data.actions.old.state,"superseded");assert.equal(require("../lib/operator/ownermuse-policy").origin(f.ledger.data,f.ledger.data.jobs[retried.taskId]).valid,true);
 const replacement=f.ledger.data.jobs[retried.taskId];assert.match(replacement.inbox[0].content,/pull\/42/);assert.equal(replacement.inbox[0].role,"assistant");replacement.state="blocked";replacement.effects.external={state:"started"};assert.throws(()=>agent.retry(replacement.id),/inspection/);
});
test("answered choices disappear from live chat without losing the saved answer",t=>{
 const f=fixture(t);f.ledger.data.appThread.questions={old:{id:"old",jobId:f.job.id,thread:"main",state:"answered",answers:["kept"]},pending:{id:"pending",jobId:f.job.id,thread:"main",state:"pending"}};
 assert.deepEqual(f.app.view().questions.map(q=>q.id),["pending"]);assert.deepEqual(f.ledger.data.appThread.questions.old.answers,["kept"]);
});
test("app merge requires a sealed native approval and refuses a changed head",async t=>{
 const f=fixture(t,"Merge the green PR 42"), head="a".repeat(40),base="b".repeat(40);let current=head;const writes=[];
 const broker=createBroker({ledger:f.ledger,config:f.config,mcp:{servers:()=>[]},discord:async()=>{},sandbox:{},exec:async(_bin,args)=>{
  if(args.includes("-X")){writes.push(args);return JSON.stringify({merged:true,sha:"c".repeat(40)});}
  const url=args[1];if(url.endsWith("/pulls/42"))return JSON.stringify({number:42,state:"open",head:{sha:current,ref:"fixture"},base:{sha:base,ref:"development"},mergeable:true});
  if(url.includes("/files?"))return "[]";if(url.includes("/check-runs?"))return JSON.stringify({check_runs:[{name:"verify",status:"completed",conclusion:"success"}]});throw new Error("Unexpected fixture API "+url);
 }});
 const plain=h=>({reviewedHead:h,change:"Fix the reported issue with the account page display.",impact:"People will see the corrected account information after release.",risk:"The account page needs checking before the change reaches everyone."});
 const first=await broker.tool(f.job,"github",{action:"merge",number:42,explanation:plain(head)});assert.equal(first.state,"pending");assert.equal(writes.length,0);
 const action=f.ledger.data.actions[first.action];assert.equal(action.ownerMuse.scope.head,head);assert.ok(action.ownerMuse.scope.repository);
 const decisions=require("../lib/operator/decisions").createDecisions({ledger:f.ledger,config:f.config,discord:async()=>{}});
 // The real authenticated app surface records the exact human receipt.
 const app=createAppChannel({ledger:f.ledger,config:f.config,decisions:()=>decisions});app.authenticatedAnswer(first.decision,"approve");
 f.job.state="running";current="d".repeat(40);const changed=await broker.tool(f.job,"github",{action:"merge",number:42,explanation:plain(current)});assert.equal(changed.state,"pending");assert.notEqual(changed.action,first.action);assert.equal(writes.length,0);
 current=head;const result=await broker.tool(f.job,"github",{action:"merge",number:42});assert.equal(result.merged,true);assert.equal(writes.filter(a=>a.includes("PUT")).length,1);assert.equal(action.state,"done");assert.equal(writes.some(a=>a.includes("DELETE")),false);
});
test("new authenticated Test checks reply immediately without draining a model job",t=>{
 const f=fixture(t);let drains=0;const app=createAppChannel({ledger:f.ledger,config:f.config,drain:()=>drains++});const response=app.authenticatedPost("Test","instant-check","main",{mode:"new"});
 assert.equal(f.ledger.data.jobs[response.jobId].state,"done");assert.equal(app.view().messages.at(-1).text,"Received. I’m here.");assert.equal(drains,0);const repeated=app.authenticatedPost("Test","instant-check","main",{mode:"new"});assert.equal(repeated.duplicate,true);assert.equal(drains,0);
});
test("live feedback distinguishes blocked tasks and pending questions from completed work",t=>{
 const f=fixture(t);f.job.state="blocked";const activity=require("../lib/operator/appcontrols").activityState;assert.equal(activity(f.ledger.data).status,"Needs attention");assert.equal(activity(f.ledger.data).count,1);
 f.job.state="waiting";f.ledger.data.appThread.questions={q:{state:"pending",jobId:f.job.id}};assert.equal(activity(f.ledger.data).status,"Waiting for your answer");
});
test("connection checks do not wait behind an existing conversation",t=>{
 const f=fixture(t,"How is the investigation going?");f.job.kind="conversation";const check=f.app.authenticatedPost("Ping",null,"main",{mode:"followup"});assert.notEqual(check.jobId,f.job.id);assert.equal(f.job.state,"running");assert.equal(f.ledger.data.jobs[check.jobId].state,"done");
});
test("unattested saved app approvals are shown as restartable work, not unusable approval buttons",t=>{
 const f=fixture(t);delete f.ledger.data.ownerMuseOrigins[f.job.id];f.job.state="waiting";f.ledger.data.decisions={old:{id:"old",jobId:f.job.id,state:"pending",question:"An old app approval"}};
 const agent=require("../lib/operator/appagent").createAppAgent({ledger:f.ledger,config:f.config,app:f.app});assert.equal(agent.task(f.job.id).attention.action,"retry");assert.equal(f.app.pendingDecisions().length,0);assert.equal(f.ledger.data.decisions.old.state,"pending");
});
test("administrative recovery binds the saved owner source and cannot mint legacy authority", t => {
 const f=fixture(t); f.job.state="blocked"; const agent=require("../lib/operator/appagent").createAppAgent({ledger:f.ledger,config:f.config,app:f.app});
 const recover=require("../lib/operator/apprecovery").recover, deps={ledger:f.ledger,config:f.config,app:f.app,agent};
 const input={operation:"retry",taskId:f.job.id,sourceMessageId:f.job.source.messageId};
 assert.throws(()=>recover(deps,{...input,sourceMessageId:"wrong"}),/source/);
 delete f.ledger.data.ownerMuseOrigins[f.job.id]; assert.throws(()=>recover(deps,input),/cannot create/);
 const p=require("../lib/operator/ownermuse-policy"), artifact={id:"report",task:f.job.id,kind:"report",title:"Existing audit",summary:"No missed payout established.",markdown:"Evidence and limits saved."};
 f.ledger.data.appThread.artifacts={report:artifact};f.job.ownerMuseBlocker={capability:"read_tool",message:"Old refusal"};
 const report={...input,operation:"report",artifactId:"report",artifactDigest:p.digest(artifact)};
 assert.throws(()=>recover(deps,{...report,artifactDigest:"wrong"}),/digest/);
 f.job.effects.uncertain={state:"started"};assert.throws(()=>recover(deps,input),/uncertain/);
 const result=recover(deps,report);assert.equal(result.retainedActionHold,true);assert.equal(f.job.effects.uncertain.state,"started");assert.equal(result.messageIds.length,1);assert.equal(f.job.state,"blocked");assert.equal(p.origin(f.ledger.data,f.job).valid,false);assert.equal(f.job.ownerMuseBlocker,undefined);
 assert.match(f.job.summary,/No missed payout/);assert.equal(recover(deps,report).duplicate,true);assert.equal(f.job.history.at(-1).priorBlocker.message,"Old refusal");
});
test("a held directive can reach the existing staff command without waking or releasing the coordinator", async t => {
 const f=fixture(t);const target=f.ledger.createJob("ticket:100",{kind:"ticket",ticket:100,role:"support",channelId:"channel",source:{},inbox:[]});target.state="deferred";
 f.ledger.data.channels.channel={claimedBy:f.config.ownerId,category:"mechanics"};
 const command=f.ledger.createJob("staff:100",{kind:"command",role:"owner",actorId:f.config.ownerId,ticket:100,channelId:"channel",source:{authorId:f.config.ownerId},inbox:[],deadline:Date.now()+60000});command.state="waiting";
 const args={ticket:100,recipientTaskId:command.id};const r=await f.broker.tool(f.job,"support_directive",args);
 assert.equal(r.outcome,"held");assert.equal(target.state,"deferred");assert.equal(command.state,"waiting");assert.equal(command.inbox.length,1);
 await f.broker.tool(f.job,"support_directive",args);assert.equal(command.inbox.length,1);assert.equal(f.ledger.data.channels.channel.claimedBy,f.config.ownerId);
 command.state="running";await assert.rejects(f.broker.tool(command,"calculate",{expression:"1+1"}),/support_updates/);
 await f.broker.tool(command,"support_updates",{});const saved=f.ledger.data.supportDirectives[r.id];assert.ok(saved.incorporatedAt);assert.equal(saved.incorporatedBy,command.id);assert.equal(saved.outcome,"held");
 // Activation puts its input into requestInbox before the first model tool.
 delete saved.incorporatedAt;delete saved.incorporatedBy;command.requestInbox=[{directiveId:r.id}];f.broker.supportDirectiveTick();assert.ok(saved.incorporatedAt);assert.equal(saved.incorporatedBy,command.id);assert.equal(target.state,"deferred");
 command.actorId="outsider";await assert.rejects(f.broker.tool(f.job,"support_directive",args),/authenticated staff/);
 assert.equal(target.state,"deferred");assert.equal(Object.keys(f.ledger.data.actions).length,0);
});

test("uncertain publication is explained before legacy restart and cannot be retried", t => {
 const f=fixture(t);f.job.state="blocked";delete f.ledger.data.ownerMuseOrigins[f.job.id];
 f.ledger.data.actions.pendingPublish={id:"pendingPublish",jobId:f.job.id,kind:"publish_patch",state:"executing"};
 const agent=require("../lib/operator/appagent").createAppAgent({ledger:f.ledger,config:f.config,app:f.app});
 (f.ledger.data.decisions ||= {}).legacy={id:"legacy",jobId:f.job.id,state:"pending",question:"Old merge request"};
 const task=agent.task(f.job.id);assert.equal(task.canRetry,false);assert.deepEqual(task.decisions,[]);assert.equal(task.attention.title,"Keir is checking the earlier publication");assert.equal(task.attention.action,null);assert.match(task.attention.detail,/publication/);
 assert.throws(()=>agent.retry(f.job.id),/inspection/);assert.equal(f.ledger.data.actions.pendingPublish.state,"executing");
});
