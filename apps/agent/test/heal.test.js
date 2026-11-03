"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("../lib/heal");

const adhoc = {
  kind: "adhoc",
  env: "prod",
  description: "Unstick player 42's campaign flag after the turn 48 crash",
  collection: "characters",
  filter: { _id: "42" },
  action: { kind: "set", set: { campaignStuck: false } },
  expectedMax: 1,
};

test("validateRequest accepts a bounded ad-hoc set and a ledger heal", () => {
  const a = h.validateRequest(adhoc);
  assert.equal(a.ok, true);
  assert.equal(a.spec.kind, "adhoc");
  const l = h.validateRequest({ kind: "ledger", env: "sandbox", defectId: "AHD-1234", ticket: "77" });
  assert.deepEqual(l, { ok: true, spec: { kind: "ledger", env: "sandbox", defectId: "AHD-1234", ticket: 77 } });
});

test("validateRequest refuses the dangerous shapes", () => {
  const cases = [
    [{ ...adhoc, env: "production" }, /env must be/],
    [{ ...adhoc, filter: {} }, /filter is required/],
    [{ ...adhoc, action: { kind: "delete" } }, /deletes are not available/],
    [{ ...adhoc, expectedMax: 0 }, /expectedMax/],
    [{ ...adhoc, expectedMax: 5000 }, /expectedMax/],
    [{ ...adhoc, description: "fix" }, /description is required/],
    [{ ...adhoc, collection: "users; drop" }, /collection is required/],
    [{ kind: "ledger", env: "prod" }, /defectId is required/],
    [{ kind: "shell", env: "prod" }, /kind must be/],
  ];
  for (const [body, re] of cases) {
    const out = h.validateRequest(body);
    assert.equal(out.ok, false, JSON.stringify(body));
    assert.match(out.error, re);
  }
});

test("planCall and applyCall target the right tools and only confirm prod on prod", () => {
  const { spec } = h.validateRequest(adhoc);
  assert.equal(h.planCall(spec, "Egg via Keir").name, "heal_adhoc_plan");
  const apply = h.applyCall(spec, "tok", "Ariane via Keir");
  assert.equal(apply.name, "heal_adhoc_apply");
  assert.equal(apply.args.confirmAdminApply, true);
  assert.equal(apply.args.confirmProd, true);
  assert.equal(apply.args.token, "tok");
  assert.equal(apply.args.kind, undefined);
  // heal-ops mints {id, expiresAt}; apply must receive the id string.
  const minted = h.applyCall(spec, { id: "heal_abc", expiresAt: "2026-10-12T07:00:00Z" }, "op");
  assert.equal(minted.args.token, "heal_abc");
  assert.throws(() => h.applyCall(spec, { expiresAt: "x" }, "op"), /no usable confirm token/);
  const ledger = h.validateRequest({ kind: "ledger", env: "sandbox", defectId: "AHD-1" }).spec;
  const la = h.applyCall(ledger, "t", "op");
  assert.equal(la.name, "heal_apply");
  assert.equal(la.args.confirmProd, undefined);
});

test("planRefusal explains a withheld token", () => {
  assert.equal(h.planRefusal({ ok: true, token: "abc" }), null);
  assert.match(h.planRefusal({ ok: true, token: null, tokenWithheld: "nothing to heal" }), /nothing to heal/);
  assert.match(h.planRefusal({ ok: true, token: null, guards: { refusal: "turn in flight" } }), /turn in flight/);
  assert.match(h.planRefusal({ ok: false, error: "env not configured" }), /env not configured/);
});

test("cardText shows heal-ops' numbers, plain words, and pings the developers", () => {
  const { spec } = h.validateRequest(adhoc);
  const card = h.cardText({
    spec,
    plan: { plan: { affected: 1, moneyDelta: 0, summary: "ignored for ad-hoc" } },
    requester: "Egg",
    people: [{ id: "111", name: "Egg" }, { id: "222", name: "Ariane" }],
  });
  assert.match(card, /asked by Egg/);
  assert.match(card, /Where: the main server · Records changed: 1/);
  assert.doesNotMatch(card, /Money moved/);
  assert.match(card, /<@111> <@222> react ✅ to apply or ❌ to cancel/);
  assert.doesNotMatch(card, /[–—]/);
});

test("a compensation request plans and applies through heal-ops compensation, never an ad-hoc balance set", () => {
  const { validateRequest, planCall, applyCall } = require("../lib/heal");
  const r = validateRequest({ kind: "compensation", env: "prod", ticket: 1498, description: "repay the energy revenue the new-sector clamp held back", credits: [{ corporationId: "6ac3dbf9c6e9f850d977790d", amountLocal: 170000000, basis: "turns 130 to 133" }] });
  assert.equal(r.ok, true);
  assert.equal(r.spec.mode, "credit"); assert.equal(r.spec.expectedMax, 1); assert.equal(r.spec.touchesMoney, true);
  const plan = planCall(r.spec, "op");
  assert.equal(plan.name, "heal_compensate_plan"); assert.equal(plan.args.touchesMoney, undefined); assert.equal(plan.args.credits[0].amountLocal, 170000000);
  assert.equal(applyCall(r.spec, { id: "heal_t" }, "op").name, "heal_compensate_apply");
  assert.equal(validateRequest({ kind: "compensation", env: "prod", description: "repay something owed here", credits: [{ corporationId: "x", amountLocal: 1 }] }).ok, false);
  assert.equal(validateRequest({ kind: "compensation", env: "prod", description: "repay something owed here", credits: [{ corporationId: "6ac3dbf9c6e9f850d977790d", amountLocal: -1 }] }).ok, false);
});

test("validateRequest reads a bare set or unset as the action kind", () => {
  assert.equal(h.validateRequest({ ...adhoc, action: { set: { campaignStuck: false } } }).spec.action.kind, "set");
  assert.equal(h.validateRequest({ ...adhoc, action: { unset: ["campaignStuck"] } }).spec.action.kind, "unset");
  assert.equal(h.validateRequest({ ...adhoc, action: { delete: true } }).ok, false);
});
