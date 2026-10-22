"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");

function fixture(t, { live = true, refuse = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-sentry-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const saved = Object.fromEntries(["SENTRY_API_TOKEN", "SENTRY_ORG", "SENTRY_API_URL", "KEIR_DEPLOYED_SHA_CMD", "KEIR_AHD_HEALTH_URL"].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { SENTRY_API_TOKEN: "test-token", SENTRY_ORG: "test-org", SENTRY_API_URL: "https://sentry.example", KEIR_DEPLOYED_SHA_CMD: "/fixture/ahd-deployed-sha.sh", KEIR_AHD_HEALTH_URL: "https://game.example/api/health" });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const writes = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === "https://game.example/api/health") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    writes.push({ url, method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { status: refuse ? 403 : 200 });
  });
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "owner", staffIds: ["delegate"], stateDir: dir, repositories: {}, scanChannels: [], supportDeferred: () => false };
  const exec = async (cmd, args) => {
    // The running web commit; an undeployed fix leaves it on an older commit.
    if (cmd === "/fixture/ahd-deployed-sha.sh") return "d".repeat(40);
    const route = args[1];
    if (/pulls\/7$/.test(route)) return JSON.stringify({ merged: true, merge_commit_sha: "abc1234", body: "Refs #41" });
    if (/\/files\?/.test(route)) return JSON.stringify([{ filename: "src/components/Panel.tsx" }]);
    if (/\/deployments\?/.test(route)) return JSON.stringify([]);
    if (/compare\//.test(route)) return JSON.stringify({ status: live ? "behind" : "ahead" });
    throw new Error(`unexpected ${route}`);
  };
  const mcp = { call: async () => { throw new Error("no MCP needed"); } };
  const broker = createBroker({ ledger, config, mcp, exec, discord: async () => { throw new Error("no Discord"); }, sandbox: {}, now: () => 5000 });
  const job = ledger.createJob("finding", { kind: "finding", role: "support", repository: "AHDGame", deadline: 9e15, source: {} }); job.state = "running";
  return { writes, ledger, job, call: (input) => broker.tool(job, "sentry", input) };
}

test("Sentry notes and resolution use exact endpoints and receipts without duplicate writes", async (t) => {
  const f = fixture(t);
  const note = { action: "note", id: "42", text: "Tracked at https://github.com/Egg3901/AHDGame/issues/41" };
  await f.call(note); await f.call(note);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].url, "https://sentry.example/api/0/organizations/test-org/issues/42/comments/");
  assert.equal(f.writes[0].method, "POST");
  assert.equal((await f.call({ action: "resolve", id: "42", fix: 7 })).resolved, true);
  await f.call({ action: "resolve", id: "42", fix: 7 });
  assert.equal(f.writes.length, 3);
  assert.equal(f.writes[1].method, "PUT");
  assert.deepEqual(f.writes[1].body, { status: "resolved" });
});

test("Sentry refuses unlinked fixes and pending deployments before writing", async (t) => {
  const f = fixture(t, { live: false });
  assert.equal((await f.call({ action: "resolve", id: "42", fix: 7 })).resolved, false);
  assert.equal(f.writes.length, 0);
});

test("Sentry 403 is a clear refusal and never records a link", async (t) => {
  const f = fixture(t, { refuse: true });
  await assert.rejects(f.call({ action: "note", id: "42", text: "Tracked at https://github.com/Egg3901/AHDGame/issues/41" }), /refused.*403/);
  assert.equal(f.ledger.data.sentryLinks?.[42], undefined);
  assert.equal(f.job.state, "running");
  assert.equal(Object.values(f.job.effects)[0].state, "rejected");
});

test("a live but unrelated PR cannot resolve an arbitrary Sentry issue", async (t) => {
  const f = fixture(t);
  const out = await f.call({ action: "resolve", id: "42", fix: 7 });
  assert.equal(out.resolved, false);
  assert.match(out.reason, /link this Sentry issue/);
  assert.equal(f.writes.length, 0);
});
