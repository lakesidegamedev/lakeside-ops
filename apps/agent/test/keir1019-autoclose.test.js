"use strict";
// Keir 10.1.9: the closing rule.
const test = require("node:test");
const assert = require("node:assert");
const { decideClose, createAutoCloser, isConfirmation, QUIET_MS } = require("../lib/operator/autoclose");

const H = 3600000, NOW = Date.parse("2026-11-17T12:00:00Z");
const snap = (o = {}) => ({ ticket: 7, open: true, running: false, ownerClosureHold: false, pendingDecision: false, pendingHandoffs: false, fixPending: false, held: null,
  lane: "question", answeredAt: NOW - 8 * H, liveAt: 0, lastHumanAt: NOW - 9 * H, lastReplyAt: NOW - 8 * H, lastHumanUnanswered: false, confirmed: false, ...o });

test("confirmation detection: thanks and it worked close; thanks with a catch or a question does not", () => {
  for (const t of ["thanks!", "That worked, thank you", "perfect, it's fixed now", "got it, makes sense"]) assert.equal(isConfirmation(t), true, t);
  for (const t of ["thanks but it is still broken", "thanks, why is it 200k?", "still not fixed", "ok", ""]) assert.equal(isConfirmation(t), false, t);
});

test("rule a: a confirmation after the answer closes at once", () => {
  const d = decideClose(snap({ answeredAt: NOW - 2 * H, lastReplyAt: NOW - 2 * H, lastHumanAt: NOW - 10 * 60000, confirmed: true }), NOW);
  assert.deepEqual([d.action, d.rule], ["close", "a"]);
});

test("rule b: fix live and 6 hours with no player message closes; 5 hours does not", () => {
  const live = { liveAt: NOW - 7 * H, lane: "bug", answeredAt: NOW - 7 * H, lastReplyAt: NOW - 7 * H, lastHumanAt: NOW - 9 * H };
  assert.deepEqual([decideClose(snap(live), NOW).action, decideClose(snap(live), NOW).rule], ["close", "b"]);
  assert.equal(decideClose(snap({ ...live, liveAt: NOW - 5 * H, answeredAt: NOW - 5 * H, lastReplyAt: NOW - 5 * H }), NOW).action, "none");
  // a bug answered but not live is never closed by the quiet rule
  assert.equal(decideClose(snap({ lane: "bug", fixPending: true }), NOW).action, "none");
  assert.equal(decideClose(snap({ lane: "bug" }), NOW).action, "none");
});

test("rule c: an answered question with a quiet player for 6 hours closes; sooner does not", () => {
  const d = decideClose(snap(), NOW);
  assert.deepEqual([d.action, d.rule], ["close", "c"]);
  assert.equal(decideClose(snap({ answeredAt: NOW - 5 * H, lastReplyAt: NOW - 5 * H }), NOW).action, "none");
  assert.equal(decideClose(snap({ lastHumanAt: NOW - 1 * H, lastReplyAt: NOW - 8 * H, lastHumanUnanswered: false }), NOW).action, "none");
  assert.equal(QUIET_MS, 6 * H);
});

test("holds: owner closure hold, owner decision, developer handoff, held, running, unanswered, not answered", () => {
  const confirmed = { confirmed: true, lastHumanAt: NOW - 1000, answeredAt: NOW - 2 * H };
  for (const o of [{ ownerClosureHold: true }, { pendingDecision: true }, { pendingHandoffs: true }, { held: "paused by the owner" }, { running: true }, { open: false }, { lastHumanUnanswered: true }]) {
    assert.equal(decideClose(snap({ ...confirmed, ...o }), NOW).action, "none", JSON.stringify(o));
    assert.equal(decideClose(snap(o), NOW).action, "none", JSON.stringify(o));
  }
  assert.equal(decideClose(snap({ answeredAt: 0 }), NOW).action, "none");
  // a player message after the last reply that is not a confirmation is owed an answer
  assert.equal(decideClose(snap({ lastHumanAt: NOW - 20 * 60000, lastReplyAt: NOW - 8 * H }), NOW).action, "none");
});

