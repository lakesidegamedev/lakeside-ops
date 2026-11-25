"use strict";
// Keir guardrails before re-enable (owner decision 2026-11-22): incident context, evidence-gated claims, one message per
// reply, no balance or design work from tickets, auto-escalation, and the Terra ticket route.
const test = require("node:test");
const assert = require("node:assert");
const g = require("../lib/operator/guardrails");
const { setup } = require("./keir10-post.helpers");
const { splitReply } = require("../lib/operator/replysplit");
const pb = require("../lib/operator/postbudget");

const NOW = Date.parse("2026-11-22T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const turn = (n, ok, h = 1, extra = {}) => ({ turn: n, success: ok, finishedAt: hoursAgo(h), ...extra });

// ---- 1. incident context -------------------------------------------------------------------------------------------

test("incident context lists open incidents and failures of the last 24 hours, and ignores older ones", () => {
  const rows = g.turnRows([turn(108, false, 20, { failedPhases: ["corporationTurn"] }), turn(109, true, 18), turn(100, false, 40), turn(110, true, 5)]);
  const ctx = g.incidentContext({ incidents: [{ number: 1871, title: "Turn 108 failed" }], rows, now: NOW });
  assert.deepEqual(ctx.openIncidents, [{ number: 1871, title: "Turn 108 failed" }]);
  assert.deepEqual(ctx.turnFailures24h.map((f) => f.turn), [108], "turn 100 is older than 24 hours");
  assert.equal(ctx.lastFailureTurn, 108);
  assert.equal(ctx.cleanTurnsSinceLastFailure, 2);
  assert.equal(ctx.recoveryAllowed, true);
  assert.match(ctx.instruction, /turn 108/);
});

test("failure rows from turn_failure_detail count as failures", () => {
  const rows = g.failureRows({ turn: 108, attempts: [{ success: false, realTime: hoursAgo(3), failedPhases: ["bankingTurn"] }, { success: true, realTime: hoursAgo(2) }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turn, 108); assert.equal(rows[0].phase, "bankingTurn");
});

test("recovered is refused until two clean turns follow the last failure", () => {
  const mk = (clean) => g.incidentContext({ incidents: [{ number: 1871, title: "t" }], rows: g.turnRows([turn(108, false, 4), ...Array.from({ length: clean }, (_, i) => turn(109 + i, true, 3 - i))]), now: NOW });
  for (const clean of [0, 1]) {
    const why = g.recoveryRefusal(mk(clean), "Good news, the incident has recovered and turns are running normally.");
    assert.match(why, /only \d clean turn/, `clean=${clean}`);
    assert.match(why, /turn 108/);
  }
  assert.equal(g.recoveryRefusal(mk(2), "Good news, the incident has recovered."), null);
  assert.equal(g.recoveryRefusal(mk(0), "Turn 108 failed and I am waiting for two clean turns before calling it recovered."), null, "a sentence that denies or conditions recovery is fine");
});

test("an open incident with no failure in the window still blocks a recovery claim; an unreadable record blocks it too", () => {
  const open = g.incidentContext({ incidents: [{ number: 1871, title: "t" }], rows: [], now: NOW });
  assert.match(g.recoveryRefusal(open, "That is resolved now."), /incident #1871 is still open/);
  const blind = g.incidentContext({ readable: false, now: NOW });
  assert.match(g.recoveryRefusal(blind, "Everything is back to normal."), /could not be read/);
  assert.equal(g.recoveryRefusal(g.incidentContext({ rows: [], now: NOW }), "Everything is back to normal."), null);
});

test("through the post path: a ticket post saying recovered is refused while the failure is fresh, and goes out after two clean turns", async () => {
  let turns = [turn(108, false, 4, { failedPhases: ["x"] }), turn(109, true, 3)];
  const f = setup({ call: async (_s, tool) => (tool === "recent_turns" ? turns : tool === "turn_failure_detail" ? { turn: 108, attempts: [] } : { ok: true, delivery: { posted: true, delivery: { status: "posted" } } }) });
  f.job.incidentContext = null;
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "The turn problem has recovered and turns are running normally again." }), /only 1 clean turn/);
  assert.equal(f.audits("recovery_refused").length, 1);
  f.advance(2); // past the one minute cache
  turns = [turn(108, false, 4, { failedPhases: ["x"] }), turn(109, true, 3), turn(110, true, 2)];
  f.job.incidentContextAt = 0;
  const r = await f.broker.tool(f.job, "channel_reply", { message: "The turn problem has recovered and turns are running normally again." });
  assert.equal(r.published, true);
});

test("the agent context carries the incident facts for a ticket job", async () => {
  const f = setup({ call: async (_s, tool) => (tool === "recent_turns" ? [turn(108, false, 2)] : { ok: true }) });
  const ctx = await f.broker.incidentContext(f.job);
  assert.equal(ctx.lastFailureTurn, 108);
  assert.equal(f.job.incidentContext, ctx);
});

// ---- 2. evidence-gated claims ---------------------------------------------------------------------------------------

const REPORTER = { id: "4242", name: "Fixture Player", username: "fixtureplayer" };
const EVIDENCE = "[reporter_state] character Fixture Player; [corporations] Fixture Mining cash 1,250,000 revenue 480000 turn 112";

test("a causal or outcome claim about money needs a read of the player's own record", () => {
  const claim = "Your construction spending is why your sales rose.";
  assert.equal(g.claimProblems({ message: claim, evidence: "", reporter: REPORTER })[0].why, "entity");
  assert.equal(g.claimProblems({ message: claim, evidence: "[support_list] other player Someone Else sales", reporter: REPORTER })[0].why, "entity");
  assert.deepEqual(g.claimProblems({ message: claim, evidence: EVIDENCE, reporter: REPORTER }), []);
  assert.equal(g.claimProblems({ message: claim, evidence: EVIDENCE, reporter: null })[0].why, "entity", "an unknown reporter cannot be matched");
});

test("running, fixed, live and paid claims are covered; findings, plans, hedges and questions are not", () => {
  const n = (m) => g.claimSentences(m).length;
  assert.equal(n("The clinics are running."), 1);
  assert.equal(n("Your payments went through."), 1);
  assert.equal(n("Your dividend was paid out."), 1);
  assert.equal(n("The salary fix is live."), 1);
  assert.equal(n("I am checking whether your clinics are running."), 0);
  assert.equal(n("Your clinics might be running."), 0);
  assert.equal(n("Are your clinics running?"), 0);
  assert.equal(n("Your payment will go through next turn."), 0);
  assert.equal(n("I have not confirmed your payments were paid."), 0);
  assert.equal(n("The fund buys only Austrian bonds because candidates are sorted by country code."), 0, "a mechanic with no player entity is the rule lookup's job");
});

test("when a failure overlaps the period, the claim must name the turn range", () => {
  const incident = g.incidentContext({ incidents: [{ number: 1871, title: "t" }], rows: g.turnRows([turn(108, false, 6), turn(109, false, 5), turn(110, true, 4), turn(111, true, 3)]), now: NOW });
  const bare = g.claimProblems({ message: "Your cash is 1,250,000 now.", evidence: EVIDENCE, reporter: REPORTER, incident });
  assert.equal(g.claimProblems({ message: "Your cash is 1,250,000 now.", evidence: "", reporter: REPORTER, incident })[0].why, "entity", "a bare figure about the player's own money is a claim");
  assert.equal(bare[0].why, "turn range"); assert.match(bare[0].detail, /turns 108 to 109/);
  assert.deepEqual(g.claimProblems({ message: "Your cash is 1,250,000 as of turn 112, after the failed turns 108 to 109.", evidence: EVIDENCE, reporter: REPORTER, incident }), []);
});

test("through the post path: a claim without evidence is refused even when the ticket has a verified release", async () => {
  const f = setup({ noEntityRead: true });
  f.ledger.data.jobs[f.job.id].releaseEvidence = { pr1: { main: true, verified: true, at: f.now() - 1000 } }; // the old ticket-wide bypass
  f.playerWrote(5);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Your clinics are running again after the fix." }), /no read in this activation shows a record for this player's own character/);
  assert.equal(f.audits("claim_refused").length, 1);
  assert.equal(f.posts().length, 0);
  f.job.reporterCharacter = REPORTER; f.job.evidenceText = EVIDENCE;
  const r = await f.broker.tool(f.job, "channel_reply", { message: "Your clinics are running again after the fix." });
  assert.equal(r.published, true);
});

// ---- 3. one message per reply ---------------------------------------------------------------------------------------

test("a reply is one Discord message unless it passes 2000 characters; the hourly cap defaults to 3", () => {
  const multi = "First finding about your plant.\n\nSecond finding about the contract. Third sentence here. Fourth sentence here.\n\n- one\n- two";
  assert.deepEqual(splitReply(multi), [multi]);
  assert.equal(splitReply("x ".repeat(1500)).length, 2);
  assert.equal(pb.DEFAULT_PER_HOUR, 3);
});

test("a turn recap is not called for by the closing condition alone", () => {
  const posts = [{ at: 10, text: "Turn 27: every basket sold." }];
  const msg = "Turn 28: shops did not sell out; some went unsold.";
  assert.equal(pb.turnPostRule({ posts, humanAt: 0, message: msg, calledFor: true }).why, "turn not called for");
  assert.equal(pb.turnPostRule({ posts, humanAt: 20, message: msg }), null, "the player asked");
  assert.equal(pb.turnPostRule({ posts, humanAt: 0, message: msg, promiseDue: true }), null, "a promise is due");
});

// ---- 4. no design or balance work from tickets ----------------------------------------------------------------------

test("balance changes are recognised by path and by wording", () => {
  const eco = /^src\/lib\/(economy|market)\//;
  assert.match(g.balanceChange({ files: ["src/lib/economy/rates.ts"], economyPaths: eco }), /changes src\/lib\/economy/);
  assert.match(g.balanceChange({ files: ["src/data/recipes.json"] }), /recipes\.json/);
  assert.match(g.balanceChange({ texts: ["fix(economy): cut mining input costs by 20%", "Lowers the input rate."] }), /cut mining input costs/);
  assert.match(g.balanceChange({ texts: ["Rescale logistics recipe to 8/9"] }) || "", /recipe/i);
  assert.equal(g.balanceChange({ files: ["src/components/Panel.tsx"], texts: ["fix(ui): show the right label", "The label was wrong."] }), null);
});

test("offers to build and quotes of the owner's intent are refused", () => {
  assert.equal(g.scopeProblem("Say the word and I build a state debt system with a 25% cap.").kind, "offer");
  assert.equal(g.scopeProblem("I can build a sales health card for you.").kind, "offer");
  assert.equal(g.scopeProblem("Egg said the owner has settled on one governor bill.").kind, "intent");
  assert.equal(g.scopeProblem("The owner decided this is working as intended.").kind, "intent");
  assert.equal(g.scopeProblem("Your sector page shows 25% of output sold. I have passed this to staff for review."), null);
});

test("through the post path: an offer to build files one owner card, tells the player staff will review, and posts nothing", async () => {
  const cards = [];
  const f = setup({ call: async (s, tool, args) => { if (tool === "kanban_add") { cards.push(args); return { id: 900 + cards.length }; } return tool === "kanban_list" ? [] : { ok: true }; } });
  f.playerWrote(5);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Say the word and I build a sales health card for you." }), /offers to build[\s\S]*passed this to staff for review/);
  assert.equal(f.posts().length, 0);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "The owner has decided this is working as intended." }), /quotes or describes/);
  assert.equal(cards.length, 1, "one owner card per ticket, however many drafts are refused");
  assert.match(cards[0].title, /Ticket 123: owner decision/);
  assert.equal(f.ledger.data.ownerCards[123].id, 901);
});

