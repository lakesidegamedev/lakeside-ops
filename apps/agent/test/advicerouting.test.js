"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const advice = require("../lib/operator/advicerouting");
const { playbookFor, finishRefusal } = require("../lib/operator/playbooks");
const data = { channels: { c: { category: "gameplay" } }, jobs: {} };
const job = (extra = {}) => ({ id: "j", kind: "ticket", role: "support", ticket: 99, channelId: "c", tags: { kind: "mechanics_question" }, source: { role: "system", content: "I want to know which state or country I can invest for energy or chemical industries" }, ...extra });

test("old mechanics tags still route the original investment question to Ask", () => {
  const j = job(); assert.equal(advice.requiresRedirect(j, data), true);
  assert.equal(playbookFor(j, data).kind, "gameplay_advice");
  assert.throws(() => advice.guard(j, data, "Choose another state with available energy demand."), /Ask/);
  assert.throws(() => advice.guard(j, data, advice.REPLY + " Buy gas plants."), /Ask/);
  assert.doesNotThrow(() => advice.guard(j, data, advice.REPLY));
});
test("factual navigation is not treated as investment advice", () => {
  assert.equal(advice.requiresRedirect(job({ source: { content: "Where is the share holding selector?" } }), data), false);
});
test("concrete defects and repairs keep their support path in a gameplay category", () => {
  for (const kind of ["bug_report", "data_repair", "feature_request", "design_feedback"]) {
    const j = job({ tags: { kind } }); assert.equal(advice.requiresRedirect(j, data), false);
    assert.doesNotThrow(() => advice.guard(j, data, "The share form label is incorrect."));
  }
  assert.equal(advice.requiresRedirect(job({ pullRequests: ["fix"] }), data), false);
  assert.equal(advice.requiresRedirect(job({ incidentCandidates: [{ number: 1 }] }), data), false);
});
test("advice completion needs a delivered redirect after the latest player message, not data reads", () => {
  const j = job({ lastPlayerAt: 10, investigatedReads: 20 });
  assert.match(finishRefusal(j, data, "done"), /Ask/);
  j.adviceRedirectedAt = 11; assert.equal(finishRefusal(j, data, "done"), null);
  j.lastPlayerAt = 12; assert.match(finishRefusal(j, data, "done"), /Ask/);
});
test("advice cannot leak back through closure actions or follow-up text", () => {
  const j = job();
  assert.throws(() => advice.guardResolution(j, data, { message: advice.REPLY, actions: ["Build elsewhere."] }), /Advice resolution/);
  assert.doesNotThrow(() => advice.guardResolution(j, data, { message: advice.REPLY, actions: ["Directed gameplay advice to Ask."], followUp: "Report a concrete bug here if something is broken." }));
});

test("player conversations also redirect advice, including new messages after a greeting", () => {
  const j = job({ kind: "conversation", role: "player", ticket: undefined, tags: { kind: "banter" }, source: { content: "hello" }, inbox: [{ role: "user", content: "Where should I invest in energy?" }] });
  assert.equal(advice.requiresRedirect(j, data), true);
  assert.throws(() => advice.guard(j, data, "Build in another state."), /Ask/);
  assert.equal(advice.requiresRedirect({ ...j, role: "owner" }, data), false);
});