// End to end through the closer with a stub broker.
function fixture(jobOver = {}, rows = null) {
  const jobs = { j1: { id: "j1", kind: "ticket", ticket: 7, state: "waiting", at: NOW - 20 * H, channelId: "c1", lane: "question", resolutionReadyAt: NOW - 8 * H, lastPublishedAt: NOW - 8 * H, observedPlayerAt: NOW - 9 * H, lastPlayerAt: NOW - 9 * H, deadline: NOW + 99 * H, ...jobOver } };
  const saved = []; const calls = [];
  const ledger = { data: { jobs, seen: { "ticket:7": "j1" }, decisions: {}, liveSaid: {} }, audit: (k, v) => saved.push([k, v]), save() {} };
  const broker = {
    supportAuthority: async (job) => { assert.equal(job.state, "running"); return rows || [{ id: "10", timestamp: new Date(NOW - 9 * H).toISOString(), author: { id: "p1" }, content: "why is it 200k?" }, { id: "11", timestamp: new Date(NOW - 8 * H).toISOString(), author: { id: "bot", bot: true }, content: "answer" }]; },
    tool: async (job, name, input) => { calls.push({ name, input, state: job.state }); return { ok: true }; } };
  const closer = createAutoCloser({ ledger, broker, config: { ownerId: "own", staffIds: [] }, now: () => NOW });
  return { closer, jobs, calls, saved };
}

test("closer: resolves a quiet answered ticket through support_resolve with one short closing line, then restores waiting", async () => {
  const f = fixture();
  const r = await f.closer.tick();
  assert.deepEqual(r.closed, [{ ticket: 7, rule: "c" }]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].input.tool, "support_resolve");
  assert.match(f.calls[0].input.args.message, /closing this ticket/);
  assert.doesNotMatch(f.calls[0].input.args.message, /[–—]/);
  assert.equal(f.jobs.j1.state, "waiting");
});

test("closer: the player's thanks closes it even when Keir replied later and observation lagged", async () => {
  const rows = [{ id: "10", timestamp: new Date(NOW - 3 * H).toISOString(), author: { id: "p1" }, content: "why 200k?" }, { id: "11", timestamp: new Date(NOW - 150 * 60000).toISOString(), author: { id: "bot", bot: true }, content: "answer" },
    { id: "12", timestamp: new Date(NOW - 30 * 60000).toISOString(), author: { id: "p1" }, content: "ok that makes sense, thanks!" }];
  const f = fixture({ resolutionReadyAt: NOW - 150 * 60000, lastPublishedAt: NOW - 150 * 60000, observedPlayerAt: NOW - 3 * H }, rows);
  const r = await f.closer.tick();
  assert.deepEqual(r.closed, [{ ticket: 7, rule: "a" }]);
  assert.ok(f.jobs.j1.observedPlayerAt >= NOW - 30 * 60000);
});

test("closer: owner closure hold, pending owner decision and an unanswered last message are never closed", async () => {
  for (const over of [{ ownerClosureHold: { handoffId: "h" } }, { ownerDecisionPending: true }]) {
    const f = fixture(over);
    assert.deepEqual((await f.closer.tick()).closed, []);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({}, [{ id: "11", timestamp: new Date(NOW - 8 * H).toISOString(), author: { id: "bot", bot: true }, content: "answer" }, { id: "12", timestamp: new Date(NOW - 7 * H).toISOString(), author: { id: "p1" }, content: "but what about my other depot?" }]);
  assert.deepEqual((await f.closer.tick()).closed, []);
  assert.equal(f.calls.length, 0);
});

test("closer: a refused resolve is remembered and not retried inside the retry window", async () => {
  const f = fixture();
  let n = 0;
  const closer = createAutoCloser({ ledger: { data: { jobs: f.jobs, seen: { "ticket:7": "j1" }, decisions: {}, liveSaid: {} }, audit() {}, save() {} },
    broker: { supportAuthority: async () => [{ id: "10", timestamp: new Date(NOW - 9 * H).toISOString(), author: { id: "p1" }, content: "why is it 200k?" }, { id: "11", timestamp: new Date(NOW - 8 * H).toISOString(), author: { id: "bot", bot: true }, content: "answer" }],
      tool: async () => { n++; throw new Error("give the player the final answer and wait for the closure grace period"); } },
    config: { ownerId: "own", staffIds: [] }, now: () => NOW });
  const r = await closer.tick();
  assert.equal(r.refused.length, 1);
  await closer.tick();
  assert.equal(n, 1);
  assert.equal(f.jobs.j1.state, "waiting");
});
