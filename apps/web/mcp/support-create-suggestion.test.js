"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { z } = require("zod");
const { registerCreateSuggestion } = require("./support-create-suggestion");
const user = "111111111111111111", channel = "222222222222222222", message = "333333333333333333";
function fixture({ write = true, fail = false, badAuthor = false, badReceipt = false } = {}) {
  let handler, schema; const docs = new Map(), calls = [];
  const Intake = { insertOne: async d => { if (docs.has(d._id)) throw Object.assign(new Error("duplicate"), { code: 11000 }); docs.set(d._id, d); }, findOne: async q => docs.get(q._id), updateOne: async (q, patch) => Object.assign(docs.get(q._id), patch.$set) };
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    if (url.endsWith(`/messages/${message}`)) return Response.json({ id: message, content: "Please show remaining construction turns", author: { id: badAuthor ? "999999999999999999" : user, username: "source-user" } });
    if (url.endsWith(`/channels/${channel}`)) return Response.json({ id: channel, guild_id: "guild" });
    if (fail) throw new Error("lost response");
    return Response.json({ issueNumber: 8, detailUrl: badReceipt ? "https://wrong.test/feedback/8" : "https://game.test/feedback/8", githubIssueUrl: null });
  };
  registerCreateSuggestion({ tool: (_name, _description, shape, fn) => { schema = z.object(shape).strict(); handler = fn; } }, { auth: { scopes: { write } }, Intake, z, fetchImpl,
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
