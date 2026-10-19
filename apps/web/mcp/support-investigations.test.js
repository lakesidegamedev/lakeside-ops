"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { auditCandidates, investigationSummary, staffOverwrites } = require("./support-investigations");
const flag=(type,severity="medium")=>({type,severity,detail:"Observed evidence",detectedAt:"2026-10-19"});
test("one weak signal stays below filing threshold; independent signals combine",()=>{
  const account={_id:"source",characterId:"abc",flags:[flag("ip_sharing")]};
  assert.equal(auditCandidates([account],[])[0].needsReview,false);
  account.flags.push(flag("shared_fingerprint"));assert.equal(auditCandidates([account],[])[0].needsReview,true);
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
 const candidate={key,subject:"Fixture subject",needsReview:true,signals:[{...flag("cash_mismatch","high"),source:"financialTxLog",sourceId:"test-tx"}],transactions:[]};
 const discordImpl=async(path,init={})=>{calls.push({path,...init});if(path==="/users/@me")return{id:"222222222222222222",username:"Keir"};if(path.endsWith("/roles"))return[{id:process.env.DISCORD_DEVELOPER_ROLE_ID},{id:process.env.DISCORD_MODERATOR_ROLE_ID}];if(path.endsWith("/channels")&&!init.method)return[];if(path.endsWith("/channels")&&init.method==="POST"){acl=JSON.parse(init.body).permission_overwrites;return{id:"channel"};}if(path==="/channels/channel")return{id:"channel",permission_overwrites:invalidAcl?[]:acl};if(path.endsWith("/messages"))return{id:"message"};throw Error(path);};
 global.fetch=async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify(url.endsWith("/reserve")?{ticketNumber:42}:{ok:true}),{status:200});};
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
