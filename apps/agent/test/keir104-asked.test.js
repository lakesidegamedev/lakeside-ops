"use strict";
// Keir 10.4: answer what the player asked. Asked anchor in the case file, deflection gate on the post path,
// and the downvote loop (ticket 1852: the player reported a tech cap, Keir answered about R&D points, vote: "this is not what i asked about").
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./keir10-post.helpers");
const { createFeedback } = require("../lib/operator/feedback");
const tc = require("../lib/operator/ticketcase");

const T0 = Date.parse("2026-11-17T14:00:00Z");
const ASKED = "Sector Tech does nothing because it's already at 30% cap";
const DEFLECT = "Your real blocker is R&D points: you hold 1.2 against a cost of 38, so the research cannot start.";
const ANSWER = "Sector Tech is capped at 30%, so more research in it adds nothing until the cap rises. Separately, your R&D points are 1.2 against a cost of 38.";

function ticketFixture() {
  const f = setup();
  f.job.source.content = ASKED;
  f.ledger.data.ticketObservations = { 123: [{ tool: "read_tool", at: f.now() - 1000, input: "{}", result: JSON.stringify({ researchPoints: 1.2, researchCost: 38, sectorTechCapPercent: 30 }) }] };
  tc.syncActivation(f.ledger.data, f.job, { now: f.now() });
  f.playerWrote(5);
  return f;
}

test("the ticket text is recorded as asked and rendered first, open items first", () => {
  const d = {};
  const j = { id: "j1", ticket: 1852, kind: "ticket", channelId: "C1", source: { at: new Date(T0).toISOString(), content: ASKED, authorId: "P" } };
  d.channelContext = { C1: [{ role: "player", authorId: "P", at: new Date(T0 + 5000).toISOString(), content: "Thanks, that is great." }, { role: "player", authorId: "P", at: new Date(T0 + 9000).toISOString(), content: "Why can't I build a second lab?" }] };
  tc.syncActivation(d, j, { now: T0 + 10000, ownerId: "O", botId: "B" });
  const c = tc.get(d, 1852);
  assert.equal(c.asked.length, 2, "thanks is not an ask");
  assert.ok(c.asked.every((a) => a.answeredAt === null));
  tc.recordPost(d, j, ANSWER, { now: T0 + 20000 });
  assert.ok(c.asked[0].answeredAt, "the cap complaint was answered");
  assert.equal(c.asked[1].answeredAt, null, "the lab question was not");
  const text = tc.render(d, 1852);
  assert.match(text, /Player asked/);
  assert.match(text, /^Case file[^\n]*\nPlayer asked/, "asked comes first, before claims");
  const lines = text.split("\n").filter((l) => /OPEN:|answered:/.test(l));
  assert.match(lines[0], /OPEN: Why can't I build a second lab/, "open items first");
  assert.match(lines[1], /answered: Sector Tech does nothing/);
});

test("1852 replay: the R&D deflection is refused, check_draft lists it without spending the budget, the real answer passes", async () => {
  const f = ticketFixture();
  assert.equal(tc.get(f.ledger.data, 123).asked.length, 1);
  const c = await f.broker.tool(f.job, "check_draft", { message: DEFLECT });
  assert.equal(c.ok, false);
  assert.ok(c.problems.some((p) => /does not answer it/.test(p.problem) && /Sector Tech does nothing/.test(p.problem)), JSON.stringify(c.problems));
  assert.equal(tc.get(f.ledger.data, 123).askedRefusals, 0, "check_draft does not spend the budget");
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: DEFLECT }), /Answer what they asked first/);
  assert.equal(f.audits("asked_deflection_refused").length >= 1, true);
  assert.equal(f.posts().length, 0);
  assert.equal(tc.get(f.ledger.data, 123).askedRefusals, 1);
  const ok = await f.broker.tool(f.job, "check_draft", { message: ANSWER });
  assert.ok(!ok.problems?.some((p) => /does not answer it/.test(p.problem)), JSON.stringify(ok.problems));
  await f.broker.tool(f.job, "channel_reply", { message: ANSWER });
  assert.equal(f.posts().length, 1);
  assert.ok(tc.get(f.ledger.data, 123).asked[0].answeredAt, "the post marked the ask answered");
});

