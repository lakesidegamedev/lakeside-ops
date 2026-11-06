"use strict";
// Keir 8.4.2 part 2 (mod chat, 2026-11-06). Transcript: Monroe (a moderator, not on the static
// staff list) said "the longest sleepover yet"; Egg asked "@Keir do you think they are alts?";
// Keir answered "I can't say yet ... send me the names", then woke again on Monroe's unaddressed
// message, was forced to reply "even if nothing changed" and called her "that player", "their
// word, not evidence". The question was classified simple, ran in the quick lane and no lookup ran.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const clarify = require("../lib/operator/clarify");
const { createModRoster } = require("../lib/operator/modroster");
const { createConversation } = require("../lib/operator/conversation");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");

const MOD = "555555555555555551", OWNER = "111111111111111111", MONROE = "222222222222222223", PLAYER = "222222222222222224", BOT = "333333333333333333", GUILD = "444444444444444444";
const ROLE_MOD = "700000000000000001", ROLE_ADMIN = "700000000000000002", ROLE_FAN = "700000000000000003";
const ROLES = [
  { id: GUILD, name: "@everyone", permissions: "0" },
  { id: ROLE_MOD, name: "Moderator", permissions: String(1n << 40n) },
  { id: ROLE_ADMIN, name: "Keepers", permissions: String(1n << 3n) },
  { id: ROLE_FAN, name: "Fan club", permissions: "0" },
];
const MEMBERS = { [MONROE]: { roles: [ROLE_MOD] }, [PLAYER]: { roles: [ROLE_FAN] } };
const config = { ownerId: OWNER, staffIds: ["999999999999999999"], botId: BOT, guildId: GUILD, scanChannels: [], taskLifetimeMs: 86400000, supportDeferred: () => false };
const discordFor = (calls = []) => async (method, url) => {
  calls.push(url);
  if (url === `/guilds/${GUILD}/roles`) return ROLES;
  const id = /members\/(\d+)$/.exec(url)?.[1];
  if (id) return MEMBERS[id] || { roles: [] };
  return [];
};
const msg = (id, authorId, content, extra = {}) => ({ id, author: { id: authorId, username: authorId === MONROE ? "DeathSequnce" : authorId === OWNER ? "egg3901" : "someone" }, content, timestamp: new Date(Date.parse("2026-11-06T04:58:00Z") + Number(BigInt(id) % 1000n) * 1000).toISOString(), attachments: [], ...extra });
const tick = () => new Promise((r) => setImmediate(r));

test("a moderator who is not in the static staff list is recorded as moderator, not player", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir842b-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const mods = createModRoster({ config, discord: discordFor() });
  const conversation = createConversation({ ledger, config, mods });
  assert.ok(!config.staffIds.includes(MONROE));
  conversation.record({ id: MOD }, msg("900000000000000002", MONROE, "the longest sleepover yet"));
  conversation.record({ id: MOD }, msg("900000000000000005", PLAYER, "hi all"));
  await tick(); await tick(); await tick();
  const rows = ledger.data.channelContext[MOD];
  assert.equal(rows.find((r) => r.authorId === MONROE).role, "moderator");
  assert.equal(rows.find((r) => r.authorId === PLAYER).role, "player", "a member with no moderation role stays a player");
  // a later message is labelled at once from the cache, with no further lookup
  conversation.record({ id: MOD }, msg("900000000000000008", MONROE, "well, it is different people"));
  assert.equal(ledger.data.channelContext[MOD].at(-1).role, "moderator");
  assert.match(conversation.snapshot({ source: { channelId: MOD } }).roles, /moderator rows are staff, never players/);
});

test("roles on the gateway message are used without a lookup, and an administrator role counts", async () => {
  const calls = [];
  const mods = createModRoster({ config, discord: discordFor(calls) });
  await mods.modRoles();
  mods.observe({ author: { id: "888" }, member: { roles: [ROLE_ADMIN] } });
  assert.equal(mods.isModerator("888"), true);
  mods.observe({ author: { id: "889" }, member: { roles: [ROLE_FAN] } });
  assert.equal(mods.isModerator("889"), false);
  assert.equal(calls.filter((u) => /members/.test(u)).length, 0);
});

test("member roles are cached with a TTL and looked up again after it", async () => {
  const calls = []; let t = 1000;
  const mods = createModRoster({ config, discord: discordFor(calls), now: () => t, memberTtlMs: 60000, rolesTtlMs: 60000 });
  assert.equal(await mods.ensure(MONROE), true);
  assert.equal(await mods.ensure(MONROE), true);
  assert.equal(calls.filter((u) => /members/.test(u)).length, 1);
  t += 61000;
  assert.equal(mods.isModerator(MONROE), false, "an expired entry is not trusted");
  assert.equal(await mods.ensure(MONROE), true);
  assert.equal(calls.filter((u) => /members/.test(u)).length, 2);
});

test("a moderator role grants a label only, never developer powers", async () => {
  const mods = createModRoster({ config, discord: discordFor() });
  await mods.ensure(MONROE);
  assert.equal(mods.isModerator(MONROE), true);
  assert.ok(!config.staffIds.includes(MONROE));
});

