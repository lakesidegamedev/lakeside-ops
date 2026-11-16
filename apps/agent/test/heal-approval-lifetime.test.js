"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { createDecisions } = require("../lib/operator/decisions");
const OWNER = "333052320252297216", DELEGATE = "565289871799746593", BOT = "1479984768194969663";
const HOUR = 3600000;
const repair = { kind: "adhoc", env: "prod", description: "Restore one approved fixture balance", collection: "characters", filter: { sequentialId: 1 }, action: { kind: "set", set: { fixture: true } }, expectedMax: 1, touchesMoney: true };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heal-consent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: OWNER, staffIds: [DELEGATE], botId: BOT, stateDir: dir, repositories: {}, scanChannels: [], supportDeferred: () => false };
  let clock = Date.now(), changed = false, plans = 0;
  const calls = [], messages = {};
  const mcp = { servers: () => [], call: async (server, name, args, write) => {
    calls.push({ name, args, write });
    if (name.endsWith("_plan")) return { token: { id: `fresh-${++plans}`, expiresAt: new Date(clock + 9 * 60000).toISOString() }, plan: { affected: changed === "count" ? 2 : 1, summary: changed === "digest" ? "Changed fixture plan" : "One fixture" }, guards: { ok: true } };
    return { ok: true };
  } };
  const discord = async (method, route, body) => {
    const id = route.split("/").pop();
    if (method === "DELETE") { messages[id].deleted = true; return {}; }
    // Keir 10.1.1: a copy nobody answered is edited to its outcome; count it as retired like a delete.
    if (method === "PATCH" && /No longer needed/.test(body?.content || "")) { messages[id].deleted = true; messages[id].edited = body.content; return {}; }
    return messages[id];
  };
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: {}, now: () => clock });
  const decisions = createDecisions({ ledger, config, discord, now: () => clock });
  const job = ledger.createJob("owner-fixture", { kind: "command", role: "owner", actorId: OWNER, repository: "AHDGame", source: { authorId: OWNER, messageId: "original-direction", content: "Investigate the fixture repair" }, deadline: clock + 48 * HOUR });
  job.state = "running";
  const send = (recipient = OWNER) => {
    const entry = Object.values(ledger.data.outbox).find((e) => e.decision && e.recipient === recipient);
    const id = `dm-${recipient}`;
    messages[id] = { author: { id: BOT }, content: entry.content };
    decisions.delivered({ ...entry, sentContent: entry.content }, "approval-channel", id);
    return id;
  };
  return { ledger, broker, decisions, job, calls, messages, send, advance: (ms) => { clock += ms; }, changePlan: (mode = "count") => { changed = mode; } };
}

test("an unread heal approval survives token expiry and remains reviewable for 24 hours", async (t) => {
  const f = fixture(t);
  const request = await f.broker.tool(f.job, "request_heal", repair);
  assert.equal(request.state, "pending", "money is never autoapproved");
  const action = f.ledger.data.actions[request.action];
  const id = f.send();
  f.advance(10 * 60000);
  await f.decisions.tick();
  assert.equal(action.state, "pending");
  assert.equal(f.messages[id].deleted, undefined);
  f.advance(3 * HOUR);
  await f.decisions.tick();
  assert.ok(Object.values(f.ledger.data.outbox).some((e) => e.recipient === DELEGATE));
  f.advance(21 * HOUR);
  await f.decisions.tick();
  assert.equal(action.state, "expired");
  assert.equal(f.messages[id].deleted, true);
});

