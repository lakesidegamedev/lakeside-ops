"use strict";
// Keir 9: a sentence that calls behaviour a bug, a fault or something needing a code change must rest on a read that marks it a fault.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const bc = require("../lib/operator/bugclaim");

// A read that shows the rule at work and calls nothing a fault. Generic wording.
const RULE_READ = JSON.stringify({ route: { from: "North depot", to: "Harbour yard", blockedBy: "tariff wall on all goods, from turn 12" }, note: "a wall closes every route between the two regions, including a firm's own yards" });
const PLAYER = "My harbour yard says grain is short although my northern depots make plenty.";
const READS = [RULE_READ];

const POSITIVE = [
  "That is a bug in the route rules.",
  "This looks like a real bug.",
  "The wall closing your own yards is a fault, not the rule.",
  "A wall should not block a firm moving its own stock, so this needs a code change.",
  "That needs a fix from the developers.",
  "The depot count is wrongly blocking the shipment.",
  "This is a defect in how the wall is applied.",
  "The route check is broken for your own yards.",
  "That is a glitch in the shipping check.",
  "The wall code is wrong here, so I am taking it to the developers.",
  "The shipping queue needs to be fixed.",
  "That is another bug on the same page.",
  "The shipment counter is incorrectly closing the route.",
  "This counts as a bug, since your own yards are cut off.",
  "A flaw in the route check stops your depots supplying the yard.",
  "That is simply a mistake in the wall logic.",
  "The yard page is buggy for this case.",
  "Your yards aren't working as they should, and the fix is a code change.",
];

const NEGATIVE = [
  "The wall closes every route between the two regions, your own yards included.",
  "That is not a bug, it is how the wall works.",
  "This isn't really a fault: the code closes the route on purpose.",
  "If you hit a bug on this page, report it here.",
  "Please report a bug using the form in the channel.",
  "Is this a bug on your side too?",
  "I'm checking whether this is a bug.",
  "I have not confirmed this is a fault, but the route check may be closing it.",
  "It might be a bug, though I cannot tell from what I read.",
  "You said this is a bug, and I am looking at the wall rule now.",
  "The developers decided it is a fault and will fix it in the next update.",
  "No code change is needed: the wall rule applies to every route.",
  "The grain is sold at the northern depots instead.",
  "Your depots made 12,000 units and sold 11,900 outside.",
  "That wording is the rule as written, so I do not need a fix from anyone.",
  "The route does not need a developer to open it; lifting the wall would.",
  "When a player hits a bug, we file it under the tracker.",
  "I will check whether the page has a defect.",
  "The wall started on turn 12 and covers all goods.",
  "Thanks, got it.",
];

test("positives: a defect label with no marking in the reads is an unbacked claim", () => {
  assert.ok(POSITIVE.length >= 15);
  for (const m of POSITIVE) assert.ok(bc.unbackedBugClaim(m, READS, PLAYER), `should be flagged: ${m}`);
});

test("negatives: denials, questions, instructions, hedges, restatements and plain facts are not flagged", () => {
  assert.ok(NEGATIVE.length >= 15);
  for (const m of NEGATIVE) assert.equal(bc.unbackedBugClaim(m, READS, PLAYER), null, `should not be flagged: ${m}`);
  assert.equal(bc.unbackedBugClaim("", READS, PLAYER), null);
  assert.equal(bc.unbackedBugClaim(null, READS, PLAYER), null);
});

test("a read that marks the same behaviour as a fault backs the label", () => {
  const tracker = JSON.stringify({ issues: [{ number: 7, state: "open", title: "Route check closes a firm's own yards under a wall", labels: ["bug"] }] });
  assert.equal(bc.unbackedBugClaim("That is a bug in the route check, and it closes your own yards.", [RULE_READ, tracker], PLAYER), null);
  const code = "// FIXME: the wall check wrongly closes routes between a firm's own yards\nfunction open(a, b) {}";
  assert.equal(bc.unbackedBugClaim("The wall closing your own yards is a fault.", [code], PLAYER), null);
});

test("a fault marking about something else does not back the label", () => {
  const other = JSON.stringify({ issues: [{ number: 9, title: "Chart legend overlaps the title", labels: ["bug", "ui"] }] });
  assert.ok(bc.unbackedBugClaim("A wall should not block a firm moving its own stock, so this needs a code change.", [RULE_READ, other], PLAYER));
});

test("a read that shows the rule but never marks a fault does not back it", () => {
  assert.ok(bc.unbackedBugClaim("This is a bug in the wall check closing your own yards.", [RULE_READ], PLAYER));
});

test("hedge labels the sentence unconfirmed and keeps the rest of the answer", () => {
  const msg = "Your depots sold nearly everything outside. A wall should not block a firm moving its own stock, so this needs a code change. The wall began on turn 12.";
  const claim = bc.unbackedBugClaim(msg, READS, PLAYER);
  const out = bc.hedge(msg, claim, 700);
  assert.match(out, /Your depots sold nearly everything outside\./);
  assert.match(out, /I have not confirmed this is a fault, but a wall should not block/);
  assert.match(out, /The wall began on turn 12\.$/);
  assert.equal(bc.unbackedBugClaim(out, READS, PLAYER), null, "the hedged text is no longer a claim");
  const tight = bc.hedge(msg, claim, msg.length + 5);
  assert.ok(!/needs a code change/.test(tight) && /sold nearly everything/.test(tight) && /wall began/.test(tight));
});

