"use strict";
const test=require("node:test"), assert=require("node:assert/strict"), fs=require("node:fs"), path=require("node:path"), vm=require("node:vm");
const {render}=require("../lib/operator/decisions");
// Run the real operator delivery function, not just its card renderer.
async function deliver(decision) {
  const entry={id:"entry",destination:"owner",recipient:"owner",decision:decision.id,content:"old wording",tldrDone:true,at:Date.now(),attempts:0};
  const ledger={data:{jobs:{},outbox:{entry},decisions:{[decision.id]:decision}},save(){},audit(){}};
  const sent=[],errors=[];
  const source=fs.readFileSync(path.join(__dirname,"../operator.js"),"utf8");
  const start=source.indexOf("async function flushOutbox() {");
  const end=source.indexOf("\n// Moderation tickets",start);
  const context={ledger,config:{ownerId:"owner",staffIds:[]},delivering:false,RESUME_HORIZON_MS:86400000,
    require:()=>({suppressOutbox:()=>false}),renderDecision:render,isAppJob:()=>false,
    ensureDm:async()=>"dm",ownerText:s=>s,redactSecrets:s=>s,chunkMessage:s=>[s],
    discord:async(_method,_route,body)=>{sent.push(body);return{id:"message"};},
    decisions:{delivered(e){decision.sentContent=e.sentContent;}},events:{append(){}},log:e=>errors.push(e)};
  vm.runInNewContext(source.slice(start,end)+"\nthis.flush=flushOutbox;",context);
  await context.flush(); assert.deepEqual(errors,[]);return{entry,sent};
}
test("actual Discord delivery preserves the explanation and test-only destination",async()=>{
  const x={id:"abc",state:"pending",signoff:true,question:"Promoting development to staging carries changes to high-impact code: src/lib/price.ts. Head abc123",
    review:{title:"Put the share-price fix on the test server?",scope:{action:"promote",to:"staging",head:"abc123"},human:{change:"Some companies' share prices kept falling and then suddenly jumped. This fix corrects that calculation.",impact:"Affected prices can recover toward their intended value.",risk:"Share prices need checking before players receive the change."},approve:"Put this change on the test server.",decline:"Leave the test server as it is.",where:"This affects the test server only. The live game stays as it is."},options:null};
  const {sent}=await deliver(x);assert.equal(sent.length,1);
  assert.match(sent[0].content,/Some companies' share prices/);
  assert.match(sent[0].content,/test server only/);
  assert.doesNotMatch(sent[0].content,/src\/|Head abc123|Sign-off to ship|high-impact code|Exact scope|\"to\"/);
  assert.equal(x.sentContent,sent[0].content,"the click verifier must trust exactly the plain text that was sent");
});
test("actual Discord delivery retains named choice labels and outcomes",async()=>{
  const {sent}=await deliver({id:"def",state:"pending",question:"Which remedy?",options:[{id:"1",label:"Refund the missing payment",detail:"Prepare a refund for separate approval."},{id:"2",label:"Restore the item",detail:"Prepare an item repair."}]});
  assert.match(sent[0].content,/Refund the missing payment/);assert.match(sent[0].content,/Prepare an item repair/);
});
