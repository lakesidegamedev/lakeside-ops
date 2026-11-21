"use strict";
// Keir 11.2 item 8: ticket post budget. Replays the real post sequences of tickets 1845 and 1859 (fixture notes say what
// is inferred) through the same rules the broker's post guard and live notice apply, and checks which posts would have
// been suppressed or merged.
const test = require("node:test");
const assert = require("node:assert");
const pb = require("../lib/operator/postbudget");
const { isCorrection } = require("../lib/operator/playercopy");
const fixture = require("./fixtures/keir112-ticket-posts.json");

const t = (iso) => Date.parse(iso);
const promises = require("../lib/operator/promises");
const closing = require("../lib/operator/closing");
// Mirrors broker.guardTicketPostRules (model replies) and broker.liveNotice (code notices) for the 11.2 rules, including the
// second pass's single turn rule: a turn report needs a player message, a due recorded promise (recorded by the post path as
// posts go out) or the closing condition, and never repeats the answer. close: { from, ref } is the ticket's closing condition
// calling for turn ref, set at time from. The turn clock is read from the turn numbers the posts themselves report.
function replay(ticket, { cap = 4, close = null } = {}) {
  const f = fixture.tickets[ticket];
  const events = [...f.posts.map((p) => ({ ...p, t: t(p.at) })), ...f.player.map((p) => ({ kind: "player", t: t(p.at) }))].sort((a, b) => a.t - b.t);
  const accepted = [], suppressed = [], announced = new Set();
  const d = { ticketPromises: {}, watch: {} }, job = { id: `j${ticket}`, kind: "ticket", ticket };
  let humanAt = 0, overflowAt = null, turn = null, turnAt = 0, stepBacks = [];
  for (const e of events) {
    if (e.kind === "player") { humanAt = e.t; continue; }
    // Turns run hourly: the clock is the latest turn a post named, plus the hours since.
    const named = [...String(e.text).matchAll(/\bturn (\d+)\b/gi)].map((m) => Number(m[1]));
    const sinceNamed = turn ? Math.floor((e.t - turnAt) / 3600000) : 0;
    if (named.length && Math.max(...named) >= (turn || 0) + sinceNamed) { turn = Math.max(...named); turnAt = e.t; }
    d.watch.turnClock = turn ? { turn: turn + Math.floor((e.t - turnAt) / 3600000), at: e.t } : undefined;
    if (close && e.t >= t(close.from) && !job.closing) job.closing = { closesWhen: close.closesWhen, waitingOn: close.waitingOn, on: { kind: "turn", ref: close.ref } };
    const receipts = f.receipts.filter((r) => t(r.at) <= e.t);
    const receipt = receipts.length ? { key: receipts.map((r) => r.key).join("|"), at: t(receipts.at(-1).at) } : null;
    let why = null;
    if (e.kind === "notice") {
      if (!receipt) why = "no main release receipt";
      else if (announced.has(receipt.key)) why = "this release was already announced";
      else if (accepted.some((p) => p.at >= receipt.at && pb.liveClaim(p.text))) why = "the model already said it is live";
    } else if (!/^Your support report has been resolved/.test(e.text)) { // the resolve notice is not a channel reply
      const owed = humanAt > (accepted.at(-1)?.at || 0);
      const calledFor = closing.closingCallsForTurn(d, job, e.t);
      const turnArgs = { posts: accepted, humanAt, message: e.text, correction: isCorrection(e.text), promiseDue: promises.calledFor(d, ticket, e.t), calledFor };
      e.via = pb.turnPostVia(turnArgs);
      const turnRule = pb.turnPostRule(turnArgs);
      if (pb.liveClaim(e.text) && pb.liveAlreadySaid({ posts: accepted, receipt, humanAt })) why = "live already said";
      else if (turnRule) why = turnRule.why;
      else {
        const r = pb.hourly({ posts: accepted, humanAt, now: e.t, cap, essential: owed || isCorrection(e.text), overflowUsedAt: overflowAt });
        if (!r.allow) why = "hourly cap";
        else if (r.overflow) overflowAt = e.t;
        else if (e.via === "closing") closing.noteTurnReport(d, job, e.t);
        else if (e.via === "promise") promises.keepForReport(d, ticket, e.t);
      }
    }
    if (why) { suppressed.push({ at: e.at, kind: e.kind, why, text: e.text.slice(0, 80) }); continue; }
    if (e.kind === "notice" && receipt) announced.add(receipt.key);
    accepted.push({ at: e.t, text: e.text, kind: "reply", via: e.via || null });
    if (e.kind !== "notice") {
      promises.notePost(d, ticket, job, e.text, e.t);
      closing.notePost(d, ticket, e.text, { now: e.t, correction: isCorrection(e.text) });
      // The activation after this post: a step-back when a threshold was crossed (job.at: the ticket's first post).
      job.at ||= e.t;
      if (closing.stepBack(d, job, e.t + 60000, closing.DEFAULTS)) { stepBacks.push({ after: e.at, level: job.stepBackLevel, why: job.stepBack.why.join(", ") }); job.stepBack.done = true; }
    }
  }
  return { accepted, suppressed, live: accepted.filter((p) => pb.liveClaim(p.text)), stepBacks, promises: d.ticketPromises[ticket] || [] };
}
const hhmm = (iso) => iso.slice(5, 16);

