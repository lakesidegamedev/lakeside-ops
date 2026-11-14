"use strict";
// Keir 9.0.4 (ticket 1829): an instruction to change a setting is a claim; it must rest on a read naming that setting.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const sc = require("../lib/operator/settingclaim");

const GAME_READ = JSON.stringify({ screen: "Settings > Interface", control: "Reduce motion", note: "the reduce motion switch stops slide animations and sets the progress bar to finish at once" });
const READS = [GAME_READ];

const POSITIVE = [
  "Turn off the sound effects in Settings.",
  "Go to Settings, Accessibility, then switch off Remove animations.",
  "You can switch the night filter back on.",
  "Please disable the night filter.",
  "Enable dark theme under Settings, Display.",
  "Switch off battery saver on your phone.",
  "Turn the vibration setting off.",
  "Untick the auto refresh option.",
  "Open Settings and then toggle compact layout.",
  "You should turn on large text in your phone's accessibility settings.",
  "Open Settings, Notifications, and disable the badge counter.",
  "Could you please turn off low power mode?",
  "Just flip the high contrast switch off.",
  "For now, deactivate the swipe gestures setting.",
  "You need to enable location sharing in Settings, Privacy.",
  "First, change the language setting to English.",
  "Then switch the data saver mode on.",
  "Go to Settings, Privacy, Tracking.",
];
const NEGATIVE = [
  "Is reduce motion on?",
  "Do you have the sound effects turned off?",
  "I turned off the logging while I read the code.",
  "The game turns off the animation when the slide ends.",
  "Do not change any settings, nothing on your side is wrong.",
  "You do not need to turn anything off.",
  "There is no need to disable anything.",
  "I have not confirmed it, but turn off the night filter might help.",
  "The slideshow moves on when the progress bar finishes.",
  "Turn left at the depot.",
  "Your record shows the harbour yard is short of grain.",
  "A fix is being made and I will reply here.",
  "Open the ticket again if it happens a second time.",
  "Settings are saved when you leave the screen.",
  "Which setting do you have on?",
  "It switched to the next slide after four seconds.",
  "The reduce motion switch is on by default.",
  "Please send a screenshot of the slideshow.",
  "Open Settings and look around.",
  "That setting was turned on by an update last week.",
];

test("instructions to change a setting are flagged when no read names the setting (15+)", () => {
  assert.ok(POSITIVE.length >= 15);
  for (const m of POSITIVE) assert.ok(sc.unbackedSettingClaims(m, READS).length, `should be flagged: ${m}`);
});
test("everything else is left alone (15+)", () => {
  assert.ok(NEGATIVE.length >= 15);
  for (const m of NEGATIVE) assert.equal(sc.unbackedSettingClaims(m, READS).length, 0, `should not be flagged: ${m}`);
  assert.equal(sc.unbackedSettingClaims("", READS).length, 0);
  assert.equal(sc.unbackedSettingClaims(null, READS).length, 0);
});
test("a read naming the setting backs the instruction; a read of another setting does not", () => {
  assert.equal(sc.unbackedSettingClaims("Turn on reduce motion in Settings, Interface.", READS).length, 0);
  assert.equal(sc.unbackedSettingClaims("Turn on reduce motion in Settings, Interface.", []).length, 1);
  assert.equal(sc.unbackedSettingClaims("Go to Settings, Accessibility, then switch off Remove animations.", READS).length, 1);
  assert.equal(sc.unbackedSettingClaims("Switch reduce motion off on your phone.", READS).length, 1);
});
test("hedge labels the instruction and keeps the rest", () => {
  const msg = "The bar finishes at once. Go to Settings, Accessibility, then switch off Remove animations. A fix is coming.";
  const bad = sc.unbackedSettingClaims(msg, READS);
  const out = sc.hedge(msg, bad, 1000);
  assert.match(out, /This may help, but I have not confirmed it: go to Settings, Accessibility/);
  assert.match(out, /^The bar finishes at once\./);
  assert.match(out, /A fix is coming\.$/);
  assert.equal(sc.unbackedSettingClaims(out, READS).length, 0, "a labelled instruction is not flagged again");
});

const CH = "777777777777777777";
const ticketDiscord = async (_m, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-123" }] : []);
function setup(readText = GAME_READ) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir904-setting-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { screenOutgoing: async () => ({ labels: [], refuse: null }), ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false };
  const calls = [];
  const mcp = { servers: () => ["support", "ops-knowledge", "gamestate"], list: async () => ["support_public_update", "code_search", "trace_sector"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })),
    call: async (...a) => { calls.push(a); if (a[1] === "trace_sector") return JSON.parse(readText); return { ok: true, id: "card-9", hits: [], delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 10 * 3600000;
  const broker = createBroker({ ledger, config, mcp, discord: ticketDiscord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-123", content: "The slideshow jumps to the end." }, deadline: 9e15 });
  job.codeLookups = 1; job.state = "running"; ledger.data.seen["ticket:123"] = job.id; ledger.data.disclosed = { 123: { at: 1, posted: true } };
  const posts = () => calls.filter((c) => c[1] === "support_public_update" && c[2].deliver === true).map((c) => c[2].message);
  const audits = (kind) => (ledger.data.audit || []).filter((a) => a.kind === kind);
  const read = () => broker.tool(job, "read_tool", { server: "gamestate", tool: "trace_sector", args: {} });
  return { ledger, broker, job, posts, audits, read, advance: (min) => { clock += min * 60000; } };
}
const PHONE = "The bar finishes at once when animations are off. Go to Settings, Accessibility, then switch off Remove animations.";

test("broker: an instruction no read names is refused, and is not a post or a finish blocker", async () => {
  const f = setup(JSON.stringify({ note: "slide timing" }));
  await f.read();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Turn on reduce motion in Settings, Interface." }), /tells the player to change a setting/);
  assert.equal(f.posts().length, 0);
  assert.ok(!f.job.replyRefusedPending);
});
test("broker: accepted when a code read names the setting", async () => {
  const f = setup();
  await f.read();
  await f.broker.tool(f.job, "channel_reply", { message: "Turn on reduce motion in Settings, Interface." });
  assert.equal(f.posts().length, 1);
  assert.equal(f.audits("setting_claim_refused").length, 0);
});
test("broker: a phone-setting instruction is refused when the read only shows the game setting", async () => {
  const f = setup();
  await f.read();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: PHONE }), /tells the player to change a setting/);
  assert.equal(f.posts().length, 0);
});
test("broker: two refusals at most, then the instruction goes out labelled", async () => {
  const f = setup();
  await f.read();
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: PHONE }));
  f.advance(1);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: PHONE + " " }));
  f.advance(1);
  await f.broker.tool(f.job, "channel_reply", { message: PHONE });
  assert.equal(f.audits("setting_claim_refused").length, 2);
  assert.equal(f.posts().length, 1);
  assert.match(f.posts()[0], /This may help, but I have not confirmed it: go to Settings, Accessibility/);
  assert.equal(f.audits("setting_claim_hedged").length, 1);
});
test("the refusal text is listed in PACING_REFUSAL so finishing is never blocked", () => {
  const src = fs.readFileSync(path.join(__dirname, "../lib/operator/broker.js"), "utf8");
  const pacing = new RegExp(/const PACING_REFUSAL = \/(.*)\/i;/.exec(src)[1], "i");
  assert.ok(pacing.test(sc.REFUSAL({ phrase: "x" })));
});
