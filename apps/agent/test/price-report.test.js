"use strict";
// Keir 10.2.1: tickets 1837 ($3.7B clinic) and 1841 ($22.2M depot) were wrong-number reports answered as mechanics questions.
const test = require("node:test");
const assert = require("node:assert/strict");
const pr = require("../lib/operator/pricereport");
const rc = require("../lib/operator/readclaim");
const { plan } = require("../lib/operator/fastlane");
const lanes = require("../lib/operator/ticketlanes");

const T1841 = "Why does 1 depot cost 22 million dollars";
const T1837 = "I am trying to build 1 clinic and it says it cost 3.7billion";
const REPLY_1841 = "That $22.2M is the build price for what one depot can move a day, not a fee. One depot holds 5 units of daily capacity, priced off what that output is worth at this point in history. Your market share, borrowing rates, CEO skill, local prices and tech move it up or down.";
const mk = (content) => ({ id: "j", kind: "ticket", role: "support", ticket: 1841, history: [], inbox: [], tags: { kind: "mechanics_question", kindConfidence: 0.95 }, source: { authorId: "1", content, attachments: [] } });

test("1841 and 1837 are suspected wrong-number reports; rules questions are not", () => {
  assert.ok(pr.isSuspectNumberReport(T1841));
  assert.ok(pr.isSuspectNumberReport(T1837));
  assert.ok(pr.isSuspectNumberReport("why is my income so low, only $4k"));
  assert.ok(!pr.isSuspectNumberReport("How many votes does cloture need?"));
  assert.ok(!pr.isSuspectNumberReport("why does it cost money to build"));
});

test("the fast lane no longer answers them, and the ticket routes to the investigating lane", () => {
  const cfg = { fastLane: true, askUrl: "x", askSecret: "s" };
  assert.equal(plan(mk(T1841), cfg).skip, "suspected wrong number");
  assert.equal(plan(mk(T1837), cfg).skip, "suspected wrong number");
  assert.equal(plan(mk("How many votes does cloture need?"), cfg).kind, "answer");
  assert.equal(lanes.route(mk(T1841), {}).lane, "bug");
  assert.equal(lanes.route(mk(T1837), {}).lane, "bug");
});

test("the 1841 composition phrasing is an unverified claim without a read, and passes with one that names the parts", () => {
  assert.equal(rc.unbackedClaims(REPLY_1841, [], T1841).length, 3);
  const reads = ["depotPrice = capacity * outputValue * marketShareFactor; borrowing rate, ceoSkill, local price and tech multiply the build price"];
  assert.ok(rc.unbackedClaims("Your market share, borrowing rates, CEO skill, local prices and tech move it up or down.", reads, T1841).length === 0);
});

test("a price explanation is refused with no live read, and when the price is out of proportion to cash", () => {
  const none = pr.refusal(REPLY_1841, { playerText: T1841, reads: [], gameRead: false, backed: false });
  assert.match(none, /reporting 22 million as a wrong-looking number/);
  const reads = ['{"corporation":"McCarthy Logistics","cash":4600000}'];
  const out = pr.refusal(REPLY_1841, { playerText: T1841, reads, gameRead: true, backed: true });
  assert.match(out, /out of proportion/);
  assert.match(out, /raise_to_developers/);
  assert.equal(pr.cashIn(reads), 4600000);
  assert.ok(pr.outOfProportion(pr.reportedFigure(T1841), 4600000));
  assert.ok(!pr.outOfProportion(pr.reportedFigure(T1841), 40000000));
});

test("an expected price may be explained once read and backed; an honest 'looks wrong' reply is never refused", () => {
  const reads = ['{"cash":90000000}'];
  assert.equal(pr.refusal(REPLY_1841, { playerText: T1841, reads, gameRead: true, backed: true }), null);
  assert.match(pr.refusal(REPLY_1841, { playerText: T1841, reads, gameRead: true, backed: false }), /No read shows/);
  const honest = "$22M for one depot looks wrong next to your $4.6M cash. I am checking it as a possible bug and have passed the figures to the developers.";
  assert.equal(pr.refusal(honest, { playerText: T1841, reads: ['{"cash":4600000}'], gameRead: true, backed: true }), null);
  assert.ok(pr.LOOKS_WRONG.test(honest));
});

test("1837: $3.7B for a clinic against a few million in cash is out of proportion", () => {
  const msg = "The $3.7B is the build price for one clinic, priced off market share and fees.";
  const out = pr.refusal(msg, { playerText: T1837, reads: ['cash: 3100000'], gameRead: true, backed: true });
  assert.match(out, /out of proportion/);
});
