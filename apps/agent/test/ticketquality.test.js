"use strict";
// Review 2026-11-01: real ticket copy that reached players, now refused.
const test = require("node:test");
const assert = require("node:assert/strict");
const { refusal, emptyResult } = require("../lib/operator/ticketquality");
const statusCard = require("../lib/operator/statuscard");

const kind = (text, ctx) => refusal(text, ctx)?.kind || null;

test("apologies and self-narration are refused (1742, 1743, 1739)", () => {
  assert.equal(kind("I owe you a correction. Your screenshot shows a live agreement, and I am sorry for it."), "confessional");
  assert.equal(kind("I'm taking this one personally. Tracing it now."), "confessional");
  assert.equal(kind("Downloading the app again won't help yet; sorry for the earlier advice saying it would."), "confessional");
  assert.equal(kind("Correction: you have three agreements, not none."), null);
});

test("talking about the player in their own channel is refused (1742)", () => {
  assert.equal(kind("That is why I told him twice that nothing was signed."), "third_person");
  assert.equal(kind("The player has the answer now: the control sits on a rival's page."), "third_person");
  assert.equal(kind("That figure does not match anything the player could have earned."), null, "reports about another player name a third party");
  assert.equal(kind("Other players saw the same price drop."), null);
});

test("a not-there claim after one empty read needs a second, different read (1742)", () => {
  const msg = "Oracle has no supply contract recorded in either direction, so nothing is binding.";
  assert.equal(kind(msg, { emptyReads: [{ sig: "a" }] }), "absence_unconfirmed");
  assert.equal(kind(msg, { emptyReads: [{ sig: "a" }, { sig: "a" }] }), "absence_unconfirmed");
  assert.equal(kind(msg, { emptyReads: [{ sig: "a" }, { sig: "b" }] }), null);
  assert.equal(kind(msg, { emptyReads: [] }), null);
});

test("a promise to change a screen needs something behind it (1736)", () => {
  const msg = "We'll make the mine's page show these deliveries instead of 0% sold.";
  assert.equal(kind(msg), "promise_unbacked");
  assert.equal(kind("I am having that wording fixed."), "promise_unbacked");
  assert.equal(kind(msg, { escalated: true }), null);
  assert.equal(kind(msg, { building: true }), null);
});

test("a developer decision must be on record (1742)", () => {
  const msg = "The developers decided to compensate everyone hit by the pricing bug.";
  assert.equal(kind(msg, { escalated: true }), "decision_unrecorded");
  assert.equal(kind(msg, { decided: true }), null);
});

test("ordinary answers pass", () => {
  for (const t of ["Both fixes are live now. Auto pricing follows what energy actually sold for last turn.", "Nothing you need to do.", "Your Pennsylvania mines made 454 units and sold every one."])
    assert.equal(kind(t, {}), null, t);
});

test("empty results are recognised in the shapes the tools return", () => {
  assert.equal(emptyResult({ docs: [], matched: 0 }), true);
  assert.equal(emptyResult({ content: [{ type: "text", text: "{\"items\":[]}" }] }), true);
  assert.equal(emptyResult("[]"), true);
  assert.equal(emptyResult({ docs: [{ a: 1 }] }), false);
  assert.equal(emptyResult({ ok: true }), false);
});

test("card stages only move forward unless the note says why (1739)", () => {
  assert.match(statusCard.regression({ stage: "main" }, { stage: "sandbox" }), /only move forward/);
  assert.match(statusCard.regression({ stage: "main" }, { stage: "found" }), /only move forward/);
  assert.equal(statusCard.regression({ stage: "main" }, { stage: "sandbox", note: "Rolled back after it failed on the main server" }), null);
  assert.equal(statusCard.regression({ stage: "found" }, { stage: "main" }), null);
  assert.equal(statusCard.regression({ stage: "confirmed" }, { stage: "main" }), null);
  assert.equal(statusCard.regression(undefined, { stage: "found" }), null);
});

test("Fix written needs a fix that exists (1743)", () => {
  assert.equal(statusCard.stageAllowed("written", { investigated: { done: true } }).ok, false);
  assert.equal(statusCard.stageAllowed("written", { building: { done: true } }).ok, true);
});

test("a decision names the developer who approved it (owner, 2026-11-01)", () => {
  const ctx = { decided: true, approvers: ["Egg"], developers: ["Egg", "Ariane"] };
  assert.equal(kind("The developers decided to compensate everyone hit by the pricing bug.", ctx), "decision_unnamed");
  assert.equal(kind("The credit was agreed and is being applied.", ctx), "decision_unnamed");
  assert.equal(kind("Ariane approved compensation for this.", ctx), "decision_unnamed", "the approver on record is Egg");
  assert.equal(kind("Egg approved compensation for everyone hit by the pricing bug.", ctx), null);
  assert.equal(kind("Ariane approved compensation for this.", { ...ctx, approvers: [] }), null, "no approver on record: any developer name");
  assert.equal(kind("Your price setting is approved by the market each turn.", ctx), null);
});
