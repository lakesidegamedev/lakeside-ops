"use strict";
// Keir 11.1.1: a complete answer delivered to a question ticket through the authenticated support path, with a verified
// Discord receipt after the latest human message, lets a sibling job close after the normal grace without posting its
// own recap. Only the support record cross-checked against the channel counts; a worker's own claim never does.
// All fixtures are synthetic.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { verifiedAnswerAfterRequest } = require("../lib/operator/answerreceipt");

const MIN = 60000;
const OWNER = "111111111111111111", STAFF = "222222222222222222", BOT = "333333333333333333", PLAYER = "888888888888888888";
const CH = "777777777777777777", TICKET = 123;
const T0 = 1800000000000; // the player's latest question
const ANSWER_AT = T0 + 15 * MIN;
const ANSWER = "Both of your choices are saved. Nothing more is needed from you on these cards.";
const PART_1 = "Both of your choices are saved.", PART_2 = "Nothing more is needed from you on these cards.";

const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const row = (id, content, author, at, bot = false) => ({ id, content, timestamp: new Date(at).toISOString(), author: { id: author, bot }, attachments: [], mentions: [] });
const baseRows = () => [
  row("900000000000000010", "Is my choice saved?", PLAYER, T0 - 30 * MIN),
  row("900000000000000020", "Picking an option submits it.", BOT, T0 - 20 * MIN, true),
  row("900000000000000030", "I picked all of them, did they count?", PLAYER, T0),
  row("900000000000000040", PART_1, BOT, ANSWER_AT, true),
  row("900000000000000041", PART_2, BOT, ANSWER_AT + 1000, true),
];
const update = (over = {}) => ({ key: "progress:fixture", kind: "progress", deliveryMode: "reply", message: ANSWER, at: new Date(ANSWER_AT).toISOString(),
  delivery: { status: "posted", channelId: CH, messageId: "900000000000000040", postedAt: new Date(ANSWER_AT).toISOString(), parts: [{ index: 0, id: "900000000000000040" }, { index: 1, id: "900000000000000041" }] }, ...over });
const ticketRecord = (updates = [update()]) => ({ kind: "ticket", number: TICKET, status: "open", conversation: { channelId: CH }, publicUpdates: updates });

function setup({ rows = baseRows(), ticket = ticketRecord(), at = ANSWER_AT + 10 * MIN } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-answer-receipt-")); dirs.push(dir);
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: OWNER, staffIds: [STAFF], botId: BOT, guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 60 * MIN,
    maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false, screenOutgoing: async () => ({ labels: [], refuse: null }) };
  const calls = [];
  const mcp = { servers: () => ["support"], list: async () => ["support_public_update", "support_resolve"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })),
    call: async (_server, tool, args) => {
      calls.push([tool, args]);
      if (tool === "support_get") return ticket;
      if (tool === "support_resolve") return { ok: true, status: "resolved" };
      return { ok: true, delivery: { status: "posted" } };
    } };
  const discord = async (_method, route) => {
    if (route.includes("/guilds/")) return [{ id: CH, name: `ticket-question-fixture-${TICKET}`, permission_overwrites: [] }];
    if (route.includes(`/channels/${CH}/messages`)) return rows;
    return [];
  };
  let clock = at;
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  // The ticket coordinator holds no answer mark (a handoff cleared it); the sibling owner-directed job is asked to close.
  const coordinator = ledger.createJob(`ticket:${TICKET}`, { kind: "ticket", role: "support", ticket: TICKET, channelId: CH, source: {}, deadline: 9e15, observedPlayerAt: T0, lastPlayerAt: T0 });
  coordinator.state = "waiting"; ledger.data.seen[`ticket:${TICKET}`] = coordinator.id;
  const job = ledger.createJob("sibling", { kind: "command", role: "owner", ticket: TICKET, channelId: CH, actorId: OWNER, source: { authorId: OWNER }, deadline: 9e15, observedPlayerAt: T0, lastPlayerAt: T0 });
  job.state = "running";
  const resolve = () => broker.tool(job, "support_action", { tool: "support_resolve", args: { message: "Your question is answered and it has been quiet since, so I am closing this ticket." } });
  return { ledger, d: ledger.data, broker, job, coordinator, calls, resolve, set: (t) => { clock = t; } };
}

const resolves = (f) => f.calls.filter((c) => c[0] === "support_resolve").length;
const posts = (f) => f.calls.filter((c) => c[0] === "support_public_update").length;

