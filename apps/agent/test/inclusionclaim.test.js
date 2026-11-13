"use strict";
// Keir 9: "X already includes Y, so counting both double counts" needs a read that says the inclusion is whole.
const test = require("node:test");
const assert = require("node:assert");
const { inclusionClaim, inclusionRefusal } = require("../lib/operator/rulelookup");

const PARTIAL_READ = JSON.stringify({ holding: { shareValueIncludesSubsidiary: "partly, through its earnings only" } });
const WHOLE_READ = "The group total includes every subsidiary at book value.";
const UNRELATED_READ = JSON.stringify({ shares: 12, price: 40 });

test("claims: an inclusion or a double-count verdict is a claim, a denial or a question is not", () => {
  for (const m of [
    "The parent's price already carries the subsidiary's profits, so adding both would count the same earnings twice.",
    "Counting both is double counting here.",
    "The group total already includes the branch figures.",
    "The fee is already reflected in the quoted price.",
  ]) assert.ok(inclusionClaim(m), m);
  for (const m of [
    "Counting both would not be double counting.",
    "That is not double counting.",
    "Does the total already include the branch figures?",
    "Net worth counts only the shares held in your own name.",
    "I'm checking whether the price already includes it.",
  ]) assert.equal(inclusionClaim(m), null, m);
});

test("a partial read refuses a whole-inclusion claim and any double-count verdict, and shows the read line", () => {
  const r = inclusionRefusal("The parent's price already carries the subsidiary's profits, so adding both would count them twice.", [PARTIAL_READ]);
  assert.match(r, /only partial/);
  assert.match(r, /partly, through its earnings only/);
  assert.match(inclusionRefusal("The price already reflects part of it, so counting both would be double counting.", [PARTIAL_READ]), /only partial/);
  assert.match(inclusionRefusal("The price already includes the branch.", [PARTIAL_READ]), /only partial/);
});

test("a partial inclusion stated with its limit passes", () => {
  assert.equal(inclusionRefusal("The price already reflects the subsidiary only partly, through its earnings.", [PARTIAL_READ]), null);
});

test("a whole inclusion in the read lets the claim through; no read at all refuses it", () => {
  assert.equal(inclusionRefusal("The total already includes the branch figures, so adding them again would count twice.", [WHOLE_READ]), null);
  assert.match(inclusionRefusal("The total already includes the branch figures.", [UNRELATED_READ]), /nothing this ticket has read says so/);
});

test("a draft that says it is unconfirmed is never refused, and replies without the claim are untouched", () => {
  assert.equal(inclusionRefusal("I have not confirmed this in the game code yet, but the price probably already includes it.", [UNRELATED_READ]), null);
  assert.equal(inclusionRefusal("Net worth counts the shares held in your own name.", [PARTIAL_READ]), null);
});
