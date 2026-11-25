"use strict";
// 2026-11-23: tickets stalled overnight (1884, 1886, 1889, 1891). The wake cap handed tickets to staff who were not there,
// the sweeper DMed the owner instead of starting a worker, a promised follow-up failed with nobody sent, a wrong public
// correction went out unchecked, patch reads timed out and were reported as "larger than 2 MB", and Keir told a player it
// "still needed" data it could read itself. Synthetic ticket, names and ids only.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const g = require("../lib/operator/guardrails");
const { setup } = require("./keir10-post.helpers");
const { createLedger } = require("../lib/operator/store");
const { createCodingWorkers } = require("../lib/operator/codingworkers");
const inv = require("../lib/operator/investigation");
const promises = require("../lib/operator/promises");
const own = require("../lib/operator/ownlookups");
const { patchReadError, createDelegation } = require("../lib/operator/delegation");
const { GIT_CONFIG } = require("../lib/operator/sandbox");

const posted = async (s, tool) => (tool === "kanban_add" ? { id: 990 } : tool === "kanban_list" ? [] : { ok: true, delivery: { posted: true, delivery: { status: "posted" } } });

// ---- wake cap -> worker -------------------------------------------------------------------------------------------

test("a wake cap hands the ticket to a worker: one plain line, no pause, no staff, Keir keeps posting (1891)", async () => {
  const asked = [];
  const workers = { queueInvestigation: (a) => { asked.push(a); return { skipped: false, run: { id: "cw-123-1" } }; } };
  const f = setup({ call: posted, codingWorkers: () => workers });
  f.job.runStarts = Array.from({ length: 6 }, (_, i) => f.now() - i * 60000);
  const e = await f.broker.escalationCheck(f.job, { wakeCapped: true });
  assert.equal(e.handedTo, "cw-123-1");
  assert.equal(asked.length, 1); assert.equal(asked[0].stall, true); assert.match(asked[0].reason, /retry limit \(6 runs/);
  assert.deepEqual(f.posts(), [g.CAP_HANDOFF_LINE], "the player hears one plain line");
  assert.doesNotMatch(g.CAP_HANDOFF_LINE, /staff|stopped/i);
  assert.equal(f.ledger.data.ticketEscalations?.[123], undefined, "not handed to staff");
  assert.equal(f.ledger.data.ticketPauses?.[123], undefined, "not paused");
  assert.equal(f.ledger.data.outbox?.["escalation:123"], undefined, "no owner DM");
  assert.equal(f.audits("cap_handoff").length, 1);
  assert.equal(f.ledger.data.ticketPromises[123].filter((p) => p.state === "open").length, 1, "the line is tracked as a promise");
  // A second cap inside six hours does nothing more.
  assert.equal(await f.broker.escalationCheck(f.job, { wakeCapped: true }), null);
  assert.equal(f.posts().length, 1); assert.equal(asked.length, 1);
});

test("a wake cap with a worker already on the ticket posts nothing new", async () => {
  const f = setup({ call: posted, codingWorkers: () => ({ queueInvestigation: () => ({ skipped: true, active: true, run: { id: "cw-123-9" } }) }) });
  const e = await f.broker.escalationCheck(f.job, { wakeCapped: true });
  assert.equal(e.handedTo, "cw-123-9");
  assert.deepEqual(f.posts(), []);
});

test("a wake cap falls back to the staff hand-off only when no worker can start", async () => {
  const f = setup({ call: posted, codingWorkers: () => ({ queueInvestigation: () => ({ skipped: true, permanent: true, reason: "coding workers are switched off" }) }) });
  const e = await f.broker.escalationCheck(f.job, { wakeCapped: true });
  assert.equal(e.why, "wake_cap");
  assert.match(f.ledger.data.ticketEscalations[123].detail, /no worker could be started \(coding workers are switched off\)/);
  assert.equal(f.audits("cap_handoff_failed").length, 1);
});

test("old corrections hand off once, not again every six hours after the ticket is answered (1884)", async () => {
  const asked = [];
  const f = setup({ call: posted, codingWorkers: () => ({ queueInvestigation: () => { asked.push(1); return { skipped: false, run: { id: `cw-123-${asked.length}` } }; } }) });
  f.ledger.data.ticketPosts = { 123: [{ text: "Correction: the price fell, not rose." }, { text: "Correction: it was turn 12." }] };
  const first = await f.broker.escalationCheck(f.job);
  assert.equal(first.why, "repeated_corrections");
  f.advance(7 * 60);
  assert.equal(await f.broker.escalationCheck(f.job), null, "same corrections, no second recheck");
  assert.equal(asked.length, 1);
  f.ledger.data.ticketPosts[123] = [1, 2, 3].map((i) => ({ text: `Correction: fix ${i}.` }));
  f.advance(7 * 60);
  assert.equal((await f.broker.escalationCheck(f.job)).why, "repeated_corrections", "a new correction hands off again");
  assert.equal(asked.length, 2);
});

// ---- stall pickup by the investigation worker ---------------------------------------------------------------------

function workers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-stall-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const cw = createCodingWorkers({ ledger, api: {}, stateDir: dir, readFile: () => "", mkdir: () => {}, host: () => ({ memAvailableKb: 64e6, load1: 0, cpus: 18 }) });
  const job = ledger.createJob("t", { kind: "ticket", ticket: 1886, role: "support", source: { content: "Provincial votes use the wrong seat count" } });
  job.state = "waiting"; job.summary = "Fix written; waiting.";
  job.raisedToDevelopers = [{ id: 255710, title: "Bill votes use the Senate seat count", blocking: false }, { id: 255729, title: "Restore review of the voting correction", blocking: true }];
  return { ledger, cw, job };
}

