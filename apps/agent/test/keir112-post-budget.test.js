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
// Mirrors broker.guardTicketPostRules (model replies) and broker.liveNotice (code notices) for the 11.2 rules.
function replay(ticket, { cap = 4 } = {}) {
  const f = fixture.tickets[ticket];
  const events = [...f.posts.map((p) => ({ ...p, t: t(p.at) })), ...f.player.map((p) => ({ kind: "player", t: t(p.at) }))].sort((a, b) => a.t - b.t);
  const accepted = [], suppressed = [], announced = new Set();
  let humanAt = 0, overflowAt = null;
  for (const e of events) {
    if (e.kind === "player") { humanAt = e.t; continue; }
    const receipts = f.receipts.filter((r) => t(r.at) <= e.t);
    const receipt = receipts.length ? { key: receipts.map((r) => r.key).join("|"), at: t(receipts.at(-1).at) } : null;
    let why = null;
    if (e.kind === "notice") {
      if (!receipt) why = "no main release receipt";
      else if (announced.has(receipt.key)) why = "this release was already announced";
      else if (accepted.some((p) => p.at >= receipt.at && pb.liveClaim(p.text))) why = "the model already said it is live";
    } else {
      const owed = humanAt > (accepted.at(-1)?.at || 0);
      if (pb.liveClaim(e.text) && pb.liveAlreadySaid({ posts: accepted, receipt, humanAt })) why = "live already said";
      else if (!isCorrection(e.text) && pb.repeatsTurnAnswer({ posts: accepted, humanAt, message: e.text })) why = "same turn answer";
      else {
        const r = pb.hourly({ posts: accepted, humanAt, now: e.t, cap, essential: owed || isCorrection(e.text), overflowUsedAt: overflowAt });
        if (!r.allow) why = "hourly cap";
        else if (r.overflow) overflowAt = e.t;
      }
    }
    if (why) { suppressed.push({ at: e.at, kind: e.kind, why, text: e.text.slice(0, 80) }); continue; }
    if (e.kind === "notice" && receipt) announced.add(receipt.key);
    accepted.push({ at: e.t, text: e.text, kind: "reply" });
  }
  return { accepted, suppressed, live: accepted.filter((p) => pb.liveClaim(p.text)) };
}
const hhmm = (iso) => iso.slice(5, 16);

test("ticket 1845: eight 'now live' notices become four, the repeated model announcement is refused, and repeated turn answers stop", () => {
  const before = fixture.tickets[1845].posts;
  assert.equal(before.filter((p) => p.kind === "notice").length, 8);
  const r = replay(1845);
  const notices = r.accepted.filter((p) => /^This is now live/.test(p.text));
  assert.equal(notices.length, 4, JSON.stringify(r.suppressed, null, 1));
  const why = Object.fromEntries(r.suppressed.map((s) => [hhmm(s.at), s.why]));
  // 17:14: the model announced the 17:01 release a second time.
  assert.equal(why["11-17T17:14"], "live already said");
  // 18:12, 19:04 and 22:04: the same release renamed on the card.
  for (const k of ["11-17T18:12", "11-17T19:04", "11-17T22:04"]) assert.match(why[k] || "", /already announced|already said/, k);
  // 20:55 next day: the model had already said it at 20:36, so the card notice stays quiet (one voice).
  assert.equal(why["11-18T20:55"], "the model already said it is live");
  // Turn reports that repeat the answer with new numbers and no player message in between (turns 25, 27 and 37).
  assert.deepEqual(r.suppressed.filter((s) => s.why === "same turn answer").map((s) => hhmm(s.at)), ["11-17T22:04", "11-18T00:31", "11-18T10:59"]);
  assert.equal(r.suppressed.length, 8);
  assert.equal(r.accepted.length, 25);
  // Corrections are never suppressed.
  assert.ok(!r.suppressed.some((s) => isCorrection(s.text)));
  assert.ok(r.accepted.length < before.length);
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

test("hourly cap: past the limit only one merged correction or owed answer goes out; anything else is refused with a reason", () => {
  const now = t("2026-11-19T04:00:00Z"), m = (min) => now - min * 60000;
  const posts = [m(50), m(40), m(30), m(20)].map((at) => ({ at, text: "Update." }));
  assert.equal(pb.hourly({ posts, humanAt: m(55), now, cap: 4 }).allow, false);
  const first = pb.hourly({ posts, humanAt: m(55), now, cap: 4, essential: true });
  assert.deepEqual([first.allow, first.overflow], [true, true]);
  const second = pb.hourly({ posts, humanAt: m(55), now, cap: 4, essential: true, overflowUsedAt: m(1) });
  assert.equal(second.allow, false);
  assert.match(pb.hourlyRefusal(second, 4), /merged message past that limit already went out/);
  assert.match(pb.hourlyRefusal(pb.hourly({ posts, humanAt: m(55), now, cap: 4 }), 4), /Merge what is still needed into one message/);
  // A new player message resets the count.
  assert.equal(pb.hourly({ posts, humanAt: m(10), now, cap: 4 }).allow, true);
  // Status cards never count.
  assert.equal(pb.hourly({ posts: posts.map((p) => ({ ...p, kind: "status_card" })), humanAt: m(55), now, cap: 4 }).allow, true);
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
