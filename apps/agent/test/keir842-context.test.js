"use strict";
// Keir 8.4.2: read images and case context before asking (owner, 2026-11-06, mod chat).
// Transcript: Danica posted two screenshots naming the accounts "midnight" and "ashtravino",
// Monroe said "the longest sleepover yet", Egg asked "@Keir do you think they are alts?" and
// Keir answered "send me the two names". The screenshot text below is mocked: the image bytes
// stand in for it, and the model's reading of them is what names the accounts.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const clarify = require("../lib/operator/clarify");
const casecontext = require("../lib/operator/casecontext");
const chatcontext = require("../lib/operator/chatcontext");
const { createConversation } = require("../lib/operator/conversation");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");

const MOD = "555555555555555551", OWNER = "111111111111111111", DANICA = "222222222222222222", MONROE = "222222222222222223";
const M = { shots: "900000000000000001", sleep: "900000000000000002", ask: "900000000000000003", old: "900000000000000000" };
const SCREENSHOT_TEXT = "midnight and ashtravino: login pair; blocked registration matches midnight's IP, fingerprint, device key, tracking cookie";
const KEIR_842 = "I can't say yet, because I don't know which two accounts you mean. The recent messages only mention a 40+ hour 'sleepover' and don't name anyone. Send me the two names and I'll compare them. I can't judge alts from this chat alone.";
const SIG = new AbortController().signal;
const PNG = Buffer.from("iVBORw0KGgo=", "base64");

const config = { ownerId: OWNER, staffIds: [DANICA, MONROE], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, supportDeferred: () => false };
const msg = (id, authorId, content, extra = {}) => ({ id, author: { id: authorId, username: authorId === DANICA ? "Danica" : authorId === OWNER ? "Egg" : "Monroe" }, content, timestamp: new Date(Date.parse("2026-11-06T04:58:00Z") + Number(BigInt(id) % 1000n) * 1000).toISOString(), attachments: [], ...extra });
const png = (name) => ({ filename: name, content_type: "image/png", size: PNG.length, url: `https://cdn.discordapp.com/attachments/1/2/${name}` });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir842-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const conversation = createConversation({ ledger, config, now: () => Date.parse("2026-11-06T05:00:00Z") });
  const ch = { id: MOD };
  conversation.record(ch, msg(M.old, MONROE, "unrelated chat from earlier"));
  conversation.record(ch, msg(M.shots, DANICA, "The plot thickens", { attachments: [png("login-pairs.png"), png("blocked-registration.png")] }));
  conversation.record(ch, msg(M.sleep, MONROE, "the longest sleepover yet", { message_reference: { message_id: M.shots } }));
  const ask = msg(M.ask, OWNER, "@Keir do you think they are alts?", { message_reference: { message_id: M.sleep } });
  conversation.record(ch, ask);
  const calls = [];
  const mcp = { servers: () => ["support", "gamestate"], list: async () => [], call: async (...a) => { calls.push(a); return { ok: true }; } };
  const discordCalls = [];
  const discord = async (method, url) => {
    discordCalls.push(url);
    const id = /messages\/(\d+)$/.exec(url)?.[1];
    if (id === M.shots) return { id, attachments: [png("login-pairs.png"), png("blocked-registration.png")] };
    return [];
  };
  const broker = createBroker({ ledger, config, mcp, discord, conversation, sandbox: { run: async () => ({ code: 0, output: "" }) } });
  const job = ledger.createJob("c", { kind: "conversation", role: "owner", actorId: OWNER, channelId: MOD, replyChannel: MOD,
    source: { messageId: M.ask, channelId: MOD, channelName: "mod-chat", authorId: OWNER, author: "Egg", content: ask.content, replyTo: M.sleep, attachments: [] }, deadline: 9e15 });
  job.state = "running";
  return { ledger, conversation, broker, job, calls, discordCalls };
}

test("images in the last messages and the reply chain are listed with where to open them", () => {
  const f = setup();
  const images = f.conversation.recentImages(f.job);
  assert.deepEqual(images.map((i) => [i.messageId, i.index, i.name]), [[M.shots, 0, "login-pairs.png"], [M.shots, 1, "blocked-registration.png"]]);
  assert.equal(images[0].author, "Danica");
});

test("an image far outside the last ten messages is still found through the reply chain", () => {
  const f = setup();
  for (let i = 0; i < 12; i++) f.conversation.record({ id: MOD }, msg(`9100000000000001${String(i).padStart(2, "0")}`, MONROE, `filler ${i}`));
  const newest = msg("920000000000000001", OWNER, "do you think they are alts?", { message_reference: { message_id: M.sleep } });
  f.conversation.record({ id: MOD }, newest);
  const job = { ...f.job, source: { ...f.job.source, messageId: newest.id, replyTo: M.sleep } };
  assert.equal(f.conversation.recentImages(job).length, 2, "reply chain M.ask -> sleep -> shots reaches the screenshots");
  const unrelated = { ...f.job, source: { ...f.job.source, messageId: "920000000000000002", replyTo: undefined } };
  assert.equal(f.conversation.recentImages(unrelated).length, 0, "without the chain they fall outside the last ten");
});