test("a stalled ticket gets a worker even when the cause is not marked unverified, with Keir's open cards in its brief (1886)", () => {
  const { cw, job } = workers();
  assert.equal(cw.queueInvestigation({ job }).skipped, true, "without stall the old rule holds");
  const out = cw.queueInvestigation({ job, reason: "no progress for 6 h", stall: true });
  assert.equal(out.skipped, false);
  assert.equal(out.run.trigger, "stall"); assert.equal(out.run.card, 255729, "the blocking card leads");
  assert.match(out.run.detail, /card 255729 \(blocking\): Restore review/);
  assert.match(out.run.detail, /card 255710: Bill votes/);
  assert.match(out.run.detail, /Why this was started: no progress for 6 h/);
});

test("stall runs get one extra investigation on top of the per-ticket budget, then stop", () => {
  const { ledger, cw, job } = workers();
  ledger.data.codingWorkers = { seq: 2, runs: { a: { id: "a", kind: "investigate", ticket: 1886, state: "reported" }, b: { id: "b", kind: "investigate", ticket: 1886, state: "reported" } } };
  assert.equal(cw.queueInvestigation({ job, stall: true }).skipped, false);
  ledger.data.codingWorkers.runs[`cw-1886-3`].state = "reported";
  const again = cw.queueInvestigation({ job, stall: true });
  assert.equal(again.skipped, true); assert.equal(again.permanent, true);
  assert.equal(inv.MAX_INVESTIGATIONS_PER_TICKET + inv.EXTRA_STALL_RUNS, 3);
});

// ---- promises ------------------------------------------------------------------------------------------------------

test("\"I will follow up when a fix is in\" is a fix promise, not an owner promise (1886)", () => {
  assert.equal(promises.detect("It is filed with the developers as one issue, and I will follow up here when a fix is in.", 0).kind, "release");
});

test("a promise that two wakes could not deliver starts a worker instead of only DMing the owner (1886)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-prom-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  let clock = Date.parse("2026-11-23T07:00:00Z");
  const job = ledger.createJob("t", { kind: "ticket", ticket: 1886, role: "support" }); job.state = "waiting";
  ledger.data.seen["ticket:1886"] = job.id;
  ledger.data.ticketPromises = { 1886: [{ id: "1886-x", at: clock - 20 * 3600000, jobId: job.id, state: "open", wakes: 2, text: "I will follow up here when a fix is in.", kind: "release", dueAt: clock - 10 * 3600000, wokenAt: clock - 3600000, nextAt: clock - 1 }] };
  const sent = [];
  const keeper = promises.createPromises({ ledger, now: () => clock, post: async () => {}, dispatch: (j, reason) => { sent.push(reason); return { run: { id: "cw-1886-80" } }; } });
  await keeper.tick();
  assert.equal(sent.length, 1); assert.match(sent[0], /could not deliver it after two wakes/);
  assert.equal(ledger.data.ticketPromises[1886][0].worker, "cw-1886-80");
  assert.equal(Object.keys(ledger.data.outbox || {}).filter((k) => k.startsWith("promise-overdue")).length, 0, "no owner DM when a worker took it");
});

// ---- own lookups (1884) ---------------------------------------------------------------------------------------------

const P1884 = "In turn 158, your Texas site sold about 26 financial services contracts, down from 60 in turn 157. That accounts for part of the revenue drop.  I still need the rest of your sites’ results to pin down the full drop and whether the bank played a part.";