// The 1845 closing condition as the model would have set it when the first fix was written (16:12): the player's shops
// get retail demand after the fix, waiting on the first turn after it is live (turn 21).
const CLOSE_1845 = { from: "2026-11-17T16:12:00Z", ref: 21, closesWhen: "closes when the player's shops get retail demand after the fix", waitingOn: "the first turn after the fix is live" };

test("ticket 1845: eight 'now live' notices become four, the repeated model announcement is refused, and per-turn posts stop", () => {
  const before = fixture.tickets[1845].posts;
  assert.equal(before.filter((p) => p.kind === "notice").length, 8);
  const r = replay(1845, { close: CLOSE_1845 });
  const notices = r.accepted.filter((p) => /^This is now live/.test(p.text));
  assert.equal(notices.length, 4, JSON.stringify(r.suppressed, null, 1));
  const why = Object.fromEntries(r.suppressed.map((s) => [`${hhmm(s.at)} ${s.kind}`, s.why]));
  // 17:14: the model announced the 17:01 release a second time.
  assert.equal(why["11-17T17:14 reply"], "live already said");
  // 18:12, 19:04 and 22:04: the same release renamed on the card.
  for (const k of ["11-17T18:12", "11-17T19:04", "11-17T22:04"]) assert.match(why[`${k} notice`] || "", /already announced|already said/, k);
  // 20:55 next day: the model had already said it at 20:36, so the card notice stays quiet (one voice).
  assert.equal(why["11-18T20:55 notice"], "the model already said it is live");
  // Keir 11.2 second pass: a turn having run is not a reason to post. Seven unprompted per-turn reports are held back.
  assert.deepEqual(r.suppressed.filter((s) => s.why === "turn not called for").map((s) => hhmm(s.at)),
    ["11-17T22:04", "11-17T23:12", "11-18T00:31", "11-18T04:52", "11-18T13:46", "11-18T19:52", "11-18T21:06"]);
  assert.equal(r.suppressed.length, 12);
  assert.equal(r.accepted.length, 21);
  // Corrections are never suppressed.
  assert.ok(!r.suppressed.some((s) => isCorrection(s.text)));
});

