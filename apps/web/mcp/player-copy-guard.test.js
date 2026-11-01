"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { internalTerm } = require("./player-copy-guard");

test("internal release details are refused in player copy", () => {
  assert.equal(internalTerm("PR #4442 is in review and automated checks are still running.").kind, "a PR or issue number");
  assert.equal(internalTerm("I filed it as AHDGame issue #4440.").kind, "a PR or issue number");
  assert.equal(internalTerm("It passed the full CI gate and has merged to development.").kind, "CI");
  assert.equal(internalTerm("Fix options are in your decision DM.").kind, "internal routing");
  assert.equal(internalTerm("Let me discover the tools I have access to.").kind, "agent narration");
});

test("ordinary player copy passes", () => {
  assert.equal(internalTerm("The hiring fix is live on the main server. This now has its own ticket, 1628."), null);
  assert.equal(internalTerm("Your iron mine sold 272,050 tons, about 67%."), null);
  assert.equal(internalTerm("The fix is being tested on the sandbox."), null);
});

test("apologies and third-person talk about the player are refused (review 2026-11-01)", () => {
  const { voiceProblem } = require("./player-copy-guard");
  assert.ok(voiceProblem("I owe you a correction. Your agreements do exist."));
  assert.ok(voiceProblem("That was my mistake, and it is why I told him twice."));
  assert.ok(voiceProblem("Sorry for the slow reply."));
  assert.equal(voiceProblem("Correction: you have three agreements, not none."), null);
  assert.equal(voiceProblem("That figure does not match anything the player could have earned."), null);
});
