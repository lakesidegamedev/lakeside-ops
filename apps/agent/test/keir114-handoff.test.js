"use strict";
// Keir 11.4 (owner, 2026-11-21): "with the developers" must be true and never said to a developer. Built from tickets
// 1872 (Keir's own worker was writing the fix) and 1875 (the developer asked for a picture and was told it was with
// the developers), with the look-alike true messages that must still go out.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const truth = require("../lib/operator/handofftruth");
const promises = require("../lib/operator/promises");

const CH = "777777777777777777", OWNER = "111111111111111111", STAFF = "222222222222222222", BOT = "333333333333333333", PLAYER = "555555555555555555";
const discord = async (_m, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-1872" }] : []);
function setup({ kind = "ticket", role = "support", actorId = null, source = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir114-handoff-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: OWNER, staffIds: [STAFF], botId: BOT, guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir };
  const calls = [];
  const mcp = { servers: () => ["support", "ops-knowledge"], list: async () => [], call: async (...a) => { calls.push(a); return { ok: true, delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const src = source || { channelId: CH, channelName: "ticket-bug-fixture-1872", authorId: PLAYER, role: "player", content: "Corp page crashes", at: new Date(clock - 60000).toISOString() };
  const job = ledger.createJob(`t-${kind}`, { role, kind, actorId, ticket: 1872, channelId: CH, replyChannel: CH, source: src, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:1872"] = job.id; ledger.data.disclosed = { 1872: { at: 1, posted: true } };
  const posts = () => [...calls.filter((c) => c[1] === "support_public_update" && c[2].deliver === true).map((c) => c[2].message), ...Object.values(ledger.data.outbox || {}).map((e) => e.content)];
  return { ledger, broker, job, posts, config, d: ledger.data };
}
const workerOn = (f, state = "running", pr = null) => {
  f.job.raisedToDevelopers = [{ id: 255638, title: "Corporation page fails", at: 1, kind: "bug", workerRun: "cw-1872-55" }];
  f.d.codingWorkers = { runs: { "cw-1872-55": { id: "cw-1872-55", ticket: 1872, state, pr } } };
};

test("1872: Keir's own worker is writing the fix, so 'with the developers' is refused with the first-person line", async () => {
  const f = setup(); workerOn(f);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "It is with the developers now and I will come back when there is something to try." }),
    (e) => /no developer has it/.test(e.message) && /I am preparing a fix/.test(e.message));
  assert.equal(f.posts().length, 0);
  await f.broker.tool(f.job, "channel_reply", { message: "I am preparing a fix now and I will come back when there is something to try." });
  assert.equal(f.posts().length, 1);
  assert.ok(!/developers/.test(f.posts()[0]));
});

test("the first-person stage follows Keir's real work: in testing with a PR, waiting with a pending sign-off", () => {
  const f = setup(); workerOn(f, "to_staging", 7073);
  assert.equal(truth.keirWork(f.d, 1872, [f.job]), "testing");
  f.d.codingWorkers.runs["cw-1872-55"].state = "needs_owner";
  assert.equal(truth.keirWork(f.d, 1872, [f.job]), "approval");
  f.d.codingWorkers.runs["cw-1872-55"].state = "done";
  assert.equal(truth.keirWork(f.d, 1872, [f.job]), null);
});

test("a card Keir's worker took is not a developer receipt; a card a person holds is", () => {
  const f = setup(); workerOn(f);
  assert.deepEqual(truth.developerReceipts(f.d, 1872, [f.job]), []);
  f.d.codingWorkers.runs["cw-1872-55"].state = "escalated"; // the worker gave it back to a person
  assert.equal(truth.developerReceipts(f.d, 1872, [f.job]).length, 1);
});

test("look-alike: a real handoff to a developer with a receipt still goes out", async () => {
  const f = setup();
  f.job.raisedToDevelopers = [{ id: 255700, title: "Account link needs a person", at: 1, kind: "question", blocking: true }];
  await f.broker.tool(f.job, "channel_reply", { message: "I have passed this to the developers and I will tell you here when they reply." });
  assert.equal(f.posts().length, 1);
});

test("look-alike: a player told truthfully that a developer is deciding goes out", async () => {
  const f = setup();
  f.d.decisions = { x1: { id: "x1", jobId: f.job.id, state: "pending", question: "Ticket 1872: change the rule?", at: 1 } };
  assert.equal(truth.deflection("It is with the developers to decide whether the rule changes.", { d: f.d, job: f.job, ticketNo: 1872, jobs: [f.job], config: f.config }), null);
});

test("no receipt at all: refused, and the refusal names both true alternatives", () => {
  const f = setup();
  const t = truth.deflection("I've passed the exact cause to the developers.", { d: f.d, job: f.job, ticketNo: 1872, jobs: [f.job], config: f.config });
  assert.match(t, /I am preparing a fix/); assert.match(t, /needsHuman/);
});

test("1875: the developer who asked is never told their request is with the developers, and 'I cannot render' is refused", async () => {
  const src = { channelId: CH, channelName: "ticket-bug-fixture-1872", authorId: OWNER, role: "owner", messageId: "1573728600182755459", content: "can you show us a rendered image of how you would make that distinction clearer? <@333333333333333333>", at: new Date(10 * 3600000 - 1000).toISOString() };
  const f = setup({ kind: "conversation", role: "owner", actorId: OWNER, source: src }); workerOn(f);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I cannot render the page from here, so that is the copy as it would appear; it is with the developers now." }), /render_preview/);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "That is the copy as it would appear. It is with the developers now." }), /answers the owner who asked you directly/);
  assert.equal(f.posts().length, 0);
});

test("a staff message inside a player's ticket makes staff the audience; naming the developer's own card is allowed", () => {
  const f = setup();
  f.job.inbox = [{ authorId: STAFF, role: "support", content: "Keir where is this at?", at: new Date(10 * 3600000).toISOString() }];
  f.job.raisedToDevelopers = [{ id: 255700, title: "x", at: 1, kind: "question", issue: 7080 }];
  assert.equal(truth.audienceOf(f.job, f.config), "staff");
  assert.match(truth.deflection("It is with the developers now.", { d: f.d, job: f.job, ticketNo: 1872, jobs: [f.job], config: f.config }), /a developer who asked/);
  assert.equal(truth.deflection("It is with the developers now: issue #7080, not picked up yet.", { d: f.d, job: f.job, ticketNo: 1872, jobs: [f.job], config: f.config }), null);
  // Staff chatting without naming Keir: Keir's next post still answers the player.
  f.job.inbox = [{ authorId: STAFF, role: "support", content: "looking at this one too", at: new Date(10 * 3600000).toISOString() }];
  assert.equal(truth.audienceOf(f.job, f.config), "player");
});

test("a render failure that really happened may be said once", () => {
  const f = setup();
  assert.equal(truth.deflection("The preview could not render (the browser runtime did not start), so here is the text.", { d: f.d, job: f.job, config: f.config, previewFailed: true }), null);
});

test("the read-only claim is refused for the owner with the tool to use", () => {
  const f = setup({ kind: "command", role: "owner", actorId: OWNER, source: { channelId: "app", authorId: OWNER, content: "merge them" } });
  f.job.replyChannel = "app";
  assert.match(truth.deflection("I can't merge these myself. My ticket access is read-only, so I can't merge, close or create tickets.", { d: f.d, job: f.job, config: f.config }), /ticket_command/);
});

test("'I will come back when there is something to try' is a tracked promise that comes due with the fix", () => {
  const p = promises.detect("I am preparing a fix and I will come back when there is something to try.", 0);
  assert.equal(p.kind, "release");
});

// ---------- Keir 11.4 release review: B1, M1 and the answer that must still go out ----------

test("B1: true rule answers with cannot create / can't make / can't produce pass; the 1875 sentence is still refused", () => {
  const f = setup();
  const ctx = { d: f.d, job: f.job, ticketNo: 1872, jobs: [f.job], config: f.config, renderOffered: true };
  for (const m of [
    "You cannot create a second company while your first one is still listed.",
    "You can't produce steel in a region with no iron supply.",
    "I can't make changes to your account balance; a moderator has to approve a refund.",
    "I can't make that merge myself; it changes the economy, so it is your call.",
    "This page cannot render a chart for a company with no history.",
  ]) assert.equal(truth.deflection(m, ctx), null, m);
  assert.match(truth.deflection("I cannot render the page from here, so that is the copy as it would appear.", ctx), /render_preview/);
  assert.match(truth.deflection("I can't show you an image of it.", ctx), /render_preview/);
});

test("B1: a player's rule answer containing 'cannot create' is posted through the real broker", async () => {
  const f = setup();
  f.job.source.content = "Why can I not start a second company?";
  f.d.ticketObservations = { 1872: [{ at: 1, job: f.job.id, tool: "read_tool", input: JSON.stringify({ server: "ops-knowledge", tool: "code_read", args: { path: "src/lib/corporations/founding.ts" } }), result: JSON.stringify({ path: "src/lib/corporations/founding.ts", text: "one listed company" }) }] };
  f.job.lastCodeReadAt = 1; f.job.codeLookups = 1;
  await f.broker.tool(f.job, "channel_reply", { message: "You cannot create a second company while your first one is still listed." });
  assert.equal(f.posts().length, 1);
  assert.match(f.posts()[0], /cannot create a second company/);
});

test("B1: 'I cannot render' is only checked when render_preview was offered, so a player's ticket is never told to draw", () => {
  const f = setup();
  assert.equal(truth.deflection("I cannot render a preview here, but the wording would be: Sold last turn.", { d: f.d, job: f.job, ticketNo: 1872, jobs: [f.job], config: f.config, renderOffered: false }), null);
});

test("a refusal is never the end of the answer: the third try goes out without the false sentence", async () => {
  const f = setup(); workerOn(f);
  const draft = "The page reads a field that some companies do not have, so it shows the error panel.\n\nIt is with the developers now.";
  for (let i = 0; i < 2; i++) await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: draft }), /no developer has it/);
  assert.equal(f.posts().length, 0);
  await f.broker.tool(f.job, "channel_reply", { message: draft });
  assert.equal(f.posts().length, 1);
  assert.match(f.posts()[0], /error panel/);
  assert.ok(!/with the developers/.test(f.posts()[0]));
  assert.equal(f.job.deflectionRefusals.n, 2);
});

test("a message that is nothing but the false claim is still refused on the third try", async () => {
  const f = setup(); workerOn(f);
  for (let i = 0; i < 3; i++) await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "It is with the developers now." }), /no developer has it/);
  assert.equal(f.posts().length, 0);
});

test("withoutDeflections keeps paragraphs and drops only the false sentence", () => {
  const f = setup(); workerOn(f);
  const out = truth.withoutDeflections("First line of the answer. It is with the developers now.\n\nSecond paragraph.", { d: f.d, job: f.job, ticketNo: 1872, jobs: [f.job], config: f.config });
  assert.equal(out, "First line of the answer.\n\nSecond paragraph.");
});
