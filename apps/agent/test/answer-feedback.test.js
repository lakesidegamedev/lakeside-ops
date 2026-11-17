"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createFeedback, parseRecorded } = require("../lib/operator/feedback");

const BOT = "1479984768194969663", OWNER = "333052320252297216", GUILD = "1465445442987888743";
const TOKEN = "test-interaction-token-xxxxxxxxxxxx";
function fixture({ replies = {}, member = { roles: [] }, enabled = true, channels = {}, jobs = {} } = {}) {
  let t = 1_800_000_000_000;
  const ledger = { data: { jobs }, saves: 0, audits: [], save() { this.saves++; }, audit(k, v) { this.audits.push([k, v]); } };
  const calls = [];
  const discord = async (method, url, body) => {
    calls.push({ method, url, body });
    if (method === "GET" && url.startsWith("/webhooks/")) { const r = replies[url.split("/")[3]]; if (!r) throw new Error("404 Unknown Webhook"); return r; }
    if (method === "GET" && url.startsWith("/guilds/")) return member;
    const list = /^\/channels\/(\d+)\/messages\?/.exec(url);
    if (method === "GET" && list) return (channels[list[1]] || []).map((m) => ({ ...m }));
    const edit = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(url);
    if (method === "PATCH" && edit) { const m = (channels[edit[1]] || []).find((x) => x.id === edit[2]); if (m) m.components = []; }
    return {};
  };
  const config = { botId: BOT, ownerId: OWNER, guildId: GUILD, staffIds: ["565289871799746593"], modRoleIds: ["900000000000000001"] };
  const isModerator = async (id) => ((await discord("GET", `/guilds/${GUILD}/members/${id}`)).roles || []).includes("900000000000000001");
  const fb = createFeedback({ ledger, config, discord, isModerator, now: () => t, release: "10.2.0", enabled });
  const patches = () => calls.filter((c) => c.method === "PATCH");
  return { fb, ledger, calls, patches, advance: (ms) => { t += ms; }, at: () => t };
}
const job = { id: "j1", ticket: 1845, kind: "ticket", role: "support", provider: { lane: "support", runner: "muse", model: "muse-spark", effort: "high" } };
const reply = (content, user, messageId, modal = false) => ({ author: { id: BOT }, content, flags: 64,
  interaction_metadata: modal ? { type: 5, user: { id: user }, triggering_interaction_metadata: { type: 3, user: { id: user }, interacted_message_id: messageId } }
    : { type: 3, user: { id: user }, interacted_message_id: messageId } });

test("only channel answers get the row, never acks, DMs or decision buttons", () => {
  const { fb } = fixture();
  assert.ok(fb.components("channel-reply:abc", {}, job));
  assert.ok(fb.components("finish:abc", {}, job));
  assert.equal(fb.components("ack:abc", {}, job), null);
  assert.equal(fb.components("channel-reply:abc", {}, null), null);
  assert.equal(fb.components("channel-reply:abc", { components: [{}] }, job), null);
  assert.equal(fixture({ enabled: false }).fb.components("finish:abc", {}, job), null);
  const ids = fb.components("finish:x", {}, job)[0].components.map((c) => c.custom_id);
  assert.deepEqual(ids, ["keir_fb:great", "keir_fb:up", "keir_fb:down", "keir_fb:report"]);
});

test("a newer answer in the same channel takes the row off the older one", async () => {
  const { fb, patches } = fixture();
  await fb.delivered("100000000000000001", "200000000000000001", job);
  await fb.delivered("100000000000000002", "200000000000000009", job);
  assert.equal(patches().length, 0);
  await fb.delivered("100000000000000001", "200000000000000002", job);
  assert.deepEqual(patches(), [{ method: "PATCH", url: "/channels/100000000000000001/messages/200000000000000001", body: { components: [] } }]);
});

test("rows expire after a day", async () => {
  const { fb, patches, advance } = fixture();
  await fb.delivered("100000000000000001", "200000000000000001", job);
  advance(23 * 3600000); await fb.sweep(); assert.equal(patches().length, 0);
  advance(2 * 3600000); await fb.sweep();
  assert.equal(patches().length, 1);
  await fb.sweep(); assert.equal(patches().length, 1);
});

test("the vote, voter and message come from Discord's record, and a changed vote replaces the old one", async () => {
  const msg = "200000000000000001", player = "400000000000000001";
  const replies = { [TOKEN]: reply("Thanks, feedback recorded: 👍 Helpful.", player, msg) };
  const { fb, ledger } = fixture({ replies });
  await fb.delivered("100000000000000001", msg, job);
  assert.deepEqual(await fb.record({ token: TOKEN }), { ok: true, vote: "up", voter: "player", changed: false });
  replies[TOKEN] = reply("Thanks, feedback recorded: 👎 Not helpful.\nReason: it quoted the wrong tax rate", player, msg, true);
  const r = await fb.record({ token: TOKEN });
  assert.equal(r.vote, "down"); assert.equal(r.changed, true);
  const votes = Object.values(ledger.data.answerFeedback.votes);
  assert.equal(votes.length, 1);
  assert.equal(votes[0].reason, "it quoted the wrong tax rate");
  assert.equal(votes[0].model, "muse-spark"); assert.equal(votes[0].ticket, 1845); assert.equal(votes[0].release, "10.2.0");
});

