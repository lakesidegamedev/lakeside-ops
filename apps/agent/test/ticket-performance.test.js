"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { observeTicket, reconcileTickets, keyFor } = require("../lib/operator/ticketoutcomes");
const { distribution, ticketPerformance, readTicketPerformance } = require("../lib/operator/ticketperformance");

function fixture() {
  const job = { id: "support", kind: "ticket", ticket: 12, channelId: "ch", at: 1000, state: "waiting" };
  const data = { jobs: { support: job } };
  const ticket = { number: 12, status: "resolved", createdAt: 100,
    conversation: { channelId: "ch" }, resolution: { receiptId: "r1", resolvedAt: 10000, closedBy: "other-agent" },
    resolutionAttribution: { agent: "keir", jobId: "support", evidence: "verified-answer" } };
  const row = { event: "activation", at: new Date(11000).toISOString(), job: "support", ticket: 12,
    model: "claude-sonnet-5-5", provider: "claude-cli-subscription", turns: 4, durationMs: 3000,
    tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 } };
  return { job, data, ticket, row };
}

test("mean and even-sample median are correct, invalid/missing measurements excluded", () => {
  assert.deepEqual(distribution([1, 3, 5, 9, null, undefined, -1]),
    { n: 4, mean: 4.5, median: 4, p90: 9, p95: 9, min: 1, max: 9 });
  assert.equal(distribution([]).mean, null);
});

test("external closer preserves Keir credit and the resolving model, closure activation included", () => {
  const f = fixture();
  observeTicket(f.data, f.job, f.ticket, 12000);
  const r = ticketPerformance(f.data, [f.row], { since: 9000, until: 12000 });
  assert.equal(r.resolved.tickets, 1);
  assert.equal(r.resolved.resolutionMs.median, 9900);
  assert.equal(r.resolved.pickupToResolutionMs.mean, 9000);
  assert.equal(r.resolved.turns.mean, 4);
  assert.equal(r.tickets[0].closedBy, "other-agent");
  assert.equal(r.tickets[0].resolvingModel.model, f.row.model);
  assert.equal(r.tickets[0].actualBilledUsd, null);
  assert.ok(r.tickets[0].apiEquivalentUsd > 0);
  assert.equal(ticketPerformance(f.data, [f.row], { since: 10001, until: 12000 }).resolved.tickets, 0);
});

test("coding children with no ticket inherit attribution; mixed models retain separate contributions", () => {
  const f = fixture();
  f.data.jobs.child = { id: "child", kind: "coding", codingParent: "support", at: 2000 };
  observeTicket(f.data, f.job, f.ticket);
  const childRow = { ...f.row, job: "child", ticket: null, model: "unpriced-model", turns: 7 };
  const r = ticketPerformance(f.data, [f.row, childRow, { ...f.row, event: "request", turns: 100 }], { until: 12000 });
  assert.equal(r.resolved.turns.mean, 11);
  assert.equal(r.byModel.length, 2);
  assert.equal(r.tickets[0].apiEquivalentUsd, null);
  assert.ok(r.tickets[0].knownApiEquivalentUsd > 0);
  assert.equal(r.tickets[0].unpricedActivations, 1);
  assert.equal(r.byModel.find(m => m.model === "unpriced-model").turns.mean, 7);
});

test("receiptless closures, proposals, done jobs and merges never count as resolution", () => {
  for (const change of [f => { f.ticket.resolution = null; }, f => { f.ticket.mergedInto = 10; },
    f => { f.ticket.status = "in_progress"; }, f => { f.job.state = "done"; f.job.channelClosed = true; f.ticket.resolution = null; }]) {
    const f = fixture(); change(f); observeTicket(f.data, f.job, f.ticket);
    assert.equal(ticketPerformance(f.data, [f.row], { until: 12000 }).resolved.tickets, 0);
  }
});

test("unattributed canonical closure remains assisted; a Keir submission supplies historical credit", () => {
  const f = fixture(); delete f.ticket.resolutionAttribution;
  observeTicket(f.data, f.job, f.ticket);
  assert.equal(ticketPerformance(f.data, [f.row], { until: 12000 }).assisted.tickets, 1);
  f.job.resolutionSubmitted = true; f.job.resolutionSubmittedAt = 10500;
  observeTicket(f.data, f.job, f.ticket);
  assert.equal(ticketPerformance(f.data, [f.row], { until: 12000 }).resolved.tickets, 1);
  f.ticket.resolutionAttribution = { agent: "human", evidence: "human supplied the fix" };
  observeTicket(f.data, f.job, f.ticket);
  assert.equal(ticketPerformance(f.data, [f.row], { until: 12000 }).resolved.tickets, 0);
});

