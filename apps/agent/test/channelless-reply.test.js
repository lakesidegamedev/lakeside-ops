"use strict";
// KBX5 channelless--open (2026-11-03): an open ticket whose Discord channel is gone. Every
// reply is refused (nowhere to deliver it), and that refusal used to arm the refused-reply
// hold, so finish "waiting" was refused too and the task could only end blocked.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");

test("an undeliverable reply on a channel-less ticket does not hold finish", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channelless-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "1", staffIds: [], botId: "2", guildId: "3", stateDir: dir, repositories: {}, scanChannels: [], supportDeferred: () => false };
  const mcp = { servers: () => ["support"], call: async (server, tool) => (tool === "support_get" ? { ticket: { number: 5100 }, number: 5100, status: "open", kind: "ticket" } : { ok: true }) };
  const discord = async (method, route) => (/\/guilds\/.*\/channels/.test(route) ? [] : {});
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: {}, now: () => Date.now() });
  const job = ledger.createJob("ticket:5100", { kind: "ticket", role: "support", ticket: 5100, channelId: null, replyChannel: null, source: { content: "Where did my factory go?" }, deadline: Date.now() + 86400000 });
  job.state = "running";
  await broker.tool(job, "ticket_record", { op: "read" }).catch(() => {});
  await assert.rejects(broker.tool(job, "support_action", { tool: "support_public_update", args: { kind: "ticket", number: 5100, update_kind: "progress", deliver: true, message: "Checking your factory now." } }));
  assert.notEqual(job.replyRefusedPending, true, "a reply with nowhere to go is not an answer the player is owed");
  const r = await broker.tool(job, "finish", { state: "waiting", summary: "No channel; waiting for staff." });
  assert.equal(r.state ?? job.state, "waiting");
});
