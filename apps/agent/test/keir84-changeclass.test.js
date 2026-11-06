"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const cc = require("../lib/operator/changeclass");
const policy = require("../lib/operator/replypolicy");

const PAIRS = [
  ["bug_fix", "bugfix"], ["display_fix", "display"], ["data_heal", "data-heal"],
  ["rule_change", "rule"], ["balance_change", "balance"], ["economy_change", "economy-behaviour"],
];

test("one vocabulary: every canonical class and every alias from the other spelling set maps", () => {
  for (const c of cc.CLASSES) assert.equal(cc.normalizeClass(c), c);
  for (const [alias, canonical] of PAIRS) {
    assert.equal(cc.normalizeClass(alias), canonical, alias);
    assert.equal(cc.normalizeClass(alias.replace("_", "-")), canonical, alias);
    assert.equal(cc.normalizeClass(alias.toUpperCase()), canonical, alias);
    assert.equal(cc.parseClass(alias), canonical, alias);
    assert.equal(policy.normalizeChangeClass(alias), canonical, alias);
  }
  assert.deepEqual(policy.CHANGE_CLASSES, [...cc.CLASSES]);
  assert.equal(cc.normalizeClass("nonsense"), null);
  assert.equal(cc.parseClass(""), null);
  assert.throws(() => cc.parseClass("tweak"), /changeClass must be one of/);
});

test("requiresOwner is true exactly for rule, balance and economy-behaviour, in either spelling", () => {
  for (const [alias, canonical] of PAIRS) {
    const gated = ["rule", "balance", "economy-behaviour"].includes(canonical);
    assert.equal(cc.requiresOwner(alias), gated, alias);
    assert.equal(cc.requiresOwner(canonical), gated, canonical);
    assert.equal(policy.requiresOwner(alias), gated, alias);
  }
  assert.equal(cc.requiresOwner(null), false);
});

test("a class recorded with the old names is still gated by the merge and promote guard", () => {
  for (const alias of ["rule_change", "balance_change", "economy_change"]) {
    const klass = cc.classifyChange({ declared: alias, blastClass: "logic" });
    assert.equal(klass.gated, true, alias);
    assert.throws(() => cc.assertShippable({ actions: {} }, { declared: alias, action: "merge", number: 1, ownerId: "o" }), (e) => e.code === "OWNER_APPROVAL_REQUIRED", alias);
  }
  for (const alias of ["bug_fix", "display_fix", "data_heal"]) assert.equal(cc.classifyChange({ declared: alias, blastClass: "logic" }).gated, false, alias);
  assert.equal(cc.classifyChange({ body: "x\nChange-class: rule_change\n", blastClass: "logic" }).gated, true);
});