test("refusals stop at two per ticket so a post never sticks", async () => {
  const f = ticketFixture();
  for (let i = 0; i < 2; i++) await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: `${DEFLECT} Attempt ${i}.` }), /Answer what they asked first/);
  await f.broker.tool(f.job, "channel_reply", { message: DEFLECT });
  assert.equal(f.posts().length, 1);
});

test("questions back to the player, corrections and posts on the asked subject are not deflections", () => {
  const d = {};
  const j = { id: "j1", ticket: 1852, kind: "ticket", source: { at: new Date(T0).toISOString(), content: ASKED, authorId: "P" } };
  tc.syncActivation(d, j, { now: T0, ownerId: "O", botId: "B" });
  assert.equal(tc.deflection(d, 1852, "The real blocker may be elsewhere. Can you send a screenshot of the Sector Tech page?"), null);
  assert.equal(tc.deflection(d, 1852, "Correction: that was the wrong record, the real issue is the 30% cap on Sector Tech."), null);
  assert.equal(tc.deflection(d, 1852, "The Sector Tech cap of 30% is by design, so extra research does nothing there."), null, "it addresses the subject");
  assert.equal(tc.deflection(d, 1852, "I'm still looking into this and will report back after the next turn."), null, "a holding line has no redirect");
  assert.ok(tc.deflection(d, 1852, "This is working as intended. Your lab queue is full."));
  assert.equal(tc.deflection({}, 1852, DEFLECT), null, "no asked item, no gate");
});

// Downvote loop
const BOT = "1479984768194969663", OWNER = "333052320252297216", GUILD = "1465445442987888743", TOKEN = "test-interaction-token-xxxxxxxxxxxx";
function fbFixture({ members = {}, state = "waiting" } = {}) {
  let t = T0;
  const jobs = { j1: { id: "j1", kind: "ticket", ticket: 1852, state, inbox: [], source: { at: new Date(T0 - 60000).toISOString(), content: ASKED, authorId: "P" } } };
  const ledger = { data: { jobs, seen: { "ticket:1852": "j1" } }, audits: [], save() {}, audit(k, v) { this.audits.push([k, v]); } };
  tc.syncActivation(ledger.data, jobs.j1, { now: T0 - 30000 });
  const replies = {};
  const discord = async (method, url) => {
    if (method === "GET" && url.startsWith("/webhooks/")) return replies[url.split("/")[3]];
    if (method === "GET" && url.startsWith("/guilds/")) return { roles: [] };
    if (method === "GET" && /^\/channels\/\d+\/messages\/\d+$/.test(url)) return { content: DEFLECT };
    if (method === "GET" && url.startsWith("/channels/")) return [];
    return {};
  };
  const woke = [];
  const fb = createFeedback({ ledger, config: { botId: BOT, ownerId: OWNER, guildId: GUILD, staffIds: ["565289871799746593"] }, discord, now: () => t, release: "10.4.0", wake: (j) => woke.push(j.id) });
  const vote = async (user, msg, text = "Thanks, feedback recorded: 👎 Not helpful.\nReason: this is not what i asked about") => {
    replies[TOKEN] = { author: { id: BOT }, content: text, flags: 64, interaction_metadata: { type: 3, user: { id: user }, interacted_message_id: msg } };
    return fb.record({ token: TOKEN });
  };
  return { fb, ledger, jobs, woke, vote, advance: (ms) => { t += ms; } };
}
const delivered = (fb, msg) => fb.delivered("100000000000000001", msg, { id: "j1", ticket: 1852, kind: "ticket", role: "support", provider: {} });