// ---- finish guard ----
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir842b-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const conversation = createConversation({ ledger, config });
  const mcp = { servers: () => ["support", "gamestate"], list: async () => [], call: async () => ({ ok: true }) };
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], conversation, sandbox: { run: async () => ({ code: 0, output: "" }) } });
  const ask = msg("900000000000000003", OWNER, `<@${BOT}> do you think they are alts?`);
  const job = ledger.createJob("c", { kind: "conversation", role: "owner", actorId: OWNER, channelId: MOD, replyChannel: MOD,
    source: { messageId: ask.id, channelId: MOD, channelName: "mod-chat", authorId: OWNER, author: "egg3901", content: ask.content, at: ask.timestamp, attachments: [] }, deadline: 9e15 });
  job.state = "running";
  return { ledger, broker, job, conversation, ask };
}

test("transcript: once Keir answered the addressed message, the woken job finishes silently", async () => {
  const f = fixture();
  await f.broker.tool(f.job, "channel_reply", { message: "Midnight and ashtravino share an IP, a fingerprint and a device key. Likely the same person, medium-high confidence." });
  f.job.lastPublishedAt = undefined;
  // the second wake (Monroe's unaddressed message): the owed-reply guard must not fire again
  f.job.channelReplyQueued = false;
  f.job.channelRepliedAt = undefined;
  f.ledger.data.channelContext[MOD] = [...(f.ledger.data.channelContext[MOD] || []),
    { id: "900000000000000004", authorId: BOT, role: "assistant", content: "answered", at: new Date(Date.parse(f.ask.timestamp) + 8000).toISOString(), observedAt: Date.parse(f.ask.timestamp) + 8000 }];
  const r = await f.broker.tool(f.job, "finish", { state: "waiting", summary: "Nothing new." });
  assert.equal(r.state, "waiting");
});

test("a reply sent in this very task also satisfies the owed-reply guard", async () => {
  const f = fixture();
  await f.broker.tool(f.job, "channel_reply", { message: "Likely the same person. Medium confidence, from the shared device key." });
  const r = await f.broker.tool(f.job, "finish", { state: "waiting", summary: "Replied." });
  assert.equal(r.state, "waiting");
});

test("an addressed message that was never answered still forces one reply, without 'even if nothing changed'", async () => {
  const f = fixture();
  await assert.rejects(() => f.broker.tool(f.job, "finish", { state: "waiting", summary: "Nothing." }), (e) => /addressed you directly/.test(e.message) && !/even if nothing changed/.test(e.message));
});

test("a staff message that does not address Keir never sets staffReplyOwed", async () => {
  const f = fixture();
  f.job.source = { ...f.job.source, authorId: MONROE, content: "well, it is different people", at: new Date(Date.parse(f.ask.timestamp) + 60000).toISOString() };
  f.job.requestInbox = [{ authorId: OWNER, content: "lmao okay", at: new Date(Date.parse(f.ask.timestamp) + 70000).toISOString() }];
  const cfg = config.staffIds; cfg.push(MONROE);
  try {
    const r = await f.broker.tool(f.job, "finish", { state: "waiting", summary: "Nothing new." });
    assert.equal(r.state, "waiting");
    assert.equal(f.job.staffReplyOwed, undefined);
  } finally { cfg.pop(); }
});

test("a message Discord marks as addressed to Keir (mention or reply) is owed an answer", async () => {
  const f = fixture();
  f.job.source = { ...f.job.source, content: "are those two the same person", mentioned: true };
  await assert.rejects(() => f.broker.tool(f.job, "finish", { state: "waiting", summary: "Nothing." }), /addressed you directly/);
});

// ---- lookup before "I can't tell" ----
const CANT = "I can't tell from this chat alone. I don't have enough to say whether they are alts.";
test("lookupRequiredRefusal: people or case question, no lookup, 'I can't tell' is refused", () => {
  assert.match(clarify.lookupRequiredRefusal({ question: "do you think they are alts?", message: CANT }), /looked nothing up/);
  assert.equal(clarify.lookupRequiredRefusal({ question: "do you think they are alts?", message: CANT, lookups: 1 }), null);
  assert.equal(clarify.lookupRequiredRefusal({ question: "what time is the turn?", message: CANT }), null, "not about people or cases");
  assert.equal(clarify.lookupRequiredRefusal({ question: "are they alts?", message: "Yes, same device key and IP." }), null, "an answer is not refused");
  assert.equal(clarify.lookupRequiredRefusal({ question: "are they alts?", message: CANT, refusals: 2 }), null, "released after two refusals");
});

test("broker: the owner's alt question cannot be answered 'I can't tell' before any lookup, and a lookup unlocks it", async () => {
  const f = fixture();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: CANT }), /looked nothing up/);
  await f.broker.tool(f.job, "read_tool", { server: "support", tool: "support_search", args: { query: "sleepover" } }, new AbortController().signal);
  assert.equal(f.job.lookupReads, 1);
  const res = await f.broker.tool(f.job, "channel_reply", { message: "Searched support for the sleepover cases: nothing links these two accounts, so I can't tell from records. Low confidence either way." });
  assert.equal(res.queued, true);
});
