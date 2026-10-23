"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { reconcileTickets } = require("../lib/operator/ticketoutcomes");
const { createRecovery } = require("../lib/operator/selfrecovery");
function fixture() {
  const job = { id: "old", kind: "ticket", ticket: 12, channelId: null, state: "blocked", at: 1000, effects: {}, ownerDecisionPending: true };
  const data = { jobs: { old: job }, decisions: {
    ask: { id: "ask", jobId: "old", state: "pending" },
    handback: { id: "handback", jobId: "old", state: "approve", selfRecovery: { kind: "handback", ticket: 12 } },
  }, actions: {}, outbox: {}, supportOwner: { tickets: { 12: "staff" } } };
  const ledger = { data, audit() {}, save() {} };
  const ticket = { number: 12, status: "resolved", conversation: { channelId: "closed-conversation" },
    resolution: { receiptId: "receipt", resolvedAt: 2000, channelDelivery: { status: "posted" } } };
  return { job, data, ledger, ticket };
}
test("canonical delivered closure retires an unbound stale worker and suppresses recovery approvals", async () => {
  const f = fixture();
  await reconcileTickets({ ledger: f.ledger, readTicket: async () => f.ticket, now: 10000 });
  assert.equal(f.job.state, "done"); assert.equal(f.job.resolved, true);
  assert.equal(f.data.decisions.ask.state, "withdrawn");
  assert.equal(f.job.resolutionSubmitted, undefined, "do not claim a new resolution or its credit");
  let transfers = 0;
  const recovery = createRecovery({ ledger: f.ledger, config: { ownerId: "owner" }, now: () => 20000 });
  recovery.tick({}, { supportDeferred: () => true, setTicketOwner: () => { transfers++; } });
  assert.equal(transfers, 0); assert.equal(f.job.state, "done");
});
test("answered handback cannot revive an already terminal worker", () => {
  const f = fixture(); f.job.state = "done"; f.job.resolved = true;
  let transfers = 0;
  createRecovery({ ledger: f.ledger, now: () => 20000 }).tick({}, { setTicketOwner: () => { transfers++; } });
  assert.equal(transfers, 0); assert.equal(f.job.inbox, undefined);
});
test("missing closure proof, reopened conversation and uncertain work remain untouched", async () => {
  for (const change of [f => { f.ticket.status = "open"; }, f => { f.ticket.resolution = null; },
    f => { f.ticket.resolution.channelDelivery.status = "pending"; }, f => { f.ticket.number = 99; },
    f => { f.job.channelId = "different-conversation"; },
    f => { f.job.effects.write = { state: "uncertain" }; },
    f => { f.data.actions.write = { jobId: "old", state: "executing" }; }]) {
    const f = fixture(); change(f);
    await reconcileTickets({ ledger: f.ledger, readTicket: async () => f.ticket, now: 10000 });
    assert.equal(f.job.state, "blocked"); assert.equal(f.data.decisions.ask.state, "pending");
  }
});
