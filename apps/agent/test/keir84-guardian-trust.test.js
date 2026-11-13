"use strict";
// Keir 8.4: guardian restart policy and the daily trust report.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { decideUnit, judgeOperatorHealth, DEFAULTS } = require("../lib/operator/guardian");
const { buildTrustReport, renderTrustReport, reviewReply, createTrustReporter } = require("../lib/operator/trustreport");
const { recordReply, recordPlayerMessages, contradictedClaims, trust } = require("../lib/operator/trustlog");
const { createLedger } = require("../lib/operator/store");

const MIN = 60000, H = 3600000, T0 = Date.parse("2026-11-06T17:00:00Z");
const obs = (o) => ({ unit: "keir-operator", activeState: "active", healthOk: true, healthDetail: "ok", ...o });

test("a unit stopped on purpose is never started", () => {
  const s = {};
  const d = decideUnit(obs({ activeState: "inactive", healthOk: null }), s, T0);
  assert.equal(d.action, "none"); assert.equal(d.status, "stopped");
});

test("a failed unit is restarted, with doubling backoff, then the guardian gives up and alerts once", () => {
  const s = {};
  assert.equal(decideUnit(obs({ activeState: "failed" }), s, T0).action, "restart");
  assert.equal(decideUnit(obs({ activeState: "failed" }), s, T0 + 30000).status, "backoff");
  assert.equal(decideUnit(obs({ activeState: "failed" }), s, T0 + 2 * MIN).action, "restart", "second restart after 1 min");
  assert.equal(decideUnit(obs({ activeState: "failed" }), s, T0 + 3 * MIN).status, "backoff", "backoff doubled to 4 min");
  assert.equal(decideUnit(obs({ activeState: "failed" }), s, T0 + 7 * MIN).action, "restart", "third restart");
  const gave = decideUnit(obs({ activeState: "failed" }), s, T0 + 20 * MIN);
  assert.equal(gave.action, "give_up_alert");
  assert.match(gave.reason, /3 restarts/);
  assert.equal(decideUnit(obs({ activeState: "failed" }), s, T0 + 25 * MIN).action, "give_up", "no second alert inside 6 hours");
  assert.equal(decideUnit(obs({ activeState: "failed" }), s, T0 + 6 * H + 21 * MIN).action, "give_up_alert", "reminder every 6 hours");
});

test("an active but hung unit gets a 5 minute grace, then a restart; recovery clears the count after 30 healthy minutes", () => {
  const s = {};
  assert.equal(decideUnit(obs({ healthOk: false, healthDetail: "heartbeat 400 s old" }), s, T0).status, "degraded");
  assert.equal(decideUnit(obs({ healthOk: false }), s, T0 + 4 * MIN).action, "none");
  const r = decideUnit(obs({ healthOk: false, healthDetail: "heartbeat 400 s old" }), s, T0 + 5 * MIN);
  assert.equal(r.action, "restart"); assert.match(r.reason, /heartbeat 400 s old/);
  assert.equal(decideUnit(obs(), s, T0 + 6 * MIN).status, "healthy");
  assert.equal(s.restarts.length, 1);
  decideUnit(obs(), s, T0 + 40 * MIN);
  assert.equal(s.restarts.length, 0, "healthy for 30 minutes resets the count");
  assert.equal(s.unhealthySince, undefined, "a healthy read clears the unhealthy clock");
});

test("operator health is judged on status, stale periodic jobs and a stuck outbox", () => {
  assert.equal(judgeOperatorHealth({ status: 200, body: { staleTickers: [], outbox: { oldestDeliverableMs: 1000 } } }).ok, true);
  assert.equal(judgeOperatorHealth({ error: "ECONNREFUSED" }).ok, false);
  assert.match(judgeOperatorHealth({ status: 503, body: { heartbeatAgeMs: 400000 } }).detail, /503.*400 s/);
  assert.match(judgeOperatorHealth({ status: 200, body: { staleTickers: [{ name: "ciwatch" }] } }).detail, /ciwatch/);
  assert.match(judgeOperatorHealth({ status: 200, body: { outbox: { oldestDeliverableMs: 20 * MIN } } }).detail, /outbox stuck/);
});

test("reply spot checks flag the failures the owner has seen", () => {
  assert.equal(reviewReply("Your bond total counts both issuers twice, so it reads double what you hold.").verdict, "fine");
  assert.ok(reviewReply("It is fixed and live now. See https://github.com/x/y/pull/1").flags.includes("leaks internals or tool markup"));
  assert.ok(reviewReply("The fix is live now.").flags.includes("says fixed or live"));
  assert.ok(reviewReply("Still checking this.").flags.includes("a non-answer"));
  assert.ok(reviewReply("Looking into it — more soon.").flags.some((f) => /dash/.test(f)));
  assert.ok(reviewReply("The bond total counts both issuers twice so it reads double.", ["The bond total counts both issuers twice so it reads double what you hold."]).flags.includes("repeats an earlier post"));
  assert.ok(reviewReply('{"tool": "channel_reply", "arguments": {}}').flags.includes("leaks internals or tool markup"));
});

