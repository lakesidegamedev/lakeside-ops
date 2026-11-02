"use strict";
// Ticket 1749 (2026-11-02): a lead-in stripped to a lower-case post, a no-news update six hours
// after the same news, and a six-hourly wake on a bug report nobody had been assigned.
const test = require("node:test"), assert = require("node:assert/strict");
const { shapeTicketPost } = require("../lib/operator/playercopy");
const { unchangedWait } = require("../lib/operator/supportblockers");

test("a post whose lead-in is stripped still starts with a capital", () => {
  assert.equal(shapeTicketPost("Update: the bank closure is still with the developers."), "The bank closure is still with the developers.");
  assert.equal(shapeTicketPost("the bank closure is open."), "The bank closure is open.");
});

test("an unchanged developer status reads as a waiting notice", () => {
  for (const t of [
    "The bank closure and your request for a warning are still with the developers, and no fix has been built yet.",
    "Nothing has changed since this morning.",
    "No developer answer yet.",
  ]) assert.equal(unchangedWait(t), true, t);
  assert.equal(unchangedWait("The fix for the withdraw button is now in testing."), false);
});
