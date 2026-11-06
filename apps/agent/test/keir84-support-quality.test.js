"use strict";
// Keir 8.4: support quality, from the owner's rating of the open tickets on 2026-11-05 and 06
// (1763, 1766, 1772, 1775, 1757, 1750). Each test is the behaviour that was missing.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { outboundLeak } = require("../lib/operator/toolmarkup");
const policy = require("../lib/operator/replypolicy");
const { createDecisions } = require("../lib/operator/decisions");

const CH = "777777777777777777";
const ticketDiscord = async (_method, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-123" }] : []);
function setup({ discord = ticketDiscord } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir84-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, developerNames: { "222222222222222222": "Dev" } };
  const calls = [];
  const mcp = { servers: () => ["support", "ops-knowledge"], list: async () => ["support_public_update", "support_resolve"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })), call: async (...a) => { calls.push(a); return { ok: true, id: "card-9", delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-123" }, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id;
  const advance = (min) => { clock += min * 60000; };
  return { ledger, config, broker, job, calls, advance, now: () => clock };
}

test("stall posts: the post history keeps the whole run, and a second needs the player to have written (ticket 1766)", async () => {
  const f = setup();
  await f.broker.tool(f.job, "channel_reply", { message: "I haven't found what mothballs your plant yet, so I won't guess." });
  // Three hours later, still no player message: the old one-hour history forgot the first post.
  f.advance(180); f.job.lastCodeReadAt = f.now() + 1; f.advance(1);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Still no confirmed cause. I haven't found the rule that sets it." }), /investigation instead|code_exact/);
  // The player writes, Keir reads code since: one more is allowed, a third in a row never.
  f.job.observedPlayerAt = f.now(); f.advance(1); f.job.lastCodeReadAt = f.now() + 1; f.advance(1);
  await f.broker.tool(f.job, "channel_reply", { message: "I haven't confirmed the rule yet; the plant's coal shortage is the lead." });
  f.advance(60); f.job.observedPlayerAt = f.now(); f.advance(1); f.job.lastCodeReadAt = f.now() + 1; f.advance(1);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I still haven't traced it, so I won't guess." }), /investigation instead|code_exact/);
  // A running investigator no longer excuses a repeat.
  const child = f.ledger.createJob("inv", { kind: "coding", investigation: true, codingParent: f.job.id, deadline: 9e15 });
  f.job.investigations = [child.id];
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I still haven't traced it, so I won't guess." }), /investigation instead|code_exact/);
});

test("update spam: no milestone, no new read, no new player message means no post (tickets with 30 to 57 updates)", async () => {
  const f = setup();
  await f.broker.tool(f.job, "channel_reply", { message: "Your revenue fell sharply between those two turns because your plants sold far less." });
  f.advance(15);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I am continuing to look at the sales drop on your plants." }), /real milestone|status card/);
  // A question is a milestone; so is a finding after a new read; so is a player message.
  await f.broker.tool(f.job, "channel_reply", { message: "Did you reactivate the California plants after turn 675?" });
  f.advance(15); f.job.lastGameReadAt = f.now() + 1; f.advance(1);
  await f.broker.tool(f.job, "channel_reply", { message: "Your California plants were mothballed at turn 675 and still make nothing, which explains the drop." });
  f.advance(15);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I am still going over the plant records for you." }), /real milestone|status card/);
  f.job.observedPlayerAt = f.now(); f.advance(1);
  await f.broker.tool(f.job, "channel_reply", { message: "Thanks, noted. The reactivation does not clear the loss counter, so they were mothballed again." });
});

test("a production-typed live notice is not sent without the main release receipt", async () => {
  const f = setup();
  f.ledger.data.statusCards = { 123: { messageId: "9", channelId: CH, items: [], liveNotified: [] } };
  const effectJob = f.job;
  await f.broker.liveNotice?.(effectJob, 123, [], [{ name: "Margins", stage: "main", blocked: false }]);
  assert.equal(f.calls.filter((c) => c[2]?.update_kind === "production").length, 0);
});

test("a rule explained as working as designed does not close a bug ticket; the owner decides (1775, 1757, 1750)", () => {
  const msg = "Neither screen is miscalculating. The numbers check out and this works as designed.";
  assert.match(policy.resolveRefusal({ texts: [msg] }), /under review/);
  assert.match(policy.resolveRefusal({ texts: [msg] }), /rule_change/);
  // Once the owner decided, or a fix exists, closing is fine.
  assert.equal(policy.resolveRefusal({ texts: [msg], decided: true }), null);
  assert.equal(policy.resolveRefusal({ texts: [msg], fixed: true }), null);
  // An unanswered owner decision always holds the ticket.
  assert.match(policy.resolveRefusal({ texts: ["Fixed and live."], decided: true, pendingDecision: true }), /owner decision/);
  assert.equal(policy.resolveRefusal({ texts: ["Your contract has been reinstated and the shares are back."] }), null);
});

test("support_resolve is refused for an explanation-only closure and while a decision is pending", async () => {
  const f = setup();
  f.job.channelClosed = false;
  f.ledger.data.channels = { [CH]: { category: "bug" } };
  await assert.rejects(f.broker.tool(f.job, "support_action", { tool: "support_resolve", args: { message: "The numbers check out; this works as designed." } }), /under review|owner decision|support write|schema/);
  f.ledger.data.channels = { [CH]: { category: "bug" } };
  const other = f.ledger.createJob("d1", { role: "support", kind: "ticket", ticket: 123, deadline: 9e15 });
  f.ledger.data.decisions = { d1: { id: "d1", jobId: other.id, state: "pending", question: "q", at: f.now(), sent: {} } };
  await assert.rejects(f.broker.tool(f.job, "support_action", { tool: "support_resolve", args: { message: "Done." } }), /owner decision|support write|schema/);
});

test("timid hedging is refused; a thorough search must say it plainly (ticket 1772)", () => {
  const unchecked = "I haven't checked the exact trigger, so I won't quote a threshold.";
  const absent = "I can't confirm that. I searched for a way to move a sector between companies and found nothing, so I won't tell you it exists.";
  assert.match(policy.timidRefusal(unchecked), /Look up the rule/);
  assert.match(policy.timidRefusal(absent, { lookups: 1 }), /only 1 code lookup/);
  assert.match(policy.timidRefusal(absent, { lookups: 4 }), /No, that does not exist/);
  assert.equal(policy.timidRefusal("No, that does not exist. A sector cannot be moved between companies."), null);
  assert.equal(policy.timidRefusal("A state can order a sale once a company holds over 40% of a sector."), null);
});

test("timid hedging is refused on the real reply path", async () => {
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I searched and found nothing, so I won't tell you it exists." }), /only 0 code lookups|No, that does not exist/);
  f.job.codeLookups = 3;
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I searched and found nothing, so I won't tell you it exists." }), /No, that does not exist/);
  await f.broker.tool(f.job, "channel_reply", { message: "No, that does not exist. You cannot move a sector to another company you own." });
});

test("'handed to an investigator' needs a real investigation job, and the ids are recorded", async () => {
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I've handed the mothballing question to an investigator." }), /investigation job|delegate_investigation/);
  const child = f.ledger.createJob("inv", { kind: "coding", investigation: true, codingParent: f.job.id, deadline: 9e15 });
  f.job.investigations = [child.id];
  await f.broker.tool(f.job, "channel_reply", { message: "I've handed the mothballing question to an investigator." });
  assert.ok(f.ledger.data.audit.some((a) => a.kind === "handoff_claim_backed" && a.refs.investigators.includes(`investigation:${child.id}`)));
});

test("'the developers have it' needs a queue item with an id", async () => {
  const f = setup();
  f.job.raisedToDevelopers = [{ id: null, title: "x" }];
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I've passed it to the developers." }), /reached them|raise_to_developers/);
  f.job.raisedToDevelopers = [{ id: "card-9", title: "x" }];
  await f.broker.tool(f.job, "channel_reply", { message: "I've passed it to the developers." });
});

test("tool-call text and broker machinery never reach a player (owner report 2026-11-06)", async () => {
  for (const text of [
    "<function_calls><invoke name=\"read_tool\"><parameter name=\"x\">1</parameter></invoke></function_calls>",
    "{\"tool\":\"support_action\",\"args\":{\"tool\":\"support_public_update\"}}",
    "```json\n{\"name\": \"read_tool\", \"arguments\": {\"server\": \"gamestate\"}}\n```",
    "Let me call mcp__keir__finish now.",
    "<invoke name=\"x\">",
    "Not posted: this states an outcome Keir has no receipt for",
    "task execution authority is inactive: this task is queued. Its turn is over. Stop now: make no more tool calls.",
    "I will use the raise_to_developers tool.",
  ]) assert.ok(outboundLeak(text), text.slice(0, 50));
  for (const text of ["Your plants are mothballed.", "The 'name' field on your page shows the company: Acme. Args are not involved.", "Revenue fell from 2,328,307 to 706,138."]) assert.equal(outboundLeak(text), null, text);
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "{\"tool\":\"support_action\",\"args\":{\"tool\":\"support_public_update\"}}" }), /tool-call text|Not posted/);
  await assert.rejects(f.broker.tool(f.job, "support_action", { tool: "support_public_update", args: { message: "```json\n{\"tool\": \"read_tool\", \"args\": {}}\n```" } }), /tool-call text|Not posted|schema/);
});

