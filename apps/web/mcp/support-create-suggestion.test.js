"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { z } = require("zod");
const { registerCreateSuggestion, verifiedReceipt } = require("./support-create-suggestion");
const user = "111111111111111111", channel = "222222222222222222", message = "333333333333333333";
function fixture({ write = true, fail = false, badAuthor = false, badReceipt = false, ticketReporter = user, recovered = false, ambiguous = false } = {}) {
  let handler, schema; const docs = new Map(), calls = [];
  const Intake = { insertOne: async d => { if (docs.has(d._id)) throw Object.assign(new Error("duplicate"), { code: 11000 }); docs.set(d._id, d); }, findOne: async q => docs.get(q._id), updateOne: async (q, patch) => Object.assign(docs.get(q._id), patch.$set) };
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    if (url.endsWith(`/messages/${message}`)) return Response.json({ id: message, content: "Please show remaining construction turns", author: { id: badAuthor ? "999999999999999999" : user, username: "source-user" } });
    if (url.endsWith(`/channels/${channel}`)) return Response.json({ id: channel, guild_id: "guild" });
    if (fail) throw new Error("lost response");
    return Response.json({ issueNumber: 8, detailUrl: badReceipt ? "https://wrong.test/feedback/8" : "https://game.test/feedback/8", githubIssueUrl: null });
  };
  registerCreateSuggestion({ tool: (_name, _description, shape, fn) => { schema = z.object(shape).strict(); handler = fn; } }, { auth: { scopes: { write } }, Intake, Suggestions: { find: q => ({ limit: () => ({ toArray: async () => {
      assert.equal(q.discordSubmitUserId,user);assert.equal(q.title,"Construction progress");
      const doc={issueNumber:8,context:{url:"https://www.game.test/feedback/8"}};
      return recovered ? (ambiguous ? [doc,doc] : [doc]) : [];
    } }) }) }, Tickets: { findOne: async q => q.ticketNumber === 42 ? { ticketNumber:42, discordUserId:ticketReporter, discordUsername:"source-user", description:"Please show remaining construction turns", messages:["Unattributed follow-up"] } : null }, z, fetchImpl,
    env: { AHD_GAME_API_URL: "https://game.test", AHD_GUILD_ID: "guild", DISCORD_BOT_TOKEN: "test-bot-token", DISCORD_BOT_API_KEY: "test-game-token", KEIR_OWNER_ID: user }, jsonResult: value => ({ value }), errorResult: error => ({ error }) });
  const args = { title: "Construction progress", description: "Show remaining construction turns", category: "ui_improvement", gameSystem: "corporations", discord_user_id: user, source_channel_id: channel, source_message_id: message };
  return { run: (extra = {}) => handler(schema.parse({ ...args, ...extra })), calls, docs, args };
}
test("native suggestion API receives the original author with the private bot header, and retries reuse the receipt", async () => {
  const f = fixture(); const a = await f.run(), b = await f.run();
  assert.equal(a.value.number, 8); assert.equal(a.value.reporterId, user); assert.equal(b.value.duplicate, true);
  const writes = f.calls.filter(c => c.method === "POST"); assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].body).discordUserId, user); assert.equal(writes[0].headers["X-Bot-Token"], "test-game-token");
  assert.equal(a.value.githubIssueUrl, null);
});
test("read-only scope, forged author and changed retry payload cannot create suggestions", async () => {
  const ro = fixture({ write: false }); assert.match((await ro.run()).error, /write scope/); assert.equal(ro.calls.length, 0);
  const forged = fixture({ badAuthor: true }); assert.match((await forged.run()).error, /source author/); assert.equal(forged.docs.size, 0);
  const f = fixture(); await f.run(); assert.match((await f.run({ title: "A different proposal" })).error, /different submission/);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});
test("an ambiguous API outcome or invalid receipt blocks automatic resubmission", async () => {
  for (const options of [{ fail: true }, { badReceipt: true }]) {
    const f = fixture(options); assert.ok((await f.run()).error); assert.match((await f.run()).error, /outcome needs inspection/);
    assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  }
});
test("app origins require the configured owner and cannot include a Discord source", async () => {
  const f = fixture(); assert.match((await f.run({ app_request_id: "app-message" })).error, /configured owner/);
  const result = await f.run({ app_request_id: "app-message", source_channel_id: undefined, source_message_id: undefined });
  assert.equal(result.value.reporterId, user); assert.equal(f.calls.filter(c => c.url.includes("discord.com")).length, 0);
});

