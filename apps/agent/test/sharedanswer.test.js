"use strict";
// Keir 9 feature B: one checked answer reused when several players report the same fault.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const shared = require("../lib/operator/sharedanswer");

const HOUR = 3600000;
const CH_A = "777777777777777777", CH_B = "888888888888888888";
const REPORT_A = "The chemicals page tile shows the wrong income at /corporation/chemicals after the turn 412 update";
const REPORT_B = "My chemicals page tile shows wrong income at /corporation/chemicals since turn 412";
const ANSWER_A = "The tile was reading the offer instead of the sales, so that is a bug on the chemicals page.\n\nFrom: your chemicals page.";

function setup({ search = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sharedanswer-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { screenOutgoing: async () => ({ labels: [], refuse: null }), ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const calls = [];
  const mcp = { servers: () => ["support"], list: async () => [], call: async (server, tool, args) => {
    calls.push([tool, args]);
    if (tool === "support_search") return { results: search.map((number) => ({ number })) };
    if (tool === "support_public_update") return { delivery: { posted: true, status: "posted" } };
    return {};
  } };
  let clock = 100 * HOUR;
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const mk = (id, ticket, channel, text) => {
    const job = ledger.createJob(id, { role: "support", kind: "ticket", ticket, channelId: channel, replyChannel: channel, source: { channelId: channel, channelName: `ticket-bug-fixture-${ticket}`, content: text }, deadline: 9e15 });
    job.state = "running"; ledger.data.seen[`ticket:${ticket}`] = job.id; return job;
  };
  const a = mk("a", 123, CH_A, REPORT_A);
  const b = mk("b", 124, CH_B, REPORT_B);
  return { ledger, broker, a, b, calls, d: ledger.data, now: () => clock, advance: (ms) => { clock += ms; } };
}

test("a post with a code-written source line is kept as a checked answer; a post without one is not", () => {
  const f = setup();
  shared.noteAnswer(f.d, 123, "Your tile is working as designed.", { at: f.now(), jobId: "a" });
  assert.equal(f.d.checkedAnswers?.[123], undefined);
  shared.noteAnswer(f.d, 123, ANSWER_A, { at: f.now(), jobId: "a" });
  assert.equal(f.d.checkedAnswers[123].length, 1);
  assert.equal(f.d.checkedAnswers[123][0].source, "your chemicals page");
  assert.doesNotMatch(f.d.checkedAnswers[123][0].text, /From:/);
});

test("a match needs two independent signals, not one", async () => {
  const f = setup();
  shared.noteAnswer(f.d, 123, ANSWER_A, { at: f.now() });
  // Wording and the same screen: two signals.
  const two = shared.findMatch(f.d, f.b, { now: f.now() });
  assert.ok(two);
  assert.equal(two.ticket, 123);
  assert.ok(two.why.length >= 2);
  // Only the same screen name, different problem in different words: one signal.
  f.b.source.content = "Where can I find the election page for my party, I opened /corporation/chemicals by mistake";
  assert.equal(shared.findMatch(f.d, f.b, { now: f.now() }), null);
  // Only the search returning the ticket, unrelated report: one signal.
  f.b.source.content = "Please reset my notification settings, nothing else is wrong at all";
  assert.equal(shared.findMatch(f.d, f.b, { now: f.now(), hits: [123] }), null);
  // The search plus matching wording is two.
  f.b.source.content = "Chemicals tile shows the wrong income";
  assert.ok(shared.findMatch(f.d, f.b, { now: f.now(), hits: [123] }));
});

test("only checked, undisputed, uncorrected, recent answers are reused", () => {
  const f = setup();
  shared.noteAnswer(f.d, 123, ANSWER_A, { at: f.now() });
  assert.ok(shared.findMatch(f.d, f.b, { now: f.now() }));
  // Disputed by its player afterwards.
  f.d.trust = { playerMessages: [{ ticket: 123, at: f.now() + 1000, text: "That's not right, it is still wrong for me" }] };
  assert.equal(shared.findMatch(f.d, f.b, { now: f.now() + 5000 }), null);
  // A neutral later message does not dispute it.
  f.d.trust = { playerMessages: [{ ticket: 123, at: f.now() + 1000, text: "Thanks, that explains it" }] };
  assert.ok(shared.findMatch(f.d, f.b, { now: f.now() + 5000 }));
  // Corrected later by Keir.
  shared.noteAnswer(f.d, 123, "Correction to my last message: the tile reads the sales figure.", { at: f.now() + 2000 });
  assert.equal(shared.findMatch(f.d, f.b, { now: f.now() + 5000 }), null);
  // Older than 72 hours.
  const g = setup();
  shared.noteAnswer(g.d, 123, ANSWER_A, { at: g.now() });
  assert.equal(shared.findMatch(g.d, g.b, { now: g.now() + 73 * HOUR }), null);
});

test("the precheck gives the new task the earlier answer with its source, links both tickets and does not merge", async () => {
  const f = setup({ search: [123] });
  shared.noteAnswer(f.d, 123, ANSWER_A, { at: f.now() });
  const m = await f.broker.sharedAnswerPrecheck(f.b);
  assert.equal(m.ticket, 123);
  const ctx = f.broker.sharedAnswerContext(124);
  assert.match(ctx.summary, /^Ticket 123 had the same problem; the answer given there, checked against your chemicals page, was: /);
  assert.ok(ctx.matchedOn.length >= 2);
  assert.equal(f.d.ticketLinks[124][0].ticket, 123);
  assert.equal(f.d.ticketLinks[123][0].ticket, 124);
  assert.ok(!f.calls.some((c) => /merge/.test(c[0])));
  assert.equal(f.a.state, "running");
});

test("a draft that contradicts the earlier checked answer is refused once with both texts, then goes out", async () => {
  const f = setup({ search: [123] });
  shared.noteAnswer(f.d, 123, ANSWER_A, { at: f.now() });
  await f.broker.sharedAnswerPrecheck(f.b);
  await assert.rejects(f.broker.tool(f.b, "channel_reply", { message: "The chemicals page tile is working as designed." }), (e) => /contradicts the checked answer/.test(e.message) && /reading the offer/.test(e.message) && /working as designed/.test(e.message));
  assert.ok(!f.b.replyRefusedPending, "a consistency refusal must not block finishing");
  f.advance(20 * 60000);
  // Same direction as the refused draft is not the point: the second post is not checked again.
  const out = await f.broker.tool(f.b, "channel_reply", { message: "I looked at your page. Your corporation has no sales yet, so the tile is empty." });
  assert.equal(out.published, true);
});

test("an aligned draft is not refused", async () => {
  const f = setup({ search: [123] });
  shared.noteAnswer(f.d, 123, ANSWER_A, { at: f.now() });
  await f.broker.sharedAnswerPrecheck(f.b);
  const out = await f.broker.tool(f.b, "channel_reply", { message: "That tile is a bug: it was reading the offer instead of your sales." });
  assert.equal(out.published, true);
});

test("the earlier player's figures never count as the new player's own read", async () => {
  const f = setup({ search: [123] });
  shared.noteAnswer(f.d, 123, "That tile is a bug, it showed 9876 instead of the sales.\n\nFrom: your chemicals page.", { at: f.now() });
  await f.broker.sharedAnswerPrecheck(f.b);
  await assert.rejects(f.broker.tool(f.b, "channel_reply", { message: "Your tile showed 9876 instead of the sales, which is a bug." }), /not appear in anything this ticket has read/);
});
