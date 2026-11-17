"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createFeedback, parseRecorded } = require("../lib/operator/feedback");

const BOT = "1479984768194969663", OWNER = "333052320252297216", GUILD = "1465445442987888743";
const TOKEN = "test-interaction-token-xxxxxxxxxxxx";
function fixture({ replies = {}, member = { roles: [] }, enabled = true } = {}) {
  let t = 1_800_000_000_000;
  const ledger = { data: {}, saves: 0, audits: [], save() { this.saves++; }, audit(k, v) { this.audits.push([k, v]); } };
  const calls = [];
  const discord = async (method, url, body) => {
    calls.push({ method, url, body });
    if (method === "GET" && url.startsWith("/webhooks/")) { const r = replies[url.split("/")[3]]; if (!r) throw new Error("404 Unknown Webhook"); return r; }
    if (method === "GET" && url.startsWith("/guilds/")) return member;
    return {};
  };
  const config = { botId: BOT, ownerId: OWNER, guildId: GUILD, staffIds: ["565289871799746593"], modRoleIds: ["900000000000000001"] };
  const isModerator = async (id) => ((await discord("GET", `/guilds/${GUILD}/members/${id}`)).roles || []).includes("900000000000000001");
  const fb = createFeedback({ ledger, config, discord, isModerator, now: () => t, release: "10.2.0", enabled });
  return { fb, ledger, calls, advance: (ms) => { t += ms; }, at: () => t };
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
  const { fb, calls } = fixture();
  await fb.delivered("100000000000000001", "200000000000000001", job);
  await fb.delivered("100000000000000002", "200000000000000009", job);
  assert.equal(calls.length, 0);
  await fb.delivered("100000000000000001", "200000000000000002", job);
  assert.deepEqual(calls, [{ method: "PATCH", url: "/channels/100000000000000001/messages/200000000000000001", body: { components: [] } }]);
});

test("rows expire after a day", async () => {
  const { fb, calls, advance } = fixture();
  await fb.delivered("100000000000000001", "200000000000000001", job);
  advance(23 * 3600000); await fb.sweep(); assert.equal(calls.length, 0);
  advance(2 * 3600000); await fb.sweep();
  assert.equal(calls[0].method, "PATCH"); assert.equal(calls.length, 1);
  await fb.sweep(); assert.equal(calls.length, 1);
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
