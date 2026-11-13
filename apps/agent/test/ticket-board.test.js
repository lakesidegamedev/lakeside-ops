"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ticketBoard } = require("../lib/operator/ticketboard");

const NOW = 100 * 3600000;
const H = 3600000;
const job = (id, over) => ({ id, kind: "ticket", role: "support", ticket: 1, channelId: "c" + id, at: NOW - 5 * H, updatedAt: NOW - H, state: "waiting",
  source: { content: "My   treasury\nis empty after the turn", author: "Pat", channelName: "ticket-1" }, ...over });
const board = (data, o = {}) => ticketBoard({ channels: {}, ...data }, { now: NOW, guildId: "9", ...o });
const row = (data, n = 1) => board(data).tickets.find((t) => t.number === n);

test("row shape: question on one line, age, link, no player ids or private findings", () => {
  const data = { jobs: { a: job("a", { summary: "SECRET FINDING", observedPlayerAt: NOW - 3 * H, source: { content: "My   treasury\nis empty", author: "Pat", authorId: "123456789" } }) },
    channels: { ca: { category: "economy" } } };
  const r = row(data);
  assert.equal(r.question, "My treasury is empty"); assert.equal(r.player, "Pat"); assert.equal(r.category, "economy");
  assert.equal(r.ageMs, 5 * H); assert.equal(r.channelUrl, "https://discord.com/channels/9/ca");
  assert.doesNotMatch(JSON.stringify(board(data)), /SECRET FINDING|123456789/);
});

test("plain-word states come from the ledger", () => {
  const st = (jobs, extra = {}) => row({ jobs, ...extra }).state;
  assert.equal(st({ a: job("a", { state: "running" }) }), "answering");
  assert.equal(st({ a: job("a", { state: "waiting", investigations: ["i"] }), i: job("i", { kind: "investigation", role: "owner", state: "running" }) }), "investigating");
  assert.equal(st({ a: job("a", { pullRequests: [5] }) }), "fix being built");
  assert.equal(st({ a: job("a") }, { statusCards: { 1: { items: [{ name: "x", stage: "confirmed" }] } } }), "fix live and checked");
  assert.equal(st({ a: job("a", { waitingFor: { kind: "player_reply" } }) }), "waiting on the player");
  assert.equal(st({ a: job("a", { waitingFor: { kind: "developer_reply" } }) }), "waiting on a developer");
  const owner = row({ jobs: { a: job("a") }, decisions: { d: { jobId: "a", state: "pending" } } });
  assert.equal(owner.state, "waiting on the owner"); assert.equal(owner.owner, "owner");
});

test("no-answer flag fires only after 2 hours with no Keir answer since the player wrote", () => {
  const mk = (playerAgo, answerAgo) => row({ jobs: { a: job("a", { observedPlayerAt: NOW - playerAgo, lastPublishedAt: answerAgo == null ? undefined : NOW - answerAgo }) } });
  assert.equal(mk(3 * H, null).noAnswerOver2h, true);
  assert.equal(mk(1 * H, null).noAnswerOver2h, false);
  assert.equal(mk(3 * H, 4 * H).noAnswerOver2h, true);
  assert.equal(mk(3 * H, 1 * H).noAnswerOver2h, false);
  const posted = row({ jobs: { a: job("a", { observedPlayerAt: NOW - 3 * H }) }, ticketPosts: { 1: [{ at: NOW - H, text: "Fixed it", jobId: "a" }, { at: NOW - 3 * H + 1, text: "[status card]", kind: "status_card" }] } });
  assert.equal(posted.noAnswerOver2h, false); assert.equal(posted.lastKeirAnswerAt, NOW - H);
});

test("closed tickets are left out and rows sort by newest activity", () => {
  const data = { jobs: { a: job("a", { ticket: 1, updatedAt: NOW - 5 * H }), b: job("b", { ticket: 2, updatedAt: NOW - H }), c: job("c", { ticket: 3, state: "done" }) } };
  assert.deepEqual(board(data).tickets.map((t) => t.number), [2, 1]);
  const closed = { jobs: { a: job("a") }, ticketOutcomes: { "1:ca": { status: "resolved", receiptId: "r" } } };
  assert.equal(board(closed).tickets.length, 0);
});