test("voter groups: owner, staff delegate, moderator role, player", async () => {
  const msg = "200000000000000001";
  const cases = [[OWNER, { roles: [] }, "owner"], ["565289871799746593", { roles: [] }, "staff"], ["400000000000000002", { roles: ["900000000000000001"] }, "mod"], ["400000000000000003", { roles: ["1"] }, "player"]];
  for (const [user, member, want] of cases) {
    const { fb } = fixture({ member, replies: { [TOKEN]: reply("Thanks, feedback recorded: ⭐ Great.", user, msg) } });
    await fb.delivered("100000000000000001", msg, job);
    assert.equal((await fb.record({ token: TOKEN })).voter, want);
  }
});

test("forged or foreign interactions are refused", async () => {
  const msg = "200000000000000001";
  const { fb } = fixture({ replies: {
    [TOKEN]: { ...reply("Thanks, feedback recorded: ⭐ Great.", "4", msg), author: { id: "999" } },
    [TOKEN + "b"]: reply("Approved", "4", msg),
    [TOKEN + "c"]: reply("Thanks, feedback recorded: ⭐ Great.", "4", "200000000000000777"),
  } });
  await fb.delivered("100000000000000001", msg, job);
  await assert.rejects(fb.record({ token: "short" }), /bad token/);
  await assert.rejects(fb.record({ token: TOKEN }), /game bot/);
  await assert.rejects(fb.record({ token: TOKEN + "b" }), /not a feedback/);
  await assert.rejects(fb.record({ token: TOKEN + "c" }), /not a Keir answer/);
  await assert.rejects(fb.record({ token: TOKEN + "zzzz" }), /Unknown Webhook/);
});