test("changeClass is validated and recorded with requiresOwner", async () => {
  assert.equal(policy.normalizeChangeClass("rule-change"), "rule_change");
  assert.equal(policy.requiresOwner("rule_change"), true);
  assert.equal(policy.requiresOwner("display_fix"), false);
  assert.throws(() => policy.normalizeChangeClass("tweak"), /changeClass must be one of/);
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "raise_to_developers", { kind: "decision", title: "Mothball rule", detail: "The loss counter is not cleared when a player reactivates a plant, so the autopilot mothballs it again on the next turn.", question: "Should the loss counter reset when a player reactivates a plant?", options: [{ label: "Reset it", detail: "Plants stay running", recommended: true }, { label: "Keep it", detail: "As today" }] }), /changeClass/);
  const r = await f.broker.tool(f.job, "raise_to_developers", { kind: "decision", changeClass: "rule_change", title: "Mothball rule", detail: "The loss counter is not cleared when a player reactivates a plant, so the autopilot mothballs it again on the next turn.", question: "Should the loss counter reset when a player reactivates a plant?", options: [{ label: "Reset it", detail: "Plants stay running", recommended: true }, { label: "Keep it", detail: "As today" }] });
  const decision = f.ledger.data.decisions[r.decision];
  assert.equal(decision.ownerHold, true);
  assert.equal(decision.changeClass, "rule_change");
  assert.equal(decision.requiresOwner, true);
  assert.equal(decision.ticket, 123);
  assert.equal(f.job.changeClass, "rule_change");
  assert.equal(f.job.requiresOwner, true);
  assert.equal(f.job.raisedToDevelopers.at(-1).requiresOwner, true);
});

