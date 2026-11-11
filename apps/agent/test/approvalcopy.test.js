"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const copy=require("../lib/operator/approvalcopy");
const human={reviewedHead:"head",change:"Some companies' share prices wrongly kept falling, then suddenly jumped. This fixes the calculation.",impact:"Affected companies can move toward the price they should have.",risk:"Share prices need checking before this reaches the live game."};
test("test-server approval explains the player change and does not authorize live release",()=>{
 const r=copy.prepare(human,{action:"promote",to:"staging",head:"head"});
 assert.match(copy.body(r),/share prices/);assert.match(r.where,/test server only/);assert.match(r.where,/live game stays/);assert.match(r.approve,/test server/);
 assert.doesNotMatch(copy.body(r),/staging|development|\.ts|multiplier|limiter/);
});
test("live release and preparation have distinct plain-language consequences",()=>{
 const live=copy.prepare(human,{action:"promote",to:"main",head:"head"});assert.match(live.title,/players/);assert.match(live.decline,/current live version/);
 const next=copy.prepare(human,{action:"merge",number:1,head:"head"});assert.match(next.where,/does not update the test server or the live game/);
});
test("technical copy and a description of a different version cannot become approvals",()=>{
 assert.throws(()=>copy.prepare({...human,reviewedHead:"old"},{head:"head"}),/exact change/);
 for(const change of ["src/lib/corporations/prices.ts needs to be promoted.","Apply share-price multipliers before the per-turn limiter.","Promote development to staging for PR 4940."])
   assert.throws(()=>copy.prepare({...human,change},{head:"head"}),/ordinary language/);
});
test("one refusal names every field that needs fixing, with its measured length",()=>{
 // A release that carries several plain-language fixes easily runs past the limit. The model then
 // gets one refusal per field, fixes change, and is refused again for impact. Report them together.
 const long=("Players see corrected share prices after this change, and nothing else moves. ").repeat(6).trim();
 assert.ok(long.length>350);
 let message="";
 assert.throws(()=>copy.prepare({...human,change:long,impact:long,risk:long},{head:"head"}),(e)=>{message=e.message;return true;});
 for(const key of ["change","impact","risk"]) assert.match(message,new RegExp(`${key} is ${long.length} characters`),`${key} reported with its length`);
 assert.match(message,/limit is 350/);
 assert.match(message,/Fix all of these in one call/);
 assert.doesNotMatch(message,/[\u2013\u2014]/);
});
test("a jargon refusal quotes the offending word so it can be removed",()=>{
 let message="";
 assert.throws(()=>copy.prepare({...human,impact:"Share prices now come from outputResponseRules.ts, which runs once per turn."},{head:"head"}),(e)=>{message=e.message;return true;});
 assert.match(message,/"outputResponseRules\.ts"/);
 assert.match(message,/ordinary language/);
});
test("a desktop source change does not claim players receive a released app",()=>{
 const r=copy.prepare(human,{repository:"example/AHDClient",action:"merge",to:"main",head:"head"});
 assert.match(r.where,/only after a new app version is published and installed/);assert.doesNotMatch(r.where,/updates the live game/);
});
