"use strict";
// Keir 3.0 mandatory acceptance: replay a complete ticket lifecycle through
// the new modules with fake adapters. Player report, owner instruction
// mid-investigation, Luna-shape coding attempt, exact approval asked once,
// CI on two heads, promotion, separate web and worker deploy evidence, live
// verification over later turns, and a question arriving during the long
// fix. Asserts the invariants the 2.x system violated: one record owns the
// ticket, one public message per phase, no double ask, stale CI cannot
// advance current work, deployed is not live, and conversation capacity is
// never consumed by the fix.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCoordinator } = require("../lib/operator/coordinator");
const { createWaitRegistry, ciKey, turnKey } = require("../lib/operator/waits");
const { createEffectGate } = require("../lib/operator/effectgate");
const { createPrincipals } = require("../lib/operator/principals");
const owner = createPrincipals({ ownerId: "owner1", staffIds: [] }).fromAuthenticated({ authorId: "owner1", via: "decision-button" });
const { planPublication, composeAck } = require("../lib/operator/publisher");
const { admit } = require("../lib/operator/admission");
const { planVerification, verificationVerdict } = require("../lib/operator/sla");
const { evaluateGates, buildScopeManifest } = require("../lib/operator/release");

test("full ticket lifecycle replay", () => {
  let clock = 0;
  const now = () => clock;
  const coordinator = createCoordinator({}, { now, leaseMs: 60000 });
  const waits = createWaitRegistry({}, { now });
  const gate = createEffectGate({}, { now });
  const workId = "ticket:4242";
  const published = [];
  let lastStatus = null;
  const facts = {};
  const publish = () => {
    const plan = planPublication({ record: { id: workId, state: "open", attempts: [1], nextAction: "attempt" },
      facts, last: lastStatus, now: clock });
    if (plan.action !== "none") { published.push(plan.phase); lastStatus = { phase: plan.phase, at: clock, messageId: "m1", seq: plan.seq }; }
    return plan;
  };

  // Intake: persisted first, ack composed with no model call.
  assert.equal(coordinator.accept({ id: "msg-1", workId, kind: "instruction", actor: "player" }).accepted, true);
  assert.match(composeAck({ queuedAhead: 0, startingNow: true }), /picking this up now/);
  assert.equal(coordinator.accept({ id: "msg-1", workId, kind: "instruction" }).duplicate, true);

  // SOL investigates, delegates to a Luna-shape attempt, owner intervenes.
  const sol = coordinator.claim(workId, { provider: { runner: "codex", model: "gpt-6.1-sol" } }).attempt;
  coordinator.checkpoint(sol.id, "cause verified in source");
  coordinator.complete(sol.id, "succeeded", [{ kind: "fact", text: "cause verified" }]);
  const luna = coordinator.claim(workId, { provider: { runner: "codex", model: "gpt-6-luna" } }).attempt;
  coordinator.accept({ id: "msg-2", workId, kind: "instruction", actor: "owner", role: "owner" }); // supersedes Luna run
  assert.equal(coordinator.complete(luna.id, "succeeded", [{ text: "stale patch" }]).applied, false);
  // Stale output cannot steer the record, but it is kept and marked late.
  assert.deepEqual(coordinator.get(workId).evidence.map((e) => Boolean(e.late)), [false, true]);
  assert.equal(coordinator.get(workId).nextAction, "attempt");

  // A player question during the fix uses reserved conversation capacity.
  const admitted = admit([
    { id: "fix", kind: "ticket", state: "queued", at: 1 },
    { id: "ask", kind: "conversation", state: "queued", at: 2 },
  ], { now: clock });
  assert.ok(admitted.some((j) => j.id === "ask"));

  // Fresh fix: approval asked once for the exact patch identity.
  const fix = coordinator.claim(workId).attempt;
  coordinator.complete(fix.id, "succeeded", [{ kind: "fact", text: "patch reviewed at digest" }]);
  facts.prepared = true; facts.inPr = true; publish();
  // Opening the dev PR is standing operator authority (no ask); merging is
  // an exact approval, asked once for the exact head.
  const pr = { kind: "patch-publish", target: "repo@base1", contentDigest: "patch-X" };
  assert.equal(gate.propose(pr).needsApproval, false);
  gate.beginExecution(gate.propose(pr).identity);
  gate.recordReceipt(gate.propose(pr).identity, { pr: 99 });
  const spec = { kind: "pr-merge", target: "repo#99", environment: "development", contentDigest: "head2" };
  gate.approve(gate.propose(spec).identity, owner);
  assert.equal(gate.propose(spec).reusedApproval, true);
  assert.equal(gate.authorizeExecution(spec).allowed, true);

  // CI: first head superseded by a new commit; stale green must not count.
  waits.arm({ workId, kind: "ci", correlation: ciKey("R", 99, "head1"), deadlineMs: 3600000 });
  waits.arm({ workId, kind: "ci", correlation: ciKey("R", 99, "head2"), deadlineMs: 3600000 });
  assert.equal(waits.observe(ciKey("R", 99, "head1"), { terminal: true, currentHead: "head2" }).length, 0);
  assert.equal(waits.observe(ciKey("R", 99, "head2"), { terminal: true, result: "green", currentHead: "head2" }).length, 1);
  facts.ciGreen = true; facts.onDevelopment = true; publish();

  // Promotion scope carries an unrelated rider: flagged, owner approves extras.
  const manifest = buildScopeManifest([
    { id: "pr99", tickets: [4242], areas: ["economy"] },
    { id: "pr-rider", tickets: [], areas: ["gameplay"] },
  ]);
  assert.equal(manifest.verdict, "needs-scope-approval");
  facts.onStaging = true; facts.onMain = true; publish();

  // Deploy evidence arrives separately; web first, worker later.
  let gates = evaluateGates({ promotionHeadSha: "head2", ciHeadSha: "head2", ciGreen: true,
    stagingDeployedSha: "head2", prodWebSha: "head2" });
  assert.equal(gates.verdict, "unverified"); // worker unknown
  assert.equal(planVerification({ workId, world: "1991", deployedTurn: 300, workerDeployed: false }).blockedOn,
    "turn-worker deployment");
  facts.webDeployed = true; publish();
  gates = evaluateGates({ promotionHeadSha: "head2", ciHeadSha: "head2", ciGreen: true,
    stagingDeployedSha: "head2", prodWebSha: "head2", turnWorkerSha: "head2" });
  assert.equal(gates.verdict, "verified");
  facts.workerDeployed = true;

  // Live verification over the next two turns gates the word "live".
  const plan = planVerification({ workId, world: "1991", deployedTurn: 300, workerDeployed: true });
  for (const w of plan.waits) waits.arm(w);
  assert.equal(publish().phase, "verifying");
  waits.observe(turnKey(301, "1991"), { terminal: true });
  waits.observe(turnKey(302, "1991"), { terminal: true });
  assert.equal(verificationVerdict([{ outcome: "fixed" }, { outcome: "fixed" }], { expected: plan.expected }).verified, true);
  facts.liveVerified = true;
  assert.equal(publish().phase, "live");
  assert.equal(publish().action, "none"); // live posts exactly once

  coordinator.close(workId, { kind: "resolved", receiptId: "live-302" });
  assert.deepEqual(published, ["preparing", "testing", "releasing", "verifying", "live"]);
});

