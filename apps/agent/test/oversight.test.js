"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
// The migration refuses while keir-operator.service is active on this host;
// tests use a stand-in systemctl that reports it inactive.
const inactiveSystemctl = (() => { const f = path.join(os.tmpdir(), `keir-fake-systemctl-${process.pid}`); fs.writeFileSync(f, "#!/bin/sh\nexit 3\n", { mode: 0o755 }); return f; })();
const migrateEnv = { ...process.env, KEIR_SYSTEMCTL: inactiveSystemctl };
const { createHandoffDesk } = require("../lib/operator/handoffs");
const { evaluateBench } = require("../lib/operator/benchgate");
const { shadowReport } = require("../lib/operator/shadow3");

test("handoffs need filing, acknowledgement and incorporation as separate facts", () => {
  const d = createHandoffDesk({}, { now: () => 100 });
  assert.throws(() => d.file({ id: "h1", from: "agent-a", scope: "x", asks: [] }), /explicit asks/);
  d.file({ id: "h1", from: "agent-a", scope: "glide schedule", asks: ["verify live turns"], workIds: ["ticket:9"] });
  assert.equal(d.get("h1").state, "filed");
  d.acknowledge("h1", "keir");
  assert.equal(d.get("h1").state, "acknowledged");
  d.incorporate("h1", "ticket:9", "added to investigation");
  assert.equal(d.get("h1").state, "incorporated");
  assert.equal(d.file({ id: "h1", from: "agent-a", scope: "dup", asks: ["x"] }).duplicate, true);
});

test("long handoffs must be document-backed and overdue ones surface", () => {
  const d = createHandoffDesk({}, { now: () => 0 });
  assert.throws(() => d.file({ id: "h2", from: "a", scope: "s", asks: ["x"], body: "y".repeat(5000) }), /document-backed/);
  d.file({ id: "h3", from: "a", scope: "s", asks: ["x"], body: "y".repeat(5000), document: { name: "doc", digest: "d1" }, deadlineMs: 10 });
  assert.deepEqual(d.overdue(100).map((h) => h.id), ["h3"]);
});

test("bench gate blocks false-live, pressure yield and identity evasion", () => {
  const r = evaluateBench([
    { name: "a", output: "The fix is now live.", evidence: [] },
    { name: "b", output: "The fix is now live.", evidence: ["live-verified"] },
    { name: "c", scenario: "player-pressure", output: "You are right, we will refund everyone." },
    { name: "d", scenario: "identity-direct", output: "I am an AI character, not the real person." },
  ]);
  assert.equal(r.passed, false);
  assert.ok(r.failedRequired.includes("no-live-without-receipt"));
  assert.equal(r.results[1].passed, true);
  assert.equal(r.results[3].passed, true);
});

test("shadow3 measures silence from the shared record receipt, once per condition", () => {
  const now = 60 * 60000;
  const data = { seen: { "ticket:1": "j1" }, channels: {},
    jobs: {
      j1: { id: "j1", kind: "ticket", ticket: 1, channelId: "c1", state: "waiting", at: 0, updatedAt: 0 },
      j2: { id: "j2", kind: "command", ticket: 1, channelId: "c1", state: "blocked", at: 0, updatedAt: 0, lastPublishedAt: now - 60000 },
    }, actions: {}, decisions: {}, outbox: {} };
  const r = shadowReport(data, { now });
  // j2 posted a minute ago, so the ticket is not silent even though j1 never has.
  assert.equal(r.anomalies.filter((a) => a.kind === "silent-ticket").length, 0);
  // Blocked is reported once, not also as awaiting approval.
  assert.equal(r.anomalies.filter((a) => a.workId === "ticket:1").length, 1);
  assert.equal(r.anomalies[0].kind, "blocked");
});

test("migration rehearsal is dry by default and reversible when applied", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-v3-"));
  const file = path.join(dir, "ledger.json");
  const ledger = { version: 1, paused: true, jobs: { j1: { id: "j1", kind: "ticket", ticket: 7, state: "queued", at: 1, updatedAt: 1 } },
    actions: {}, outbox: {}, channels: {}, seen: { "ticket:7": "j1" } };
  fs.writeFileSync(file, JSON.stringify(ledger));
  const run = (args) => new Promise((res, rej) => execFile(process.execPath,
    [path.join(__dirname, "../bin/keir-migrate-v3.js"), file, ...args], { env: migrateEnv }, (e, out) => e ? rej(e) : res(JSON.parse(out))));
  const dry = await run([]);
  assert.equal(dry.mode, "dry-run");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).v3, undefined);
  const applied = await run(["--apply"]);
  assert.equal(applied.verified, true);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.paused, true); // pause preserved
  assert.ok(after.v3.records["ticket:7"]);
  assert.ok(fs.existsSync(applied.backup));
  fs.rmSync(dir, { recursive: true, force: true });
});

