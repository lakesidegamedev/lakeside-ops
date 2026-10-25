"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createPresence } = require("../lib/operator/presence");
test("two live tasks in one channel share typing and stop it after both end", async () => {
  const pulses = [], intervals = [], cleared = [];
  const p = createPresence({ discord: async (...args) => pulses.push(args), setIntervalImpl: (fn) => { intervals.push(fn); return intervals.length; }, clearIntervalImpl: (id) => cleared.push(id) });
  const a = p.begin("123"), b = p.begin("123");
  assert.equal(pulses.length, 1); assert.equal(intervals.length, 1);
  a(); a(); assert.equal(cleared.length, 0);
  await Promise.resolve(); await intervals[0](); assert.equal(pulses.length, 2);
  b(); assert.deepEqual(cleared, [1]);
  await intervals[0](); assert.equal(pulses.length, 2);
  assert.deepEqual(pulses[0], ["POST", "/channels/123/typing"]);
});
test("slow or failed typing does not overlap requests or fail a task", async () => {
  let release, calls = 0, pulse;
  const blocked = new Promise((_, reject) => { release = () => reject(new Error("fetch failed")); });
  const p = createPresence({ discord: async () => { calls++; await blocked; }, setIntervalImpl: (fn) => { pulse = fn; return 1; }, clearIntervalImpl: () => {} });
  const stop = p.begin("123"); await pulse(); assert.equal(calls, 1);
  release(); await Promise.resolve(); await Promise.resolve();
  stop(); await pulse(); assert.equal(calls, 1);
  p.begin(null)();
});
test("an owner pause stops further typing pulses even before an activation unwinds", async () => {
 let allowed=true,pulse,calls=0;
 const p=createPresence({discord:async()=>{calls++},allowed:()=>allowed,setIntervalImpl:fn=>(pulse=fn,1),clearIntervalImpl:()=>{}});
 const stop=p.begin("123");await Promise.resolve();assert.equal(calls,1);
 allowed=false;await pulse();assert.equal(calls,1);stop();
});
