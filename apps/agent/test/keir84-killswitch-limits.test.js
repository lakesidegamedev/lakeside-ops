"use strict";
// Keir 8.4: kill switch, hard caps and the owner-approval guard.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { parseKillSwitch, createKillSwitch } = require("../lib/operator/killswitch");
const limits = require("../lib/operator/limits");
const cc = require("../lib/operator/changeclass");
const { createLedger } = require("../lib/operator/store");
const { createBroker, createMcp } = require("../lib/operator/broker");

const H = 3600000;

test("kill switch file parsing: engaged, released, expiring and fail-closed", () => {
  assert.equal(parseKillSwitch(null).engaged, false);
  assert.equal(parseKillSwitch("off").engaged, false);
  assert.equal(parseKillSwitch("0").engaged, false);
  assert.deepEqual(parseKillSwitch("").engaged, true);
  assert.equal(parseKillSwitch("owner asleep\nmore").reason, "owner asleep");
  const now = Date.parse("2026-11-06T12:00:00Z");
  assert.equal(parseKillSwitch(JSON.stringify({ reason: "x", until: "2026-11-06T13:00:00Z" }), now).engaged, true);
  assert.equal(parseKillSwitch(JSON.stringify({ reason: "x", until: "2026-11-06T11:00:00Z" }), now).engaged, false);
  assert.equal(parseKillSwitch("{broken", now).engaged, true);
});

test("kill switch is read at runtime from the file and the env, and an unreadable file fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-"));
  const file = path.join(dir, "kill-switch");
  let t = 0;
  const ks = createKillSwitch({ file, env: {}, now: () => t, ttlMs: 1000 });
  assert.equal(ks.state().engaged, false);
  ks.assertClear("x");
  fs.writeFileSync(file, "stop everything");
  t += 1500;
  assert.equal(ks.state().engaged, true);
  assert.throws(() => ks.assertClear("A post"), (e) => e.code === "KILL_SWITCH" && /stop everything/.test(e.message));
  fs.unlinkSync(file); t += 1500;
  assert.equal(ks.state().engaged, false);
  assert.equal(createKillSwitch({ file, env: { KEIR_KILL_SWITCH: "1" } }).state().engaged, true);
  const unreadable = createKillSwitch({ file, env: {}, readFile: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
  assert.equal(unreadable.state().engaged, true);
  assert.equal(ks.engage({ reason: "r", by: "t" }).engaged, true);
  assert.equal(ks.release().engaged, false);
});

test("limits: defaults, env and file overrides, rolling window and idempotent counters", () => {
  assert.deepEqual(limits.resolveLimits({}), { deploysPerDay: 3, healsPerDay: 5 });
  assert.equal(limits.resolveLimits({ env: { KEIR_LIMIT_HEALS_DAY: "2" } }).healsPerDay, 2);
  assert.equal(limits.resolveLimits({ env: { KEIR_LIMIT_HEALS_DAY: "2" }, fileText: '{"healsPerDay":7}' }).healsPerDay, 7);
  assert.equal(limits.resolveLimits({ env: { KEIR_LIMIT_HEALS_DAY: "junk" } }).healsPerDay, 5);
  const d = {}, l = limits.resolveLimits({});
  assert.equal(limits.resolveLimits({ fileText: '{"playerUpdatesPerTicket24h":1}' }).playerUpdatesPerTicket24h, undefined, "the retired player cap key is ignored");
  const t0 = 1000 * H;
  for (const k of ["a", "b", "c"]) limits.recordCounter(d, "deploy", k, t0);
  assert.equal(limits.checkCounter(d, "deploy", "d", t0 + 1, l).ok, false);
  assert.equal(limits.checkCounter(d, "deploy", "a", t0 + 1, l).ok, true, "the same promotion re-read is not a new one");
  limits.recordCounter(d, "deploy", "a", t0 + 2);
  assert.equal(limits.countCounter(d, "deploy", t0 + 3), 3, "no double count");
  for (let i = 0; i < 5; i++) limits.recordCounter(d, "heal", `h${i}`, t0);
  assert.equal(limits.checkCounter(d, "heal", "h5", t0 + 1, l).ok, false);
});

test("change classes: declared gated classes, economy paths, titles and missing declarations", () => {
  assert.equal(cc.classifyChange({ declared: "balance", blastClass: "copy" }).gated, true);
  assert.equal(cc.classifyChange({ declared: "bugfix", body: "x\nChange-class: rule\n", blastClass: "logic" }).gated, true, "a gated declaration anywhere wins");
  assert.equal(cc.classifyChange({ declared: "bugfix", title: "fix: rebalance tax brackets", blastClass: "logic" }).cls, "balance");
  assert.equal(cc.classifyChange({ blastClass: "economy" }).cls, "economy-behaviour");
  assert.equal(cc.classifyChange({ declared: "economy", blastClass: "logic" }).cls, "economy-behaviour");
  assert.equal(cc.classifyChange({ blastClass: "copy" }).cls, "display");
  assert.equal(cc.classifyChange({ blastClass: "logic" }).needsDeclaration, true);
  assert.equal(cc.classifyChange({ declared: "bugfix", blastClass: "logic" }).gated, false);
  assert.throws(() => cc.assertShippable({}, { blastClass: "logic", action: "merge", ownerId: "o" }), (e) => e.code === "CHANGE_CLASS_REQUIRED");
});

