"use strict";
// Ticket 1860 (2026-11-21): the owner wrote "@Keith close this ticket please and wrap up" in the ticket's own channel.
// An earlier agent handoff had set an owner closure hold; Keir asked the owner to confirm, then refused again because the
// request "did not name" the ticket. The owner telling Keir to close the ticket in its channel lifts the hold and closes it.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { createGateway } = require("../lib/operator/gateway");
const { asksToCloseThisTicket, ownerChannelClose } = require("../lib/operator/ownerclose");

const OWNER = "111111111111111111", STAFF = "222222222222222222", BOT = "333333333333333333", PLAYER = "555555555555555555";
const CH1860 = "100000000000001860", CH1861 = "100000000000001861", STAFF_CH = "666666666666666666";
const NAME1860 = "ticket-bug-fixture-1860", NAME1861 = "ticket-bug-fixture-1861";
const SAID = `<@${BOT}> close this ticket please and wrap up`;
let seq = 0;
const msgId = () => String(700000000000000000n + BigInt(++seq));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir1860-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: OWNER, staffIds: [STAFF], botId: BOT, guildId: "444444444444444444", scanChannels: [], watched: () => true, taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir };
  const store = { 1860: { number: 1860, title: "Economy", category: "bug", status: "open" }, 1861: { number: 1861, title: "Other", category: "bug", status: "open" } };
  const calls = [], posted = {};
  const mcp = { servers: () => ["support"], list: async () => [], call: async (server, name, args) => {
    calls.push([name, args]);
    if (name === "support_get") return store[args.number] ? { ...store[args.number] } : null;
    if (name === "support_resolve") { store[args.number].status = "resolved"; return { ok: true }; }
    return { ok: true };
  } };
  const answered = [{ id: "200000000000000001", author: { id: PLAYER }, content: "the build screen looks wrong" }, { id: "200000000000000002", author: { id: BOT, bot: true }, content: "Here is the wrap-up: the screen fixes are live." }];
  const discord = async (method, url) => {
    const one = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(url);
    if (method === "GET" && one && posted[one[2]]) return posted[one[2]];
    if (method === "GET" && url.endsWith("/channels")) return [{ id: CH1860, name: NAME1860 }, { id: CH1861, name: NAME1861 }];
    if (method === "GET" && /^\/channels\/\d+\/messages\?limit=/.test(url)) return answered;
    return {};
  };
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => Date.now() });
  const gateway = createGateway({ ledger, config, now: () => Date.now() });
  // The ticket's own task, held by an earlier agent handoff (supportowner.js sets this from holdClosure: true).
  const held = ledger.createJob("ticket:1860", { kind: "ticket", role: "support", ticket: 1860, channelId: CH1860, source: { channelId: CH1860, channelName: NAME1860 }, deadline: 9e15 });
  held.state = "waiting"; held.ownerClosureHold = { handoffId: "h1", at: Date.now() };
  // A message as Discord delivers it through the gateway; the fake Discord returns the same message when re-read.
  function say(author, channelId, channelName, content) {
    const id = msgId();
    const message = { id, author: { id: author, username: author === OWNER ? "owner" : "staff", bot: false }, content, timestamp: new Date().toISOString(), mentions: content.includes(`<@${BOT}>`) ? [{ id: BOT }] : [], attachments: [] };
    posted[id] = message;
    gateway.ingest({ id: channelId, name: channelName, type: 0 }, message);
    const job = Object.values(ledger.data.jobs).find((j) => j.source?.messageId === id);
    if (job) job.state = "running";
    return { id, job };
  }
  const resolves = () => calls.filter((c) => c[0] === "support_resolve");
  return { ledger, config, broker, store, held, say, resolves, d: ledger.data };
}
const hasHold = (f, n) => Object.values(f.d.jobs).some((j) => j.ownerClosureHold && Number(j.ticket) === n);

test("1860: the owner's 'close this ticket please and wrap up' in the ticket channel lifts the hold and closes it, with no confirmation", async () => {
  const f = setup();
  const audit = [];
  const orig = f.ledger.audit; f.ledger.audit = (kind, detail) => { audit.push([kind, detail]); return orig(kind, detail); };
  const { job } = f.say(OWNER, CH1860, NAME1860, SAID);
  assert.ok(job, "the owner's message became a command task");
  assert.equal(job.kind, "command"); assert.equal(job.ticket, 1860);
  assert.equal(hasHold(f, 1860), false, "the hold is lifted as soon as the owner asks");
  assert.ok(audit.some(([k, d]) => k === "owner_closure_hold_lifted" && d.ticket === 1860 && d.job === f.held.id));
  const r = await f.broker.tool(job, "ticket_command", { op: "resolve", tickets: [1860], message: "Thanks for the report. The screen fixes are live, so this one is closed." });
  assert.equal(r.confirming, undefined, "no confirmation for a close the owner just asked for");
  assert.deepEqual(r.results.map((x) => x.closed), [true]);
  assert.equal(f.resolves().length, 1);
  assert.equal(f.store[1860].status, "resolved");
  assert.equal(Object.values(f.d.decisions || {}).length, 0, "the owner was asked nothing");
});