test("publish_patch applies the balance rule to the changed files, title and description", () => {
  const patch = "diff --git a/src/lib/economy/rates.ts b/src/lib/economy/rates.ts\n--- a/src/lib/economy/rates.ts\n+++ b/src/lib/economy/rates.ts\n@@ -1 +1 @@\n-export const MINING_INPUT = 10;\n+export const MINING_INPUT = 8;\n";
  const files = [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
  assert.match(g.balanceChange({ files, texts: ["fix(mining): lower input costs", "Cuts mining input cost."], economyPaths: /^src\/lib\/economy\// }), /src\/lib\/economy\/rates\.ts/);
});

test("a delegate_fix for a balance change is refused with an owner card", async () => {
  const cards = [];
  const f = setup({ call: async (s, tool, args) => { if (tool === "kanban_add") { cards.push(args); return { id: 960 }; } return tool === "kanban_list" ? [] : { ok: true }; } });
  await assert.rejects(f.broker.tool(f.job, "delegate_fix", { instructions: "Rebalance the mining recipe: cut the input rate by 20% so margins recover." }), /Not delegated[\s\S]*staff for review/);
  assert.equal(cards.length, 1);
  assert.equal(f.audits("balance_delegate_refused").length, 1);
});

// ---- 5. auto-escalation ---------------------------------------------------------------------------------------------

test("challenge phrases, two corrections and a wake cap each escalate; ordinary messages do not", () => {
  for (const t of ["are you sure?", "you didn't answer my question", "that's not true", "wrong", "dumb ai bot", "That is wrong."]) assert.ok(g.escalation({ playerText: t }) || /^wrong$/.test(t) && g.challenge("you are wrong") , t);
  assert.equal(g.escalation({ playerText: "are you sure about that" }).why, "player_challenge");
  assert.equal(g.escalation({ playerText: "ok thanks, that helps", corrections: 1 }), null);
  assert.equal(g.escalation({ playerText: "ok", corrections: 2 }).why, "repeated_corrections");
  assert.equal(g.escalation({ wakeCapped: true }).why, "wake_cap");
  assert.equal(g.escalation({ playerText: "are you sure", already: true }), null, "only once per ticket");
});

test("a player challenge with no worker available falls back to staff: one staff-reviewing message, a person card, no owner DM (owner rule 2026-11-23)", async () => {
  const f = setup({ call: async (s, tool) => (tool === "kanban_add" ? { id: 970 } : tool === "kanban_list" ? [] : { ok: true, delivery: { posted: true, delivery: { status: "posted" } } }) });
  f.job.lastPublishedAt = f.now() - 60000; // Keir has already answered
  f.job.inbox = [{ authorId: "888888888888888888", messageId: "5001", role: "player", content: "are you sure? that's not true", at: new Date(f.now()).toISOString() }];
  const e = await f.broker.escalationCheck(f.job);
  assert.equal(e.why, "player_challenge");
  assert.deepEqual(f.posts(), [g.STAFF_REVIEWING], "one short message");
  assert.equal(f.ledger.data.ticketEscalations[123].card, 970, "a person card is on the board");
  assert.equal(f.ledger.data.outbox["escalation:123"], undefined, "the owner is not DMed");
  assert.ok((f.ledger.data.alerts || []).some((a) => a.key === "escalation:123" && a.digest), "it goes to the daily digest");
  assert.equal(f.ledger.data.ticketPauses[123].by, "keir-escalation", "Keir is paused on the ticket");
  assert.equal(await f.broker.escalationCheck(f.job), null);
  assert.equal(f.posts().length, 1);
});

test("an opening report that says it is wrong is not a challenge to Keir", async () => {
  const f = setup({ call: async (s, tool) => (tool === "kanban_add" ? { id: 973 } : { ok: true }) });
  f.job.inbox = [{ authorId: "888888888888888888", messageId: "5003", role: "player", content: "my sales number is wrong, that is wrong", at: new Date(f.now()).toISOString() }];
  assert.equal(await f.broker.escalationCheck(f.job), null);
  assert.equal(f.audits("ticket_escalated").length, 0);
});

test("a wake cap hit escalates, and the same message is never checked twice", async () => {
  const f = setup({ call: async (s, tool) => (tool === "kanban_add" ? { id: 971 } : tool === "kanban_list" ? [] : { ok: true, delivery: { posted: true, delivery: { status: "posted" } } }) });
  const e = await f.broker.escalationCheck(f.job, { wakeCapped: true });
  assert.equal(e.why, "wake_cap");
  assert.equal(f.audits("ticket_escalated").length, 1);
});

test("a second correction on one ticket escalates on the next player message", async () => {
  const f = setup({ call: async (s, tool) => (tool === "kanban_add" ? { id: 972 } : tool === "kanban_list" ? [] : { ok: true, delivery: { posted: true, delivery: { status: "posted" } } }) });
  f.ledger.audit("correction_posted", { job: f.job.id, ticket: 123 }); f.ledger.audit("correction_posted", { job: f.job.id, ticket: 123 });
  f.job.lastPublishedAt = f.now() - 60000;
  f.job.inbox = [{ authorId: "888888888888888888", messageId: "5002", role: "player", content: "still not working for me", at: new Date(f.now()).toISOString() }];
  assert.equal((await f.broker.escalationCheck(f.job)).why, "repeated_corrections");
});

// ---- 6. routing -----------------------------------------------------------------------------------------------------

test("the default ticket route is GPT Terra at high effort", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "operator.js"), "utf8");
  assert.match(src, /ticketProvider: env\.KEIR_TICKET_PROVIDER \|\| "codex:gpt-6\.1-terra@high"/);
});