test("an image attached to the message being answered is listed even before it is recorded", () => {
  const f = setup();
  const job = { ...f.job, source: { ...f.job.source, messageId: "930000000000000001", attachments: [{ url: "u", type: "image/png", name: "mine.png" }] } };
  assert.ok(f.conversation.recentImages(job).some((i) => i.name === "mine.png"));
});

test("view_attachment opens a listed earlier image by message id and records it as read", async () => {
  const f = setup();
  const realFetch = global.fetch;
  global.fetch = async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  try {
    const out = await f.broker.tool(f.job, "view_attachment", { index: 1, messageId: M.shots }, SIG);
    assert.equal(out.image.media_type, "image/png");
    assert.equal(Buffer.from(out.image.data, "base64").equals(PNG), true);
    assert.deepEqual(f.job.viewedImages, [M.shots]);
    await assert.rejects(f.broker.tool(f.job, "view_attachment", { index: 0, messageId: M.old }), /not one of context\.recentImages/);
  } finally { global.fetch = realFetch; }
});

test("transcript: Keir's 'send me the two names' is refused while the screenshots are unopened", async () => {
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: KEIR_842 }), /2 screenshots in this channel were never opened/);
  assert.equal(f.ledger.data.outbox ? Object.keys(f.ledger.data.outbox).length : 0, 0);
});

test("after reading the screenshots, an answer with a view and the accounts goes out", async () => {
  const f = setup();
  const realFetch = global.fetch;
  global.fetch = async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  try { await f.broker.tool(f.job, "view_attachment", { index: 0, messageId: M.shots }, SIG); } finally { global.fetch = realFetch; }
  const answer = `Yes, I think midnight and ashtravino are the same person. Medium-high confidence. The screenshots (${SCREENSHOT_TEXT.slice(0, 40)}) show the blocked registration matching midnight's IP, fingerprint and device key.`;
  const res = await f.broker.tool(f.job, "channel_reply", { message: answer });
  assert.equal(res.queued, true);
});

test("a task is not blocked forever: the third attempt goes out", async () => {
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: KEIR_842 }));
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Send me the two account names and I'll look." }));
  const res = await f.broker.tool(f.job, "channel_reply", { message: "Send me the two account names and I'll look." });
  assert.equal(res.queued, true);
});

test("players are not covered by the staff guard and ticket logic is untouched", () => {
  assert.equal(clarify.unreadContextRefusal({ message: KEIR_842, images: [], viewed: [], cases: [] }), null, "nothing unread, nothing refused");
  assert.equal(clarify.asksForIdentifiers("Yes, they look like alts. High confidence, the IPs match."), false);
  assert.equal(clarify.asksForIdentifiers(KEIR_842), true);
  assert.equal(clarify.asksForIdentifiers("Which two accounts do you mean?"), true);
  assert.equal(clarify.asksForIdentifiers("Midnight and ashtravino share a registration fingerprint, so I'd call it likely. Do you want the full trace?"), false);
});

test("an unopened support case also blocks the identifier question", () => {
  const msg = clarify.unreadContextRefusal({ message: KEIR_842, images: [], viewed: [], cases: [1778, 1779, 1780] });
  assert.match(msg, /#1778, #1779, #1780/);
  assert.match(msg, /alt_ring_audit/);
});

test("case lookup: 'sleepover' and alt talk finds the moderation tickets", async () => {
  const calls = [];
  const call = async (server, tool, args) => {
    calls.push([tool, args]);
    if (tool === "support_search" && args.query === "sleepover") return { results: [1778, 1779, 1780].map((number) => ({ kind: "ticket", number, title: "Appeal", status: "closed" })) };
    if (tool === "support_list") return { items: [{ kind: "ticket", number: 1780, title: "Help", status: "closed", category: "moderation" }] };
    return { results: [] };
  };
  const found = await casecontext.lookup({ texts: ["The plot thickens", "the longest sleepover yet", "@Keir do you think they are alts?"], call });
  assert.deepEqual(found.cases.map((c) => c.number).sort(), [1778, 1779, 1780]);
  assert.ok(calls.some(([t]) => t === "support_list"), "alt talk adds the recent moderation list");
  assert.match(found.instruction, /support_get/);
});

test("case lookup: a failing or slow support server never blocks the answer", async () => {
  assert.equal(await casecontext.lookup({ texts: ["the longest sleepover yet"], call: async () => { throw new Error("down"); } }), null);
  const slow = await casecontext.lookup({ texts: ["the longest sleepover yet"], call: () => new Promise(() => {}), timeoutMs: 30 });
  assert.equal(slow, null);
  assert.equal(await casecontext.lookup({ texts: [], call: async () => ({}) }), null);
});

test("images in context force the full profile and the vision lane", () => {
  const job = { kind: "conversation", source: { content: "do you think they are alts?" }, tags: { contextProfile: "focused", kindConfidence: 0.9 } };
  assert.equal(chatcontext.profile(job), "focused");
  job.contextImages = 2;
  assert.equal(chatcontext.profile(job), "full");
  const { routeForVision } = require("../lib/operator/agent");
  if (routeForVision) {
    const ledger = { audit() {}, save() {} };
    assert.equal(routeForVision(job, { visionProvider: "claude:claude-sonnet-5-5@medium" }, ledger), true);
    assert.equal(job.provider.vision, true);
  }
});
