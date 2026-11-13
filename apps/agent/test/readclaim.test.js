"use strict";
// Keir 9: a reply must not say what a page, record or panel shows unless a read on this ticket returned those words.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const rc = require("../lib/operator/readclaim");

// What the reads on the ticket returned. Generic wording, no ticket text.
const READ = JSON.stringify({ widget: { gaugePct: 100, gaugeSource: "allocation record", made: 200, shipped: 150, shippedPct: 75, limitingInput: "grain" }, note: "shipped and shippedPct come from the dispatch record; the gauge reads the allocation record" });
const READS = [READ];
const PLAYER = "The gauge on my widget page says 100% but the dispatch line says 75% shipped.";

// Claims about what a source shows that nothing in READ supports.
const POSITIVE = [
  "The gauge is reading how much of your stock you put on the shelf.",
  "Your record says shipments were held back by the depot.",
  "The panel shows the queue was cleared by the night shift.",
  "The log records a pause for repairs on the second day.",
  "The page says the warehouse flooded.",
  "The widget page names the courier strike as the delay.",
  "The tile counts only the crates that left on trucks.",
  "The report lists three cancelled orders from the north depot.",
  "The 100% was the share of crates you reserved for export.",
  "The figure was the count of boxes stacked in the yard.",
  "What the game saved about that turn: the depot reopened late.",
  "The ledger shows a refund issued to the carrier.",
  "The dashboard is using last week's reserve rather than today's.",
  "Your history records a transfer to the coastal yard.",
  "The gauge means how many pallets are waiting for a lorry.",
  "The badge reads the fuel level instead of the cargo level.",
  "The screen displays the old schedule from before the merger.",
  "The line is tracking the number of staff on leave.",
];

// Honest sentences: backed by the read, negated, hedged, a question, a request, a restatement of the player, or no source.
const NEGATIVE = [
  "The gauge reads the allocation record.",
  "The dispatch record shows 150 shipped of 200 made.",
  "The widget page names grain as the limiting input.",
  "The gauge shows 100% and the line shows 75% shipped.",
  "The page does not name a cause for the gap.",
  "Your record shows no cancelled orders.",
  "The panel never says which depot was involved.",
  "Nothing on the page says why the gauge reads 100%.",
  "The gauge may be reading the number of crates you reserved.",
  "I have not confirmed this, but the gauge is reading the reserved crates.",
  "Does the panel show the courier name?",
  "Could you tell me what the log says on your screen?",
  "I'm checking what the dispatch record shows.",
  "You said the line shows 75% shipped, and that matches the record.",
  "I asked for the gauge to show the shipped share instead.",
  "The developers will look at what the gauge reads.",
  "The gauge probably counts the allocation share.",
  "Thanks, got it.",
  "The two figures come from different records, and the cause is not established.",
  "Your shipments went out on turn 12 and the stock fell afterwards.",
  "The record is blank for that turn.",
];

test("readClaims: positives are claims about what a source shows and are unbacked by the read", () => {
  assert.ok(POSITIVE.length >= 15);
  for (const m of POSITIVE) {
    const bad = rc.unbackedClaims(m, READS, PLAYER);
    assert.ok(bad.length >= 1, `should be an unbacked claim: ${m}`);
  }
});

test("readClaims: negatives are not flagged", () => {
  assert.ok(NEGATIVE.length >= 15);
  for (const m of NEGATIVE) assert.deepStrictEqual(rc.unbackedClaims(m, READS, PLAYER).map((c) => c.clause), [], `should not be flagged: ${m}`);
  assert.deepStrictEqual(rc.unbackedClaims("", READS, PLAYER), []);
  assert.deepStrictEqual(rc.unbackedClaims(null, READS, PLAYER), []);
});

test("a claim is backed only when its words sit together in one read, not scattered across a long text", () => {
  const long = "held " + "filler ".repeat(80) + "back " + "filler ".repeat(80) + "inputs";
  assert.ok(rc.unbackedClaims("Your record says inputs held the run back.", [long], "").length === 1);
  assert.ok(rc.unbackedClaims("Your record says inputs held the run back.", ["inputs held the run back at the mill"], "").length === 0);
});

test("with no reads at all a recorded-fact claim is unbacked; the player's own words never back it", () => {
  assert.equal(rc.unbackedClaims("The log records a pause for repairs.", [], "").length, 1);
  assert.equal(rc.unbackedClaims("The log records a pause for repairs.", [], "The log records a pause for repairs.").length, 0, "restating the player is not a finding");
});

