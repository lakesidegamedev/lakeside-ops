"use strict";
// Keir 8: failures that provably wrote nothing are definite, not uncertain.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker, createMcp } = require("../lib/operator/broker");

const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
process.env.KEIR_DEPLOYED_SHA_CMD = "/fixture/probe.sh";
const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-definite-")); dirs.push(dir);
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  return { dir, ledger, config };
};

// Probe P3 of the effects audit, now a test.
function publishFixture(failOn) {
  const { ledger, config, dir } = mk(); config.repositories = { AHDGame: dir };
  const git = [];
  const exec = async (cmd, args) => {
    if (cmd === "/usr/bin/git") { git.push(args.filter((x) => !x.startsWith("-")).slice(1, 3).join(" ")); if (failOn && args.includes(failOn.step) && failOn.times-- > 0) throw Object.assign(new Error(failOn.message), { code: 128 }); }
    if (cmd === "/usr/bin/gh") return "https://github.com/lakesidegamedev/AHDGame/pull/9\n";
    return ""; };
  const diff = "diff --git a/src/components/Shop.tsx b/src/components/Shop.tsx\n--- a/src/components/Shop.tsx\n+++ b/src/components/Shop.tsx\n+const x = 1;\n";
  const sandbox = { run: async (id, command) => ({ code: 0, output: /diff --no-ext-diff/.test(command) ? diff : "" }), deps: () => null };
  const broker = createBroker({ ledger, config, mcp: { servers: () => [], list: async () => [], call: async () => ({}) }, discord: async () => [], sandbox, now: () => 5000, exec });
  const job = ledger.createJob("t", { role: "owner", kind: "command", repository: "AHDGame", source: {}, deadline: 9e15 }); job.state = "running";
  return { broker, job, git, ledger };
}

for (const step of ["fetch", "worktree", "commit"]) {
  test(`publish_patch: a ${step} failure before the first push is a definite failure, the task keeps running and the call can repeat`, async () => {
    const f = publishFixture({ step, message: `${step} failed`, times: 1 });
    await assert.rejects(f.broker.tool(f.job, "publish_patch", { title: "fix(shop): show the header", body: "Fix." }), new RegExp(`${step} failed`));
    const [key, receipt] = Object.entries(f.job.effects)[0];
    assert.equal(receipt.state, "rejected"); assert.equal(receipt.retryable, true);
    assert.equal(f.job.state, "running", "no block for a person");
    assert.ok(f.git.some((g) => /^worktree remove/.test(g)), "the half-made worktree is removed");
    assert.ok(f.ledger.data.audit.some((r) => r.kind === "effect_rejected" && r.key === key), "the decision leaves an audit row");
    // A later publish in the same process goes through (each publish is its own action).
    const again = await f.broker.tool(f.job, "publish_patch", { title: "fix(shop): show the header", body: "Fix." });
    assert.match(JSON.stringify(again), /pull\/9/);
    assert.ok(Object.values(f.job.effects).some((e) => e.state === "done"));
  });
}

test("publish_patch: a failure AFTER the push stays uncertain and blocks", async () => {
  const { ledger, config, dir } = mk(); config.repositories = { AHDGame: dir };
  const exec = async (cmd, args) => { if (cmd === "/usr/bin/gh") throw new Error("gh: HTTP 502"); return ""; };
  const diff = "diff --git a/src/components/Shop.tsx b/src/components/Shop.tsx\n--- a/src/components/Shop.tsx\n+++ b/src/components/Shop.tsx\n+const x = 1;\n";
  const sandbox = { run: async (id, command) => ({ code: 0, output: /diff --no-ext-diff/.test(command) ? diff : "" }), deps: () => null };
  const broker = createBroker({ ledger, config, mcp: { servers: () => [], list: async () => [], call: async () => ({}) }, discord: async () => [], sandbox, now: () => 5000, exec });
  const job = ledger.createJob("t", { role: "owner", kind: "command", repository: "AHDGame", source: {}, deadline: 9e15 }); job.state = "running";
  await assert.rejects(broker.tool(job, "publish_patch", { title: "fix(shop): show the header", body: "Fix." }), /502/);
  assert.equal(job.state, "blocked"); assert.equal(Object.values(job.effects)[0].state, "started");
});

