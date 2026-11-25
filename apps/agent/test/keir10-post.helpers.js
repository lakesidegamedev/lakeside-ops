"use strict";
// Shared fixture for the Keir 10 post path tests (synthetic ticket, names and ids only).
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");

const CH = "777777777777777777";
const ticketDiscord = async (_method, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-123" }] : []);

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir10-post-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, ...(over.config || {}) };
  const calls = [];
  const handler = over.call || (async () => ({ ok: true, id: "card-9", hits: [], delivery: { posted: true, delivery: { status: "posted" } } }));
  const mcp = {
    servers: () => over.servers || ["support", "ops-knowledge"],
    list: async () => ["support_public_update", "support_resolve", "support_get", "code_search", ...(over.listed || [])].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })),
    call: async (...a) => { calls.push(a); return handler(...a); },
  };
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord: over.discord || ticketDiscord, ...(over.exec ? { exec: over.exec } : {}), sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock, ...(over.codingWorkers ? { codingWorkers: over.codingWorkers } : {}) });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-123", content: "Why is my plant idle?" }, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id; ledger.data.disclosed = { 123: { at: 1, posted: true } };
  // A read of the player's own record this activation, so the evidence-gated claim check (guardrails.js) is satisfied unless a test turns it off.
  if (!over.noEntityRead) { job.reporterCharacter = { id: "4242", name: "Fixture Player", username: "fixtureplayer" }; job.ownRecordRead = true; }
  job.codeLookups = 1; job.lastCodeReadAt = clock - 1000; // a code read exists, so the rule-before-code check stays out of the way
  const posts = () => calls.filter((c) => c[1] === "support_public_update" && c[2].deliver === true).map((c) => c[2].message);
  const audits = (kind) => (ledger.data.audit || []).filter((a) => a.kind === kind);
  return { ledger, broker, job, calls, posts, audits, dir, now: () => clock, advance: (min) => { clock += min * 60000; }, playerWrote: (agoMin = 5) => { job.observedPlayerAt = clock - agoMin * 60000; } };
}
module.exports = { setup, CH };
