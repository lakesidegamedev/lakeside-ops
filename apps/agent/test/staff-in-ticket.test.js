"use strict";
// Keir 9.0.3: a staff or owner question asked inside a ticket channel gets the ticket route and the same claim checks as a player answer.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { createAgent } = require("../lib/operator/agent");
const ac = require("../lib/operator/accountclaim");

const POSITIVE = [
  "Not linked. Their account exists but carries no Discord link.",
  "This player's account is not linked to Discord.",
  "The account isn't linked yet.",
  "There is no Discord link on the record.",
  "The account has no character.",
  "They don't have a character on that account.",
];
const NEGATIVE = [
  "Their account is linked and has two characters.",
  "Is the account not linked?",
  "If your account is not linked, the link command in the lobby will fix it.",
  "I have not confirmed whether the account is linked.",
  "The stock count is wrong on that page.",
  "There is no link between the two reports.".replace("no link", "a shared note"),
];
test("account statements are recognised, questions, conditions and hedges are not", () => {
  for (const m of POSITIVE) assert.ok(ac.accountClaim(m), m);
  for (const m of NEGATIVE) assert.equal(ac.accountClaim(m), null, m);
});
test("a claim needs a read that shows it and agrees with it", () => {
  const linked = { reads: ['{"account":{"username":"u","linked":true},"characters":[{"name":"n","sequentialId":4}]}'], inspections: [{ account: { linked: true }, characters: [{ name: "n" }] }] };
  const noDiscordField = { reads: ['{"username":"u"}'], inspections: [] };
  const showsNoLink = { reads: ['{"username":"u","discordId":null}'], inspections: [] };
  assert.equal(ac.unbackedAccountClaim("Not linked.", {}).reason, "unread");
  assert.equal(ac.unbackedAccountClaim("Not linked.", linked).reason, "contradicted");
  assert.equal(ac.unbackedAccountClaim("The account has no character.", linked).reason, "contradicted");
  assert.equal(ac.unbackedAccountClaim("There is no Discord link.", noDiscordField).reason, "unread");
  assert.equal(ac.unbackedAccountClaim("There is no Discord link.", showsNoLink), null);
  assert.equal(ac.unbackedAccountClaim("Their account is linked.", {}), null);
});

const CH = "777777777777777777", OWNER = "111111111111111111";
const ticketDiscord = async (_m, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-fixture-123" }] : []);
function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir9-staffticket-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { screenOutgoing: async () => ({ labels: [], refuse: null }), ownerId: OWNER, staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false };
  const calls = [];
  const mcp = { servers: () => ["support"], list: async () => ["support_public_update"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })),
    call: async (...a) => { calls.push(a); return { ok: true, id: "card-9", delivery: { posted: true, delivery: { status: "posted" } } }; } };
  const clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord: ticketDiscord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const job = ledger.createJob("c1", { role: "owner", kind: "command", actorId: OWNER, ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-fixture-123", authorId: OWNER, content: "their account should be linked, is it not?", at: new Date(clock - 5000).toISOString() }, deadline: 9e15, ...extra });
  job.state = "running"; ledger.data.disclosed = { 123: { at: 1, posted: true } };
  const posts = () => calls.filter((c) => c[1] === "support_public_update" && c[2].deliver === true).map((c) => c[2].message);
  const audits = (kind) => (ledger.data.audit || []).filter((a) => a.kind === kind);
  return { ledger, broker, job, posts, audits, config };
}
const FALSE_CLAIM = "Not linked. Their account exists but carries no Discord link.";

test("an owner task cannot tell the ticket channel an account is unlinked without a read, once", async () => {
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: FALSE_CLAIM }), (e) => /nothing read in this activation shows that/.test(e.message));
  assert.equal(f.posts().length, 0);
  assert.equal(f.audits("account_claim_refused").length, 1);
  assert.ok(!f.job.replyRefusedPending, "never blocks finishing");
  const src = fs.readFileSync(path.join(__dirname, "../lib/operator/broker.js"), "utf8");
  const pacing = new RegExp(/const PACING_REFUSAL = \/(.*)\/i;/.exec(src)[1], "i");
  assert.ok(pacing.test(ac.REFUSAL({ kind: "link", sentence: "s", reason: "unread" })) && pacing.test(ac.REFUSAL({ kind: "link", sentence: "s", reason: "contradicted" })));
  // Keir 9.0.4: refused twice, then it goes out labelled as not checked, never as a fact.
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: FALSE_CLAIM }), /nothing read in this activation/);
  assert.equal(f.audits("account_claim_refused").length, 2);
  await f.broker.tool(f.job, "channel_reply", { message: FALSE_CLAIM });
  assert.match(f.posts().at(-1), /I have not checked this yet, so it may be wrong: not linked\. I have not checked this yet, so it may be wrong: their account exists but carries no Discord link/i);
});