test("a fixed claim is contradicted by the player's next message or by Keir's own correction", () => {
  const d = {};
  recordReply(d, { ticket: 3, jobId: "j", text: "Your margins are fixed and live on the main server now.", at: T0 });
  recordReply(d, { ticket: 4, jobId: "j", text: "Your margins are fixed and live on the main server now.", at: T0 });
  // The clock is passed in: a fixed date plus the real clock aged out after 7 days (CI, 2026-11-13).
  recordPlayerMessages(d, 3, [{ content: "it is still broken, same number as before", at: new Date(T0 + 5 * MIN).toISOString() }], T0 + 6 * MIN);
  recordPlayerMessages(d, 4, [{ content: "thanks, looks right now", at: new Date(T0 + 5 * MIN).toISOString() }], T0 + 6 * MIN);
  const found = contradictedClaims(d, T0 - H, T0 + H);
  assert.equal(found.length, 1); assert.equal(found[0].ticket, 3); assert.equal(found[0].contradictedBy, "player");
  recordReply(d, { ticket: 4, jobId: "j", text: "Correction: that is not fixed yet, the change is still on the test server.", at: T0 + 20 * MIN });
  assert.equal(contradictedClaims(d, T0 - H, T0 + H).length, 2);
});

function reportLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const open = ledger.createJob("a", { kind: "ticket", role: "support", ticket: 11, source: {}, pullRequests: ["https://github.com/o/r/pull/9"] });
  open.state = "waiting"; open.updatedAt = T0 - H;
  const done = ledger.createJob("b", { kind: "ticket", role: "support", ticket: 12, source: {} });
  done.state = "done"; done.resolved = true; done.channelClosed = true; done.resolutionSubmittedAt = T0 - 2 * H; done.updatedAt = T0 - 2 * H;
  ledger.data.decisions = { x: { id: "x", state: "pending", jobId: open.id, at: T0 - 30 * H, question: "Approve the rate change?" } };
  recordReply(ledger.data, { ticket: 11, jobId: open.id, text: "The bond total counts both issuers twice, so it reads double what you hold.", at: T0 - 3 * H });
  recordReply(ledger.data, { ticket: 12, jobId: done.id, text: "The unban is done and your account is active again.", at: T0 - 2 * H });
  trust(ledger.data).sweeps[11] = { at: T0 - 2 * H, kind: "escalate_owner", reason: "no substantive progress for 8 h" };
  return { ledger, dir };
}

test("the trust report is short, plain and covers each section the owner asked for", () => {
  const { ledger } = reportLedger();
  const report = buildTrustReport({ d: ledger.data, now: T0, random: () => 0.1, guardian: { restarts: [{ at: T0 - H, unit: "keir-operator" }], giveUps: [] }, killSwitch: { engaged: false } });
  assert.deepEqual(report.tickets, { handled: 2, resolved: 1, open: 1 });
  assert.deepEqual(report.fixes, ["https://github.com/o/r/pull/9"]);
  assert.equal(report.awaitingOwner.decisions[0].ageH, 30);
  assert.equal(report.awaitingOwner.escalations[0].ticket, 11);
  assert.equal(report.spotChecks.length, 2);
  const text = renderTrustReport(report);
  assert.match(text, /2 tickets handled, 1 resolved, 1 still open/);
  assert.match(text, /Waiting on you \(2\)/);
  assert.match(text, /1 automatic restart \(keir-operator\)/);
  assert.match(text, /No fixed or live claim was contradicted/);
  assert.doesNotMatch(text, /[–—]/);
  assert.ok(text.length < 1900, "fits one Discord message");
});

test("the reporter delivers once a day at 9 Eastern: owner DM, file and knowledge save", async () => {
  const { ledger, dir } = reportLedger();
  const saved = [];
  let clock = Date.parse("2026-11-06T12:00:00Z"); // 07:00 ET
  const reporter = createTrustReporter({ ledger, config: { stateDir: dir, ownerId: "1" }, now: () => clock, outDir: path.join(dir, "reports"), mcp: { call: async (...a) => { saved.push(a); return { id: "doc1" }; } } });
  assert.equal(await reporter.tick(), null, "too early");
  clock = Date.parse("2026-11-06T15:00:00Z"); // 10:00 ET
  const first = await reporter.tick();
  assert.ok(first.file && fs.existsSync(first.file));
  assert.equal(saved[0][1], "knowledge_save"); assert.equal(saved[0][3], true);
  const dm = ledger.data.outbox["trust-report:2026-11-06"];
  assert.equal(dm.destination, "owner");
  assert.equal(await reporter.tick(), null, "once a day");
  const failing = createTrustReporter({ ledger, config: { stateDir: dir, ownerId: "1" }, now: () => clock + 86400000, outDir: path.join(dir, "reports"), mcp: { call: async () => { throw new Error("down"); } } });
  const next = await failing.tick();
  assert.ok(next.file && !next.knowledge, "a failed knowledge save still leaves the DM and the file");
});
