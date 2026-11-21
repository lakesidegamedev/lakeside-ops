"use strict";
// Keir 10.1.14: the stand-down fixes from the 2026-11-17 live ledger review (tickets 1836, 1838, 1842, 1843, 1844, 1845).
const test = require("node:test");
const assert = require("node:assert");
const sd = require("../lib/operator/standdown");
const { decideClose } = require("../lib/operator/autoclose");

const H = 3600000, NOW = Date.parse("2026-11-17T12:00:00Z");

// A: nothing new, nothing changed
test("A: a second substantive post with no player message and no state change is refused", () => {
  const d = { jobs: { j1: { id: "j1", ticket: 1836, raisedToDevelopers: [{ id: 1, at: 1 }] } }, decisions: {} };
  const fp = sd.stateFingerprint(d, 1836);
  const last = { at: NOW - 3 * H, fp };
  const msg = "Both items are settled. Reply here if anything still looks wrong.";
  assert.match(sd.noNewRefusal({ last, humanAt: NOW - 6 * H, fp, message: msg, now: NOW }), /not written since/);
});
test("A: a new player message, a state change, a correction, or staff asking lets it through", () => {
  const d = { jobs: { j1: { id: "j1", ticket: 1, raisedToDevelopers: [{ id: 1, at: 1 }] } }, decisions: {}, keirIssues: {} };
  const fp = sd.stateFingerprint(d, 1), last = { at: NOW - H, fp };
  assert.equal(sd.noNewRefusal({ last, humanAt: NOW - 60000, fp, message: "x.", now: NOW }), null);
  d.jobs.j1.raisedToDevelopers[0].releasedAt = NOW;
  assert.notEqual(sd.stateFingerprint(d, 1), fp);
  assert.equal(sd.noNewRefusal({ last, humanAt: 0, fp: sd.stateFingerprint(d, 1), message: "x.", now: NOW }), null);
  assert.equal(sd.noNewRefusal({ last, humanAt: 0, fp, message: "Correction: it is live.", now: NOW }), null);
  assert.equal(sd.noNewRefusal({ last, humanAt: 0, fp, message: "x.", answeringStaff: true, now: NOW }), null);
  assert.equal(sd.noNewRefusal({ last: { ...last, question: true }, humanAt: 0, fp, message: "x.", now: NOW }), null, "a finding after an unanswered question is new");
  assert.equal(sd.noNewRefusal({ last: null, humanAt: 0, fp, message: "x.", now: NOW }), null);
});
test("A: a decision answered or an issue closed changes the fingerprint", () => {
  const d = { jobs: { j1: { id: "j1", ticket: 2, raisedToDevelopers: [{ id: 5, issue: 9 }] } }, decisions: { x: { id: "x", jobId: "j1", state: "pending" } }, keirIssues: { 9: { state: "open" } } };
  const a = sd.stateFingerprint(d, 2);
  d.keirIssues[9].state = "closed"; const b = sd.stateFingerprint(d, 2);
  d.decisions.x.state = "answered"; const c = sd.stateFingerprint(d, 2);
  assert.equal(new Set([a, b, c]).size, 3);
});

// B: the developer handoff line
test("B: 'passed it to the developers' needs a receipt for the current question", () => {
  assert.equal(sd.limitationLine(null), sd.NOT_PASSED_ON);
  assert.equal(sd.limitationLine({ raised: true, id: 7, selfOwned: true }), sd.NOT_PASSED_ON);
  assert.equal(sd.limitationLine({ raised: true, id: 7 }), sd.PASSED_ON);
  const jobs = [{ raisedToDevelopers: [{ id: 1, at: 100 }, { id: 2, at: 500, selfOwned: true }] }];
  assert.equal(sd.currentQuestionReceipt(jobs, 300), null, "older than the player's message, and self owned");
  assert.equal(sd.currentQuestionReceipt(jobs, 50).id, 1);
  assert.equal(sd.currentQuestionReceipt([{ raisedToDevelopers: [{ id: 1, at: 900, releasedAt: 950 }] }], 50), null);
});