test("Keir 10.0.3: an incident Keir's own monitor opened gets a Keir task; a staff incident does not (ticket 1831)", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { createLedger } = require("../lib/operator/store");
  const lifecycle = require("../lib/operator/lifecycle");
  const ledger = createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keir-inc-")), "ledger.json"));
  const config = { botId: "bot", taskLifetimeMs: 3600000 };
  const rows = [{ author: { id: "bot" }, embeds: [{}], timestamp: new Date(0).toISOString() }];
  ledger.data.keirIncidents = { 1831: { title: "Turn 6 failed", summary: "Turn 6 failed to finish." } };
  const own = lifecycle.adoptFromIntake(ledger, { id: "c1", name: "ticket-incident-keir-1831" }, rows, { category: "incident", number: 1831, config, now: 1 });
  assert.ok(own && own.keirIncident, "Keir owns its own incident");
  assert.match(own.source.content, /Keir owns it/);
  const staffs = lifecycle.adoptFromIntake(ledger, { id: "c2", name: "ticket-incident-mod-1832" }, rows, { category: "incident", number: 1832, config, now: 1 });
  assert.equal(staffs, null, "a staff incident stays with staff");
  assert.equal(require("../lib/operator/ticketlanes").route(own, ledger.data, null).lane, "outage");
});