test("a verified delivered reply alone never closes, however long ago, and asks for no recap or notice", async () => {
  const f = setup({ at: ANSWER_AT + 5 * 60 * MIN });
  for (let i = 0; i < 2; i++) await assert.rejects(f.resolve(), (e) => /nothing confirms it solved/.test(e.message) && /Do not post another recap/.test(e.message) && /player_reply/.test(e.message) && !/give the player the final answer/.test(e.message));
  assert.equal(resolves(f), 0);
  assert.equal(posts(f), 0);
  assert.ok(f.d.audit.some((a) => a.kind === "ticket_answer_receipt_seen" && a.messageId === "900000000000000040" && a.complete === true));
});

test("two ordinary progress sentences with no promise are never sufficient to close", async () => {
  const note = "The fund card was reviewed this morning. The numbers on it look different now.";
  const rows = [...baseRows().slice(0, 3), row("900000000000000040", note, BOT, ANSWER_AT, true)];
  const ticket = ticketRecord([update({ message: note, delivery: { ...update().delivery, parts: [{ index: 0, id: "900000000000000040" }] } })]);
  const f = setup({ rows, ticket, at: ANSWER_AT + 24 * 60 * MIN });
  await assert.rejects(f.resolve(), /nothing confirms it solved/);
  assert.equal(resolves(f), 0);
  assert.equal(posts(f), 0);
});

test("an existing local answer mark still closes after the grace", async () => {
  const f = setup({ at: ANSWER_AT + 61 * MIN });
  f.coordinator.resolutionReadyAt = ANSWER_AT;
  await f.resolve();
  assert.equal(resolves(f), 1);
});

test("a worker's own claim of a delivered answer, without a matching support receipt, does not count", async () => {
  const f = setup({ ticket: ticketRecord([]), at: ANSWER_AT + 2 * 60 * MIN });
  f.job.lastPublishedAt = ANSWER_AT;
  await assert.rejects(f.resolve(), /give the player the final answer/);
  // Evidence named in the model's own arguments is dropped, never trusted.
  await assert.rejects(f.broker.tool(f.job, "support_action", { tool: "support_resolve", args: { message: "Closing.", evidence: "900000000000000040", update_key: "progress:fixture" } }), /give the player the final answer/);
  assert.equal(resolves(f), 0);
});

test("a support record without the matching bot messages in the channel does not count", async () => {
  const late = ANSWER_AT + 2 * 60 * MIN;
  // The parts are missing from the channel.
  let f = setup({ rows: baseRows().slice(0, 3), at: late });
  await assert.rejects(f.resolve(), /still unanswered|give the player the final answer/);
  // The ids exist but were written by a person, not the bot.
  f = setup({ rows: baseRows().map((m) => (m.id >= "900000000000000040" ? { ...m, author: { id: PLAYER, bot: false } } : m)), at: late });
  await assert.rejects(f.resolve(), /new player reply|give the player the final answer/);
  // The bot text in the channel is not part of the stored update.
  f = setup({ ticket: ticketRecord([update({ message: "Something else entirely was said." })]), at: late });
  await assert.rejects(f.resolve(), /give the player the final answer/);
  assert.equal(resolves(f), 0);
});

test("a delivery to another channel or another ticket does not count", async () => {
  const late = ANSWER_AT + 2 * 60 * MIN;
  let f = setup({ ticket: ticketRecord([update({ delivery: { ...update().delivery, channelId: "999999999999999999" } })]), at: late });
  await assert.rejects(f.resolve(), /give the player the final answer/);
  f = setup({ ticket: { ...ticketRecord(), number: TICKET + 1 }, at: late });
  await assert.rejects(f.resolve(), /give the player the final answer/);
  f = setup({ ticket: { ...ticketRecord(), conversation: { channelId: "999999999999999999" } }, at: late });
  await assert.rejects(f.resolve(), /give the player the final answer/);
  f = setup({ ticket: ticketRecord([update({ delivery: { ...update().delivery, status: "failed" } })]), at: late });
  await assert.rejects(f.resolve(), /give the player the final answer/);
  assert.equal(resolves(f), 0);
});