test("a persisted opening report survives deleted channels and retains its reporter and retry receipt", async () => {
  const f=fixture(), args={source_channel_id:undefined,source_message_id:undefined,source_ticket_number:42,source_ticket_message:"Please show remaining construction turns",discord_user_id:undefined};
  const a=await f.run(args), b=await f.run(args);
  assert.equal(a.value.reporterId,user);assert.equal(b.value.duplicate,true);
  assert.equal(f.calls.filter(c=>c.url.includes("discord.com")).length,0);
  assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
});
test("archival filing refuses invented text, authorless follow-ups, forged reporters and mixed origins", async () => {
  const args={source_channel_id:undefined,source_message_id:undefined,source_ticket_number:42,source_ticket_message:"Please show remaining construction turns"};
  for(const text of ["Invented proposal","Unattributed follow-up"]){const f=fixture();assert.match((await f.run({...args,source_ticket_message:text})).error,/persisted conversation/);assert.equal(f.calls.length,0);}
  const f=fixture({ticketReporter:"999999999999999999"});assert.match((await f.run(args)).error,/reporter/);assert.equal(f.calls.length,0);
  const mixed=fixture();assert.match((await mixed.run({...args,source_message_id:message})).error,/mixed/);assert.equal(mixed.calls.length,0);
});

test("canonical www receipts are accepted while foreign origins and altered paths are refused", () => {
 assert.equal(verifiedReceipt({issueNumber:8,detailUrl:"https://www.game.test/feedback/8"},"https://game.test").url,"https://www.game.test/feedback/8");
 for(const url of ["https://evil.test/feedback/8","http://game.test/feedback/8","https://game.test/feedback/9","https://game.test/feedback/8?next=evil","https://user@game.test/feedback/8","https://game.test:444/feedback/8"])
  assert.equal(verifiedReceipt({issueNumber:8,detailUrl:url},"https://game.test"),null,url);
});
test("lost API responses reconcile one canonical suggestion without a second POST", async () => {
 const f=fixture({fail:true,recovered:true});assert.ok((await f.run()).error);
 const a=await f.run();assert.equal(a.value.recovered,true);assert.equal(a.value.number,8);assert.equal(a.value.reporterId,user);
 assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
 const b=await f.run();assert.equal(b.value.duplicate,true);assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
 const ambiguous=fixture({fail:true,recovered:true,ambiguous:true});await ambiguous.run();assert.match((await ambiguous.run()).error,/needs inspection/);
 assert.equal(ambiguous.calls.filter(c=>c.method==="POST").length,1);
});

test("Ask origins file under the linked Discord id or the game user id, once per action, and are not reachable from the tool", async () => {
 const { createSuggestion } = require("./support-create-suggestion");
 const docs = new Map(), calls = [];
 const Intake = { insertOne: async d => { if (docs.has(d._id)) throw Object.assign(new Error("duplicate"), { code: 11000 }); docs.set(d._id, d); }, findOne: async q => docs.get(q._id), updateOne: async (q, patch) => Object.assign(docs.get(q._id), patch.$set) };
 const fetchImpl = async (url, init) => { calls.push({ url, ...init }); return Response.json({ issueNumber: 9, detailUrl: "https://game.test/feedback/9" }); };
 const deps = { Intake, fetchImpl, env: { AHD_GAME_API_URL: "https://game.test", DISCORD_BOT_API_KEY: "k" } };
 const base = { title: "Union map", description: "Show union strength by state", category: "ui_improvement", gameSystem: "parties", ask_action_id: "abcdefghijklmnop", source_text: "file that as a suggestion" };
 const linked = await createSuggestion({ ...base, discord_user_id: user }, deps);
 assert.equal(linked.number, 9); assert.equal(linked.source, "ask:abcdefghijklmnop"); assert.equal(JSON.parse(calls[0].body).discordUserId, user);
 assert.equal((await createSuggestion({ ...base, discord_user_id: user }, deps)).duplicate, true); assert.equal(calls.length, 1);
 const unlinked = await createSuggestion({ ...base, ask_action_id: "qrstuvwxyz012345", ahd_user_id: "a".repeat(24) }, deps);
 assert.equal(unlinked.reporterId, `user:${"a".repeat(24)}`); const body = JSON.parse(calls[1].body); assert.equal(body.userId, "a".repeat(24)); assert.equal(body.discordUserId, undefined);
 assert.equal([...docs.values()][1].sourceText, "file that as a suggestion");
 await assert.rejects(createSuggestion({ ...base, ask_action_id: "short" , discord_user_id: user }, deps), /Invalid Ask action id/);
 await assert.rejects(createSuggestion({ ...base, discord_user_id: user, source_message_id: message }, deps), /mixed/);
 await assert.rejects(createSuggestion({ ...base, discord_user_id: user, ahd_user_id: "a".repeat(24) }, deps), /one submitter/);
 // The tool schema has no Ask fields, so a tool caller cannot claim an Ask origin.
 const f = fixture(); assert.throws(() => f.run({ ask_action_id: "abcdefghijklmnop", source_channel_id: undefined, source_message_id: undefined }), /ask_action_id/); assert.equal(f.docs.size, 0);
});
