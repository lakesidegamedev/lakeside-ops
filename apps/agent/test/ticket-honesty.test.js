"use strict";
// Keir 10.2 (ticket 1837): composition claims need a read, escalations carry findings, unfinished named work is detected.
const test = require("node:test");
const assert = require("node:assert");
const rc = require("../lib/operator/readclaim");
const eb = require("../lib/operator/escalationbrief");

test("a composition claim is unbacked when no read mentions it", () => {
  const msg = "That $1.3B is one clinic before extras, the $3.7B adds market share and fees.";
  const reads = ["canSubmit = cash >= total; total = base + dominanceSurcharge + tollFee"];
  const bad = rc.unbackedClaims(msg, reads, "I am trying to build 1 clinic and it says it cost 3.7billion");
  assert.ok(bad.length >= 1);
});

test("a composition claim is backed when a read contains the same words", () => {
  const msg = "The total adds the dominance surcharge and the toll fee.";
  const reads = ["total = base + dominanceSurcharge + toll fee; the dominance surcharge applies per state"];
  assert.equal(rc.unbackedClaims(msg, reads, "").length, 0);
});

test("a hedged composition claim is not flagged", () => {
  assert.equal(rc.readClaims("It may include fees on top of the base cost.").length, 0);
});

test("escalation brief says what was checked, the evidence and the blocker", () => {
  const out = eb.build({ ticket: 1837, summary: "next investigator to read build dialog pricing", playerAsked: "why 3.7B for one clinic",
    reads: [{ input: JSON.stringify({ server: "gamestate", tool: "trace_corp" }), result: "cash 3.1M" }], codeLookups: 0, codeRead: false, posts: ["not confirmed"] });
  assert.match(out, /Checked: gamestate\.trace_corp/);
  assert.match(out, /code read: no/);
  assert.match(out, /Evidence:\n- gamestate\.trace_corp: cash 3\.1M/);
  assert.match(out, /Blocker: No game code was read/);
});

test("summaries that name undone work are detected", () => {
  assert.ok(eb.namesUnfinishedWork("Blocked on reading the build dialog footer in the next activation."));
  assert.ok(eb.namesUnfinishedWork("next investigator to read build dialog pricing"));
  assert.ok(!eb.namesUnfinishedWork("Told the player the total includes the toll, read from BuildDialog.tsx."));
});