test("ticket 1845 through the wake path: every turn report that goes out was called for, and one step-back comes at the threshold", () => {
  const r = replay(1845, { close: CLOSE_1845 });
  // Why each turn report went out, as the rule decided it: a promise Keir had made (each promise licenses one report), the
  // closing condition's one turn, the player had just written, or a correction.
  const reasons = r.accepted.filter((p) => p.via).map((p) => [new Date(p.at).toISOString().slice(5, 16), p.via]);
  assert.deepEqual(reasons, [["11-17T17:07", "correction"], ["11-17T18:03", "promise"], ["11-17T19:04", "closing"], ["11-17T21:07", "promise"],
    ["11-18T04:58", "answer"], ["11-18T10:59", "promise"], ["11-18T23:08", "promise"]]);
  // The promises those posts kept were recorded by the post path, not by the model.
  assert.ok(r.promises.some((p) => p.state === "kept" && /\bI will check\b|\bI will\b/i.test(p.text)));
  // Exactly one step-back activation at the threshold (the 10th Keir post).
  assert.equal(r.stepBacks.length, 1, JSON.stringify(r.stepBacks));
  assert.equal(r.stepBacks[0].level, 1);
  assert.match(r.stepBacks[0].why, /10 Keir posts/);
  // Without the closing condition one more report (turn 22) is held back: only a promise, the player or the condition opens one.
  const bare = replay(1845);
  assert.equal(bare.suppressed.filter((s) => s.why === "turn not called for").length, 8);
});

test("ticket 1859: the live notice with no release of its own is suppressed; corrections and answers still go out", () => {
  const r = replay(1859);
  const why = Object.fromEntries(r.suppressed.map((s) => [hhmm(s.at), s.why]));
  assert.equal(why["11-19T03:16"], "no main release receipt", "the false 03:16 notice");
  assert.equal(r.suppressed.length, 1, "only the false notice");
  assert.ok(r.accepted.some((p) => /^Correction: the "now live on the main server" note above was wrong/.test(p.text)));
  assert.ok(r.accepted.some((p) => /^The turn has now run/.test(p.text)), "the promised turn follow-up goes out");
  assert.ok(!r.suppressed.some((s) => isCorrection(s.text)));
});

test("hourly cap: past the limit a correction or owed answer still goes out; anything else is refused with a reason", () => {
  const now = t("2026-11-19T04:00:00Z"), m = (min) => now - min * 60000;
  const posts = [m(50), m(40), m(30), m(20)].map((at) => ({ at, text: "Update." }));
  assert.equal(pb.hourly({ posts, humanAt: m(55), now, cap: 4 }).allow, false);
  const first = pb.hourly({ posts, humanAt: m(55), now, cap: 4, essential: true });
  assert.deepEqual([first.allow, first.overflow], [true, true]);
  // Third pass: an essential post always goes out; after the merged overflow message, anything else waits.
  assert.equal(pb.hourly({ posts, humanAt: m(55), now, cap: 4, essential: true, overflowUsedAt: m(1) }).allow, true);
  const second = pb.hourly({ posts, humanAt: m(55), now, cap: 4, overflowUsedAt: m(1) });
  assert.equal(second.allow, false);
  assert.match(pb.hourlyRefusal(second, 4), /merged message past that limit already went out/);
  assert.match(pb.hourlyRefusal(pb.hourly({ posts, humanAt: m(55), now, cap: 4 }), 4), /Merge what is still needed into one message/);
  // A new player message resets the count.
  assert.equal(pb.hourly({ posts, humanAt: m(10), now, cap: 4 }).allow, true);
  // Status cards never count.
  assert.equal(pb.hourly({ posts: posts.map((p) => ({ ...p, kind: "status_card" })), humanAt: m(55), now, cap: 4 }).allow, true);
});