test("summary and digest count by group and list problems", async () => {
  const msg = "200000000000000001", replies = {};
  const { fb, at } = fixture({ replies });
  await fb.delivered("100000000000000001", msg, job);
  const votes = [["⭐ Great.", OWNER], ["👍 Helpful.", "400000000000000001"], ["🚩 Problem reported.\nReason: told me to sell bonds that do not exist", "400000000000000002"]];
  for (const [i, [text, user]] of votes.entries()) { replies[TOKEN + i] = reply(`Thanks, feedback recorded: ${text}`, user, msg); await fb.record({ token: TOKEN + i }); }
  const s = fb.summary({ days: 7 });
  assert.equal(s.overall.total, 3); assert.equal(s.overall.helpfulRate, 0.667);
  assert.equal(s.byVoter.owner.great, 1); assert.equal(s.byModel["muse-spark"].report, 1);
  assert.equal(s.problems.length, 1); assert.match(s.problems[0].link, /discord\.com\/channels\//);
  assert.match(fb.digestLine(at() - 86400000), /1 ⭐, 1 👍, 0 👎, 1 🚩[\s\S]*sell bonds/);
  assert.equal(fb.digestLine(at() + 1), "");
});

test("the contract line parses only the bot's own wording", () => {
  assert.deepEqual(parseRecorded("Thanks, feedback recorded: 👎 Not helpful."), { vote: "down", reason: null });
  assert.equal(parseRecorded("feedback recorded: 👍"), null);
  assert.equal(parseRecorded("Thanks, feedback recorded: 🎉 Party."), null);
});

// The release build ships apps/agent alone, so the web copy is only present in
// the full repository; the parity check runs there (CI) and skips in a release.
const webRow = require("node:path").join(__dirname, "../../web/feedback-row.js");
test("the support service's feedback row is identical to Keir's", { skip: !require("node:fs").existsSync(webRow) && "web app not in this tree" }, () => {
  assert.deepEqual(require(webRow).row(), require("../lib/operator/feedback").row());
});

test("a click on a support-service reply is adopted from Discord and tied to its ticket", async () => {
  const msg = "200000000000000007", chan = "100000000000000005", player = "400000000000000001";
  const replies = { [TOKEN]: { ...reply("Thanks, feedback recorded: 👎 Not helpful.", player, msg), channel_id: chan } };
  const f = fixture({ replies });
  const base = f.fb;
  const orig = f.calls;
  // wrap discord by rebuilding with extra routes
  const { createFeedback } = require("../lib/operator/feedback");
  const ledger = f.ledger;
  const discord = async (method, url) => {
    if (url.startsWith("/webhooks/")) return replies[TOKEN];
    if (url === `/channels/${chan}/messages/${msg}`) return { author: { id: BOT }, components: base.components ? require("../lib/operator/feedback").row() : [] };
    if (url === `/channels/${chan}`) return { name: "ticket-bug-mazes-1851" };
    return {};
  };
  const fb = createFeedback({ ledger, config: { botId: BOT, ownerId: OWNER, guildId: GUILD, staffIds: [] }, discord, now: () => 1_800_000_000_000, release: "10.2.1" });
  const r = await fb.record({ token: TOKEN });
  assert.equal(r.vote, "down");
  const v = Object.values(ledger.data.answerFeedback.votes)[0];
  assert.equal(v.ticket, 1851);
  assert.equal(v.kind, "support-reply");
  void orig;
});

test("a message without our buttons or not from the bot is not adopted", async () => {
  const msg = "200000000000000008", chan = "100000000000000005", player = "400000000000000001";
  const { createFeedback } = require("../lib/operator/feedback");
  const ledger = { data: {}, save() {}, audit() {} };
  const discord = async (m, url) => {
    if (url.startsWith("/webhooks/")) return { ...reply("Thanks, feedback recorded: 👍 Helpful.", player, msg), channel_id: chan };
    if (url.includes("/messages/")) return { author: { id: player }, components: [] };
    return { name: "ticket-x-1" };
  };
  const fb = createFeedback({ ledger, config: { botId: BOT, ownerId: OWNER, staffIds: [] }, discord, release: "x" });
  await assert.rejects(fb.record({ token: TOKEN }), /not a Keir answer/);
});

// One row per channel, on the newest message, whichever writer posted it.
const CH = "100000000000000001";
const withRow = (id, at) => ({ id, author: { id: BOT }, timestamp: new Date(at).toISOString(), components: require("../lib/operator/feedback").row() });
const plain = (id, at) => ({ id, author: { id: BOT }, timestamp: new Date(at).toISOString(), components: [] });
const holders = (list) => list.filter((m) => m.components.length).map((m) => m.id);

test("a Keir answer strips rows left by support-service replies, which are not in the ledger", async () => {
  const channels = { [CH]: [plain("300000000000000009", 1_800_000_000_000), withRow("300000000000000003", 1), withRow("300000000000000002", 1), withRow("300000000000000001", 1)] };
  const { fb } = fixture({ channels });
  channels[CH].unshift(withRow("300000000000000010", 1_800_000_000_000));
  await fb.delivered(CH, "300000000000000010", job);
  assert.deepEqual(holders(channels[CH]), ["300000000000000010"]);
});

test("three support-service replies in a row leave one row, on the last", async () => {
  const channels = { [CH]: [] };
  const { fb } = fixture({ channels });
  // The support service posts each reply's last part with the row, then Keir's rule runs from Discord's state.
  for (const id of ["300000000000000001", "300000000000000002", "300000000000000003"]) {
    channels[CH].unshift(withRow(id, 1_800_000_000_000), plain("5" + id.slice(1), 1_800_000_000_000));
    await fb.reconcile(CH, { keepId: id });
  }
  assert.deepEqual(holders(channels[CH]), ["300000000000000003"]);
});

test("the sweep strips a support-service row after a day and de-duplicates open ticket channels", async () => {
  const old = 1_800_000_000_000 - 30 * 3600000;
  const channels = { [CH]: [withRow("300000000000000003", old), withRow("300000000000000002", old)] };
  const jobs = { j1: { kind: "ticket", state: "waiting", ticket: 9, replyChannel: CH } };
  const { fb } = fixture({ channels, jobs });
  await fb.sweep();
  assert.deepEqual(holders(channels[CH]), []);
});

test("the sweep keeps a fresh newest row, strips older ones, skips ended tickets and rescans only after a pause", async () => {
  const fresh = 1_800_000_000_000 - 3600000;
  const channels = { [CH]: [withRow("300000000000000003", fresh), withRow("300000000000000002", fresh)], "100000000000000002": [withRow("300000000000000005", 1)] };
  const jobs = { j1: { kind: "ticket", state: "waiting", ticket: 9, replyChannel: CH }, j2: { kind: "ticket", state: "done", ticket: 8, replyChannel: "100000000000000002" } };
  const { fb, calls, advance } = fixture({ channels, jobs });
  await fb.sweep();
  assert.deepEqual(holders(channels[CH]), ["300000000000000003"]);
  assert.deepEqual(holders(channels["100000000000000002"]), ["300000000000000005"]);
  const gets = () => calls.filter((c) => c.method === "GET").length;
  const before = gets(); await fb.sweep(); assert.equal(gets(), before);
  advance(31 * 60000); await fb.sweep(); assert.ok(gets() > before);
});

test("staleHolders only counts our rows and never touches other components", () => {
  const { staleHolders } = require("../lib/operator/feedback");
  const other = { id: "5", author: { id: BOT }, components: [{ components: [{ custom_id: "decision:yes" }] }] };
  assert.deepEqual(staleHolders([other, withRow("4", 1), withRow("3", 1)]), ["3"]);
  assert.deepEqual(staleHolders([withRow("4", 1), withRow("3", 1)], { keepId: "3" }), ["4"]);
  assert.deepEqual(staleHolders("nope"), []);
});
