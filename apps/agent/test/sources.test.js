"use strict";
// Keir 9: verified sources. Ticket numbers must come from this ticket's reads; code writes the "From:" line.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const sources = require("../lib/operator/sources");

const CH = "777777777777777777";
const ticketDiscord = async (_method, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-123" }] : []);
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir9-src-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false };
  const calls = [];
  const mcp = { servers: () => ["support", "ops-knowledge"], list: async () => ["support_public_update", "support_resolve", "code_search"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })), call: async (...a) => { calls.push(a); return { ok: true, id: "card-9", hits: [], delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord: ticketDiscord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-123", content: "Why did my revenue fall after turn 670?" }, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id; ledger.data.disclosed = { 123: { at: 1, posted: true } };
  const posts = () => calls.filter((c) => c[1] === "support_public_update" && c[2].deliver === true).map((c) => c[2].message);
  const audits = (kind) => (ledger.data.audit || []).filter((a) => a.kind === kind);
  return { ledger, broker, job, calls, posts, audits, advance: (min) => { clock += min * 60000; } };
}
const obs = (tool, args, result, at = 1) => ({ key: String(at) + tool, task: "old", tool: "read_tool", at, input: JSON.stringify({ server: "gamestate", tool, args }), result: JSON.stringify(result) });
const SECTOR = obs("trace_sector", { region: "Norland", sector: "Oil" }, { revenue: 41288610 }, 5);
const OVERVIEW = obs("game_overview", {}, { currentTurn: 675, players: 120 }, 3);
const CODE = { ...obs("code_search", { question: "x" }, { hits: ["tax is 12.5 percent"] }, 4), input: JSON.stringify({ server: "ops-knowledge", tool: "code_search", args: { question: "x" } }) };
const seed = (f, rows) => { f.ledger.data.ticketObservations = { 123: rows }; f.ledger.data.ruleLookupRefused = { 123: 1 }; };

test("a number from an earlier activation's observation is accepted", async () => {
  const f = setup(); seed(f, [SECTOR]);
  await f.broker.tool(f.job, "channel_reply", { message: "Your Oil revenue was 41,288,610 last turn." });
  assert.equal(f.posts().length >= 1, true);
  assert.equal(f.ledger.data.numberCheckRefused?.[123], undefined);
});

test("an invented number is refused, named, and refused at most twice", async () => {
  const f = setup(); seed(f, [SECTOR]);
  const msg = "Your Oil revenue was 52,000,000 last turn.";
  for (let i = 0; i < 2; i++) await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: msg }), (e) => /52,000,000/.test(e.message) && /calculate/.test(e.message));
  assert.equal(f.posts().length, 0);
  await f.broker.tool(f.job, "channel_reply", { message: msg });
  assert.equal(f.posts().length >= 1, true);
  assert.equal(f.audits("number_check_gave_up").length, 1);
});

test("the number refusal does not block finishing", async () => {
  const f = setup(); seed(f, []);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Your revenue was 52,000,000." }), /52,000,000/);
  assert.ok(!f.job.replyRefusedPending);
});

test("a calculated value counts as read", async () => {
  const f = setup(); seed(f, [SECTOR]); f.job.evidence = [52000000];
  await f.broker.tool(f.job, "channel_reply", { message: "Your Oil revenue was 52,000,000 last turn." });
  assert.equal(f.posts().length >= 1, true);
});

test("Checked line names trace_sector, game_overview and code reads in player terms", () => {
  assert.equal(sources.checkedLine("Your revenue was 41,288,610.", [SECTOR, OVERVIEW]), "From: your Oil page in Norland.");
  assert.equal(sources.checkedLine("Your revenue was 675,000.", [SECTOR, OVERVIEW, obs("game_overview", {}, { currentTurn: 675, x: 675000 }, 9)]), "From: turn 675.");
  assert.equal(sources.checkedLine("The tax is 12.5% by design.", [SECTOR, CODE]), "From: the game's rules.");
  assert.equal(sources.checkedLine("Your revenue was 41,288,610 and the tax is 12.5%.", [SECTOR, CODE]), "From: your Oil page in Norland and the game's rules.");
});

test("a rule with no matching number falls back to the most recent game read", () => {
  assert.equal(sources.checkedLine("Only the chair can file.", [OVERVIEW, CODE]), "From: the game's rules.");
});

test("unknown tools are omitted and no line is added when nothing qualifies", () => {
  const odd = obs("heal_query", { collection: "tickets" }, { n: 41288610 }, 8);
  assert.equal(sources.checkedLine("Your revenue was 41,288,610.", [odd]), null);
  assert.equal(sources.checkedLine("Your revenue was 41,288,610.", [odd, SECTOR]), "From: your Oil page in Norland.");
  assert.equal(sources.checkedLine("Which turn did you see it on?", [SECTOR]), null);
  assert.equal(sources.checkedLine("Your revenue was 41,288,610.", []), null);
});

test("the line never carries a tool name, id, URL or hostile argument", () => {
  const bad = obs("trace_sector", { region: "https://ops.example/x", sector: "trace_sector 0123456789abcdef0123" }, { r: 41288610 });
  const line = sources.checkedLine("Your revenue was 41,288,610.", [bad]);
  assert.ok(!line || !/trace_|https?:|\/\/|[0-9a-f]{12,}/i.test(line), line);
  const long = obs("trace_sector", { region: "R".repeat(300), sector: "S".repeat(300) }, { r: 41288610 });
  const l2 = sources.checkedLine("Your revenue was 41,288,610.", [long]);
  assert.ok(!l2 || l2.length <= sources.MAX_LINE);
});

test("a line the model wrote itself is replaced by the code-written one", () => {
  const out = sources.appendChecked("Your revenue was 41,288,610.\n\nChecked: trace_sector abc.", [SECTOR]);
  assert.equal(out, "Your revenue was 41,288,610.\n\nFrom: your Oil page in Norland.");
  assert.equal(sources.appendChecked("Your revenue was 41,288,610.\n\nChecked: made up.", []), "Your revenue was 41,288,610.");
});

test("length rule: the line is dropped, not the reply, when it would not fit", () => {
  const near = "Your revenue was 41,288,610. " + "x".repeat(0) + "Word ".repeat(133).trim() + ".";
  assert.ok(near.length > 665 && near.length < 700, String(near.length));
  assert.equal(sources.appendChecked(near, [SECTOR]), near);
  const five = "One. Two. Three. Four. Revenue was 41,288,610.";
  assert.equal(sources.appendChecked(five, [SECTOR]), five);
});

test("end to end: the posted ticket reply carries the Checked line", async () => {
  const f = setup(); seed(f, [SECTOR]);
  await f.broker.tool(f.job, "channel_reply", { message: "Your Oil revenue was 41,288,610 last turn." });
  assert.ok(f.posts().join("\n").includes("From: your Oil page in Norland."));
});

test("audit 2026-11-13: a rule or cause never borrows an unrelated read; only a code read sources it", () => {
  assert.equal(sources.checkedLine("Only the chair can file.", [OVERVIEW, SECTOR]), null);
  assert.equal(sources.checkedLine("Only the chair can file.", [OVERVIEW, CODE]), "From: the game's rules.");
});
