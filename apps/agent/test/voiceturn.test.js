"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { context, readSchemas, finalReplyQueued } = require("../lib/operator/voiceturn");
test("delegated voice context stops at its own source and identifies delivery by accepted turn", () => {
  const root={id:"voice-b",voiceMode:true,replyChannel:"app",source:{messageId:"new"}},child={id:"worker",museParent:root.id};
  const data={jobs:{[root.id]:root,worker:child},appThread:{messages:[{id:"old",seq:1,role:"owner",text:"Same question",jobId:"voice-a"},{id:"new",seq:2,role:"owner",text:"Same question",jobId:root.id},{id:"other-answer",seq:3,role:"keir",text:"An answer",jobId:"voice-a"}]}};
  const c=context(data,child);assert.equal(c.turn.jobId,root.id);assert.equal(c.turn.replyRequired,true);assert.equal(c.conversation.messages.length,2);
  data.appThread.messages.push({seq:4,role:"keir",jobId:root.id,text:"Checking",voiceProgress:true});assert.equal(finalReplyQueued(data,child),false);
  data.appThread.messages.push({seq:5,role:"keir",jobId:root.id,text:"A quick answer",provisional:true});assert.equal(finalReplyQueued(data,child),false,"a provisional first answer is not the finished turn");
  data.appThread.messages.push({seq:6,role:"keir",jobId:root.id,text:"Final answer"});assert.equal(finalReplyQueued(data,child),true);
});
test("prefetched voice schemas are bounded reviewed reads, never arbitrary server tools", async () => {
  const calls=[];
  const rows=await readSchemas({servers:()=>["ops-knowledge","engine","unknown"],list:async(server,signal)=>{calls.push(server);assert.ok(signal instanceof AbortSignal);return[{name:server==="engine"?"engine_health":"kanban_get",inputSchema:{type:"object"}},{name:"delete_all",inputSchema:{}}]}});
  assert.deepEqual(calls.sort(),["engine","ops-knowledge"]);assert.equal(rows.length,2);assert.equal(rows.some(r=>r.tool==="delete_all"),false);
});
test("missing and failed schema adapters leave normal guarded discovery available", async()=>{
 assert.deepEqual(await readSchemas({}),[]);
 assert.deepEqual(await readSchemas({servers:()=>["engine"],list:async()=>{throw Error("offline")}}),[]);
});
