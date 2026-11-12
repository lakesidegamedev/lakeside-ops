"use strict";
// Keir 9: a ticket message that states a game rule or a cause needs a game-code read behind it, asked for once per ticket.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { assertsRule, ruleClaim, REFUSAL } = require("../lib/operator/rulelookup");

const POSITIVE = [
  "Your revenue fell because the plants sold far less last turn.",
  "The shortfall comes from the tariff that was applied at the border.",
  "That is why your approval dropped after the vote.",
  "The reason your party cannot nominate is the membership threshold.",
  "The drop is caused by a policy that expired two turns ago.",
  "What is holding your corporation back is the energy shortage in your region.",
  "This is designed so that new companies grow slowly.",
  "That is intended behaviour for coalition parties.",
  "This is not a bug, the tax applies to every sector.",
  "Only the party leader can call a leadership vote.",
  "A governor cannot sign a treaty on their own.",
  "Cooperatives never pay the corporate tax rate.",
  "Dividends are always paid after the turn ends.",
  "The game sets the interest rate from the central bank policy.",
  "Production is recalculated each turn from your workforce.",
  "Output is updated per turn, so you only see it after processing.",
  "Heavy industry unlocks once you reach the second era.",
  "A lease requires at least three active plants.",
  "The loss is due to the new export ban.",
  "Your shares fell as a result of the merger announcement.",
  "That explains why the price moved.",
  "The bonus is capped at 10 percent for small firms.",
  "Your bond yield results from the fiscal balance of your country.",
  "I checked and the issue stems from the way the vote was counted.",
  "It works as designed: the bonus only applies to new hires.",
  "Own-site deliveries are counted as unsold on the run chart.",
  "The score counts toward your party's seat total only once.",
  "Net worth is calculated from the shares you hold directly.",
  "The savings rate is calculated from the prime rate and inflation.",
  "Your plant is idle because it has no input supplier, which explains the lower output.",
  "Regional bills do not move the lean; only governor orders do, and that is by design.",
  "Impeachment needs a strict majority of all House seats, and the Senate then needs two thirds.",
];

const NEGATIVE = [
  "Did you reactivate the California plants after the last turn?",
  "Which corporation were you looking at when this happened?",
  "Thanks, got it.",
  "Noted, I will take a look.",
  "I'm checking your plant records now.",
  "I am still looking into it and will report back.",
  "Hi, I'm Keir, the support assistant for this game.",
  "The developers decided to change the vote threshold, and will ship it soon.",
  "The owner approved the repair and it is being prepared.",
  "I'm waiting for the check to finish.",
  "Could you send a screenshot of the page?",
  "Understood.",
  "Let me know if you see it again.",
  "Can you tell me which turn this happened on?",
  "I've passed this to the developers.",
  "Sure, I'll come back to you shortly.",
  "Is this on your main account?",
  "Your ticket is open.",
  "I can't see your account records from here, so could you paste the figure?",
  "I never got the attachment, can you send it again?",
  "Your character holds 3 offices and 2 corporations.",
  "The owner said they want to decide this one themselves.",
  "Is the rate low because of the inflation figure?",
];

test("assertsRule: messages that state a rule or a cause", () => {
  for (const m of POSITIVE) assert.ok(assertsRule(m), `should assert a rule: ${m}`);
  assert.ok(POSITIVE.length >= 25);
});

test("assertsRule: questions, acknowledgements, status lines, relayed decisions and plain facts are exempt", () => {
  for (const m of NEGATIVE) assert.ok(!assertsRule(m), `should not assert a rule: ${m}`);
  assert.ok(NEGATIVE.length >= 15);
  assert.equal(assertsRule(""), false);
  assert.equal(assertsRule(null), false);
});

test("ruleClaim names the kind and the sentence, and skips an exempt first sentence", () => {
  const c = ruleClaim("Thanks for the detail. Your revenue fell because the plants sold less.");
  assert.equal(c.kind, "cause");
  assert.equal(c.pattern, "because");
  assert.match(c.sentence, /^Your revenue fell/);
  assert.equal(ruleClaim("Only the chair can file.").kind, "rule");
});

