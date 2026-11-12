"use strict";
// Keir 9: the 8.4 milestone deadlock. Two rules contradicted each other; neither may block the other.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const policy = require("../lib/operator/replypolicy");

const CH = "777777777777777777";
const STAFF = "222222222222222222";
const ticketDiscord = async (_method, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-123" }] : []);
const CAUSAL = "Your revenue fell because the California plants were mothballed at turn 675.";
function setup({ answerGate = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir9-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: [STAFF], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, developerNames: { [STAFF]: "Dev" }, answerGate };
  const calls = [];
  const mcp = { servers: () => ["support", "ops-knowledge"], list: async () => ["support_public_update", "support_resolve"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })), call: async (...a) => { calls.push(a); return { ok: true, id: "card-9", delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord: ticketDiscord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-123", content: "Why did my revenue fall after turn 670?" }, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id; ledger.data.disclosed = { 123: { at: 1, posted: true } };
  const advance = (min) => { clock += min * 60000; };
  const posts = () => calls.filter((c) => c[1] === "support_public_update" && c[2].deliver === true).map((c) => c[2].message);
  const audits = (kind) => (ledger.data.audit || []).filter((a) => a.kind === kind);
  // Hold the draft, then finish the checker with a report and let the parent be woken.
  async function hold(message = CAUSAL) {
    const r = await broker.tool(job, "channel_reply", { message });
    return r;
  }
  const checker = () => Object.values(ledger.data.jobs).find((j) => j.challenge);
  async function report(summary, state = "done") {
    const child = checker(); child.state = state; child.summary = summary; job.state = "waiting";
    broker.codingComplete(child);
    for (let i = 0; i < 400 && !job.inbox?.some((m) => m.answerCheck || m.investigationResult); i++) await new Promise((r) => setTimeout(r, 5));
    return child;
  }
  return { ledger, config, broker, job, calls, advance, now: () => clock, posts, audits, hold, checker, report };
}

test("milestoneRefusal: a human message since Keir's last post, or an approved action run since, is news", () => {
  const base = { message: "I have your note and am continuing with the plant records.", lastPost: { at: 1 } };
  assert.match(policy.milestoneRefusal(base), /real milestone/);
  assert.equal(policy.milestoneRefusal({ ...base, humanSpokeAfter: true }), null);
  assert.equal(policy.milestoneRefusal({ ...base, approvedActionSince: true }), null);
});

test("deadlock: an owner or developer speaking in the ticket lets Keir reply without a new player message", async () => {
  const f = setup({ answerGate: false });
  await f.broker.tool(f.job, "channel_reply", { message: "I am looking at your plant records." });
  f.advance(15);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I am still going over the plant records for you." }), /real milestone/);
  f.ledger.data.channelContext = { [CH]: [{ id: "m2", authorId: STAFF, role: "support", content: "Keir, what did you find?", at: new Date(f.now()).toISOString(), observedAt: f.now() }] };
  f.advance(1);
  await f.broker.tool(f.job, "channel_reply", { message: "I am still going over the plant records for you." });
  assert.equal(f.posts().length, 2);
});

test("deadlock: after an owner-approved repair ran, the update is not refused for lack of a new read", async () => {
  const f = setup({ answerGate: false });
  await f.broker.tool(f.job, "channel_reply", { message: "I am looking at your plant records." });
  f.advance(15);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "The repair step ran on your account a minute ago." }), /real milestone/);
  f.ledger.data.actions = { a1: { id: "a1", jobId: f.job.id, kind: "heal", state: "done", executedAt: f.now() + 1 } };
  f.advance(1);
  await f.broker.tool(f.job, "channel_reply", { message: "The repair step ran on your account a minute ago." });
  assert.equal(f.posts().length, 2);
});

test("the update-spam refusal does not block finishing: the player already has Keir's last message", async () => {
  const f = setup();
  const first = "I am reading your sector history now and will tell you what I find?";
  await f.broker.tool(f.job, "channel_reply", { message: first });
  f.advance(45);
  await assert.rejects(() => f.broker.tool(f.job, "channel_reply", { message: "Still looking at the sector history for you." }), /Not posted/);
  assert.ok(!f.job.replyRefusedPending);
});
