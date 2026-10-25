"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createRecovery } = require("../lib/operator/selfrecovery");
const { openDecision, createDecisions, render } = require("../lib/operator/decisions");
function fixture(job = {}) {
 const data = { jobs: { j: { id: "j", kind: "ticket", ticket: 1658, state: "blocked", ...job } }, actions: {}, decisions: {}, outbox: {} };
 return { data, save(){}, audit(){}, notify(key, destination, content, extra){ data.outbox[key] = { destination, content, ...extra }; } };
}
test("held ownership, missing questions and uncertain receipts never mint permission cards", () => {
 for (const fields of [{ heldSince: 1, updatedAt: 1 }, { ownerDecisionPending: true }, { effects: { write: { state: "uncertain", at: 1 } } }]) {
  const ledger = fixture(fields), handed = [];
  const recovery = createRecovery({ ledger, config: { ownerId: "owner" }, now: () => 10 * 3600000 });
  recovery.tick({}, { supportDeferred: () => true, setTicketOwner: (...args) => handed.push(args) });
  assert.equal(Object.keys(ledger.data.decisions).length, 0);
  assert.equal(Object.keys(ledger.data.outbox).length, 0);
  assert.deepEqual(handed, []);
  if (fields.effects) assert.equal(ledger.data.jobs.j.effects.write.state, "uncertain");
  if (fields.ownerDecisionPending) assert.equal(ledger.data.jobs.j.ownerDecisionPending, true);
 }
});
test("an unbound operational proposal cannot appear as an executable approval", () => {
 const ledger = fixture(), config = { ownerId: "owner" };
 for (const question of ["Restart turn scheduling and clear the auto-pause so turn 412 runs?", "Approve to hand ticket 1658 back to Keir.", "Approve to let Keir proceed with its best verified plan."]) {
  assert.throws(() => openDecision(ledger, config, { jobId: "j", question }), /bound action|No owner decision/i);
 }
 assert.throws(() => openDecision(ledger, config, { jobId: "j", actionId: "handback:1658", question: "Hand it back?" }), /bound action/i);
});
test("obsolete synthetic cards are withdrawn and removed without changing their holds", async () => {
 const ledger = fixture({ ownerDecisionPending: true });
 ledger.data.decisions.old = { id: "old", jobId: "j", actionId: "handback:1658", question: "Hand it back?", state: "pending", selfRecovery: { kind: "handback", ticket: 1658 }, sent: { owner: { channelId: "dm", messageId: "m", content: "old" } } };
 const deleted = [], decisions = createDecisions({ ledger, config: { ownerId: "owner", staffIds: [] }, discord: async (method, route) => { if (method === "DELETE") deleted.push(route); } });
 assert.throws(() => decisions.applyAuthenticatedApp(ledger.data.decisions.old, "approve", "owner"), /obsolete|synthetic/i);
 await decisions.tick();
 assert.equal(ledger.data.decisions.old.state, "withdrawn");
 assert.deepEqual(deleted, ["/channels/dm/messages/m"]);
 assert.equal(ledger.data.jobs.j.state, "blocked");
 assert.equal(ledger.data.jobs.j.ownerDecisionPending, true);
 createRecovery({ ledger, config: { ownerId: "owner" } }).tick({});
 assert.equal(ledger.data.jobs.j.ownerDecisionPending, true);
 assert.equal(ledger.data.jobs.j.state, "blocked");
});
test("a real pending action retains its exact authorization and a single plain question", () => {
 const ledger = fixture();ledger.data.actions.a = { id: "a", jobId: "j", state: "pending", kind: "host", args: { argv: ["true"] } };
 const x = openDecision(ledger, { ownerId: "owner" }, { jobId: "j", actionId: "a", question: "Restart the verified service?" });
 assert.equal(x.actionId, "a"); assert.equal(ledger.data.actions.a.state, "pending");
 const text = render(x.question, { tldr: "Invented pros, cons and recommendation." });
 assert.equal(text.includes("Invented"), false); assert.equal(text.includes("Details:"), false);
 assert.equal(text.split(x.question).length - 1, 1);
});
