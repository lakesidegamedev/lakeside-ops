"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createAccountAudit, INTERVAL } = require("../lib/operator/account-audit");
function fixture() {
  let time = 200000000, scans = 0, writes = 0;
  const ledger = { data: {}, save() {}, audit() {} };
  const mcp = { async call(server, tool, args, write) { assert.equal(write,true); if (tool === "support_audit_accounts") { scans++; return { at: "now", truncated: false, candidates: [{ key: "character:abc", needsReview: true, reviewBasis: { kind: "shared_cookie_coordinated_login" }, signals: [{ type: "cash_mismatch" }] }] }; } writes++; return { ok:true, ticketNumber:42, channelId:"staff" }; } };
  return { ledger, mcp, audit:createAccountAudit({ledger,mcp,now:()=>time}), advance(ms) {time+=ms;}, counts:()=>({scans,writes}) };
}
test("preview cannot file and scheduled sweeps respect 12 hours", async()=>{
  const f=fixture(); await f.audit.sweep({dryRun:true}); assert.deepEqual(f.counts(),{scans:1,writes:0});
  assert.equal(await f.audit.tick(),null); f.advance(15*60000); await f.audit.tick();
  assert.deepEqual(f.counts(),{scans:2,writes:1}); f.advance(INTERVAL); await f.audit.tick();
  assert.equal(f.counts().writes,1);
});
test("ambiguous filing is durable and never repeated after restart",async()=>{
  const f=fixture(); const original=f.mcp.call; f.mcp.call=async(...args)=>{if(args[1]==="support_create_investigation")throw Error("lost response");return original(...args);};
  const report=await f.audit.sweep();assert.equal(report.uncertain.length,1);
  let calls=0;f.mcp.call=async(...args)=>{if(args[1]==="support_create_investigation")calls++;return original(...args);};
  const restarted=createAccountAudit({ledger:f.ledger,mcp:f.mcp});await restarted.sweep();assert.equal(calls,0);
});
test("pause and invalid audit receipts prevent filing",async()=>{
  const f=fixture(); f.ledger.data.paused=true;await assert.rejects(f.audit.sweep(),/stopped/);assert.equal(f.counts().scans,0);
  f.ledger.data.paused=false;f.mcp.call=async()=>({});await assert.rejects(f.audit.sweep(),/receipt/);
});
test("filing limit defers excess cases and a manual sweep drains the next batch",async()=>{
  const f=fixture();let writes=0;f.mcp.call=async(s,t)=>t==="support_audit_accounts"?{truncated:true,candidates:Array.from({length:7},(_,i)=>({key:`character:${i}`,needsReview:true,reviewBasis:{kind:"shared_cookie_coordinated_login"},signals:[]}))}:{ok:true,ticketNumber:++writes,channelId:"staff"};
  let r=await f.audit.sweep();assert.equal(r.opened.length,5);assert.equal(r.deferred,2);assert.equal(r.truncated,true);
  r=await f.audit.sweep();assert.equal(r.opened.length,2);assert.equal(r.existing.length,5);
});
test("financial pages share a timestamp without promoting unrelated sensor warnings into tickets",async()=>{
 const f=fixture();let page=0;f.mcp.call=async(s,t,args)=>{assert.equal(t,"support_audit_accounts");page++;if(page===1)return{at:"2026-10-19T12:00:00Z",truncated:true,sourceTruncated:false,nextCursor:"a".repeat(24),candidates:[{key:"character:abc",needsReview:false,signals:[{type:"ip_sharing",severity:"medium"}]}]};assert.deepEqual(args,{cursor:"a".repeat(24),at:"2026-10-19T12:00:00Z"});return{at:args.at,truncated:false,sourceTruncated:false,candidates:[{key:"character:abc",needsReview:false,signals:[{type:"cash_mismatch",severity:"medium"}]}]};};
 const report=await f.audit.sweep({dryRun:true});assert.equal(report.pages,2);assert.equal(report.candidates,1);assert.equal(report.review,0);assert.equal(report.truncated,false);
});
test("updated existing cases cannot starve new subjects of the filing budget",async()=>{
 const f=fixture();let version=1;f.mcp.call=async(s,t)=>t==="support_audit_accounts"?{truncated:false,candidates:Array.from({length:7},(_,i)=>({key:`character:${i}`,needsReview:true,reviewBasis:{kind:"shared_cookie_coordinated_login"},signals:[{type:"signal",detail:version}]}))}:{ok:true,ticketNumber:42,channelId:"staff"};
 await f.audit.sweep();version++;const report=await f.audit.sweep();assert.equal(report.opened[0].key,"character:5");assert.equal(report.opened[1].key,"character:6");
});
test("legacy severity-only receipts cannot authorize a filing",async()=>{
 const f=fixture();let writes=0;f.mcp.call=async(s,t)=>{if(t!=="support_audit_accounts"){writes++;return{ok:true,ticketNumber:42,channelId:"staff"};}return{truncated:false,candidates:[{key:"character:abc",needsReview:true,signals:[{type:"cash_mismatch",severity:"high"},{type:"time_velocity",severity:"high"}]}]};};
 const report=await f.audit.sweep();assert.equal(report.review,0);assert.equal(writes,0);
});
