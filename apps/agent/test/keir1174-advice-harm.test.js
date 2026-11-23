"use strict";
// Keir 11.7.4 (ticket 1884): a gameplay-category ticket with a fix on it is not advice; Keir answers instead of
// sending the player to Ask.
const test = require("node:test");
const assert = require("node:assert/strict");
const advice = require("../lib/operator/advicerouting");

const job = (extra = {}) => ({ id: "j", kind: "ticket", role: "support", ticket: 1884, tags: { kind: "gameplay_advice" }, source: { content: "how do we fix our margins to go back to how it was" }, ...extra });

test("a plain advice ticket still gets the Ask redirect", () => {
  advice.resetAskHealth();
  assert.equal(advice.requiresRedirect(job(), { jobs: {}, statusCards: {} }), true);
});

test("a fix live on the ticket's card means a real answer, not the redirect", () => {
  advice.resetAskHealth();
  const d = { jobs: {}, statusCards: { 1884: { items: [{ name: "Bank branches", stage: "main" }] } } };
  assert.equal(advice.requiresRedirect(job(), d), false);
  assert.doesNotThrow(() => advice.guard(job(), d, "Inputs rose 58% to 75% of revenue; make less and cancel the new branches."));
});

test("a pull request on another task for the same ticket also counts", () => {
  advice.resetAskHealth();
  const d = { jobs: { other: { id: "other", ticket: 1884, pullRequests: ["https://github.com/lakesidegamedev/AHDGame/pull/7288"] } }, statusCards: {} };
  assert.equal(advice.requiresRedirect(job(), d), false);
  assert.equal(advice.requiresRedirect(job({ ticket: 1999 }), d), true, "another ticket's fix does not count");
});