test("a player downvote lands in the case file, reopens the touched ask and wakes the ticket once", async () => {
  const f = fbFixture();
  tc.recordPost(f.ledger.data, f.jobs.j1, ANSWER, { now: T0 - 1000 });
  assert.ok(tc.get(f.ledger.data, 1852).asked[0].answeredAt);
  await delivered(f.fb, "200000000000000001");
  f.ledger.data.ticketPosts = { 1852: [{ jobId: "j1", at: T0, text: DEFLECT }] };
  const r = await f.vote("400000000000000001", "200000000000000001");
  assert.equal(r.voter, "player");
  const c = tc.get(f.ledger.data, 1852);
  assert.equal(c.said.length, 1);
  assert.match(c.said[0].text, /Player marked an answer unhelpful: this is not what i asked about/);
  assert.match(c.said[0].text, /Your real blocker is R&D points/);
  assert.match(tc.render(f.ledger.data, 1852), /Player statements/);
  assert.equal(f.woke.length, 1);
  assert.equal(f.jobs.j1.state, "queued");
  const row = f.jobs.j1.inbox.at(-1);
  assert.equal(row.role, "system");
  assert.match(row.content, /Re-read the "Player asked" items/);
  assert.equal(f.ledger.audits.filter(([k]) => k === "answer_feedback_wake").length, 1);
});

test("a downvote that touched the answered ask reopens it", async () => {
  const f = fbFixture();
  tc.recordPost(f.ledger.data, f.jobs.j1, ANSWER, { now: T0 - 1000 });
  await delivered(f.fb, "200000000000000001");
  const res = tc.playerUnhelpful(f.ledger.data, 1852, { answerText: ANSWER, reason: null, at: T0 });
  assert.equal(res.reopened.length, 1);
  assert.equal(tc.get(f.ledger.data, 1852).asked[0].answeredAt, null);
  assert.match(tc.get(f.ledger.data, 1852).said[0].text, /no reason/);
});

test("a second downvote within the hour is recorded but does not wake; after the hour it does", async () => {
  const f = fbFixture();
  await delivered(f.fb, "200000000000000001");
  await f.vote("400000000000000001", "200000000000000001");
  f.jobs.j1.state = "waiting";
  await delivered(f.fb, "200000000000000002");
  f.advance(20 * 60000);
  await f.vote("400000000000000001", "200000000000000002");
  assert.equal(f.woke.length, 1);
  assert.equal(tc.get(f.ledger.data, 1852).said.length, 2, "both statements are in the case file");
  assert.equal(f.jobs.j1.state, "waiting");
  f.advance(45 * 60000);
  await delivered(f.fb, "200000000000000003");
  await f.vote("400000000000000001", "200000000000000003");
  assert.equal(f.woke.length, 2);
});

test("owner and staff downvotes are recorded only, no case entry, no wake; a changed-to-same vote does not repeat", async () => {
  const f = fbFixture();
  await delivered(f.fb, "200000000000000001");
  await f.vote(OWNER, "200000000000000001");
  await f.vote("565289871799746593", "200000000000000001");
  assert.equal(f.woke.length, 0);
  assert.equal(tc.get(f.ledger.data, 1852).said.length, 0);
  assert.equal(Object.keys(f.ledger.data.answerFeedback.votes).length, 2);
  await f.vote("400000000000000001", "200000000000000001");
  await f.vote("400000000000000001", "200000000000000001");
  assert.equal(f.woke.length, 1);
  assert.equal(tc.get(f.ledger.data, 1852).said.length, 1);
});

test("a thumbs up from a player does nothing to the case, and a finished ticket is not reopened", async () => {
  const f = fbFixture();
  await delivered(f.fb, "200000000000000001");
  await f.vote("400000000000000001", "200000000000000001", "Thanks, feedback recorded: 👍 Helpful.");
  assert.equal(f.woke.length, 0);
  const g = fbFixture({ state: "done" });
  await delivered(g.fb, "200000000000000001");
  await g.vote("400000000000000001", "200000000000000001");
  assert.equal(g.woke.length, 0);
  assert.equal(g.jobs.j1.state, "done");
  assert.equal(tc.get(g.ledger.data, 1852).said.length, 1, "still recorded");
});
