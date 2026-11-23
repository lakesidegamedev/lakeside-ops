"use strict";
// Keir 11.7.3 (ticket 1890): a coordinator hold stops every Keir post on the ticket, owner-started tasks included.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createCoordinatorHolds } = require("../lib/operator/coordinatorhold");
const { setup } = require("./keir10-post.helpers");

test("a held ticket is read from the hold file and expires", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "keir-hold-"));
  let clock = Date.parse("2026-11-23T17:00:00Z");
  const holds = createCoordinatorHolds({ stateDir: dir, now: () => clock });
  assert.equal(holds.held(1890), null);
  fs.writeFileSync(path.join(dir, "coordinator-holds.json"), JSON.stringify({ 1890: { by: "coordinator", until: "2026-11-23T18:00:00Z" } }));
  assert.equal(holds.held(1890).by, "coordinator");
  assert.equal(holds.held(1891), null);
  clock = Date.parse("2026-11-23T18:00:01Z");
  assert.equal(holds.held(1890), null);
  fs.writeFileSync(path.join(dir, "coordinator-holds.json"), "not json");
  assert.equal(holds.held(1890), null);
});

test("the live notice is not posted on a held ticket", async () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "keir-hold-"));
  const f = setup({ config: { stateDir: dir } });
  fs.writeFileSync(path.join(dir, "coordinator-holds.json"), JSON.stringify({ 123: { by: "coordinator" } }));
  f.ledger.data.statusCards = { 123: { messageId: "9", channelId: f.job.channelId, items: [], liveNotified: [] } };
  f.ledger.data.ticketPosts = { 123: [] };
  f.job.pullRequests = ["https://github.com/lakesidegamedev/AHDGame/pull/7001"];
  f.job.releaseEvidence = { abc1234def: { at: f.now() - 60000, main: true, development: true, staging: true, repository: "AHDGame", pr: 7001 } };
  await f.broker.liveNotice(f.job, 123, [], [{ name: "Margins", stage: "main", blocked: false }]);
  assert.equal(f.posts().length, 0);
});

test("a held ticket's support task is not admitted, other tickets are", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "keir-hold-"));
  const holds = createCoordinatorHolds({ stateDir: dir });
  fs.writeFileSync(path.join(dir, "coordinator-holds.json"), JSON.stringify({ 1884: { by: "coordinator" } }));
  const { hold } = require("../lib/operator/admission");
  const job = (ticket) => ({ id: `t${ticket}`, kind: "ticket", role: "player", ticket, state: "queued", deadline: Date.now() + 60000 });
  assert.equal(holds.heldJob(job(1884)), true);
  assert.equal(holds.heldJob({ kind: "conversation" }), false);
  assert.equal(hold(job(1884), { supportDeferred: holds.heldJob }), "support-deferred");
  assert.equal(hold(job(1885), { supportDeferred: holds.heldJob }), null);
});
