"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createSupportOwner } = require("../lib/operator/supportowner");
const { createReopenedTickets, FRESH_MS } = require("../lib/operator/reopened");
const NOW = 10000000;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-reopened-")); t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const ledger = createLedger(path.join(dir,"ledger.json"));
  const old = ledger.createJob("ticket:1558", { kind:"ticket",role:"support",ticket:1558,channelId:"old",updatedAt:NOW-2000 });
  Object.assign(old,{state:"done",channelClosed:true,summary:"Earlier final outcome",resolutionReadyAt:NOW-3000,resolutionSubmitted:true,resolved:true});
  old.effects.previous={state:"done"};
  const owner = createSupportOwner({ledger,now:()=>NOW});
  const canonical = {number:1558,status:"in_progress",category:"bug",resolution:null,conversation:{channelId:"new",previousChannelId:"old",reopenRequestId:"request",reopenedAt:new Date(NOW-1000).toISOString()}};
  const channel = {id:"new",name:"ticket-bug-player-1558",type:0,guild_id:"guild",topic:"support-reopen:1558:request"};
  let oldLive = null, reads=0;
  const build=(l=ledger)=>createReopenedTickets({ledger:l,config:{guildId:"guild",taskLifetimeMs:86400000},supportOwner:createSupportOwner({ledger:l,now:()=>NOW}),readTicket:async()=>{reads++;return canonical;},readChannel:async(id)=>id==="old"?oldLive:channel,now:()=>NOW});
  const handoff=(options={})=>owner.receive({ ...options, id:"fresh-owner-context",from:"Codex on owner request",scope:"Continue reopened1558",asks:["Explain actionable controls and keep open"],tickets:[1558],body:"No repair or rebalance authorized."},{ensureTicketJob:()=>old});
  return{ledger,old,owner,canonical,channel,build,handoff,reads:()=>reads,setOldLive:(v)=>{oldLive=v;},file:path.join(dir,"ledger.json")};
}
test("actual handoff on closed conversation adopts a fresh canonical job and incorporates context",async(t)=>{const f=fixture(t);f.handoff();assert.equal(f.old.state,"done","handoff alone cannot revive deleted channel");const result=await f.build().adopt(1558,f.channel);assert.ok(result);const job=f.ledger.data.jobs[result.job];assert.notEqual(job.id,f.old.id);assert.equal(job.channelId,"new");assert.equal(job.state,"queued");assert.equal(job.resolutionReadyAt,undefined);assert.equal(job.resolutionSubmitted,undefined);assert.equal(job.resolved,undefined);assert.deepEqual(job.effects,{});assert.match(job.source.content,/Keep this ticket open/);assert.match(job.inbox[0].content,/No repair or rebalance authorized/);assert.equal(f.old.state,"done");assert.equal(f.old.summary,"Earlier final outcome");assert.equal(f.old.channelId,"old");f.owner.incorporateFor(job);assert.equal(f.ledger.data.handoffDesk.handoffs["fresh-owner-context"].state,"incorporated");assert.equal(await f.build().adopt(1558,f.channel),null);const loaded=createLedger(f.file);assert.equal(loaded.data.seen["ticket:1558"],job.id);assert.equal(loaded.data.jobs[f.old.id].state,"done");});
test("closed canonical tickets and unrelated new channels never revive old outcomes",async(t)=>{for(const change of [f=>{f.canonical.status="resolved";},f=>{f.canonical.resolution={message:"still closed"};},f=>{f.canonical.conversation.previousChannelId="other";},f=>{f.channel.topic="forged";},f=>{f.channel.guild_id="other";},f=>{f.channel.name="ticket-bug-player-1559";},f=>{f.canonical.conversation.reopenedAt=NOW-3000;},f=>{f.setOldLive({id:"old"});},f=>{f.ledger.data.channels.new={claimedBy:"staff"};}]){const f=fixture(t);f.handoff();change(f);assert.equal(await f.build().adopt(1558,f.channel),null);assert.equal(f.ledger.data.seen["ticket:1558"],f.old.id);assert.equal(f.old.state,"done");}});
test("no fresh authorization, pre-reopen or stale handoff cannot restart work",async(t)=>{for(const kind of ["none","stale","before"]){const f=fixture(t);if(kind!=="none"){f.handoff();f.ledger.data.handoffDesk.handoffs["fresh-owner-context"].filedAt=kind==="stale"?NOW-FRESH_MS-1:NOW-1500;}assert.equal(await f.build().adopt(1558,f.channel),null);assert.equal(f.old.state,"done");}});
test("paused, deferred, uncertain-effect and non-closure finished tasks stay terminal",async(t)=>{for(const change of [f=>{f.ledger.data.paused=true;},f=>{f.owner.setTicketOwner(1558,"staff","owner");},f=>{f.old.effects.pending={state:"started"};},f=>{f.old.channelClosed=false;}]){const f=fixture(t);f.handoff();change(f);assert.equal(await f.build().adopt(1558,f.channel),null);assert.equal(f.reads(),0);assert.equal(f.old.state,"done");}});

test("a fresh explicit owner closure hold follows the reopened ticket", async t => {
  const f = fixture(t);
  f.handoff({ holdClosure: true });
  const result = await f.build().adopt(1558, f.channel);
  const job = f.ledger.data.jobs[result.job];
  assert.deepEqual(job.ownerClosureHold, { handoffId: "fresh-owner-context", at: NOW });
  assert.deepEqual(createLedger(f.file).data.jobs[job.id].ownerClosureHold, job.ownerClosureHold);
});
test("an unrelated historical closure hold is not inherited", async t => {
  const f = fixture(t);
  f.old.ownerClosureHold = { handoffId: "old-unrelated-handoff", at: NOW - 5000 };
  f.handoff();
  const result = await f.build().adopt(1558, f.channel);
  assert.equal(f.ledger.data.jobs[result.job].ownerClosureHold, undefined);
});
