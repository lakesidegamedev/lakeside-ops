"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { handleAskAction } = require("./ask-action");
const { createSuggestion } = require("./mcp/support-create-suggestion");
const { TicketCreateError } = require("./mcp/support-create-ticket");

const discordId = "111111111111111111", userId = "a".repeat(24), actionId = "abcdefghijklmnop";

function harness({ user = { discordId }, member = true, ticketError = null } = {}) {
  const docs = new Map(), posts = [], tickets = [];
  const Intake = {
    insertOne: async (d) => { if (docs.has(d._id)) throw Object.assign(new Error("duplicate"), { code: 11000 }); docs.set(d._id, { ...d }); },
    findOne: async (q) => docs.get(q._id),
    updateOne: async (q, patch) => Object.assign(docs.get(q._id), patch.$set),
    deleteOne: async (q) => { docs.delete(q._id); },
  };
  const Users = { findOne: async (q) => (user && (q.discordId ? q.discordId === user.discordId : String(q._id) === userId) ? user : null) };
  const fetchImpl = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return Response.json({ issueNumber: 12, detailUrl: "https://game.test/feedback/12" }); };
  const deps = {
    Users, Intake, env: {},
    createSuggestion: (input, d) => createSuggestion(input, { ...d, fetchImpl, env: { AHD_GAME_API_URL: "https://game.test", DISCORD_BOT_API_KEY: "k" } }),
    createTicket: async (options) => { tickets.push(options); if (ticketError) throw ticketError; return { ticketNumber: 456, channelUrl: "https://discord.com/channels/g/c" }; },
    findMember: async () => (member ? { user: { id: discordId } } : null),
  };
  const run = (body) => handleAskAction({ kind: "suggestion", actionId, identity: { userId }, title: "Union map", description: "Show union strength by state", category: "ui_improvement", gameSystem: "parties", sourceText: "file that as a suggestion", surface: "drawer", ...body }, deps);
  return { run, docs, posts, tickets };
}

test("a suggestion from an AHD user files under their linked Discord id and repeats return the same receipt", async () => {
  const h = harness();
  const a = await h.run();
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { ok: true, receipt: { kind: "suggestion", number: 12, url: "https://game.test/feedback/12" } });
  assert.equal(h.posts[0].body.discordUserId, discordId);
  const b = await h.run();
  assert.equal(b.body.duplicate, true); assert.equal(b.body.receipt.number, 12); assert.equal(h.posts.length, 1);
});

test("an unlinked AHD user files a suggestion by game user id but cannot open a ticket", async () => {
  const h = harness({ user: { isBanned: false } });
  const a = await h.run();
  assert.equal(a.status, 200); assert.equal(h.posts[0].body.userId, userId); assert.equal(h.posts[0].body.discordUserId, undefined);
  const t = await h.run({ kind: "ticket", actionId: "ticketaction00001", category: "bug" });
  assert.equal(t.status, 422); assert.equal(t.body.needsDiscordLink, true); assert.equal(h.tickets.length, 0);
});

test("a ticket opens once through the shared core with the player as reporter", async () => {
  const h = harness();
  const body = { kind: "ticket", identity: { discordId }, category: "bug", pageUrl: "https://ahousedividedgame.com/unions" };
  const a = await h.run(body);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.receipt, { kind: "ticket", number: 456, url: "https://discord.com/channels/g/c" });
  assert.equal(h.tickets[0].discordUserId, discordId); assert.equal(h.tickets[0].category, "bug");
  assert.ok(h.tickets[0].extraFields.some((f) => f.name === "Player request" && f.value === "file that as a suggestion"));
  assert.ok(h.tickets[0].extraFields.some((f) => f.name === "Page"));
  const b = await h.run(body);
  assert.equal(b.body.duplicate, true); assert.equal(h.tickets.length, 1);
  assert.equal((await h.run({ ...body, title: "Changed" })).status, 409);
});

test("ticket failures release the claim only when nothing was created", async () => {
  const safe = harness({ ticketError: new TicketCreateError("no number", { stage: "reserve" }) });
  assert.equal((await safe.run({ kind: "ticket", category: "bug" })).status, 502);
  assert.equal(safe.docs.size, 0);
  const partial = harness({ ticketError: new TicketCreateError("refused", { stage: "register" }) });
  assert.equal((await partial.run({ kind: "ticket", category: "bug" })).status, 502);
  assert.equal((await partial.run({ kind: "ticket", category: "bug" })).status, 409);
  assert.equal(partial.tickets.length, 1);
});

test("invalid input, banned accounts, missing guild members and blocked content are refused before any write", async () => {
  for (const body of [{ kind: "vote" }, { actionId: "short" }, { identity: {} }, { identity: { userId: "nope" } }, { category: "moderation", kind: "ticket" }, { category: "incident", kind: "ticket" }, { gameSystem: "space" }, { title: " " }]) {
    const h = harness(); assert.equal((await h.run(body)).status, 400, JSON.stringify(body)); assert.equal(h.posts.length + h.tickets.length, 0);
  }
  const banned = harness({ user: { discordId, isBanned: true } }); assert.equal((await banned.run()).status, 403); assert.equal(banned.posts.length, 0);
  const unknown = harness({ user: null }); assert.equal((await unknown.run()).status, 404);
  const outside = harness({ member: false }); const r = await outside.run({ kind: "ticket", category: "bug" });
  assert.equal(r.status, 422); assert.equal(r.body.needsDiscordServer, true); assert.equal(outside.docs.size, 0);
  const shouting = harness(); assert.equal((await shouting.run({ description: "THIS IS ALL CAPITALS AND IT GOES ON FOR A WHILE TO TRIP THE CHECK" })).status, 400);
});