// C: holding lines
test("C: a holding line may not state a cause (1845)", () => {
  const bad = "Your company has nothing set aside for logistics, so I am checking whether stock is reaching your shops.";
  assert.match(sd.holdingClaimRefusal(bad), /cause or a state/);
  assert.equal(sd.holdingClaimRefusal("I am checking how your logistics spending is set up and will post what I find."), null);
  assert.equal(sd.holdingClaimRefusal("Your logistics budget is zero because you have no plants. Here is what to do next. Build one first."), null, "a real answer is not a holding line");
});
test("C: capability claims are refused (1843)", () => {
  for (const t of ["The site loads on a phone for me.", "I tested it on my phone and it works.", "I loaded the page and it looks fine.", "It works for me on mobile."])
    assert.match(sd.capabilityClaim(t) || "", /view_page/, t);
  for (const t of ["Your corporation shows revenue of 35,051 CAD.", "I read your corporation records for turn 12.", "Which browser and device are you on?"]) assert.equal(sd.capabilityClaim(t), null, t);
});

// D: price verdict
const quote = JSON.stringify({ buildQuote: { unitPriceAnchor: 6300, dominanceMultiplier: 1.5, commodityDominanceMultiplier: 1, rateMultiplier: 1.02, hostPriceMultiplier: 1, foundingMultiplier: 1, expansionMultiplier: 1, totalAnchor: 2600000 } });
test("D: the quote breakdown names the largest non-base factor", () => {
  const q = sd.quoteFactors([quote]);
  assert.equal(q.largest.key, "dominanceMultiplier");
  assert.equal(q.largest.value, 1.5);
  assert.equal(sd.quoteFactors([JSON.stringify({ dominanceMultiplier: 1, rateMultiplier: 1.3, hostPriceMultiplier: 0.8 })]).largest.key, "rateMultiplier");
  assert.equal(sd.quoteFactors(["nothing here"]).present, false);
});
test("D: a price verdict without the dominance surcharge is refused (1844); with it, allowed", () => {
  const verdict = "There is no pricing fault: 275 units at about $9,455 each is the build price for that plant.";
  assert.match(sd.priceVerdictRefusal(verdict, [quote]), /dominance surcharge at 1.5x/);
  assert.equal(sd.priceVerdictRefusal("There is no pricing fault. A dominance surcharge of 1.5x is about a third of the $9,455 per unit.", [quote]), null);
  assert.match(sd.priceVerdictRefusal(verdict, ["no quote"]), /no read on this ticket shows the quote breakdown/);
  assert.equal(sd.priceVerdictRefusal("Revenue was 35,051 CAD.", [quote]), null);
});

// E: auto-close with an unkept promise
const snap = (o = {}) => ({ ticket: 7, open: true, running: false, ownerClosureHold: false, pendingDecision: false, pendingHandoffs: false, fixPending: false, held: null,
  lane: "question", answeredAt: NOW - 8 * H, liveAt: 0, lastHumanAt: NOW - 9 * H, lastReplyAt: NOW - 8 * H, lastHumanUnanswered: false, confirmed: false, ...o });
test("E: rule c does not close over a promised follow-up (1838)", () => {
  assert.equal(decideClose(snap(), NOW).rule, "c");
  const d = decideClose(snap({ promisedFollowUp: true }), NOW);
  assert.equal(d.action, "none"); assert.match(d.reason, /follow-up was promised/);
});
test("E: the latest answer-side post decides whether a promise is outstanding", () => {
  const staff = (r) => r.author.bot || r.author.id === "S";
  const row = (id, author, content) => ({ id: String(id), author, content });
  const p = row(1, { id: "S" }, "Still being looked into, I will update you here.");
  assert.equal(sd.outstandingPromise([row(0, { id: "P" }, "why?"), p], staff), true);
  assert.equal(sd.outstandingPromise([p, row(2, { bot: true }, "It was a stale figure. It now reads 12.")], staff), false);
  assert.equal(sd.promisesFollowUp("Your question is answered."), false);
});