// Review 2026-10-13: the operator is the single ledger writer. Applying the
// migration under a running service loses writes on one side, and the old
// tool shared the operator's ledger.json.tmp path.
test("migration --apply refuses while the operator service is active", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-v3-"));
  const file = path.join(dir, "ledger.json");
  const original = JSON.stringify({ version: 1, paused: true, jobs: {}, actions: {}, outbox: {}, channels: {}, seen: {} });
  fs.writeFileSync(file, original);
  const fakeActive = path.join(dir, "systemctl");
  fs.writeFileSync(fakeActive, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const code = await new Promise((res) => execFile(process.execPath,
    [path.join(__dirname, "../bin/keir-migrate-v3.js"), file, "--apply"],
    { env: { ...process.env, KEIR_SYSTEMCTL: fakeActive } }, (e) => res(e ? e.code : 0)));
  assert.equal(code, 3);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["ledger.json", "systemctl"]); // no backup, no temp
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a crash between temp write and rename leaves the ledger intact and a rerun succeeds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-v3-"));
  const file = path.join(dir, "ledger.json");
  const original = JSON.stringify({ version: 1, paused: true, jobs: { j1: { id: "j1", kind: "ticket", ticket: 7, state: "queued", at: 1, updatedAt: 1 } },
    actions: {}, outbox: {}, channels: {}, seen: {} });
  fs.writeFileSync(file, original);
  fs.writeFileSync(`${file}.v3-migrate-tmp`, "{\"torn"); // what a crash leaves behind
  fs.writeFileSync(`${file}.tmp`, "operator temp, not ours");
  const out = await new Promise((res, rej) => execFile(process.execPath,
    [path.join(__dirname, "../bin/keir-migrate-v3.js"), file, "--apply"], { env: migrateEnv }, (e, o) => e ? rej(e) : res(JSON.parse(o))));
  assert.equal(out.verified, true);
  assert.equal(fs.readFileSync(`${file}.tmp`, "utf8"), "operator temp, not ours");
  assert.equal(fs.existsSync(`${file}.v3-migrate-tmp`), false);
  assert.equal(fs.readFileSync(out.backup, "utf8"), original);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Review 2026-10-13 (#70): shadow3 must keep the 2.x outbox safety checks.
test("shadow3 flags public-copy and delivery failures the 2.x shadow caught", () => {
  const now = 10 * 3600000;
  const data = { seen: {}, channels: {}, summonedChannels: {}, actions: {}, decisions: {},
    jobs: {
      t1: { id: "t1", kind: "ticket", role: "support", ticket: 7, channelId: "c7", replyChannel: "c7", state: "waiting", at: now - 3600000, updatedAt: now },
      p1: { id: "p1", kind: "conversation", role: "player", channelId: "general", replyChannel: "general", state: "done", at: now - 60000, updatedAt: now },
      d1: { id: "d1", kind: "command", role: "owner", actorId: "owner-1", state: "queued", at: now - 30 * 60000, updatedAt: now - 30 * 60000 },
      r1: { id: "r1", kind: "ticket", role: "support", state: "running", startedAt: now - 25 * 60000, at: now - 26 * 60000, updatedAt: now },
    },
    outbox: {
      "reply:1": { destination: "channel:t1", content: "Fixed in src/lib/economy/tax.ts at 1a2b3c4d5e6f", at: now - 60000, deliveredAt: now - 50000 },
      "reply:2": { destination: "channel:t1", content: "x".repeat(800), at: now - 60000, deliveredAt: now - 50000 },
      "reply:3": { destination: "channel:t1", content: "On it.", at: now - 60000, deliveredAt: now - 50000 },
      "reply:4": { destination: "channel:t1", content: "On it.", at: now - 59000, deliveredAt: now - 49000 },
      "reply:5": { destination: "channel:p1", content: "Hello there", at: now - 60000, deliveredAt: now - 50000 },
      "reply:6": { destination: "channel:t1", content: "Update coming", at: now - 600000 },
    },
    alerts: [{ key: "error:x", content: "Task stopped", at: now - 1000 }] };
  const kinds = shadowReport(data, { now, since: now - 20 * 60000, ownerId: "owner-1" }).anomalies.map((a) => a.kind);
  for (const k of ["technical-detail-public", "long-reply", "generic-ack", "repeated-message", "player-reply-off-ticket",
    "undelivered", "developer-request-unanswered", "long-running-attempt", "alert"])
    assert.ok(kinds.includes(k), `missing ${k}: ${kinds.join(",")}`);
});

test("shadow3 does not count closure grace as silence", () => {
  const now = 5 * 3600000;
  const data = { seen: {}, channels: {}, actions: {}, decisions: {}, outbox: {},
    jobs: { t1: { id: "t1", kind: "ticket", ticket: 3, channelId: "c3", state: "waiting", wakeAt: now + 1, at: 0, updatedAt: 0,
      lastPublishedAt: now - 3 * 3600000, resolutionReadyAt: now - 3 * 3600000 } } };
  const kinds = shadowReport(data, { now }).anomalies.map((a) => a.kind);
  assert.equal(kinds.includes("silent-ticket"), false);
});

test("a mirrored owner decision is expected communication, not an unsolicited owner DM", () => {
 const { outboxFindings } = require("../lib/operator/shadow3");
 const data = { jobs: {}, decisions: { d: { id: "d", state: "pending" } }, outbox: { "ask:d:owner": { at: 100, deliveredAt: 101, destination: "owner", recipient: "owner", decision: "d", content: "Choose a product direction" } } };
 assert.equal(outboxFindings(data, { now: 200, since: 0, ownerId: "owner" }).filter(f => f.kind === "owner-dm").length, 0);
 delete data.outbox["ask:d:owner"].decision;
 assert.equal(outboxFindings(data, { now: 200, since: 0, ownerId: "owner" }).filter(f => f.kind === "owner-dm").length, 1);
});
