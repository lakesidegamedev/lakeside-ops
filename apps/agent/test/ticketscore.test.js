"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreTicket, scoreClosed, worst, isLow, laneOf, effectOf } = require("../lib/operator/ticketscore");

const H = 3600000, T0 = Date.parse("2026-11-10T10:00:00Z");
function world(over = {}) {
  return { jobs: { j1: { id: "j1", ticket: 501, kind: "ticket", at: T0, channelId: "c1", tags: { kind: "bug_report" } } }, audit: [], feedbackLog: [], ticketPosts: {}, decisions: {},
    ticketOutcomes: { "501:c1": { ticket: 501, resolvedAt: T0 + 2 * H, createdAt: T0, reopened: false, superseded: false, receiptId: "r1" } }, ...over };
}

test("a clean, quick ticket scores 100", () => {
  const d = world(); scoreClosed(d, T0 + 3 * H);
  assert.equal(d.ticketScores[501].score, 100);
  assert.equal(d.ticketScores[501].lane, "bug");
});

test("each signal lowers the score and the factors are stored", () => {
  const d = world({
    ticketPosts: { 501: [{ text: "Correction: you have three agreements." }, { text: "Hello" }] },
    feedbackLog: [{ ticket: 501, role: "player", kind: "wrong_or_misleading", severity: "serious" }, { ticket: 501, role: "staff", kind: "tone" }, { ticket: 501, role: "player", kind: "praise" }],
    audit: [{ kind: "tool_refused", job: "j1", tool: "channel_reply" }, { kind: "tool_refused", job: "j1", tool: "channel_reply" }, { kind: "tool_refused", job: "j1", tool: "raise_to_developers" },
      ...Array.from({ length: 6 }, () => ({ kind: "cli_activation", job: "j1" }))],
    decisions: { a: { jobId: "j1", state: "done" } },
  });
  d.ticketOutcomes["501:c1"].reopened = true;
  d.ticketOutcomes["501:c1"].resolvedAt = T0 + 60 * H;
  const t = scoreTicket(d, 501, d.ticketOutcomes["501:c1"], T0 + 61 * H);
  assert.deepEqual(Object.keys(t.penalties).sort(), ["activations", "corrections", "hoursOpen", "ownerDecisions", "playerComplaints", "refusals", "reopened", "staffNegative"]);
  assert.equal(t.signals.refusals.reply, 2);
  assert.equal(t.signals.refusals.issue, 1);
  assert.equal(t.signals.activations, 6);
  assert.equal(t.signals.playerComplaints, 2);
  assert.equal(t.bonus, 5);
  assert.ok(t.score < 30, String(t.score));
  assert.ok(isLow(d, 501));
});

test("scoring is idempotent per closure and rescored after a reopen and new closure", () => {
  const d = world(); scoreClosed(d, T0 + 3 * H);
  const first = d.ticketScores[501];
  d.feedbackLog.push({ ticket: 501, role: "player", kind: "slow_or_silent" });
  assert.equal(scoreClosed(d, T0 + 4 * H), 0);
  assert.equal(d.ticketScores[501], first);
  d.ticketOutcomes["501:c1"] = { ...d.ticketOutcomes["501:c1"], reopened: true, resolvedAt: T0 + 9 * H, receiptId: "r2" };
  assert.equal(scoreClosed(d, T0 + 10 * H), 1);
  assert.ok(d.ticketScores[501].score < 100);
});

test("open, merged and superseded tickets are not scored", () => {
  const d = world(); d.ticketOutcomes["501:c1"].resolvedAt = null; assert.equal(scoreClosed(d), 0);
  d.ticketOutcomes["501:c1"].resolvedAt = T0 + H; d.ticketOutcomes["501:c1"].mergedInto = 400; assert.equal(scoreClosed(d), 0);
  d.ticketOutcomes["501:c1"].mergedInto = null; d.ticketOutcomes["501:c1"].superseded = true; assert.equal(scoreClosed(d), 0);
});

test("worst returns the lowest-scored tickets in the window, capped", () => {
  const d = { ticketScores: { 1: { ticket: 1, score: 90, closedAt: T0 }, 2: { ticket: 2, score: 20, closedAt: T0 }, 3: { ticket: 3, score: 40, closedAt: T0 }, 4: { ticket: 4, score: 10, closedAt: T0 - 9 * 24 * H } } };
  assert.deepEqual(worst(d, { since: T0 - 3 * 24 * H, limit: 2, below: 80 }).map((t) => t.ticket), [2, 3]);
});

test("lane and effect mapping", () => {
  assert.equal(laneOf({ lane: "outage" }, {}), "outage");
  assert.equal(laneOf({ tags: { kind: "feature_request" } }, {}), "idea");
  assert.equal(laneOf({ tags: { kind: "mechanics_question" } }, {}), "question");
  assert.equal(effectOf("raise_to_developers"), "issue");
  assert.equal(effectOf("mystery"), "other");
});