// ---- broker level ----
const CH = "777777777777777777";
const ticketDiscord = async (_method, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-123" }] : []);
function setup(readText = RULE_READ) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir9-bugclaim-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { screenOutgoing: async () => ({ labels: [], refuse: null }), ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false };
  const calls = [];
  const mcp = { servers: () => ["support", "ops-knowledge", "gamestate"], list: async () => ["support_public_update", "support_resolve", "code_search", "trace_sector"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })),
    call: async (...a) => { calls.push(a); if (a[1] === "trace_sector") return JSON.parse(readText); return { ok: true, id: "card-9", hits: [], delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord: ticketDiscord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-123", content: PLAYER }, deadline: 9e15 });
  job.codeLookups = 1; job.state = "running"; ledger.data.seen["ticket:123"] = job.id; ledger.data.disclosed = { 123: { at: 1, posted: true } };
  const posts = () => calls.filter((c) => c[1] === "support_public_update" && c[2].deliver === true).map((c) => c[2].message);
  const audits = (kind) => (ledger.data.audit || []).filter((a) => a.kind === kind);
  const read = () => broker.tool(job, "read_tool", { server: "gamestate", tool: "trace_sector", args: {} });
  return { ledger, broker, job, calls, posts, audits, read, advance: (min) => { clock += min * 60000; } };
}
const BUG = "A wall should not block a firm moving its own stock, so this needs a code change.";

test("an unsupported bug label is refused, tells Keir to read the code and say whether it is the rule, and is not a post", async () => {
  const f = setup();
  await f.read();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: BUG }), (e) => /calls behaviour a bug, fault or defect/.test(e.message) && /whether it is the rule/.test(e.message));
  assert.equal(f.posts().length, 0);
  assert.equal(f.audits("bug_claim_refused").length, 1);
  assert.ok(!f.job.replyRefusedPending, "a pacing refusal must never block finishing");
});

test("a plain statement of the rule is accepted without a refusal", async () => {
  const f = setup();
  await f.read();
  await f.broker.tool(f.job, "channel_reply", { message: "The wall closes every route between the two regions, your own yards included. That is how the wall works." });
  assert.equal(f.posts().length, 1);
  assert.equal(f.audits("bug_claim_refused").length, 0);
});

test("a hedged label is accepted at once", async () => {
  const f = setup();
  await f.read();
  await f.broker.tool(f.job, "channel_reply", { message: "I have not confirmed this is a fault, but a wall may be blocking a firm's own stock wrongly." });
  assert.equal(f.posts().length, 1);
  assert.equal(f.audits("bug_claim_refused").length, 0);
});

test("a bug label the reads support goes out ('this is a bug and I have reported it')", async () => {
  const tracker = JSON.stringify({ issues: [{ number: 7, state: "open", title: "Wall check closes a firm's own yards", labels: ["bug"] }], note: "wall blocks a firm moving its own stock between yards" });
  const f = setup(tracker);
  await f.read();
  await f.broker.tool(f.job, "channel_reply", { message: "That is a bug in the wall check: it closes a firm's own yards, and it is already reported." });
  assert.equal(f.posts().length, 1);
  assert.equal(f.audits("bug_claim_refused").length, 0);
});

test("two refusals at most, then the code labels the sentence unconfirmed and the player still gets the answer", async () => {
  const f = setup();
  await f.read();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: BUG }));
  f.advance(1);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: BUG + " " }));
  assert.equal(f.audits("bug_claim_refused").length, 2);
  f.advance(1);
  await f.broker.tool(f.job, "channel_reply", { message: BUG });
  assert.equal(f.audits("bug_claim_refused").length, 2, "never a third refusal");
  assert.equal(f.posts().length, 1);
  assert.match(f.posts()[0], /^I have not confirmed this is a fault, but a wall should not block/);
  assert.equal(f.audits("bug_claim_hedged").length, 1);
});

test("finishing is never blocked: the refusal text is listed in PACING_REFUSAL", () => {
  const src = fs.readFileSync(path.join(__dirname, "../lib/operator/broker.js"), "utf8");
  const pacing = new RegExp(/const PACING_REFUSAL = \/(.*)\/i;/.exec(src)[1], "i");
  assert.ok(pacing.test(bc.REFUSAL({ sentence: "s" })));
});

test("the fast lane is exempt", async () => {
  const f = setup();
  f.job.fastLane = { escalated: false };
  await f.broker.tool(f.job, "channel_reply", { message: BUG });
  assert.equal(f.posts().length, 1);
  assert.equal(f.audits("bug_claim_refused").length, 0);
});