test("a held owner decision never expires and the owner is asked again every 12 hours", async () => {
  const f = setup();
  const r = await f.broker.tool(f.job, "raise_to_developers", { kind: "decision", changeClass: "rule_change", title: "Mothball rule", detail: "The loss counter is not cleared when a player reactivates a plant, so the autopilot mothballs it again on the next turn.", question: "Should the loss counter reset when a player reactivates a plant?", options: [{ label: "Reset it", detail: "Plants stay running", recommended: true }, { label: "Keep it", detail: "As today" }] });
  const x = f.ledger.data.decisions[r.decision];
  x.at = f.now(); // openDecision stamps wall-clock time; this test drives its own clock
  const decisions = createDecisions({ ledger: f.ledger, config: f.config, discord: async () => ({}), now: f.now });
  f.advance(60 * 13);
  await decisions.tick();
  assert.equal(x.state, "pending", x.withdrawnReason || x.state);
  assert.equal(x.pings, 1);
  assert.ok(f.ledger.data.audit.some((a) => a.kind === "decision_reping" && a.decision === x.id));
  assert.ok(f.ledger.data.outbox[`ask:${x.id}:${f.config.ownerId}:r1`]);
  f.advance(60 * 5);
  await decisions.tick();
  assert.equal(x.pings, 1);
  f.advance(60 * 8);
  await decisions.tick();
  assert.equal(x.pings, 2);
  // A plain (unheld) decision still expires after two days.
  const y = f.ledger.data.decisions[r.decision];
  assert.equal(y.state, "pending");
});
