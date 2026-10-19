"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { auditCandidates, investigationSummary, staffOverwrites } = require("./support-investigations");
const flag=(type,severity="medium")=>({type,severity,detail:"Observed evidence",detectedAt:"2026-10-19"});
test("shared IP and browser fingerprints do not make a ticket, even together",()=>{
  const account={_id:"source",characterId:"abc",flags:[flag("ip_sharing")]};
  assert.equal(auditCandidates([account],[])[0].needsReview,false);
  account.flags.push(flag("shared_fingerprint"));assert.equal(auditCandidates([account],[])[0].needsReview,false);
  account.dismissed=true;assert.equal(auditCandidates([account],[]).length,0);
});
test("suppression expiry and reviewed financial flags are respected",()=>{
 const account={characterId:"abc",flags:[flag("shared_tracking_cookie","high")],suppressedFlags:[{type:"shared_tracking_cookie",suppressedUntil:"2026-10-20"}]};
 assert.equal(auditCandidates([account],[],new Date("2026-10-19")).length,0);
 assert.equal(auditCandidates([account],[],new Date("2026-10-21")).length,1);
 const tx={subjectId:"abc",subjectType:"character",suspectFlags:[{...flag("cash_mismatch","high"),reviewedAt:"2026-10-19"}]};
 assert.equal(auditCandidates([],[tx]).length,0);
});
test("currency and source ids survive a combined account/money summary",()=>{
 const c=auditCandidates([{characterId:"abc",flags:[flag("shared_fingerprint")]}],[{_id:"tx123",subjectId:"abc",subjectType:"character",type:"transfer",amount:-1200,currencyCode:"GBP",turn:311,suspectFlags:[flag("cash_mismatch","high")]}])[0];
 assert.equal(c.signals.length,2);const report=investigationSummary(c,"now");assert.match(report,/-1200 GBP/);assert.match(report,/tx123/);assert.match(report,/not proof/);assert.match(report,/anchor unavailable/);
});
test("investigation ACL grants only the two staff roles and bot, never a reporter",()=>{
 const acl=staffOverwrites("111111111111111111","222222222222222222",["333333333333333333","444444444444444444"]);
 assert.deepEqual(acl.map(x=>x.id),["111111111111111111","333333333333333333","444444444444444444","222222222222222222"]);
 assert.equal(acl[0].deny,"1024");assert.equal(acl[0].allow,"0");
 assert.throws(()=>staffOverwrites("111111111111111111","222222222222222222",["111111111111111111","444444444444444444"]));
 assert.throws(()=>staffOverwrites("111111111111111111","222222222222222222",[undefined,undefined]));
});
test("filing verifies explicit ACL, uses bot identity and never mints public receipts",async()=>{
 const { registerInvestigations }=require("./support-investigations");
 const oldFetch=global.fetch, oldDev=process.env.DISCORD_DEVELOPER_ROLE_ID, oldMod=process.env.DISCORD_MODERATOR_ROLE_ID, oldToken=process.env.DISCORD_BOT_API_KEY;
 process.env.DISCORD_DEVELOPER_ROLE_ID="333333333333333333";process.env.DISCORD_MODERATOR_ROLE_ID="444444444444444444";process.env.DISCORD_BOT_API_KEY="test";
 const calls=[], handlers={}, key="character:aaaaaaaaaaaaaaaaaaaaaaaa";
 let acl,invalidAcl=false, existing=null;
 const chain=new Proxy({},{get:()=>()=>chain});
 const candidate={...auditCandidates([{...linkedBenefitFixture(),characterId:"a".repeat(24)}],[],new Date("2026-10-19T12:00:00Z"))[0],subject:"Fixture subject"};
 const discordImpl=async(path,init={})=>{calls.push({path,...init});if(path==="/users/@me")return{id:"222222222222222222",username:"Keir"};if(path.endsWith("/roles"))return[{id:process.env.DISCORD_DEVELOPER_ROLE_ID},{id:process.env.DISCORD_MODERATOR_ROLE_ID}];if(path.endsWith("/channels")&&!init.method)return[];if(path.endsWith("/channels")&&init.method==="POST"){acl=JSON.parse(init.body).permission_overwrites;return{id:"channel"};}if(path==="/channels/channel")return{id:"channel",permission_overwrites:invalidAcl?[]:acl};if(path.endsWith("/messages"))return{id:"message"};throw Error(path);};
 global.fetch=async(url,init)=>{calls.push({url,body:init.body?JSON.parse(init.body):null});if(url.includes("capabilities=1"))return new Response(JSON.stringify({investigationIntake:true}),{status:200});return new Response(JSON.stringify(url.endsWith("/reserve")?{ticketNumber:42}:{ok:true}),{status:200});};
 registerInvestigations({tool:(name,desc,schema,fn)=>{if(typeof schema==="function")fn=schema;handlers[name]=fn;}},{auth:{scopes:{write:true}},db:{collection:()=>({findOne:async()=>existing,updateOne:async()=>({matchedCount:1})})},z:{string:()=>chain},jsonResult:x=>x,errorResult:error=>({error}),discordImpl,scanImpl:async()=>({at:"now",candidates:[candidate]})});
 try {
  let result=await handlers.support_create_investigation({key});assert.equal(result.staffOnly,true);
  const registration=calls.find(c=>c.url?.endsWith("/tickets"));assert.equal(registration.body.discordUserId,"222222222222222222");assert.equal(registration.body.category,"investigation");assert.equal(registration.body.investigationKey,key);
  assert.equal(calls.some(c=>/public-link|\/t\//.test(c.url||c.path)),false);
  const messages=calls.filter(c=>c.path?.endsWith("/messages"));assert.ok(messages.length);assert.deepEqual(JSON.parse(messages[0].body).allowed_mentions,{parse:[]});assert.equal(JSON.parse(messages[0].body).embeds[0].fields[0].value,"Investigation");
  calls.length=0;invalidAcl=true;result=await handlers.support_create_investigation({key});assert.match(result.error,/ACL verification failed/);assert.equal(calls.some(c=>c.path?.endsWith("/messages")),false);assert.equal(calls.some(c=>c.url?.endsWith("/tickets")),false);
  calls.length=0;invalidAcl=false;existing={_id:"existing",ticketNumber:42,discordChannelId:"channel"};result=await handlers.support_create_investigation({key});assert.equal(result.duplicate,true);assert.equal(result.updated,true);assert.equal(calls.some(c=>c.url?.endsWith("/reserve")),false);
 } finally {global.fetch=oldFetch;for(const[k,v]of Object.entries({DISCORD_DEVELOPER_ROLE_ID:oldDev,DISCORD_MODERATOR_ROLE_ID:oldMod,DISCORD_BOT_API_KEY:oldToken})){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});

test("normal money activity and ledger gaps never escalate merely because severity is high",()=>{
 const types=["cash_mismatch","velocity","time_velocity","large_transaction","round_trip","wash_trade","same_price_wash"];
 for(const type of types){
  const tx={_id:type,subjectId:"fixture",subjectType:"character",type:"index_fund_dividend",amount:2000000000,currencyCode:"USD",suspectFlags:[flag(type,"high")]};
  assert.equal(auditCandidates([],[tx])[0].needsReview,false,type);
 }
 const transactions=types.map(type=>({_id:type,subjectId:"fixture",subjectType:"character",suspectFlags:[flag(type,"high")]}));
 assert.equal(auditCandidates([],transactions)[0].needsReview,false,"combining noisy financial labels still is not corroboration");
});

function linkedBenefitFixture() {
 return {_id:"source",characterId:"fixture",flags:[
  {...flag("shared_tracking_cookie","high"),evidence:{trackingId:"must-not-leave-adapter",sharedWith:[{userId:"partner",username:"partner"}]}},
  {...flag("coordinated_login_pattern","high"),evidence:{matches:[{otherUserId:"partner",otherUsername:"partner",dayCount:4,overlapCount:12,sharedTrackingIds:["must-not-leave-adapter"]}]}},
  {...flag("coordinated_party_funding","high"),evidence:{partnerUsernames:["partner"],eventCount:4}}
 ]};
}
test("a ticket needs identity, repeated access and repeated benefit linked to the same pair",()=>{
 const now=new Date("2026-10-19T12:00:00Z"), account=linkedBenefitFixture();
 const candidate=auditCandidates([account],[],now)[0];assert.equal(candidate.needsReview,true);assert.equal(candidate.reviewBasis.kind,"corroborated_account_benefit");assert.deepEqual(candidate.reviewBasis.relatedUserIds,["partner"]);
 assert.equal(JSON.stringify(candidate).includes("must-not-leave-adapter"),false);
 for(let i=0;i<account.flags.length;i++)assert.equal(auditCandidates([{...account,flags:account.flags.filter((_,index)=>index!==i)}],[],now)[0].needsReview,false,`missing evidence family ${i}`);
});
test("unrelated, one-off, suppressed or stale correlations cannot open tickets",()=>{
 const now=new Date("2026-10-19T12:00:00Z");
 const changes=[a=>{a.flags[1].evidence.matches[0].otherUserId="unrelated";},a=>{a.flags[2].evidence.partnerUsernames=["unrelated"];},a=>{a.flags[2].evidence.partnerUsernames=["partner","unrelated"];},a=>{a.flags[2].evidence.eventCount=1;},a=>{a.flags[1].evidence.matches[0].dayCount=1;},a=>{a.flags[1].evidence.matches[0].overlapCount=2;},a=>{a.flags[0].detectedAt="2026-09-01";},a=>{a.suppressedFlags=[{type:"coordinated_party_funding",suppressedUntil:"2026-10-20"}];}];
 for(const change of changes){const account=linkedBenefitFixture();change(account);assert.equal(auditCandidates([account],[],now)[0].needsReview,false);}
});