test("gated changes ship only with the owner's own recorded approval", () => {
  const owner = "111";
  const base = { declared: "balance", blastClass: "logic", ownerId: owner, action: "merge", number: 77, to: "development", now: 1000 };
  assert.throws(() => cc.assertShippable({ actions: {} }, base), (e) => e.code === "OWNER_APPROVAL_REQUIRED" && e.changeClass === "balance");
  const action = (over) => ({ id: "a1", kind: "github", state: "approved", approvedBy: owner, approvedAt: 900, args: { action: "merge", number: 77, to: "development" }, ...over });
  assert.equal(cc.assertShippable({ actions: { a1: action() } }, base).approved, "a1");
  assert.equal(cc.assertShippable({ actions: { a1: action({ approvedOnBehalfBy: "999" }) } }, base).approved, "a1", "the cofounder's button on his behalf is the existing approval path");
  assert.throws(() => cc.assertShippable({ actions: { a1: action({ approvedOnBehalfBy: "999" }) } }, { ...base, inPerson: true }), (e) => e.code === "OWNER_APPROVAL_REQUIRED", "strict mode wants the owner himself");
  const set = action({ args: { action: "merge-set", prs: [{ number: 77 }, { number: 78 }] } });
  assert.equal(cc.assertShippable({ actions: { a1: set } }, base).approved, "a1", "a merge-set approval covers each PR it lists");
  assert.throws(() => cc.assertShippable({ actions: { a1: action({ args: { action: "merge", number: 78, to: "development" } }) } }, base), (e) => e.code === "OWNER_APPROVAL_REQUIRED");
  assert.throws(() => cc.assertShippable({ actions: { a1: action({ state: "pending" }) } }, base), (e) => e.code === "OWNER_APPROVAL_REQUIRED");
  assert.throws(() => cc.assertShippable({ actions: { a1: action({ approvedAt: 1 }) } }, { ...base, now: 1 + 25 * H }), (e) => e.code === "OWNER_APPROVAL_REQUIRED", "a day-old approval has lapsed");
  assert.equal(cc.assertShippable({}, { ...base, declared: "bugfix" }).gated, false);
});

function brokerSetup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir84-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000 };
  const calls = [];
  const mcp = { servers: () => ["support"], list: async () => [], call: async (...a) => { calls.push(a); return { ok: true, delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * H;
  const ksFile = path.join(dir, "kill-switch");
  const killSwitch = createKillSwitch({ file: ksFile, env: {}, now: () => clock, ttlMs: 0 });
  const lim = { get: () => limits.resolveLimits({}) };
  const broker = createBroker({ killSwitch, limits: lim, ledger, config, mcp, discord: async () => [], sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock, ...over });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: "777777777777777777", replyChannel: "777777777777777777", source: { channelId: "777777777777777777", channelName: "ticket-bug-someone-123", content: "my page is wrong", at: new Date(clock).toISOString() } });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id;
  return { ledger, broker, job, calls, killSwitch, ksFile, advance: (min) => { clock += min * 60000; }, now: () => clock };
}

test("many replies in one ticket all post: there is no per-ticket player update cap", async () => {
  const f = brokerSetup();
  const lines = ["I read your tax page and the north region rate is the line that differs.", "The second report you sent matches the first one, so I treated them as one report.", "I read your balance sheet and the interest line is the one that moved.", "Your pension statement shows the contribution posted on the earlier turn.", "The bond coupon schedule for this quarter lists the payment on the fifteenth.", "Your treasury transfer shows the amount you sent on the earlier turn.", "The election filing deadline in your state falls after the current turn."];
  for (const m of lines) { await f.broker.tool(f.job, "channel_reply", { message: m }); f.advance(11); f.job.observedPlayerAt = f.now(); f.ledger.data.ticketPosts = {}; }
  const sent = JSON.stringify(f.calls);
  for (const m of lines) assert.ok(sent.includes(m.slice(0, 40)), `posted: ${m}`);
  assert.equal(f.job.replyRefusedPending, undefined);
  assert.equal(f.ledger.data.trust?.capHits, undefined);
});

test("kill switch refuses replies and every MCP write, and finishing is allowed while it is engaged", async () => {
  const f = brokerSetup();
  fs.writeFileSync(f.ksFile, "owner is away");
  const before = f.calls.length;
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I read your quarterly figures and the second column is the one to compare." }), (e) => e.code === "KILL_SWITCH");
  assert.equal(f.calls.length, before, "nothing reached the support server");
  assert.equal(f.job.replyRefusedPending, undefined);
  fs.unlinkSync(f.ksFile);
  await f.broker.tool(f.job, "channel_reply", { message: "I read your quarterly figures and the second column is the one to compare." });
});

test("createMcp refuses a write before any network call while the gate is closed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpgate-"));
  const cfg = path.join(dir, "mcp.json");
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { support: { url: "http://127.0.0.1:9", headers: { Authorization: "Bearer x" } } } }));
  const mcp = createMcp(cfg, "tok", { gate: (what) => { throw Object.assign(new Error(`killed: ${what}`), { code: "KILL_SWITCH" }); } });
  await assert.rejects(mcp.call("support", "support_public_update", {}, true), (e) => e.code === "KILL_SWITCH" && /support_public_update/.test(e.message));
  await assert.rejects(mcp.call("support", "support_get", {}, false), (e) => e.code !== "KILL_SWITCH", "reads are never gated");
});