// F: owner answered in the channel
test("F: the owner's channel message answers the pending decision and wakes the task (1842)", () => {
  const d = { jobs: { j1: { id: "j1", ticket: 1842, state: "waiting", ownerDecisionPending: true } }, decisions: { x: { id: "x", jobId: "j1", state: "pending", at: NOW - H } } };
  const got = sd.applyOwnerChannelAnswer(d, { ticket: 1842, ownerId: "O", authorId: "O", text: "Do the refund, yes.", messageId: "m1", at: NOW });
  assert.deepEqual(got, ["x"]);
  assert.equal(d.decisions.x.state, "answered");
  assert.equal(d.jobs.j1.ownerDecisionPending, undefined);
  assert.equal(d.jobs.j1.state, "queued");
  assert.match(d.jobs.j1.inbox.at(-1).content, /owner answered/);
  assert.equal(sd.ownerAnsweredSince(d, 1842), true);
  assert.equal(sd.claimsOwnerWait("This needs the owner's decision."), true);
});
test("F: a player, an action-bound decision, or a slash command never counts as the owner's answer", () => {
  const mk = () => ({ jobs: { j1: { id: "j1", ticket: 3, state: "waiting" } }, decisions: { x: { id: "x", jobId: "j1", state: "pending", at: 1 }, y: { id: "y", jobId: "j1", state: "pending", at: 1, actionId: "a" } } });
  let d = mk();
  assert.deepEqual(sd.applyOwnerChannelAnswer(d, { ticket: 3, ownerId: "O", authorId: "P", text: "yes", at: NOW }), []);
  assert.deepEqual(sd.applyOwnerChannelAnswer(d, { ticket: 3, ownerId: "O", authorId: "O", text: "/keir status", at: NOW }), []);
  assert.deepEqual(sd.applyOwnerChannelAnswer(d, { ticket: 3, ownerId: "O", authorId: "O", text: "go ahead", at: NOW }), ["x"]);
  assert.equal(d.decisions.y.state, "pending");
});
test("F: a newer decision after the owner's answer is waiting again", () => {
  const d = { jobs: { j1: { id: "j1", ticket: 4 } }, decisions: { n: { id: "n", jobId: "j1", state: "pending", at: NOW + 1 } }, ownerChannelAnswers: { 4: { at: NOW } } };
  assert.equal(sd.ownerAnsweredSince(d, 4), false);
});

// ---- through the real post path ----
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const CH = "777777777777777777";
const ticketDiscord = async (_method, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-123" }] : []);
function setup({ discord = ticketDiscord } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir1014-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, developerNames: { "222222222222222222": "Dev" } };
  const calls = [];
  const mcp = { servers: () => ["support", "ops-knowledge"], list: async () => ["support_public_update", "support_resolve"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })), call: async (...a) => { calls.push(a); return { ok: true, id: "card-9", delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-123" }, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id;
  const advance = (min) => { clock += min * 60000; };
  return { ledger, config, broker, job, calls, advance, now: () => clock };
}

test("broker: a repeat post with nothing new is refused; a player message reopens it (A)", async () => {
  const f = setup(); f.job.lastCodeReadAt = 1; f.job.lastGameReadAt = 1;
  await f.broker.tool(f.job, "channel_reply", { message: "Your revenue fell sharply between those two turns because your plants sold far less." });
  f.advance(40); f.job.lastGameReadAt = f.now() + 1; f.advance(1);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Your revenue fell sharply between those two turns because your plants sold far less, as I checked in the latest figures." }), /has not written since|real milestone|already got this/);
  f.job.observedPlayerAt = f.now(); f.advance(1);
  await f.broker.tool(f.job, "channel_reply", { message: "Thanks. The sales drop came from the plants mothballed at turn 675, so they were idle and sold nothing." });
});
test("broker: capability and guessed-cause holding lines are refused (C)", async () => {
  const f = setup();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "The site loads on a phone for me." }), /view_page/);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Your company has nothing set aside for logistics, so I am checking whether stock is reaching your shops." }), /holding line states a cause/);
  await f.broker.tool(f.job, "channel_reply", { message: "I am checking how your logistics spending is set up and will post what I find." });
});
test("broker: waiting on the owner is refused after the owner answered in the channel (F)", async () => {
  const f = setup(); f.job.lastCodeReadAt = 1;
  f.ledger.data.ownerChannelAnswers = { 123: { at: f.now() - 60000, text: "yes do it" } };
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "This needs the owner's decision before I can change it." }), /already answered/);
});
