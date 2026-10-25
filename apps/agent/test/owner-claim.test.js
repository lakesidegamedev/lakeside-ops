"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

test("owner direction releases the owner's own claim and requeues the deferred ticket, never a staff claim", () => {
  const src = fs.readFileSync(path.join(__dirname, "../lib/operator/gateway.js"), "utf8");
  assert.match(src, /actor === config\.ownerId && d\.channels\[channel\.id\]\?\.claimedBy === config\.ownerId/);
  assert.match(src, /held\.state === "deferred"\) \{ held\.state = "queued"/);
  const dir = fs.readFileSync(path.join(__dirname, "../lib/operator/supportdirective.js"), "utf8");
  assert.match(dir, /claimant && claimant === config\.ownerId/);
  assert.match(dir, /claimReleasedAt: now\(\)/);
});

test("a hold with no proposal stays held without manufacturing a permission request", () => {
  const { createRecovery } = require("../lib/operator/selfrecovery");
  const j = { id: "h", kind: "ticket", ticket: 1584, state: "blocked", ownerDecisionPending: true };
  const ledger = { data: { jobs: { h: j }, decisions: {}, outbox: {} }, audit() {}, save() {}, notify() {} };
  const r = createRecovery({ ledger, config: { ownerId: "o" }, now: () => 1e12 });
  r.tick({}); r.tick({});
  assert.equal(Object.values(ledger.data.decisions).length, 0);
  assert.equal(j.ownerDecisionPending, true); assert.equal(j.state, "blocked");
});

test("an owner-directed moderation ticket is no longer treated as moderation-only", () => {
  const { isModerationChannel, isIncidentChannel } = require("../lib/operator/ticketCategory");
  const ledger = { data: { channels: { m: { category: "moderation" }, i: { category: "incident" }, md: { category: "moderation", ownerDirectedAt: 1 } } } };
  assert.equal(isModerationChannel(ledger, "m"), true);
  assert.equal(isIncidentChannel(ledger, "i"), true);
  assert.equal(isModerationChannel(ledger, "md"), false);
  const gw = require("node:fs").readFileSync(require("node:path").join(__dirname, "../lib/operator/gateway.js"), "utf8");
  assert.match(gw, /ownerDirectedAt: now\(\)/);
  assert.match(gw, /&& !d\.channels\[channel\.id\]\?\.ownerDirectedAt\) \{ d\.seen\[key\]/);
});

// Review 2026-10-19: a ticket held on an owner decision skipped the loop
// before the conversation wake, so its player went unanswered for hours.
test("a player message wakes a ticket held on an owner decision", () => {
  const src = fs.readFileSync(path.join(__dirname, "../operator.js"), "utf8");
  assert.match(src, /if \(j\.ownerDecisionPending && !\(j\.kind === "ticket" && !j\.channelClosed && humanInbox\(j\)\)\) \{/);
  assert.match(src, /j\.ownerDecisionPending && j\.kind === "ticket" && !j\.channelClosed && humanInbox\(j\)\) \{ j\.state = "queued"; ledger\.audit\("requeued_for_conversation"/);
});

test("an unread ticket message pages the owner after 30 minutes with the hold that keeps it", () => {
  const src = fs.readFileSync(path.join(__dirname, "../operator.js"), "utf8");
  assert.match(src, /function unreadWatchdog\(d, now, staffHeld\)/);
  assert.match(src, /unreadWatchdog\(d, now, staffHeld\);\n  const picks = pickForLanes\(/);
  assert.match(src, /now - oldest < 30 \* 60000/);
});