test("1860: a hold set after the owner's message is still lifted by the owner's request, at the tool guard and in ticket_command", async () => {
  const f = setup();
  const { job } = f.say(OWNER, CH1860, NAME1860, SAID);
  f.held.ownerClosureHold = { handoffId: "h2", at: Date.now() };
  // The tool path that threw "Ticket closure is held by an explicit owner follow-up" no longer refuses for the hold.
  let err = null;
  try { await f.broker.tool(job, "support_action", { tool: "support_resolve", args: { message: "Closing this as asked." } }); } catch (e) { err = e; }
  assert.doesNotMatch(String(err?.message || ""), /held by an explicit owner follow-up|closure hold/);
  assert.equal(hasHold(f, 1860), false);
  f.held.ownerClosureHold = { handoffId: "h3", at: Date.now() };
  f.store[1860].status = "open";
  const r = await f.broker.tool(job, "ticket_command", { op: "resolve", tickets: [1860], message: "Thanks for the report, this one is closed now." });
  assert.equal(r.confirming, undefined);
  assert.deepEqual(r.results.map((x) => x.closed), [true]);
  assert.equal(hasHold(f, 1860), false);
});

test("1860: a staff member's identical message is still refused by the owner's hold, and the owner is not asked", async () => {
  const f = setup();
  const { job } = f.say(STAFF, CH1860, NAME1860, SAID);
  assert.ok(job);
  assert.equal(hasHold(f, 1860), true, "staff cannot lift the owner's hold");
  const r = await f.broker.tool(job, "ticket_command", { op: "resolve", tickets: [1860], message: "Closing this one now as asked." });
  assert.equal(r.confirming, undefined);
  assert.equal(r.results[0].closed, false);
  assert.match(r.results[0].why, /owner put a hold on closing it, and only the owner can lift it/);
  assert.doesNotMatch(r.results[0].why, /naming/);
  await assert.rejects(f.broker.tool(job, "support_action", { tool: "support_resolve", args: { message: "Closing this as asked." } }), /held by an explicit owner follow-up/);
  assert.equal(f.resolves().length, 0);
  assert.equal(hasHold(f, 1860), true);
});

test("1860: the owner's 'close this' in another ticket's channel does not close or unhold the held ticket", async () => {
  const f = setup();
  const other = f.ledger.createJob("ticket:1861", { kind: "ticket", role: "support", ticket: 1861, channelId: CH1861, source: { channelId: CH1861, channelName: NAME1861 }, deadline: 9e15 });
  other.state = "waiting"; other.ownerClosureHold = { handoffId: "h9", at: Date.now() };
  const { job } = f.say(OWNER, CH1861, NAME1861, SAID);
  assert.equal(hasHold(f, 1860), true, "1860 keeps its hold");
  assert.equal(hasHold(f, 1861), false, "only the channel's own ticket is lifted");
  const r = await f.broker.tool(job, "ticket_command", { op: "resolve", tickets: [1860], message: "Closing this one now as asked." });
  assert.equal(r.confirming, true, "a close of a ticket the request did not name is confirmed first");
  assert.equal(f.resolves().length, 0);
  assert.equal(hasHold(f, 1860), true);
});

test("1860: the owner naming the number from another channel still closes the held ticket and clears the hold", async () => {
  const f = setup();
  const { job } = f.say(OWNER, STAFF_CH, "staff-chat", `<@${BOT}> close 1860, it is wrapped up`);
  assert.equal(hasHold(f, 1860), true, "a message outside the ticket channel lifts nothing at intake");
  const r = await f.broker.tool(job, "ticket_command", { op: "resolve", tickets: [1860], message: "Thanks for the report, this one is closed now." });
  assert.deepEqual(r.results.map((x) => x.closed), [true]);
  assert.equal(hasHold(f, 1860), false);
});

test("1860: the owner's yes to a confirmation is the owner naming the ticket, so the hold does not refuse it again", async () => {
  const f = setup();
  const { job } = f.say(OWNER, STAFF_CH, "staff-chat", `<@${BOT}> close the economy ticket please`);
  const first = await f.broker.tool(job, "ticket_command", { op: "resolve", tickets: [1860], message: "Thanks for the report, this one is closed now." });
  assert.equal(first.confirming, true);
  const x = f.d.decisions[first.decision];
  x.state = "selected"; x.selectedOption = { id: "1" };
  const r = await f.broker.tool(job, "ticket_command", { op: "resolve", tickets: [1860], message: "Thanks for the report, this one is closed now." });
  assert.deepEqual(r.results.map((y) => y.closed), [true]);
  assert.equal(hasHold(f, 1860), false);
});

test("asksToCloseThisTicket reads the owner's close requests and leaves everything else alone", () => {
  for (const t of ["close this ticket please and wrap up", "close this", "close it", "you can close", "please close", "resolve this ticket", "no need to keep updating here you can close", "close 1860"]) assert.equal(asksToCloseThisTicket(t, 1860), true, t);
  for (const t of ["don't close this", "do not close it yet", "keep it open", "not yet", "close 1861", "close the PR", "close the issue for this", "what is the status", "closed captions are broken"]) assert.equal(asksToCloseThisTicket(t, 1860), false, t);
});

test("ownerChannelClose needs the owner as the recorded author, in the ticket's own channel", () => {
  const config = { ownerId: OWNER };
  const job = (over = {}) => ({ kind: "command", role: "owner", actorId: OWNER, channelId: CH1860, ticket: 1860, source: { authorId: OWNER, channelId: CH1860, channelName: NAME1860, content: SAID }, ...over });
  assert.equal(ownerChannelClose(config, job()), 1860);
  assert.equal(ownerChannelClose(config, job({ actorId: STAFF, role: "support", source: { authorId: STAFF, channelId: CH1860, channelName: NAME1860, content: SAID } })), 0);
  assert.equal(ownerChannelClose(config, job({ source: { authorId: PLAYER, channelId: CH1860, channelName: NAME1860, content: SAID } })), 0);
  assert.equal(ownerChannelClose(config, job({ kind: "ticket" })), 0);
  assert.equal(ownerChannelClose(config, job({ channelId: STAFF_CH, source: { authorId: OWNER, channelId: STAFF_CH, channelName: "staff-chat", content: SAID } })), 0);
});