test("approval after token expiry replans and applies using only the fresh token", async (t) => {
  const f = fixture(t);
  const request = await f.broker.tool(f.job, "request_heal", repair);
  const id = f.send();
  f.advance(2 * HOUR);
  await f.decisions.tick();
  f.messages[id].content += `\n\n**Decision:** ✅ Approved by <@${OWNER}>`;
  await f.decisions.tick();
  f.job.state = "running";
  await f.broker.tool(f.job, "execute_action", { action: request.action });
  assert.equal(f.calls.filter((c) => c.name === "heal_adhoc_plan").length, 2);
  assert.equal(f.calls.find((c) => c.name === "heal_adhoc_apply").args.token, "fresh-2");
  await assert.rejects(f.broker.tool(f.job, "execute_action", { action: request.action }), /no valid exact owner approval/);
  assert.equal(f.calls.filter((c) => c.name === "heal_adhoc_apply").length, 1);
});

for (const mode of ["count", "digest"]) test(`late approval refuses changed ${mode} and never applies it`, async (t) => {
  const f = fixture(t);
  const request = await f.broker.tool(f.job, "request_heal", repair);
  const id = f.send();
  f.advance(2 * HOUR);
  await f.decisions.tick();
  f.messages[id].content += `\n\n**Decision:** ✅ Approved by <@${OWNER}>`;
  await f.decisions.tick();
  f.job.state = "running";
  f.changePlan(mode);
  await assert.rejects(f.broker.tool(f.job, "execute_action", { action: request.action }), /target or plan changed/);
  assert.equal(f.calls.some((c) => c.name === "heal_adhoc_apply"), false);
});

for (const [verdict, decisionState, actionState] of [["❌ Rejected", "reject", "rejected"], ["💬 Explain", "explain", "pending"]]) {
  test(`late ${decisionState} remains usable and removes the approval DM`, async (t) => {
    const f = fixture(t);
    const request = await f.broker.tool(f.job, "request_heal", repair);
    const id = f.send();
    f.advance(2 * HOUR);
    await f.decisions.tick();
    f.messages[id].content += `\n\n**Decision:** ${verdict} by <@${OWNER}>: Review this repair`;
    await f.decisions.tick();
    assert.equal(Object.values(f.ledger.data.decisions)[0].state, decisionState);
    assert.equal(f.ledger.data.actions[request.action].state, actionState);
    assert.equal(f.messages[id].deleted, true);
    assert.equal(f.calls.some((c) => c.write), false);
  });
}

test("cancelled work withdraws its long-lived approval and deletes the DM", async (t) => {
  const f = fixture(t);
  const request = await f.broker.tool(f.job, "request_heal", repair);
  const id = f.send();
  f.advance(2 * HOUR);
  f.job.state = "cancelled";
  await f.decisions.tick();
  assert.equal(f.ledger.data.actions[request.action].state, "withdrawn");
  assert.equal(f.messages[id].deleted, true);
  assert.equal(f.calls.some((c) => c.write), false);
});

test("Ariane can approve after normal escalation while the token is expired", async (t) => {
  const f = fixture(t);
  const request = await f.broker.tool(f.job, "request_heal", repair);
  const ownerDm = f.send();
  f.advance(3 * HOUR + 60000);
  await f.decisions.tick();
  const delegateDm = f.send(DELEGATE);
  f.messages[delegateDm].content += `\n\n**Decision:** ✅ Approved by <@${DELEGATE}>`;
  await f.decisions.tick();
  const action = f.ledger.data.actions[request.action];
  assert.equal(action.approvedOnBehalfBy, DELEGATE);
  assert.equal(f.messages[ownerDm].deleted, true);
  assert.equal(f.messages[delegateDm].deleted, true);
  f.job.state = "running";
  await f.broker.tool(f.job, "execute_action", { action: action.id });
  assert.equal(f.calls.find((c) => c.name === "heal_adhoc_apply").args.token, "fresh-2");
});

test("free-form exact refund wording does not create unbounded money autoapproval", async (t) => {
  const f = fixture(t);
  f.job.source.content = "Refund exactly 50000 USD to the fixture character and undo five action points.";
  const request = await f.broker.tool(f.job, "request_heal", repair);
  assert.equal(request.state, "pending");
  assert.equal(f.calls.some((c) => c.write), false);
});