test("the single turn rule: called-for reports still never repeat the answer; questions and the first answer always pass", () => {
  const posts = [{ at: 10, text: "Turn 27: every basket on offer sold for a fourth turn, and the price rose to 106.64 from 104.55." }];
  const same = "Turn 28: every basket on offer sold again, and the price rose to 108.10 from 106.64.";
  assert.equal(pb.turnPostRule({ posts, humanAt: 0, message: same, calledFor: true }).why, "same turn answer");
  assert.equal(pb.turnPostRule({ posts, humanAt: 0, message: "Turn 28: shops did not sell out; some went unsold.", calledFor: true }), null);
  assert.equal(pb.turnPostRule({ posts, humanAt: 0, message: same }).why, "turn not called for");
  assert.equal(pb.turnPostRule({ posts, humanAt: 0, message: same, promiseDue: true }), null);
  assert.equal(pb.turnPostRule({ posts, humanAt: 20, message: same }), null, "the player wrote");
  assert.equal(pb.turnPostRule({ posts: [], humanAt: 0, message: same }), null, "the first answer");
  assert.equal(pb.turnPostRule({ posts: [], humanAt: 0, message: same, lastKeirAt: 10 }).why, "turn not called for", "the post window emptied but Keir has posted");
  assert.equal(pb.turnPostRule({ posts, humanAt: 0, message: "Did turn 28 show your plant running?" }), null, "a question");
  assert.equal(pb.turnPostRule({ posts, humanAt: 0, message: "Your coal contract renews at turn 30." }), null, "a turn number is not a turn report");
});

test("turn reports: same answer with new numbers is a repeat; a changed answer or a player message is not", () => {
  const posts = [{ at: 1, text: "Turn 27: every basket on offer sold for a fourth turn, and the price rose to 106.64 from 104.55." }];
  assert.ok(pb.repeatsTurnAnswer({ posts, humanAt: 0, message: "Turn 28: every basket on offer sold again, and the price rose to 108.10 from 106.64." }));
  assert.equal(pb.repeatsTurnAnswer({ posts, humanAt: 0, message: "Turn 28: shops did not sell out; 12% went unsold and the price fell to 101.20." }), null);
  assert.equal(pb.repeatsTurnAnswer({ posts, humanAt: 2, message: "Turn 28: every basket on offer sold again, and the price rose to 108.10." }), null);
  assert.equal(pb.repeatsTurnAnswer({ posts, humanAt: 0, message: "Your refund is with the owner." }), null);
});

test("live claims: future and conditional wording is not an announcement", () => {
  assert.equal(pb.liveClaim("This is now live on the main server: Cheaper new stores."), true);
  assert.equal(pb.liveClaim("The retail fix is live from this turn: background countries now buy consumer goods."), true);
  assert.equal(pb.liveClaim("The repair is built and almost ready to go live, but it is not on the live server yet."), false);
  assert.equal(pb.liveClaim("It will be live on the main server after the next promotion."), false);
});

// Through the real post path (broker channel_reply): the guard is wired and the post path records promises itself.
const { setup } = require("./keir10-post.helpers");
test("post path: a promise in a delivered reply is recorded with a due time; a fifth post in an hour is refused with a reason", async () => {
  const f = setup(); f.playerWrote(5);
  await f.broker.tool(f.job, "channel_reply", { message: "Your plant is idle because it has no coal supplier. Once a turn has run, I will check its output and tell you." });
  const p = f.ledger.data.ticketPromises?.[123]?.[0];
  assert.equal(p?.kind, "turn");
  assert.equal(p.dueAt, f.now() + 90 * 60000);
  // Three more posts fill the hour (seeded as earlier posts), then a plain update is refused with the merge instruction.
  const posts = f.ledger.data.ticketPosts[123];
  for (const m of [3, 2, 1]) posts.push({ at: f.now() - m * 60000, jobId: "other", kind: "reply", text: `Update ${m}.` });
  f.advance(11);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Your coal contract renews at turn 30." }), /in the last hour with no new message from the player \(limit 4\)\. Merge what is still needed into one message/);
  // A correction still goes out as the one merged message.
  await f.broker.tool(f.job, "channel_reply", { message: "Correction: the contract renews at turn 31, not 30." });
  assert.equal(f.posts().length, 2);
});
