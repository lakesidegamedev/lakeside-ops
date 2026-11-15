"use strict";
// Keir 10: contradiction with this ticket's earlier posts, and availability claims against a read lock.
const test = require("node:test");
const assert = require("node:assert");
const cc = require("../lib/operator/claimcheck");

const post = (text, minAgo = 5, now = 1e9) => ({ at: now - minAgo * 60000, text, kind: "reply" });
const NOW = 1e9;

test("opposite claims about the same thing are caught, in both directions", () => {
  const cases = [
    ["A fix is being built for the supply problem.", "No fix is being built for the supply problem."],
    ["No fix is being built for the supply problem.", "A fix is being built for the supply problem."],
    ["The supply fix is live on the main server.", "The supply fix is not live yet."],
    ["The supply fix is not live yet.", "The supply fix is now live."],
    ["Marine wings are available at your port.", "Marine wings are not available at your port."],
    ["You can recruit marine wings at your port.", "You cannot recruit marine wings at your port."],
    ["You cannot station a fleet in North America.", "You can station a fleet in North America."],
  ];
  for (const [earlier, draft] of cases) {
    const hit = cc.contradiction(draft, [post(earlier)], { now: NOW });
    assert.ok(hit, `${earlier} / ${draft}`);
    assert.equal(hit.kind, "contradiction");
    assert.match(cc.contradictionRefusal(hit), /Correction:/);
  }
});

test("agreement, unrelated subjects and different predicates are not contradictions", () => {
  const none = [
    ["A fix is being built for the supply problem.", "The supply fix is being built and I will tell you when it is live."],
    ["The supply fix is live.", "The wording fix is not live yet."],
    ["You can recruit marine wings at your port.", "You cannot build a canal in Panama."],
    ["The fix is not live yet.", "Your plant is idle because it has no coal supplier."],
    ["No fix is being built for this.", "The turn finished at noon and your revenue is up."],
  ];
  for (const [earlier, draft] of none) assert.equal(cc.contradiction(draft, [post(earlier)], { now: NOW }), null, `${earlier} / ${draft}`);
});

test("a draft that starts with Correction: is an intended contradiction", () => {
  const earlier = post("A fix is being built for the supply problem.");
  assert.ok(cc.contradiction("No fix is being built for the supply problem.", [earlier], { now: NOW }));
  assert.equal(cc.contradiction("Correction: no fix is being built for the supply problem, the cause was a wrong setting.", [earlier], { now: NOW }), null);
});

test("status cards are not earlier claims, and only recent posts count", () => {
  assert.equal(cc.contradiction("The supply fix is not live yet.", [{ at: NOW, kind: "status_card", text: "The supply fix is live." }], { now: NOW }), null);
  const old = Array.from({ length: 13 }, (_, i) => post(i === 0 ? "The supply fix is live." : "Your plant output looks normal this turn.", 100 - i));
  assert.equal(cc.contradiction("The supply fix is not live yet.", old, { now: NOW }), null, "only the last twelve posts are compared");
});

const READ = "[read_tool] Marine Brigade: not available until 1944. Marine Brigade unlocks in 1944 for every nation.\n[read_tool] Destroyer Flotilla: available from 1900.";

test("calling a locked unit available is flagged when a read this activation says it is locked", () => {
  const hit = cc.unlockConflict("You can recruit the Marine Brigade at your coastal base.", READ);
  assert.ok(hit);
  assert.match(hit.noun, /marine/);
  assert.match(cc.unlockRefusal(hit), /not available until 1944/);
  assert.ok(cc.unlockConflict("The Marine Brigade is available to you now.", READ));
  assert.ok(cc.unlockConflict("Marine Brigade units can be recruited at any port.", READ));
});

test("saying it is locked, naming the year, or naming something else is fine", () => {
  assert.equal(cc.unlockConflict("The Marine Brigade is not available until 1944.", READ), null);
  assert.equal(cc.unlockConflict("The Marine Brigade unlocks in 1944, so you cannot recruit it yet.", READ), null);
  assert.equal(cc.unlockConflict("You can recruit the Destroyer Flotilla at your coastal base.", READ), null);
  assert.equal(cc.unlockConflict("You can recruit the Marine Brigade at your coastal base.", "[read_tool] Marine Brigade: 4000 men, strength 12."), null, "no lock read, no flag");
});

test("other lock phrasings work for any noun", () => {
  const text = "[read_tool] The Carrier Group opens in 1941.\n[read_tool] Rail Guns are locked until the second era.";
  assert.ok(cc.unlockConflict("The Carrier Group is available at your port.", text));
  assert.ok(cc.unlockConflict("You can build Rail Guns in your arsenal.", text));
  assert.equal(cc.unlockConflict("Your arsenal builds tanks.", text), null);
});