const CH = "777777777777777777";
const ticketDiscord = async (_method, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-123" }] : []);
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir9-rule-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false };
  const calls = [];
  const mcp = { servers: () => ["support", "ops-knowledge"], list: async () => ["support_public_update", "support_resolve", "code_search"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })), call: async (...a) => { calls.push(a); return { ok: true, id: "card-9", hits: [], delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord: ticketDiscord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-123", content: "Why did my revenue fall after turn 670?" }, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id; ledger.data.disclosed = { 123: { at: 1, posted: true } };
  const posts = () => calls.filter((c) => c[1] === "support_public_update" && c[2].deliver === true).map((c) => c[2].message);
  const audits = (kind) => (ledger.data.audit || []).filter((a) => a.kind === kind);
  return { ledger, broker, job, calls, posts, audits, advance: (min) => { clock += min * 60000; } };
}
const RULE = "Your revenue fell because the California plants were mothballed at turn 675.";

test("a rule stated before any code read is refused once, names the tool, and is not a post", async () => {
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: RULE }), (e) => /code_search/.test(e.message) && /ops-knowledge/.test(e.message) && /mechanic/.test(e.message) && e.message === REFUSAL);
  assert.equal(f.posts().length, 0);
  assert.equal((f.ledger.data.ticketPosts?.[123] || []).length, 0);
  assert.equal(f.audits("rule_lookup_required").length, 1);
  assert.ok(!f.job.replyRefusedPending, "the refusal must not arm the finish block");
});

test("posted after a code read: a read_tool code_search on ops-knowledge counts", async () => {
  const f = setup();
  await f.broker.tool(f.job, "read_tool", { server: "ops-knowledge", tool: "code_search", args: { question: "why plants are mothballed", claimType: "mechanic" } });
  assert.ok(f.job.codeLookups >= 1);
  await f.broker.tool(f.job, "channel_reply", { message: RULE });
  assert.equal(f.posts().length, 1);
  assert.equal(f.audits("rule_lookup_required").length, 0);
});

test("a code read by another task on the same ticket also counts", async () => {
  const f = setup();
  const other = f.ledger.createJob("t2", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH }, deadline: 9e15 });
  other.lastCodeReadAt = 5;
  await f.broker.tool(f.job, "channel_reply", { message: RULE });
  assert.equal(f.posts().length, 1);
});

test("a second try on the same ticket posts even without a read: one refusal per ticket", async () => {
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: RULE }), /code_search/);
  await f.broker.tool(f.job, "channel_reply", { message: RULE });
  assert.equal(f.posts().length, 1);
  assert.equal(f.audits("rule_lookup_required").length, 1);
  // A different rule claim later is not refused again.
  f.advance(30);
  f.job.observedPlayerAt = f.job.lastPlayerAt = 10 * 3600000 + 20 * 60000;
  await f.broker.tool(f.job, "channel_reply", { message: "Only the party chair can file, and that never changes between turns." });
  assert.equal(f.posts().length, 2);
});

test("a question, a status line and a plain finding are never refused", async () => {
  const f = setup();
  await f.broker.tool(f.job, "channel_reply", { message: "Which turn did you first see the drop?" });
  assert.equal(f.posts().length, 1);
  assert.equal(f.audits("rule_lookup_required").length, 0);
  assert.ok(!f.ledger.data.ruleLookupRefused);
});

test("the refusal never blocks finishing", async () => {
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: RULE }), /code_search/);
  assert.ok(!f.job.replyRefusedPending);
  await assert.doesNotReject(async () => { try { await f.broker.tool(f.job, "finish", { state: "waiting", summary: "Reading the game code for the rule." }); } catch (e) { assert.doesNotMatch(e.message, /was refused and nothing has been posted/); } });
});

test("KEIR_RULE_LOOKUP=0 switches the check off", async () => {
  const f = setup();
  process.env.KEIR_RULE_LOOKUP = "0";
  try {
    await f.broker.tool(f.job, "channel_reply", { message: RULE });
    assert.equal(f.posts().length, 1);
    assert.equal(f.audits("rule_lookup_required").length, 0);
  } finally { delete process.env.KEIR_RULE_LOOKUP; }
});

test("an Ask-grounded fast lane answer is exempt, a task that has escalated out of the lane is not", async () => {
  const f = setup();
  f.job.fastLane = { answers: 0 };
  await f.broker.tool(f.job, "channel_reply", { message: RULE });
  assert.equal(f.posts().length, 1);
  const g = setup();
  g.job.fastLane = { answers: 0, escalated: true };
  await assert.rejects(g.broker.tool(g.job, "channel_reply", { message: RULE }), /code_search/);
});
