"use strict";
// Owner, 2026-11-01: "It should allow it if I approve it." Tickets 1730 and
// 1742 asked the owner to approve the same payment three times each, because
// a ticket task could neither put a large payment in front of him nor run it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { createDecisions } = require("../lib/operator/decisions");
const OWNER = "333052320252297216", DELEGATE = "565289871799746593", BOT = "1479984768194969663", PLAYER = "888888888888888888";
const HOUR = 3600000;
const payment = { kind: "compensation", env: "prod", description: "Pay Oracle the approved $26,723 for three cancelled deals", credits: [{ corporationId: "6ae3246e5a095b0d9e2bb254", amountLocal: 26723, basis: "owner chose gross" }], expectedMax: 26723, ticket: "1742" };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-heal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: OWNER, staffIds: [DELEGATE], botId: BOT, stateDir: dir, repositories: {}, scanChannels: [], supportDeferred: () => false };
  let clock = Date.now(), plans = 0;
  const calls = [], messages = {};
  const mcp = { servers: () => [], call: async (server, name, args, write) => {
    calls.push({ name, args, write });
    if (name.endsWith("_plan")) return { token: { id: `fresh-${++plans}`, expiresAt: new Date(clock + 9 * 60000).toISOString() }, plan: { affected: 1, moneyDelta: 25519.72, summary: "Credit Oracle" }, guards: { ok: true } };
    return { ok: true };
  } };
  const discord = async (method, route) => {
    const id = route.split("/").pop();
    if (method === "DELETE") { if (messages[id]) messages[id].deleted = true; return {}; }
    return messages[id];
  };
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: {}, now: () => clock });
  const decisions = createDecisions({ ledger, config, discord, now: () => clock });
  const job = ledger.createJob("ticket:1742", { kind: "ticket", role: "support", ticket: 1742, actorId: PLAYER, source: { authorId: PLAYER, content: "My deals were cancelled", messageId: "player-1" }, deadline: clock + 48 * HOUR });
  job.state = "running";
  const send = (recipient = OWNER) => {
    const entry = Object.values(ledger.data.outbox).find((e) => e.decision && e.recipient === recipient);
    const id = `dm-${recipient}`;
    messages[id] = { author: { id: BOT }, content: entry.content };
    decisions.delivered({ ...entry, sentContent: entry.content }, "approval-channel", id);
    return id;
  };
  const answer = async (id, by = OWNER, verdict = "Approved") => { messages[id].content += `\n\n**Decision:** ${verdict === "Approved" ? "✅" : "❌"} ${verdict} by <@${by}>`; await decisions.tick(); };
  return { ledger, broker, decisions, job, calls, send, answer, advance: (ms) => { clock += ms; } };
}

test("a ticket task can put a large payment in front of the owner, and his approval lets it run", async (t) => {
  const f = fixture(t);
  const request = await f.broker.tool(f.job, "request_heal", payment);
  assert.equal(request.state, "pending", "money is never auto-approved");
  const action = f.ledger.data.actions[request.action];
  assert.ok(Object.values(f.ledger.data.decisions).some((x) => x.actionId === action.id), "the exact approval card goes to the owner");
  assert.ok(!Object.values(f.ledger.data.outbox).some((e) => e.recipient === PLAYER), "the reporter is never asked to approve a repair");
  await f.answer(f.send());
  assert.equal(action.state, "approved");
  assert.equal(action.exactApproval.by, OWNER);
  f.job.state = "running";
  await f.broker.tool(f.job, "execute_action", { action: action.id });
  assert.ok(f.calls.some((c) => c.name === "heal_compensate_apply"), "the approved payment is applied");
});

test("Ariane's approval on the owner's behalf also lets the ticket task run it", async (t) => {
  const f = fixture(t);
  const request = await f.broker.tool(f.job, "request_heal", payment);
  f.send();
  f.advance(3 * HOUR + 60000);
  await f.decisions.tick();
  await f.answer(f.send(DELEGATE), DELEGATE);
  const action = f.ledger.data.actions[request.action];
  assert.equal(action.approvedOnBehalfBy, DELEGATE);
  f.job.state = "running";
  await f.broker.tool(f.job, "execute_action", { action: action.id });
  assert.ok(f.calls.some((c) => c.name === "heal_compensate_apply"));
});

test("without the exact approval a ticket task still cannot run a large payment", async (t) => {
  const f = fixture(t);
  const request = await f.broker.tool(f.job, "request_heal", payment);
  const action = f.ledger.data.actions[request.action];
  await assert.rejects(f.broker.tool(f.job, "execute_action", { action: action.id }), /no valid exact owner approval/);
  // An approval recorded some other way (not on this action's own card) is not enough.
  Object.assign(action, { state: "approved", approvedBy: OWNER, approvedAt: Date.now() });
  await assert.rejects(f.broker.tool(f.job, "execute_action", { action: action.id }), /developer provenance or ticket authority/);
  assert.ok(!f.calls.some((c) => c.name === "heal_compensate_apply"));
});

test("a rejected payment card does not run", async (t) => {
  const f = fixture(t);
  const request = await f.broker.tool(f.job, "request_heal", payment);
  await f.answer(f.send(), OWNER, "Rejected");
  const action = f.ledger.data.actions[request.action];
  assert.notEqual(action.state, "approved");
  await assert.rejects(f.broker.tool(f.job, "execute_action", { action: action.id }));
});

test("once the owner has answered a payment question, asking it again in other words is refused", async (t) => {
  const f = fixture(t);
  const now = Date.now();
  (f.ledger.data.decisions ||= {}).prior = { id: "prior", jobId: f.job.id, state: "selected", at: now - HOUR, answeredAt: now - HOUR + 60000, answeredBy: OWNER,
    selectedOption: { id: "1", label: "Credit $26,723 gross", detail: "Refunds everything Oracle paid" } };
  const { answeredPayment } = require("../lib/operator/decisionpolicy");
  for (const q of ["Oracle credit: who executes the already-approved $26,723?", "Confirm the exact payment of $26,723 to Oracle", "Run the approved credit now as owner?"])
    assert.equal(answeredPayment(f.ledger.data, f.job, q, now)?.id, "prior", q);
  assert.equal(answeredPayment(f.ledger.data, f.job, "How should freight be shared between states?", now), null);
  assert.equal(answeredPayment(f.ledger.data, { id: "other" }, "who executes the approved $26,723 credit?", now), null);
  assert.equal(answeredPayment(f.ledger.data, f.job, "who executes the approved $26,723 credit?", now + 72 * HOUR), null, "two days later it may ask");
});