test("hedge labels the clause unconfirmed and keeps the rest of the answer", () => {
  const msg = "Your shipped total is right. The gauge is reading the reserved crates. Nothing else changed.";
  const bad = rc.unbackedClaims(msg, READS, PLAYER);
  const out = rc.hedge(msg, bad, 700);
  assert.match(out, /Your shipped total is right\./);
  assert.match(out, /I have not confirmed this, but the gauge is reading the reserved crates\./);
  assert.match(out, /Nothing else changed\.$/);
  assert.deepStrictEqual(rc.unbackedClaims(out, READS, PLAYER), [], "the hedged text is no longer a claim");
  const tight = rc.hedge(msg, bad, msg.length + 5);
  assert.ok(!/reserved crates/.test(tight) && /shipped total is right/.test(tight) && /Nothing else changed/.test(tight), "too long to hedge: the clause is dropped, the answer stays");
});

// ---- broker level ----
const CH = "777777777777777777";
const ticketDiscord = async (_method, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-123" }] : []);
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir9-readclaim-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { screenOutgoing: async () => ({ labels: [], refuse: null }), ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false };
  const calls = [];
  const mcp = { servers: () => ["support", "ops-knowledge", "gamestate"], list: async () => ["support_public_update", "support_resolve", "code_search", "trace_sector"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })),
    call: async (...a) => { calls.push(a); if (a[1] === "trace_sector") return JSON.parse(READ); return { ok: true, id: "card-9", hits: [], delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord: ticketDiscord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-123", content: PLAYER }, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id; ledger.data.disclosed = { 123: { at: 1, posted: true } };
  const posts = () => calls.filter((c) => c[1] === "support_public_update" && c[2].deliver === true).map((c) => c[2].message);
  const audits = (kind) => (ledger.data.audit || []).filter((a) => a.kind === kind);
  const read = () => broker.tool(job, "read_tool", { server: "gamestate", tool: "trace_sector", args: {} });
  return { ledger, broker, job, calls, posts, audits, read, advance: (min) => { clock += min * 60000; } };
}
const GUESS = "The gauge is reading how much of your stock you put on the shelf.";

test("an unread cause is refused, names what to do, is not a post and does not arm the finish block", async () => {
  const f = setup();
  await f.read();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: GUESS }), (e) => /nothing Keir read on this ticket contains that/.test(e.message) && /not confirmed/.test(e.message));
  assert.equal(f.posts().length, 0);
  assert.equal(f.audits("read_claim_refused").length, 1);
  assert.ok(!f.job.replyRefusedPending, "a pacing refusal must never block finishing");
});

test("a hedged version is accepted at once", async () => {
  const f = setup();
  await f.read();
  await f.broker.tool(f.job, "channel_reply", { message: "I have not confirmed this, but the gauge may be reading how much stock you put on the shelf." });
  assert.equal(f.posts().length, 1);
  assert.equal(f.audits("read_claim_refused").length, 0);
});

test("a statement backed by what the read returned is accepted without a refusal", async () => {
  const f = setup();
  await f.read();
  await f.broker.tool(f.job, "channel_reply", { message: "The gauge reads the allocation record, while the shipped line uses the dispatch record." });
  assert.equal(f.posts().length, 1);
  assert.equal(f.audits("read_claim_refused").length, 0);
});

test("two refusals at most, then the code labels the clause unconfirmed and the player still gets the answer", async () => {
  const f = setup();
  await f.read();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: GUESS }));
  f.advance(1);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: GUESS + " " }));
  assert.equal(f.audits("read_claim_refused").length, 2);
  f.advance(1);
  await f.broker.tool(f.job, "channel_reply", { message: GUESS });
  assert.equal(f.audits("read_claim_refused").length, 2, "never a third refusal");
  assert.equal(f.posts().length, 1);
  assert.match(f.posts()[0], /^I have not confirmed this, but the gauge is reading how much of your stock you put on the shelf\./);
  assert.equal(f.audits("read_claim_hedged").length, 1);
});

test("finishing is never blocked by this check", async () => {
  const f = setup();
  await f.read();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: GUESS }));
  assert.ok(!f.job.replyRefusedPending);
  const src = fs.readFileSync(path.join(__dirname, "../lib/operator/broker.js"), "utf8");
  const pacing = new RegExp(/const PACING_REFUSAL = \/(.*)\/i;/.exec(src)[1], "i");
  assert.ok(pacing.test(rc.REFUSAL({ clause: "c" })), "the refusal text is listed in PACING_REFUSAL");
});

test("the fast lane, system posts and staff answers are exempt", async () => {
  const f = setup();
  f.job.fastLane = { escalated: false };
  await f.broker.tool(f.job, "channel_reply", { message: GUESS });
  assert.equal(f.posts().length, 1);
  assert.equal(f.audits("read_claim_refused").length, 0);
});

test("a condition or a general instruction is not a claim about a read page (CI, 2026-11-13)", () => {
  const { readClaims } = require("../lib/operator/readclaim");
  assert.equal(readClaims("If a screen is broken or shows incorrect figures, report that here.").length, 0);
  assert.equal(readClaims("Whenever the panel shows a red badge, open it for the details.").length, 0);
});
