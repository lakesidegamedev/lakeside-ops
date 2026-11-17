"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const tc = require("../lib/operator/ticketcase");

const T0 = Date.parse("2026-11-17T14:00:00Z");
const job = (over = {}) => ({ id: "j1", ticket: 1852, kind: "ticket", role: "support", startedAt: T0 - 1000, ...over });

test("a posted claim is stored with its date, status and the reads it rested on", () => {
  const d = { ticketObservations: { 1852: [{ tool: "read_tool", at: T0 - 500, input: JSON.stringify({ server: "gamestate", tool: "trace_corp" }), result: "sector tech cap 30" }] } };
  tc.recordPost(d, job({ evidenceText: "\n[read_tool] cap 30" }), "Your sector tech is capped at 30 percent. I will report back after the next turn.", { now: T0 });
  const c = tc.get(d, 1852);
  assert.equal(c.claims.length, 1);
  assert.equal(c.claims[0].status, "standing");
  assert.match(c.claims[0].ev, /trace_corp/);
  assert.equal(c.promises.length, 1);
  assert.match(c.promises[0].text, /report back/);
});

test("questions, hedges and promises are not claims", () => {
  for (const s of ["Can you send a screenshot?", "It might be a cache problem.", "I'll check the turn log tomorrow.", "Thanks!"]) assert.equal(tc.readClaim(s), null, s);
});

test("reachable then not reachable without a correction is refused, even a day later", () => {
  const d = {};
  tc.recordPost(d, job(), "Your cards are reachable from the Cards tab.", { now: T0 });
  const hit = tc.contradiction(d, 1852, "Your cards are not reachable from the Cards tab.", { now: T0 + 30 * 3600000 });
  assert.ok(hit);
  assert.match(tc.contradictionRefusal(hit), /Correction:/);
  assert.equal(tc.contradiction(d, 1852, "Cards are unreachable right now.", { now: T0 + 60000 })?.kind, "case-contradiction");
  assert.equal(tc.contradiction(d, 1852, "Correction: your cards are not reachable from the Cards tab.", { now: T0 }), null);
});

test("a correction marks the old claim corrected and the new claim stands", () => {
  const d = {};
  tc.recordPost(d, job(), "Your cards are reachable from the Cards tab.", { now: T0 });
  tc.recordPost(d, job(), "Correction: your cards are not reachable from the Cards tab, I read the wrong record.", { now: T0 + 3600000 });
  const c = tc.get(d, 1852);
  const old = c.claims.find((x) => x.pol === "pos");
  assert.equal(old.status, "corrected");
  assert.match(old.by, /not reachable/);
  assert.equal(c.claims.find((x) => x.pol === "neg").status, "standing");
  // the corrected claim no longer blocks, the new one does
  assert.equal(tc.contradiction(d, 1852, "Your cards are reachable from the Cards tab.", { now: T0 + 7200000 })?.earlier.includes("not reachable"), true);
});

test("a withdrawal retires the claim without a replacement", () => {
  const d = {};
  tc.recordPost(d, job(), "The depot cost comes from the old price table.", { now: T0 });
  tc.recordPost(d, job(), "Correction: disregard what I said about the depot cost and the price table, I was wrong.", { now: T0 + 60000 });
  assert.equal(tc.get(d, 1852).claims[0].status, "withdrawn");
});

test("unrelated claims and same polarity repeats do not collide", () => {
  const d = {};
  tc.recordPost(d, job(), "Your cards are reachable from the Cards tab.", { now: T0 });
  assert.equal(tc.contradiction(d, 1852, "The market has no retail demand this turn.", { now: T0 + 1 }), null);
  tc.recordPost(d, job(), "Your cards are reachable from the Cards tab now.", { now: T0 + 5 });
  assert.equal(tc.get(d, 1852).claims.length, 1);
});