test("the 1884 answer is refused: Keir must read every site, and never ask the player for data it can read", async () => {
  const p = own.ownLookupProblem(P1884);
  assert.equal(p.kind, "partial");
  assert.match(own.ownLookupRefusal(p), /read every site/i);
  const f = setup({ call: posted });
  f.playerWrote(5);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: P1884 }), /reads to the player as if they have to send you game data/);
  assert.equal(f.audits("own_lookup_refused").length, 1);
});

test("saying what Keir does next, or asking for what only the player knows, is fine", () => {
  for (const ok of ["I am reading your other sites now and will post the full breakdown within the hour.", "I need a screenshot of the page you saw.", "I need you to confirm which page you were on.", "We need more players to vote."]) assert.equal(own.ownLookupProblem(ok), null, ok);
  assert.ok(own.ownLookupProblem("I do not have your bank statement yet."));
});

// ---- patch reads (1886, 1889) ---------------------------------------------------------------------------------------

test("sandbox git skips the owner and ctime checks that made every file look changed", () => {
  assert.deepEqual(Object.fromEntries(GIT_CONFIG), { "safe.directory": "*", "core.checkStat": "minimal", "core.trustctime": "false" });
});

test("a timed-out patch read retries once and never says the patch is too large", async () => {
  assert.doesNotMatch(patchReadError({ timedOut: true }), /larger than 2 MB/);
  assert.match(patchReadError({ timedOut: true }), /size is not the problem/);
  let n = 0;
  const sandbox = { capture: async () => { n += 1; if (n === 1) { const e = new Error("output capture timed out"); e.timedOut = true; throw e; } return { code: 0, output: "", truncated: false, size: 0 }; }, fork: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-deleg-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const parent = ledger.createJob("p", { kind: "ticket", ticket: 1889, role: "support", repository: "AHDGame", repositoryRef: { sha: "a" } });
  const dg = createDelegation({ ledger, sandbox, config: {} });
  const out = await dg.delegate(parent, "Require consent before a running mate joins the ticket; add a focused test.");
  assert.equal(n, 2, "retried once"); assert.ok(out.taskId);
  n = -5; // every read times out
  const parent2 = ledger.createJob("p2", { kind: "ticket", ticket: 1890, role: "support", repository: "AHDGame", repositoryRef: { sha: "b" } });
  sandbox.capture = async () => { const e = new Error("output capture timed out"); e.timedOut = true; throw e; };
  await assert.rejects(dg.delegate(parent2, "Another bounded fix description for the coding worker."), /timed out twice \(the host is busy\); the patch size is not the problem/);
});

// ---- harm from our bug: meantime steps and timing (owner rule 2026-11-23) -------------------------------------------

const h = require("../lib/operator/harmreply");

test("a reply explaining a loss our bug caused must add a meantime step and when the fix is expected", async () => {
  const bare = "Your Texas site lost revenue because a bug counted your contracts twice.";
  assert.deepEqual(h.harmProblem(bare).missing, ["meantime", "when"]);
  assert.match(h.harmRefusal(h.harmProblem(bare)), /In the meantime, you can/);
  assert.equal(h.harmProblem(`${bare} In the meantime, you can pause new contracts at that site. The fix is in testing and expected on the main server tomorrow.`), null);
  assert.equal(h.harmProblem(`${bare} There is no workaround and nothing for you to do; no date yet, the fix is being built.`), null, "an honest no-workaround line is allowed");
  assert.equal(h.harmProblem("Your revenue fell because demand in Texas dropped."), null, "not our fault: not this rule");
  assert.ok(h.harmProblem("Your revenue fell because the price fell.", { bugContext: true }), "on a ticket with a fix raised, any explained loss counts");
  const f = setup({ call: posted });
  f.playerWrote(5);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: bare }), /stops at the why/);
  assert.equal(f.audits("harm_reply_refused").length, 1);
});

test("the harm rule refuses at most twice per activation, so a ticket never stalls on it", async () => {
  const f = setup({ call: posted });
  f.playerWrote(5);
  f.job.raisedToDevelopers = [{ id: 501, title: "Supply step skips plants", blocking: false }]; // a fix is raised: the loss is ours
  const bare = "Your plant lost output because the supply step skipped it.";
  for (let i = 0; i < 2; i++) await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: bare }), /stops at the why/);
  await f.broker.tool(f.job, "channel_reply", { message: bare });
  assert.equal(f.audits("harm_reply_allowed").length, 1);
});