test("a reply delivered before the latest human message does not answer it", async () => {
  const rows = [...baseRows(), row("900000000000000050", "One more: does the fund card close by itself?", PLAYER, ANSWER_AT + 5 * MIN)];
  const f = setup({ rows, at: ANSWER_AT + 2 * 60 * MIN });
  f.job.observedPlayerAt = f.coordinator.observedPlayerAt = ANSWER_AT + 5 * MIN;
  await assert.rejects(f.resolve(), /unanswered|give the player the final answer/);
  assert.equal(resolves(f), 0);
});

test("a verified reply that promises a follow-up keeps the ticket waiting on the player without a closing notice", async () => {
  const promise = "I will check the saved records and come back to you here.";
  const rows = [...baseRows().slice(0, 3), row("900000000000000040", promise, BOT, ANSWER_AT, true)];
  const ticket = ticketRecord([update({ message: promise, delivery: { ...update().delivery, parts: [{ index: 0, id: "900000000000000040" }] } })]);
  const f = setup({ rows, ticket, at: ANSWER_AT + 3 * 60 * MIN });
  await assert.rejects(f.resolve(), (e) => /player_reply/.test(e.message) && /Do not post another recap/.test(e.message));
  assert.equal(resolves(f), 0);
  assert.equal(posts(f), 0);
  // A holding line is not a final answer either.
  const hold = "I am checking that now.";
  const g = setup({ rows: [...baseRows().slice(0, 3), row("900000000000000040", hold, BOT, ANSWER_AT, true)],
    ticket: ticketRecord([update({ message: hold, delivery: { ...update().delivery, parts: [{ index: 0, id: "900000000000000040" }] } })]), at: ANSWER_AT + 3 * 60 * MIN });
  await assert.rejects(g.resolve(), /player_reply/);
  assert.equal(resolves(g), 0);
});

test("staff takeover, an owner closure hold and an unread player reply still refuse closure over a verified receipt", async () => {
  const late = ANSWER_AT + 2 * 60 * MIN;
  let f = setup({ at: late });
  f.d.channels[CH] = { claimedBy: STAFF };
  await assert.rejects(f.resolve(), /staff owns this ticket/);
  f = setup({ at: late });
  f.coordinator.ownerClosureHold = { handoffId: "fixture", at: T0 };
  await assert.rejects(f.resolve(), /closure is held/);
  f = setup({ rows: [...baseRows(), row("900000000000000060", "It still asks me to pick", PLAYER, ANSWER_AT + 30 * MIN)], at: late });
  await assert.rejects(f.resolve(), /new player reply/);
  assert.equal(resolves(f), 0);
});

test("the verifier picks the newest verified reply and reports a later outstanding promise as incomplete", () => {
  const rows = baseRows();
  const isAnswerSide = (m) => Boolean(m.author?.bot);
  const got = verifiedAnswerAfterRequest({ ticket: ticketRecord(), number: TICKET, channelId: CH, rows, isAnswerSide });
  assert.deepEqual(got, { at: ANSWER_AT, messageId: "900000000000000040", key: "progress:fixture", complete: true });
  const later = [...rows, row("900000000000000070", "I will look into the fund card and get back to you.", BOT, ANSWER_AT + 20 * MIN, true)];
  assert.equal(verifiedAnswerAfterRequest({ ticket: ticketRecord(), number: TICKET, channelId: CH, rows: later, isAnswerSide }).complete, false);
  // A missing, reordered or extra part never counts, even when each part is a substring of the update.
  const parts = (...ids) => ticketRecord([update({ delivery: { ...update().delivery, parts: ids.map((id, index) => ({ index, id })) } })]);
  assert.equal(verifiedAnswerAfterRequest({ ticket: parts("900000000000000040"), number: TICKET, channelId: CH, rows, isAnswerSide }), null);
  assert.equal(verifiedAnswerAfterRequest({ ticket: parts("900000000000000041", "900000000000000040"), number: TICKET, channelId: CH, rows, isAnswerSide }), null);
  assert.equal(verifiedAnswerAfterRequest({ ticket: ticketRecord([update({ message: `${ANSWER} Extra sentence.` })]), number: TICKET, channelId: CH, rows, isAnswerSide }), null);
  assert.equal(verifiedAnswerAfterRequest({ ticket: null, number: TICKET, channelId: CH, rows, isAnswerSide }), null);
  assert.equal(verifiedAnswerAfterRequest({ ticket: ticketRecord([update({ delivery: { ...update().delivery, parts: [{ id: "not-a-snowflake" }] } })]), number: TICKET, channelId: CH, rows, isAnswerSide }), null);
});