test("staff statements and the fix are picked up from the channel and the ledger", () => {
  const d = { channelContext: { C1: [{ role: "owner", authorId: "O", at: new Date(T0).toISOString(), content: "I'm fixing this one now." }, { role: "player", authorId: "P", at: new Date(T0 + 1000).toISOString(), content: "Where are my cards? Is it fixed?" }] },
    jobs: { j1: { id: "j1" }, w1: { id: "w1", codingParent: "j1", state: "running", pullRequests: ["https://github.com/x/y/pull/77"] } }, statusCards: { 1852: { items: [{ name: "Sector tech cap", stage: "building" }] } } };
  const j = job({ channelId: "C1", raisedToDevelopers: [] });
  tc.syncActivation(d, j, { now: T0 + 2000, ownerId: "O", botId: "B" });
  tc.syncActivation(d, j, { now: T0 + 3000, ownerId: "O", botId: "B" });
  const c = tc.get(d, 1852);
  assert.equal(c.staff.length, 1);
  assert.equal(c.staff[0].who, "the owner");
  assert.equal(c.fix.who, "Keir's coding worker");
  assert.deepEqual(c.fix.prs, ["77"]);
  assert.equal(c.questions.filter((q) => q.by === "player").length, 2);
  const text = tc.render(d, 1852);
  assert.match(text, /I'm fixing this one now/);
  assert.match(text, /PR #77/);
  assert.match(text, /player asked: Where are my cards/);
});

test("a substantive post closes the player's open questions and keeps a promise it fulfils", () => {
  const d = { channelContext: { C1: [{ role: "player", authorId: "P", at: new Date(T0).toISOString(), content: "Where are my cards?" }] } };
  const j = job({ channelId: "C1" });
  tc.syncActivation(d, j, { now: T0 + 10, ownerId: "O", botId: "B" });
  tc.recordPost(d, j, "I will report the sector tech cap after the next turn.", { now: T0 + 20 });
  tc.recordPost(d, j, "Your sector tech cap is 30 percent and the cards sit under the Cards tab.", { now: T0 + 60000 });
  const c = tc.get(d, 1852);
  assert.ok(c.questions.every((q) => q.closedAt));
  assert.ok(c.promises[0].doneAt);
});

test("render stays under the cap and collapses the oldest corrected claims first", () => {
  const d = {};
  const c = tc.get(d, 1852, { create: true });
  for (let i = 0; i < 30; i++) c.claims.push({ id: `c${i}`, at: T0 + i * 60000, text: `Claim number ${i} about the sector tech cap on the market for corporation ${i}, long enough to take room`, pol: "pos", w: [`w${i}a`, `w${i}b`], ev: "trace_corp; 30", status: i < 20 ? "corrected" : "standing", by: "later post", byAt: T0 + 1 });
  const out = tc.render(d, 1852, { cap: 1200 });
  assert.ok(out.length <= 1200, String(out.length));
  assert.match(out, /older entries collapsed/);
  assert.match(out, /Claim number 29/);
  assert.doesNotMatch(out, /Claim number 0 /);
  assert.ok(tc.render(d, 1852).length <= tc.CAP_CHARS);
});

test("the stored record is bounded and old cases are pruned", () => {
  const d = {};
  for (let i = 0; i < 60; i++) tc.recordPost(d, job(), `Distinct statement ${i} concerning unique topic${i} widget${i} gadget${i} here.`, { now: T0 + i });
  assert.ok(tc.get(d, 1852).claims.length <= 40);
  tc.prune(d, T0 + 31 * 86400000);
  assert.equal(tc.get(d, 1852), null);
});

test("nothing throws on a malformed ledger", () => {
  assert.equal(tc.recordPost(null, job(), "x"), null);
  assert.equal(tc.render({}, 1), null);
  assert.equal(tc.contradiction({}, 1, "Your cards are not reachable."), null);
  assert.equal(tc.syncActivation({}, null), null);
});

test("a noun negation inside a paraphrase is not a reversal, but no longer is", () => {
  const d = {};
  tc.recordPost(d, job(), "Renew the contract and it starts again next turn.", { now: T0 });
  assert.equal(tc.contradiction(d, 1852, "Your plant is idle because it has no coal supplier, so renew the contract and it runs next turn.", { now: T0 + 1 }), null);
  const e = {};
  tc.recordPost(e, job(), "Your cards are reachable from the Cards tab.", { now: T0 });
  assert.ok(tc.contradiction(e, 1852, "Your cards are no longer reachable from the Cards tab.", { now: T0 + 1 }));
});
