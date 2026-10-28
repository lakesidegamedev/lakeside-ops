"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const authority = require("../lib/operator/authority");
const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function fixture(kind = "finding") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-authority-")); dirs.push(dir);
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "owner", staffIds: ["delegate", "staff"], stateDir: dir, repositories: {}, scanChannels: [], supportDeferred: () => false };
  const calls = [];
  const mcp = { servers: () => [], list: async () => [{ name: "heal_detect" }, { name: "heal_apply" }], call: async (server, tool, args, write) => {
    calls.push({ server, tool, args, write });
    if (/plan$/.test(tool)) return { token: "token", plan: { affected: 1, summary: "Repair a fixture" }, guards: { ok: true } };
    return { ok: true };
  } };
  const broker = createBroker({ ledger, config, mcp, discord: async () => { throw new Error("unexpected Discord"); }, sandbox: {}, now: () => 5000 });
  const job = ledger.createJob("fixture", { kind, role: "support", ticket: kind === "ticket" ? 1522 : undefined, repository: "AHDGame", source: {}, deadline: 9e15 }); job.state = "running";
  return { ledger, broker, job, calls, config, mcp };
}
const repair = { kind: "adhoc", env: "prod", description: "Repair duplicate fixture flag", collection: "characters", filter: { sequentialId: 1 }, action: { kind: "set", set: { fixture: true } }, expectedMax: 1 };
test("finding evidence reads have a narrow sensor allowlist", async () => {
  const f = fixture();
  await f.broker.tool(f.job, "read_tool", { server: "heal-ops", tool: "heal_detect", args: { defectId: "fixture", env: "prod" } });
  await f.broker.tool(f.job, "read_tool", { server: "gamestate", tool: "invariant_check", args: {} });
  await f.broker.tool(f.job, "read_tool", { server: "turndiag", tool: "turn_anomalies", args: {} });
  await assert.rejects(f.broker.tool(f.job, "read_tool", { server: "heal-ops", tool: "heal_apply", args: {} }), /outside support scope|read_tool is read-only/);
  await assert.rejects(f.broker.tool(f.job, "read_tool", { server: "gamestate", tool: "trace_character", args: { character: "other" } }), /outside support scope/);
  assert.ok(f.calls.every((c) => c.write === false));
});
test("finding forbidden writes reject before a pending action or Discord request exists", async () => {
  const f = fixture();
  await assert.rejects(f.broker.tool(f.job, "request_action", { kind: "mcp_write", args: { server: "x", tool: "write", args: {} }, reason: "fixture" }), /findings prepare heals/);
  assert.equal(Object.keys(f.ledger.data.actions).length, 0);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Hello" }), /never post/);
  await assert.rejects(f.broker.tool(f.job, "execute_action", { action: "approved-heal" }), /never post/);
});
test("genuine ticket authority carries a small exact heal through apply", async () => {
  const f = fixture("ticket");
  authority.grant(f.ledger.data, f.config, 1522, { by: "delegate", how: "directed", at: 4000 });
  const proposed = await f.broker.tool(f.job, "request_heal", repair);
  assert.equal(proposed.state, "approved");
  assert.match(proposed.instruction, /execute_action/);
  await f.broker.tool(f.job, "execute_action", { action: proposed.action });
  assert.ok(f.calls.some((c) => c.tool === "heal_adhoc_apply" && c.write));
});
test("automatic tickets cannot authorize huge heals or invent a grant", async () => {
  const f = fixture("ticket");
  f.ledger.data.ticketAuthority = { 1522: { by: "staff", at: 4000 } };
  await assert.rejects(f.broker.tool(f.job, "request_heal", repair), /genuine ticket authority/);
  authority.grant(f.ledger.data, f.config, 1522, { by: "owner", how: "directed", at: 4000 });
  await assert.rejects(f.broker.tool(f.job, "request_heal", { ...repair, touchesMoney: true }), /huge heals/);
  assert.equal(Object.keys(f.ledger.data.actions).length, 0);
});
test("questions, negation and retrospective messages grant no work authority", () => {
  for (const text of ["Keir, don't fix ticket #1522 yet", "Keir, do not ship ticket #1522", "Keir, why did you deploy ticket #1522?", "Have you already fixed it?"]) assert.equal(authority.isDirection(text), false, text);
  assert.equal(authority.isDirection("Keir, fix ticket #1522"), true);
});

test("ordinary staff cannot mint a carried approval and quoted directions are not consent", () => {
  const f = fixture();
  assert.equal(authority.grant(f.ledger.data, f.config, 1522, { by: "staff", how: "approved", at: 4000 }), null);
  assert.equal(authority.isDirection('Keir, the player said "fix ticket #1522"'), false);
  assert.equal(authority.isDirection("Keir, shouldn't you fix ticket #1522"), false);
});

test("developer ticket commands cannot autoapprove unknown native ledger money or broad repairs", async () => {
  for (const native of [{ detector: null, affected: 1 }, { detector: { id: "fixture", mintsMoney: true }, affected: 1 }, { detector: { id: "fixture", mintsMoney: false }, affected: 26 }]) {
    const f = fixture("command");
    Object.assign(f.job, { actorId: "delegate", ticket: 1522, source: { authorId: "delegate" } });
    authority.grant(f.ledger.data, f.config, 1522, { by: "delegate", how: "directed", at: 4000 });
    const original = f.calls;
    // The broker closes over the mutable MCP object returned by the fixture.
    f.mcp.call = async (server, tool, args, write) => {
      original.push({ server, tool, args, write });
      if (tool === "heal_list") return { defects: native.detector ? [native.detector] : [] };
      if (tool === "heal_plan") return { token: "fixture", plan: { affected: native.affected }, guards: { ok: true } };
      return {};
    };
    const proposed = await f.broker.tool(f.job, "request_heal", { kind: "ledger", env: "prod", defectId: "fixture" });
    assert.equal(proposed.state, "pending");
    const action = f.ledger.data.actions[proposed.action];
    assert.equal(authority.hugeHeal(action.args.risk), true);
    assert.deepEqual(action.args.spec, { kind: "ledger", env: "prod", defectId: "fixture" });
    assert.deepEqual(f.calls.find((c) => c.tool === "heal_plan").args, { env: "prod", defectId: "fixture", operator: "Discord developer delegate via Keir" });
  }
});

test("finding merge authority does not extend to another task's PR", async () => {
  const f = fixture();
  f.job.pullRequests = ["https://github.com/Egg3901/AHDGame/pull/10"];
  await assert.rejects(f.broker.tool(f.job, "github", { action: "merge", number: 11 }), /own exact PR/);
});

test("logic and equity paths cannot use the small-change authority carry", () => {
  for (const file of ["src/lib/equities/pool.ts", "src/lib/unknown/module.ts", "src/app/api/actions/route.ts"]) assert.equal(authority.hugeCode([file]).huge, true, file);
});

test("a finding prepares a manual repair artifact without an unusable approval button", async () => {
  const f = fixture();
  const out = await f.broker.tool(f.job, "request_heal", repair);
  assert.equal(out.state, "prepared");
  assert.equal(Object.keys(f.ledger.data.decisions || {}).length, 0);
  const dm = Object.values(f.ledger.data.outbox)[0];
  assert.equal(dm.destination, "owner");
  assert.match(dm.content, /cannot apply/);
  assert.doesNotMatch(dm.content, /test-token/);
  await assert.rejects(f.broker.tool(f.job, "execute_action", { action: out.action }), /never post.*execute/);
});