function mcpWith(url) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keir-mcp-")), "mcp.json"); dirs.push(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { support: { url, headers: { Authorization: "Bearer t" } } } }));
  return createMcp(file, "r");
}
test("MCP transport: connection refused is classed definite; a timeout or an HTTP error is not", async () => {
  const net = require("node:net"), probe = net.createServer(); await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const mcp = mcpWith(`http://127.0.0.1:${port}/mcp`);
  await assert.rejects(mcp.call("support", "support_public_update", {}, true), (e) => e.code === "MCP_CONNECT_REFUSED");
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }); };
    await assert.rejects(mcp.call("support", "x", {}, true), (e) => e.code === "MCP_CONNECT_REFUSED");
    globalThis.fetch = async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); };
    await assert.rejects(mcp.call("support", "x", {}, true), (e) => e.code === undefined);
    globalThis.fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }); };
    await assert.rejects(mcp.call("support", "x", {}, true), (e) => e.code === undefined, "a reset mid-request may have been processed");
  } finally { globalThis.fetch = real; }
});

// Probe P5 of the effects audit, now a test: the status card's message id is saved with its receipt.
test("status card: the posted card is recorded in the same save that closes the receipt, so a lost final save does not post a second card", async () => {
  const { ledger, config } = mk(); const posts = [], patches = []; let clock = 5000;
  const discord = async (method, route, body) => {
    if (method === "GET" && /\/guilds\//.test(route)) return [{ id: "777777777777777777", name: "ticket-bug-x-123", guild_id: config.guildId }];
    if (method === "GET" && /\/users\/@me$/.test(route)) return { id: config.botId, avatar: null };
    if (method === "GET" && /\/channels\/777777777777777777$/.test(route)) return { id: "777777777777777777", name: "ticket-bug-x-123", guild_id: config.guildId };
    if (method === "GET" && /messages\?limit=100/.test(route)) return [];
    if (method === "GET" && /messages\?limit=1$/.test(route)) return posts.length ? [{ id: String(900 + posts.length) }] : [];
    if (method === "POST" && /messages$/.test(route)) { posts.push(body); return { id: String(900 + posts.length) }; }
    if (method === "PATCH") { patches.push(route); return {}; }
    return []; };
  const broker = createBroker({ ledger, config, mcp: { servers: () => ["support"], list: async () => [], call: async () => ({ ok: true }) }, discord, sandbox: {}, now: () => (clock += 1000), exec: async () => "" });
  const t = ledger.createJob("ticket:123", { kind: "ticket", role: "support", ticket: 123, channelId: "777777777777777777", source: { channelId: "777777777777777777", channelName: "ticket-bug-x-123" }, deadline: 9e15 }); t.state = "waiting";
  ledger.data.seen["ticket:123"] = t.id; t.investigatedReads = 5;
  // Snapshot what is on disk at every save after the card POST.
  const saves = []; const realSave = ledger.save;
  ledger.save = (...a) => { if (posts.length) saves.push(JSON.parse(JSON.stringify(ledger.data.statusCards || null))); return realSave.apply(ledger, a); };
  const items = [{ name: "Factory panel shows zero", stage: "found", blocked: false, note: "" }];
  await broker.adminStatusCard(123, { items, status: "" });
  assert.equal(posts.length, 1);
  assert.equal(saves[0]?.[123]?.messageId, "901", "the first save after the POST already holds the card");
  assert.deepEqual(saves[0][123].items ?? [], [], "items stay as they were, so a resumed update still sees the change");
  // Crash: only that first save survived.
  ledger.data.statusCards = saves[0];
  await broker.adminStatusCard(123, { items, status: "" });
  assert.equal(posts.length, 1, "no second card");
  assert.equal(patches.length, 1, "the card is edited in place instead");
});
