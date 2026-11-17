"use strict";
// Keir 10.3: durable ticket case file, contradiction gate on the post path, shift log, injection order.
const test = require("node:test");
const assert = require("node:assert");
const { setup } = require("./keir10-post.helpers");
const tc = require("../lib/operator/ticketcase");
const shiftlog = require("../lib/operator/shiftlog");
const continuity = require("../lib/operator/continuity");

const FIRST = "Your cards are reachable from the Cards tab.";
const FLIP = "Your cards are not reachable from the Cards tab.";

test("1852 replay: reachable, then not reachable without a correction is blocked by check_draft and the real post", async () => {
  const f = setup(); f.playerWrote(5);
  await f.broker.tool(f.job, "channel_reply", { message: FIRST });
  assert.equal(f.posts().length, 1);
  assert.equal(tc.get(f.ledger.data, 123).claims[0].status, "standing", "the delivery path recorded the claim");
  // Past the day ticketPosts remembers: only the durable case file still knows.
  f.advance(26 * 60); f.ledger.data.ticketPosts[123] = []; f.playerWrote(5);
  const c = await f.broker.tool(f.job, "check_draft", { message: FLIP });
  assert.equal(c.ok, false);
  const hit = c.problems.find((p) => /standing claim in the case file/.test(p.problem));
  assert.ok(hit, JSON.stringify(c.problems));
  assert.match(hit.problem, /Correction:/);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: FLIP }), /Correction:/);
  assert.equal(f.audits("case_contradiction_refused").length >= 1, true);
  assert.equal(f.posts().length, 1);
  // The explicit correction goes out and the old claim is marked corrected.
  await f.broker.tool(f.job, "channel_reply", { message: `Correction: ${FLIP.toLowerCase().replace("your", "your")} I read the wrong record.` });
  assert.equal(f.posts().length, 2);
  const claims = tc.get(f.ledger.data, 123).claims;
  assert.equal(claims.find((x) => x.pol === "pos").status, "corrected");
  assert.equal(claims.find((x) => x.pol === "neg").status, "standing");
});

test("a draft that agrees with the standing claim is not blocked", async () => {
  const f = setup(); f.playerWrote(5);
  await f.broker.tool(f.job, "channel_reply", { message: FIRST });
  f.advance(26 * 60); f.ledger.data.ticketPosts[123] = []; f.playerWrote(5);
  const c = await f.broker.tool(f.job, "check_draft", { message: "The Cards tab lists every card, and your cards are reachable there." });
  assert.equal(c.problems.filter((p) => /case file/.test(p.problem)).length, 0, JSON.stringify(c.problems));
});

// Shift log
const stub = (over = {}) => ({ decisions: async () => ["Approve hotfix -> approved"], fixes: async () => ["card 1: Sector tech cap"], releases: async () => ["Keir 10.2.3 (hotfix)"], turn: async () => ["current turn 24 ok"], bugs: async () => ["2 tickets (#1852, #1845): Sector tech does nothing"], ...over });

test("shift log collects every section from stubbed sources within the cap", async () => {
  const out = await shiftlog.collect(stub(), { now: () => 5 });
  for (const t of ["Owner decisions today", "Fixes in flight", "Shipped, last 24h", "Turn", "Known bugs"]) assert.match(out.text, new RegExp(t));
  assert.match(out.text, /Approve hotfix/);
  assert.ok(out.text.length <= shiftlog.SHIFT_CHARS);
  assert.doesNotMatch(out.text, /[\u2013\u2014]/);
});

test("a failing or hung source degrades to unavailable and never throws", async () => {
  const out = await shiftlog.collect(stub({ fixes: async () => { throw new Error("boom"); }, turn: () => new Promise(() => {}) }), { timeoutMs: 30 });
  assert.match(out.text, /Fixes in flight: unavailable/);
  assert.match(out.text, /Turn: unavailable/);
  assert.match(out.text, /Owner decisions today:\n- Approve hotfix/);
  const none = await shiftlog.collect(stub({ decisions: async () => [] }));
  assert.match(none.text, /Owner decisions today: none/);
});

test("the ledger sources read decisions and coding jobs, group bugs by title and survive dead MCPs", async () => {
  const now = Date.parse("2026-11-17T20:00:00Z");
  const ledger = { data: { decisions: { a: { state: "answered", answeredAt: now - 3600000, tldr: "Ship the cap fix", answerText: "yes" }, b: { state: "answered", answeredAt: now - 3 * 86400000, tldr: "Old one", answerText: "no" }, c: { state: "pending", at: now } },
    jobs: { p: { id: "p", ticket: 1852 }, w: { id: "w", kind: "coding", codingParent: "p", state: "running", summary: "Raise the sector tech cap", pullRequests: ["https://github.com/x/y/pull/9"] } } }, save() {} };
  const mcp = { call: async (server, tool) => { if (tool === "support_list") return { items: [{ number: 1, title: "Sector Tech does nothing at cap", category: "bug" }, { number: 2, title: "sector tech does nothing at 30% cap", category: "bug" }, { number: 3, title: "Cannot log in", category: "bug" }, { number: 4, title: "Idea", category: "suggestion" }] }; throw new Error("down"); } };
  const sources = shiftlog.sourcesFor({ ledger, mcp, api: async () => { throw new Error("gh down"); }, releasesFile: "/nonexistent/releases.jsonl", now: () => now });
  const out = await shiftlog.collect(sources, { now: () => now });
  assert.match(out.text, /Ship the cap fix -> yes/);
  assert.doesNotMatch(out.text, /Old one/);
  assert.match(out.text, /Keir worker, ticket 1852: Raise the sector tech cap \(PR #9\)/);
  assert.match(out.text, /kanban unavailable/);
  assert.match(out.text, /2 tickets \(#1, #2\)/);
  assert.match(out.text, /Turn: unavailable/);
  assert.match(out.text, /game main unavailable/);
});

test("createShiftLog serves the ledger snapshot while fresh and rebuilds a stale one", async () => {
  let n = 0, clock = 1000;
  const ledger = { data: {}, save() {} };
  const log = shiftlog.createShiftLog({ ledger, sources: stub({ turn: async () => [`current turn ${++n}`] }), now: () => clock });
  assert.match(await log.get(), /current turn 1/);
  clock += 5 * 60000; assert.match(await log.get(), /current turn 1/);
  clock += 30 * 60000; assert.match(await log.get(), /current turn 2/);
});

// Injection order
test("the case file leads the activation context, then the shift log, then everything else", async () => {
  const f = setup(); f.playerWrote(5);
  await f.broker.tool(f.job, "channel_reply", { message: FIRST });
  continuity.setShiftLog(shiftlog.createShiftLog({ ledger: f.ledger, sources: stub() }));
  try {
    const parts = await continuity.prepare({ ledger: f.ledger, job: f.job, config: {} });
    assert.ok(parts.ticketCaseFile && parts.shiftLog);
    const context = { whatChanged: { x: 1 }, taskId: "t", caseFile: {}, ...parts, lane: "worker" };
    continuity.promote(context);
    assert.deepEqual(Object.keys(context).slice(0, 2), ["ticketCaseFile", "shiftLog"]);
    assert.ok(Object.keys(JSON.parse(JSON.stringify(context))).indexOf("whatChanged") === 2);
    assert.match(context.ticketCaseFile, /Your cards are reachable/);
    // never for a player's own task
    assert.deepEqual(await continuity.prepare({ ledger: f.ledger, job: { ...f.job, role: "player" }, config: {} }), {});
  } finally { continuity.setShiftLog(null); }
});