test("missing turns/usage/cost remain unknown, while a measured zero stays zero", () => {
  const f = fixture(); observeTicket(f.data, f.job, f.ticket);
  let r = ticketPerformance(f.data, [], { until: 12000 });
  assert.equal(r.tickets[0].turns, null); assert.equal(r.resolved.turns.n, 0);
  assert.equal(r.resolved.missingUsageTickets, 1);
  r = ticketPerformance(f.data, [{ ...f.row, turns: 0, actualBilledUsd: 0 }], { until: 12000 });
  assert.equal(r.tickets[0].turns, 0); assert.equal(r.tickets[0].actualBilledUsd, 0);
  r = ticketPerformance(f.data, [f.row, { ...f.row, turns: null }], { until: 12000 });
  assert.equal(r.tickets[0].turns, null); assert.equal(r.tickets[0].knownTurns, 4);
  assert.equal(r.tickets[0].missingTurns, 1);
});

test("reopens invalidate current success and historical evidence survives in its own conversation", () => {
  const f = fixture(); observeTicket(f.data, f.job, f.ticket);
  const oldKey = keyFor(f.job);
  const fresh = { ...f.job, id: "fresh", channelId: "new", at: 20000, reopenedFromJob: "support" };
  f.data.jobs.fresh = fresh;
  assert.equal(observeTicket(f.data, fresh, f.ticket), false);
  observeTicket(f.data, fresh, { ...f.ticket, status: "in_progress", resolution: null, conversation: { channelId: "new" } });
  const r = ticketPerformance(f.data, [f.row], { until: 30000 });
  assert.equal(r.resolved.tickets, 0); assert.equal(r.reopenedTickets, 1);
  assert.equal(r.pending, 1); assert.equal(f.data.ticketOutcomes[oldKey].receiptId, "r1");
});

test("canonical reopen stops credit even before a fresh Keir task adopts the new channel", () => {
  const f = fixture(); observeTicket(f.data, f.job, f.ticket);
  observeTicket(f.data, f.job, { ...f.ticket, status: "in_progress", resolution: null, conversation: { channelId: "new" } });
  const r = ticketPerformance(f.data, [f.row], { until: 30000 });
  assert.equal(r.resolved.tickets, 0); assert.equal(r.reopenedTickets, 1);
  assert.equal(f.data.ticketOutcomes[keyFor(f.job)].receiptId, "r1");
});

test("multiple attempts in one conversation count all work and earliest pickup once", () => {
  const f = fixture(); f.data.jobs.retry = { ...f.job, id: "retry", at: 5000 };
  observeTicket(f.data, f.job, f.ticket);
  const r = ticketPerformance(f.data, [{ ...f.row, at: new Date(2000).toISOString(), durationMs: 1000 },
    { ...f.row, job: "retry" }], { until: 12000 });
  assert.equal(r.resolved.tickets, 1); assert.equal(r.tickets[0].turns, 8);
  assert.equal(r.tickets[0].pickupToResolutionMs, 9000);
});

test("reconciliation is bounded, backfills done jobs, rotates, and preserves evidence on failure", async () => {
  const f = fixture(); f.job.state = "done";
  f.data.jobs.second = { ...f.job, id: "second", ticket: 13 };
  const ledger = { data: f.data, save() {} }, calls = [];
  await reconcileTickets({ ledger, now: 12000, limit: 1, readTicket: async n => { calls.push(n); return f.ticket; } });
  assert.deepEqual(calls, [12]);
  await reconcileTickets({ ledger, now: 13000, limit: 1, readTicket: async n => { calls.push(n); throw Error("offline"); } });
  assert.deepEqual(calls, [12, 13]);
  assert.equal(f.data.ticketOutcomes[keyFor(f.job)].receiptId, "r1");
});

test("unrelated and post-resolution work is excluded while full lifetime work crosses cohort boundary", () => {
  const f = fixture(); observeTicket(f.data, f.job, f.ticket);
  const early = { ...f.row, at: new Date(2000).toISOString(), durationMs: 1000, turns: 2 };
  const later = { ...f.row, at: new Date(20000).toISOString(), durationMs: 500, turns: 99 };
  const r = ticketPerformance(f.data, [early, f.row, later, { ...f.row, ticket: 99, job: "unrelated" }], { since: 9000, until: 30000 });
  assert.equal(r.tickets[0].turns, 6);
});

test("streaming reader tolerates missing logs and torn lines and validates windows", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-performance-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture(); observeTicket(f.data, f.job, f.ticket);
  const file = path.join(dir, "usage.jsonl");
  assert.equal((await readTicketPerformance(f.data, file, { until: 12000 })).usageLogMissing, true);
  fs.writeFileSync(file, JSON.stringify(f.row) + '\n{"torn":');
  assert.equal((await readTicketPerformance(f.data, file, { until: 12000 })).resolved.turns.mean, 4);
  assert.throws(() => ticketPerformance(f.data, [], { since: 20, until: 10 }), /window/);
});
