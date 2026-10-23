"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const { workStatus, reviewWaits, createWorkQueue }=require("../lib/operator/workqueue");
const make=(extra={})=>({id:"a",kind:"ticket",role:"support",ticket:1560,state:"waiting",at:100,updatedAt:200,wakeAt:1000,effects:{},...extra});
const data=jobs=>({jobs:Object.fromEntries(jobs.map(j=>[j.id,j])),channels:{},actions:{},decisions:{}});
test("a delegated running worker means actual work, not a waiting parent",()=>{
 const parent=make(), child=make({id:"c",ticket:null,kind:"coding",codingParent:"a",state:"running"});
 const s=workStatus(data([parent,child]),parent,{now:500});
 assert.equal(s.state,"working");assert.equal(s.activeWorkers,1);assert.equal(s.expectedDoneAt,null);
});
test("claims, decisions and uncertainty are separate from timers and cannot be bypassed",()=>{
 const j=make({channelId:"c"}),d=data([j]);d.channels.c={claimedBy:"staff"};
 assert.equal(workStatus(d,j,{now:500}).state,"held");delete d.channels.c.claimedBy;
 d.decisions.x={jobId:j.id,state:"pending",question:"Which option?"};assert.equal(workStatus(d,j,{now:500}).state,"needs-you");
 d.actions.x={jobId:j.id,state:"executing"};assert.equal(workStatus(d,j,{now:500}).state,"stuck");
 assert.equal(workStatus(d,j,{now:500}).uncertain,true);
});
test("missing wakes and expired scheduled checks are visible without fabricating a finish ETA",()=>{
 const j=make({wakeAt:0}),s=workStatus(data([j]),j,{now:500000});
 assert.equal(s.nextCheckAt,null);assert.equal(s.overdue,true);assert.equal(s.expectedDoneAt,null);
 j.wakeAt=1000000;assert.equal(workStatus(data([j]),j,{now:500000}).overdue,false);
});
test("overdue safe waits get one review wake per material progress change, while claims stay held",()=>{
 const a=make({updatedAt:1}),b=make({id:"b",channelId:"held",updatedAt:1}),c=make({id:"c",updatedAt:1,effects:{x:{state:"started"}}});
 const d=data([a,b,c]);d.channels.held={claimedBy:"staff"};let saves=0;const notifications=[];
 const ledger={data:d,save(){saves++},audit(){},notify(...x){notifications.push(x)}};
 reviewWaits(ledger,{},4000000);assert.equal(a.inbox.length,1);assert.equal(b.inbox,undefined);assert.equal(c.inbox,undefined);
 reviewWaits(ledger,{},5000000);assert.equal(a.inbox.length,1);assert.equal(notifications.length,0);
 a.effects.done={state:"done"};a.updatedAt=5000000;reviewWaits(ledger,{},5000000);
 assert.equal(a.waitReview.reviewAt,8600000);assert.ok(saves>0);
});
test("all open tickets come from a fresh open-only source and source failure preserves the last list",async()=>{
 let now=1000,calls=0;
 const mcp={servers:()=>["support"],call:async(server,tool,args,write)=>{calls++;assert.equal(args.openOnly,true);assert.equal(write,false);if(calls>1)throw Error("offline");return {items:[{number:1560,title:"Work",status:"open"},{number:1566,title:"No worker",status:"open"}]}}};
 const j=make(),q=createWorkQueue({ledger:{data:data([j])},mcp,now:()=>now});
 const r=await q.view();assert.equal(r.tickets.length,2);assert.equal(r.source.complete,true);assert.equal(r.tickets[1].timing.state,"queued");assert.equal(r.tickets[1].timing.overdue,false);
 now+=31000;const stale=await q.view();assert.equal(stale.tickets.length,2);assert.equal(stale.source.complete,false);assert.match(stale.source.error,/refresh/);
});
test("standalone queues do not require a studio support service",async()=>{
 const r=await createWorkQueue({ledger:{data:data([])}}).view();assert.equal(r.source.enabled,false);assert.deepEqual(r.tickets,[]);
});
test("a currently running action is progress, while a pending orphan approval needs repair",()=>{
 const j=make({state:"running",effects:{x:{state:"started"}}}),d=data([j]);d.actions.x={jobId:j.id,state:"executing"};
 assert.equal(workStatus(d,j,{now:500}).state,"working");
 j.state="waiting";j.effects={};d.actions.x.state="pending";
 const s=workStatus(d,j,{now:500});assert.equal(s.state,"stuck");assert.match(s.reason,/without a reviewable decision/);
});
test("a worker completion forecast is labelled and cannot reset wait age",()=>{
 const j=make({completionForecast:{kind:"worker-estimate",at:200,expectedAt:60000,basis:"One bounded review remains."},waitReview:{since:100,reviewAt:500,progress:"x"}});
 const s=workStatus(data([j]),j,{now:1000});assert.equal(s.expectedDoneAt,60000);assert.equal(s.since,100);assert.equal(s.overdue,true);assert.match(s.etaLabel,/not a guaranteed/);
});

test("waiting on a player is never overdue for the owner, even past Keir's review time", () => {
 const j = make({ wakeAt: 0, waitingFor: { kind: "player_reply" }, waitReview: { since: 100, reviewAt: 300 } });
 const s = workStatus(data([j]), j, { now: 10000 });
 assert.equal(s.state, "waiting"); assert.equal(s.overdue, false);
 const own = make({ id: "b", wakeAt: 0, waitingFor: { kind: "developer_reply" }, waitReview: { since: 100, reviewAt: 300 } });
 assert.equal(workStatus(data([own]), own, { now: 10000 }).overdue, true);
});

test("the canonical ticket job wins over an older owner command about the same ticket", async () => {
 const canonical=make({id:"support",waitingFor:{kind:"player_reply"},summary:"Recovery applied; awaiting sign-in confirmation."});
 const command=make({id:"command",role:"owner",kind:"command",updatedAt:300,wakeAt:999999,summary:"Old investigation"});
 const d=data([canonical,command]);d.seen={"ticket:1560":"support"};
 const q=createWorkQueue({ledger:{data:d},now:()=>10000,mcp:{servers:()=>["support"],call:async()=>({items:[{number:1560,title:"Recovery",status:"blocked"}]})}});
 const view=await q.view();assert.equal(view.tickets[0].task,"support");assert.equal(view.tickets[0].timing.state,"waiting");assert.match(view.tickets[0].timing.reason,/player_reply/);
});
test("a staff-held ticket does not become overdue because Keir's old forecast expired",()=>{
 const j=make({channelId:"staff",waitReview:{since:100,reviewAt:200},completionForecast:{kind:"worker-estimate",at:100,expectedAt:200}});
 const d=data([j]);d.channels.staff={claimedBy:"staff"};
 const status=workStatus(d,j,{now:10000});assert.equal(status.state,"held");assert.equal(status.overdue,false);assert.equal(status.expectedDoneAt,null);
});
test("waiting for the player retires an obsolete completion forecast",()=>{
 const j=make({waitingFor:{kind:"player_reply"},completionForecast:{kind:"worker-estimate",at:100,expectedAt:200},updatedAt:300});
 const status=workStatus(data([j]),j,{now:10000});assert.equal(status.overdue,false);assert.equal(status.expectedDoneAt,null);
});