test("Keir 9.0.4: an account fact needs a read in this activation; an older activation's read does not count", async () => {
  const f = setup();
  f.job.activationAt = 5000;
  f.job.reporterInspection = { at: 4000, account: { username: "u", linked: true }, characters: [] };
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Their account is not linked." }), /nothing read in this activation/);
  f.job.reporterInspection = { at: 6000, account: { username: "u", linked: true }, characters: [] };
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Their account is not linked." }), /shows a link or a character/);
});

test("Keir 9.0.4: purchase and refund statements are account facts; 'I cannot see their purchases' is not", async () => {
  assert.equal(ac.accountClaim("They did not get a refund on Patreon last month.").kind, "purchase");
  assert.equal(ac.accountClaim("They have already purchased the supporter perk.").kind, "purchase");
  assert.equal(ac.accountClaim("I cannot see their Patreon purchases from here, so I have not checked whether they got a refund."), null);
  assert.equal(ac.accountClaim("Has the player bought the supporter perk?"), null);
  assert.equal(ac.accountClaim("Confirmed: the licence was charged twice."), null);
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "They did not get a refund on Patreon last month." }), /nothing read in this activation/);
  await f.broker.tool(f.job, "channel_reply", { message: "I cannot see their Patreon purchases from here, so I have not checked whether they got a refund." });
});

test("a read showing the link makes 'not linked' a refusal, and the true statement goes out", async () => {
  const f = setup();
  f.job.evidenceText = '\n[reporter_state] {"account":{"username":"u","linked":true},"characters":[{"name":"n","sequentialId":4}]}';
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: FALSE_CLAIM }), (e) => /shows a link or a character/.test(e.message));
  await f.broker.tool(f.job, "channel_reply", { message: "Their account is linked and has one character." });
  assert.equal(f.posts().length, 1);
});

test("a staff answer rests on reads like a player answer: an unread 'shows' claim is refused, a backed one is not", async () => {
  const f = setup();
  const GUESS = "The gauge is reading how much of your stock you put on the shelf.";
  f.job.evidenceText = "\n[trace_sector] " + JSON.stringify({ note: "the gauge reads the allocation record" });
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: GUESS }));
  assert.equal(f.audits("read_claim_refused").length, 1);
  await f.broker.tool(f.job, "channel_reply", { message: "The gauge reads the allocation record." });
  assert.equal(f.posts().length, 1);
});

test("a staff answer that calls behaviour a bug with nothing read is refused once per attempt, bounded at two", async () => {
  const f = setup();
  const BUG = "That is a bug in the route rules.";
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: BUG }));
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: BUG + " " }));
  assert.equal(f.audits("bug_claim_refused").length, 2);
  await f.broker.tool(f.job, "channel_reply", { message: BUG + "  " });
  assert.equal(f.audits("bug_claim_refused").length, 2);
  assert.equal(f.posts().length, 1);
});

test("the player's own ticket task faces the same account check", async () => {
  const f = setup({ role: "support", kind: "ticket", actorId: undefined });
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: FALSE_CLAIM }));
  assert.equal(f.audits("account_claim_refused").length, 1);
});

function routeFixture(job) {
  const f = setup(job);
  const seen = [];
  const agent = createAgent({ ledger: f.ledger, broker: f.broker,
    config: { briefFile: path.join(__dirname, "../KEIR.md"), model: "claude-opus-5-5", maxRounds: 2, maxTurnMs: 10000, stateDir: path.dirname(f.ledger.file || os.tmpdir()), workerProvider: "opencode:opencode-go/deepseek-v4.1-flash",
      providerOverride: "opencode:opencode-go/deepseek-v4.1-flash@high", ticketProvider: "agy:gemini-4-hydrogen-medium@medium", fallbackProvider: "ollama:deepseek-v4.1-flash@high" },
    invokeImpl: async ({ runner, model }) => { seen.push([runner, model]); await f.broker.tool(f.job, "finish", { state: "waiting", summary: "Waiting." }).catch(() => {}); return { subtype: "success", result: "ok", num_turns: 1 }; } });
  return { f, agent, seen };
}
test("an owner task in a ticket channel runs on the ticket route; the same task elsewhere stays on the main route", async () => {
  const a = routeFixture({});
  await a.agent.run(a.f.job, new AbortController().signal).catch(() => {});
  assert.ok(a.seen.length && a.seen.every((x) => x[0] === "agy"), JSON.stringify(a.seen));
  assert.equal(a.f.job.provider.assignedBy, "ticket-route");
  const b = routeFixture({ ticket: undefined, channelId: "900", replyChannel: "900", source: { channelId: "900", channelName: "general", authorId: OWNER, content: "status?" } });
  await b.agent.run(b.f.job, new AbortController().signal).catch(() => {});
  assert.ok(b.seen.length && b.seen.every((x) => x[0] === "opencode"), JSON.stringify(b.seen));
  const c = routeFixture({ ticket: undefined, replyChannel: "app" });
  await c.agent.run(c.f.job, new AbortController().signal).catch(() => {});
  assert.ok(c.seen.length && c.seen.every((x) => x[0] === "opencode"), JSON.stringify(c.seen));
});
