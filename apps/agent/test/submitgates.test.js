"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const g = require("../lib/operator/submitgates");
const session = (extra = {}) => ({ job: { submitGates: { copy: true, provenance: true, review: true }, gateEvidence: "Player says they lost 2M." }, evidence: '{"cash":18640000,"currency":"GBP","revenue":235500,"turn":42}', ...extra });

test("copy rules refuse long, dashed, internal or code-like replies with the exact fix", () => {
  assert.match(g.check(session(), { reply: "x".repeat(701) }), /701 characters/);
  assert.match(g.check(session(), { reply: "Your cash — it is fine." }), /dash/);
  assert.match(g.check(session(), { reply: "The NPP ledger moved." }), /internal word/);
  assert.match(g.check(session(), { reply: "See src/lib/cash.ts for details." }), /code-style/);
});

test("numbers must come from evidence, a rescaling of it, or the ticket", () => {
  assert.equal(g.unproven("Your cash is £18.64 million and the sector made $235,500 on turn 42.", '{"cash":18640000,"revenue":235500}').length, 0);
  assert.deepEqual(g.unproven("You have £19,000,000.", '{"cash":18640000}'), [19000000]);
  const s = session();
  assert.match(g.check(s, { reply: "Your cash is £19,000,000." }), /do not appear/);
  assert.equal(g.check(s, { reply: "You said you lost 2M, but your cash is £18,640,000." }), g.REVIEW);
});

test("one review pass, then acceptance; no gates means no checks", () => {
  const s = session();
  assert.equal(g.check(s, { reply: "Your cash is £18,640,000." }), g.REVIEW);
  assert.equal(g.check(s, { reply: "Your cash is £18,640,000." }), null);
  assert.equal(g.check({ job: {} }, { reply: "x".repeat(900) }), null);
  assert.equal(g.check(session(), { other: 1 }), null);
});

test("effect guard refuses asserted approvals and effect scripts, allows reads and tests", () => {
  assert.match(g.effectRefusal("cd repo && node actions.cjs relink --approved-by Egg; echo $?"), /Refused/);
  assert.match(g.effectRefusal("node scripts/refund.cjs 350000"), /Refused/);
  assert.match(g.effectRefusal("python3 tool.py --override"), /Refused/);
  assert.equal(g.effectRefusal("cd repo && node actions.cjs status"), null);
  assert.equal(g.effectRefusal("cd repo && grep -rn relink . && cat actions.cjs"), null);
  assert.equal(g.effectRefusal("cd repo && node --test refund.test.cjs"), null);
  assert.equal(g.effectRefusal("node actions.cjs relink --dry-run"), null);
});

test("an unrendered template never reaches a player", () => {
  assert.match(g.check(session(), { reply: "Your profit fell by £{{d}}." }), /unrendered placeholder \{\{d\}\}/);
});

// Confusion-matrix set: every prohibited command must be refused, every permitted one allowed.
test("effect guard: prohibited and permitted command sets", () => {
  const prohibited = [
    "node actions.cjs relink --approved-by Egg", "cd repo && node actions.cjs relink --approver Ariane", "python3 tool.py --as-owner grant", "bash ops.sh --override",
    "node scripts/refund.cjs 350000", "npx tsx scripts/transfer.ts --to 812", "node actions.cjs credit 5000000", "sh delete-account.sh 4242",
    "node scripts/refund.cjs --dry-run --force", "node payout.cjs --skip-checks",
  ];
  const permitted = [
    "git push --force origin keir/fix", "npm install --force", "git checkout --force main", "cd repo && grep -rn refund src",
    "node --test test/credit.test.js", "npx vitest run src/lib/refund/refund.test.ts", "node actions.cjs status", "node scripts/refund.cjs --dry-run",
    "cat docs/approve-flow.md", "git log --oneline -5",
  ];
  for (const c of prohibited) assert.ok(g.effectRefusal(c), `should refuse: ${c}`);
  for (const c of permitted) assert.equal(g.effectRefusal(c), null, `should allow: ${c}`);
});
