"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { createAppChannel } = require("../lib/operator/appchannel");
const { openSuggestion } = require("../lib/operator/suggestionintake");
const owner = "111111111111111111", developer = "222222222222222222", player = "333333333333333333", channel = "444444444444444444", report = "555555555555555555", request = "666666666666666666";
const input = { title: "Show mine construction progress", description: "Show remaining construction turns on the mine page.", category: "ui_improvement", gameSystem: "corporations" };
function fixture(t, text = "Please file a suggestion to show mine construction progress") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-suggestion-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: owner, staffIds: [developer], guildId: "guild", stateDir: dir, repositories: {}, taskLifetimeMs: 86400000, supportDeferred: () => false };
  const app = createAppChannel({ ledger, config });
  const job = ledger.data.jobs[app.authenticatedPost(text, undefined, "main", { mode: "new" }).jobId]; job.state = "running";
  const calls = [];
  const mcp = { servers: () => ["support"], list: async () => [], call: async (server, tool, args, write) => {
    calls.push({ server, tool, args, write }); return { filed: true, number: 42, url: "https://game.test/feedback/42", reporterId: args.discord_user_id };
  } };
  const messages = { [request]: { id: request, author: { id: developer }, content: text }, [report]: { id: report, author: { id: player }, content: "Could we show the remaining construction turns?" } };
  const discord = async (_method, url) => url.includes("/guilds/") ? [{ id: channel, name: "ticket-42" }]
    : url.includes("/messages?") ? [messages[report]]
    : url.includes("/messages/") ? messages[url.split("/").at(-1)] : { id: channel, guild_id: "guild" };
  const broker = createBroker({ ledger, config, appChannel: app, mcp, discord, sandbox: {} });
  return { ledger, config, app, job, calls, mcp, discord, messages, broker };
}
test("authenticated app filing uses the owner identity and returns one native receipt on retries", async t => {
  const f = fixture(t);
  const a = await f.broker.tool(f.job, "open_suggestion", input), b = await f.broker.tool(f.job, "open_suggestion", input);
  assert.equal(a.number, 42); assert.equal(b.number, 42); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].tool, "support_create_suggestion"); assert.equal(f.calls[0].write, true);
  assert.equal(f.calls[0].args.discord_user_id, owner); assert.ok(f.calls[0].args.app_request_id);
  assert.equal(f.job.filedSuggestions[Object.keys(f.job.filedSuggestions)[0]].number, 42);
});
test("an app inspection, forged reporter or edited source cannot mint a suggestion", async t => {
  const inspect = fixture(t, "Inspect suggestion status");
  await assert.rejects(inspect.broker.tool(inspect.job, "open_suggestion", input), /explicitly/);
  const f = fixture(t);
  await assert.rejects(f.broker.tool(f.job, "open_suggestion", { ...input, reportMessageId: report }), /authenticated owner/);
  f.ledger.data.appThread.messages.find(m => m.jobId === f.job.id).text += " changed";
  await assert.rejects(f.broker.tool(f.job, "open_suggestion", input), /unchanged/);
  assert.equal(inspect.calls.length + f.calls.length, 0);
});
test("developer filing preserves the original player's author rather than the developer", async t => {
  const f = fixture(t);
  const job = f.ledger.createJob("developer", { kind: "command", role: "support", actorId: developer, source: { channelId: channel, messageId: request }, replyChannel: channel, deadline: Date.now() + 60000 }); job.state = "running";
  const result = await f.broker.tool(job, "open_suggestion", { ...input, channelId: channel, reportMessageId: report });
  assert.equal(result.reporterId, player); assert.equal(f.calls[0].args.source_message_id, report);
  assert.equal(f.calls[0].args.discord_user_id, player);
});
test("revoked requests and bot or foreign-guild sources are refused before writing", async t => {
  const f = fixture(t);
  const job = f.ledger.createJob("developer", { kind: "command", role: "support", actorId: developer, source: { channelId: channel, messageId: request }, replyChannel: channel, deadline: Date.now() + 60000 }); job.state = "running";
  f.messages[request].content = "Do not file a suggestion";
  await assert.rejects(f.broker.tool(job, "open_suggestion", { ...input, reportMessageId: report }), /provenance/);
  f.messages[request].content = "File a suggestion"; f.messages[report].author.bot = true;
  await assert.rejects(f.broker.tool(job, "open_suggestion", { ...input, reportMessageId: report }), /human/);
  f.messages[report].author.bot = false;
  await assert.rejects(openSuggestion({ ...f, job, input: { ...input, reportMessageId: report }, discord: async () => ({ guild_id: "other" }) }), /provenance|outside/);
  assert.equal(f.calls.length, 0);
});
test("ticket suggestions use only a verified message in the assigned ticket", async t => {
  const f = fixture(t), job = { id: "ticket", kind: "ticket", role: "support", channelId: channel, source: {}, effects: {} };
  const args = { ...f, job, input: { ...input, reportMessageId: report }, supportAuthority: async () => [f.messages[report]], effect: async (_j, _key, fn) => fn() };
  assert.equal((await openSuggestion(args)).reporterId, player);
  await assert.rejects(openSuggestion({ ...args, input: { ...args.input, channelId: "777777777777777777" } }), /verified history/);
  await assert.rejects(openSuggestion({ ...args, supportAuthority: async () => [] }), /verified history/);
});
test("uncertain writes are not replayed and incomplete receipts are never called filed", async t => {
  const f = fixture(t); let attempts = 0;
  f.mcp.call = async () => { attempts++; throw new Error("Connection lost after submission"); };
  await assert.rejects(f.broker.tool(f.job, "open_suggestion", input), /Connection lost/);
  f.job.state = "running";
  await assert.rejects(f.broker.tool(f.job, "open_suggestion", input), /uncertain/);
  assert.equal(attempts, 1);
  const g = fixture(t); g.mcp.call = async () => ({ filed: true, number: 42, reporterId: player });
  await assert.rejects(g.broker.tool(g.job, "open_suggestion", input), /verified native receipt/);
});

