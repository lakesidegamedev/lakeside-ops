"use strict";
// 2026-11-14: a ticket whose channel was deleted by closure kept waking on a
// self-recovery nudge. Orientation reads ticket_history before every activation,
// and the broker passed through Discord's bare 404 ("Discord GET /channels/...:
// 404") with nothing about what to do, so the same read came back on each wake.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");

const CHANNEL = "100000000000000005";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-closed-history-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "100000000000000001", staffIds: ["100000000000000002"], botId: "100000000000000003", guildId: "100000000000000004",
    taskLifetimeMs: 86400000, supportDeferred: () => false, stateDir: dir, repositories: {}, readyReads: false };
  const mcp = { servers: () => [], list: async () => [], call: async () => ({}) };
  let calls = 0;
  const discord = async (method, route) => {
    calls += 1;
    const error = new Error(`Discord ${method} ${route.split("?")[0]}: 404`);
    error.status = 404;
    throw error;
  };
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => 5000 });
  const job = ledger.createJob("ticket:4242", { kind: "ticket", role: "support", ticket: 4242, channelId: CHANNEL, source: {}, deadline: 9999999999999 });
  job.state = "running";
  ledger.data.channels[CHANNEL] = { category: "other" };
  ledger.save();
  return { dir, ledger, broker, job, calls: () => calls };
}

test("a deleted ticket channel ends history reads with the next step named", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  await assert.rejects(f.broker.tool(f.job, "ticket_history", {}), /channel no longer exists .*do not retry; finish without posting/);
  assert.equal(f.job.channelClosed, true, "the closure is recorded so the next activation closes the ticket");
  const before = f.calls();
  await assert.rejects(f.broker.tool(f.job, "ticket_history", {}), /finish without posting/);
  assert.equal(f.calls(), before, "a recorded closure is not re-read from Discord");
});

test("a closed ticket can finish without an answer it has nowhere to post", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  f.job.channelClosed = true;
  f.job.lastGameReadAt = 4900;
  f.job.lastPlayerAt = 4000;
  f.ledger.save();
  await f.broker.tool(f.job, "finish", { state: "done", summary: "The ticket channel was closed by staff; there is nowhere to answer." });
  assert.equal(f.job.state, "done");
});