test("ticket filing through the broker accepts an abort signal without losing lifecycle checks", async t => {
  const f = fixture(t);
  const job = f.ledger.createJob("support-ticket", { kind: "ticket", role: "support", ticket: 42,
    channelId: channel, source: {}, deadline: Date.now() + 60000 });
  job.state = "running";
  const signal = new AbortController().signal;
  const result = await f.broker.tool(job, "open_suggestion", { ...input, reportMessageId: report }, signal);
  assert.equal(result.reporterId, player);
  assert.equal(f.calls[0].args.source_channel_id, channel);
  assert.equal(f.calls[0].args.source_message_id, report);
  job.state = "waiting";
  await assert.rejects(f.broker.tool(job, "open_suggestion", { ...input, reportMessageId: report }, signal), /inactive/);
  assert.equal(f.calls.length, 1);
});

test("reopened ticket filing uses the preserved author and authenticated opening report without fetching a deleted channel", async t => {
 const f=fixture(t), oldChannel="777777777777777777", text="Please show remaining construction turns";
 const job={id:"reopened",kind:"ticket",role:"support",ticket:42,channelId:channel,source:{},effects:{}};
 f.ledger.data.jobs.old={id:"old",kind:"ticket",ticket:42,source:{channelId:oldChannel,authorId:player,content:"A follow-up"}};
 f.mcp.call=async(server,tool,args)=>{f.calls.push({server,tool,args});return tool==="support_get"?{number:42,description:text,conversation:{channelId:channel,previousChannelId:oldChannel}}:{filed:true,number:8,url:"https://game.test/feedback/8",reporterId:args.discord_user_id};};
 const args={...f,job,input:{...input,archivedMessage:text},supportAuthority:async(_j,states)=>assert.equal(states,undefined),effect:async(_j,_key,fn)=>fn(),discord:async()=>{throw Error("Deleted channel must not be fetched")}};
 assert.equal((await openSuggestion(args)).reporterId,player);
 assert.equal(f.calls.at(-1).args.source_ticket_number,42);assert.equal(f.calls.at(-1).args.source_ticket_message,text);
 await assert.rejects(openSuggestion({...args,input:{...args.input,archivedMessage:"Invented text"}}),/preserved authenticated author/);
 delete f.ledger.data.jobs.old;
 await assert.rejects(openSuggestion(args),/preserved authenticated author/);
});

test("a filed outcome is not classified as an internal support failure", () => {
 const {internalFailure}=require("../lib/operator/supportblockers");
 assert.equal(internalFailure("Your original post is now filed as a suggestion. Here is its feedback link."),false);
 assert.equal(internalFailure("I filed your wage and hiring proposal."),false);
 assert.equal(internalFailure("The original post was deleted by its author."),false);
});
