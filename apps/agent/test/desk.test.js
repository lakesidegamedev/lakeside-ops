"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const read = require("../lib/desk/read");
const { handle } = require("../lib/desk/router");
const { levelOf, roleTable } = require("../lib/desk/config");

const NOW = 1_800_000_000_000, MIN = 60000;
const T = roleTable();
const as = (r) => ({ roles: [T[r][0]] });
const job = (id, ticket, extra = {}) => ({ id, kind: "ticket", ticket, state: "waiting", at: NOW - 90 * MIN, updatedAt: NOW - 40 * MIN, provider: { runner: "claude", model: "m1" }, ...extra });
const mk = (jobs, extra = {}) => ({ now: NOW, active: true, release: "keir-v9.0.0", ledger: { jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), actions: {}, audit: [], ticketPosts: {}, routeCooldown: {}, ...extra.ledger }, usage: extra.usage || [] });

test("doctor: provider cap names the route and the time left", () => {
  const s = mk([job("a", 101, { state: "queued" })], { ledger: { routeCooldown: { claude: NOW + 30 * MIN } }, usage: [{ job: "a", outcome: "error", error: "Usage limit reached", at: new Date(NOW - 5 * MIN).toISOString() }] });
  const out = read.doctor(s, 101);
  assert.match(out, /cool down/); assert.match(out, /30 min left/); assert.match(out, /usage limit/i);
});

test("doctor: waiting on a player, on an approval, on a developer", () => {
  assert.match(read.doctor(mk([job("a", 1, { waitingFor: { kind: "player_reply", since: NOW - 120 * MIN } })]), 1), /waiting for the player \(2 h/);
  const ap = mk([job("a", 2)], { ledger: { actions: { x: { id: "x", jobId: "a", state: "pending", expiresAt: NOW + 1e6 } } } });
  assert.match(read.doctor(ap, 2), /approval from the owner/);
  assert.match(read.doctor(mk([job("a", 3, { waitingFor: { kind: "developer_reply", since: NOW - 10 * MIN } })]), 3), /waiting for a developer/);
});

test("doctor: crashed activation and unknown ticket and finished ticket", () => {
  const crashed = mk([job("a", 4, { state: "blocked" })], { usage: [{ job: "a", outcome: "interrupted", at: new Date(NOW - 3 * MIN).toISOString() }] });
  assert.match(read.doctor(crashed, 4), /interrupted/);
  assert.match(read.doctor(mk([]), 9), /no task on ticket 9/);
  assert.match(read.doctor(mk([job("a", 5, { state: "done" })]), 5), /finished/);
});

test("doctor without a ticket, Keir off", () => {
  const s = mk([job("a", 6)]); s.active = false;
  const out = read.doctor(s);
  assert.match(out, /OFF/); assert.match(out, /Oldest waiting: ticket 6/); assert.match(out, /\/keir on/);
});

test("status counts and waiting list", () => {
  const s = mk([job("a", 1, { state: "running", startedAt: NOW - MIN }), job("b", 2, { waitingFor: { kind: "player_reply", since: NOW - 5 * MIN } }), job("c", 3, { waitingFor: { kind: "developer_reply" } })]);
  assert.match(read.status(s), /Open tickets: 3\. In progress: 1\. Waiting on staff: 1\. Waiting on the player: 1/);
  const w = read.waiting(s);
  assert.match(w, /Ticket 2: the player/); assert.match(w, /Ticket 3: a developer/); assert.doesNotMatch(w, /Ticket 1:/);
});

test("why: trail newest last, at most 12, From lines kept, ids and dashes stripped", () => {
  const posts = Array.from({ length: 15 }, (_, i) => ({ at: NOW - (20 - i) * MIN, kind: "reply", text: `From: Keir\nhello <@123456789012345678> — ${i}` }));
  const s = mk([job("a", 7)], { ledger: { ticketPosts: { 7: posts }, audit: [{ at: NOW - MIN, job: "a", kind: "reply-refused", reason: "number not read" }, { at: NOW - 2 * MIN, ticket: 7, kind: "escalated_to_developers" }] } });
  const out = read.why(s, 7), lines = out.split("\n").slice(1);
  // Identical lines in a row collapse with a count, so the trail stays short and a loop reads as one event.
  assert.ok(lines.length <= 12); assert.match(out, /From: Keir.*\(x\d+\)/); assert.match(lines.at(-1), /refused/);
  assert.doesNotMatch(out, /\d{17}|—|–/);
});

test("replies stay under 1800 characters", () => {
  const jobs = Array.from({ length: 200 }, (_, i) => job(`j${i}`, 1000 + i, { waitingFor: { kind: "player_reply", since: NOW - MIN } }));
  assert.ok(read.waiting(mk(jobs)).length <= 1800);
});

test("roles: server-side levels and private by default", async () => {
  assert.equal(levelOf({ roles: [] }), 0); assert.equal(levelOf(as("mod")), 1); assert.equal(levelOf(as("junior")), 2); assert.equal(levelOf(as("dev")), 3);
  const deps = { loadState: () => mk([]), actions: null, models: null };
  const denied = await handle({ command: "keir", sub: "status", member: { roles: ["1"] } }, deps);
  assert.match(denied.content, /do not have a role/); assert.equal(denied.ephemeral, true);
  assert.equal((await handle({ command: "keir", sub: "status", member: as("mod") }, deps)).ephemeral, true);
  assert.equal((await handle({ command: "keir", sub: "status", options: { share: true }, member: as("mod") }, deps)).ephemeral, false);
  assert.match((await handle({ command: "keir", sub: "nudge", options: { ticket: 1 }, member: as("mod") }, deps)).content, /do not have a role/);
  assert.match((await handle({ command: "keir", sub: "off", member: as("junior") }, deps)).content, /do not have a role/);
});

test("router with part 2 absent says not available yet; present modules are called", async () => {
  const deps = { loadState: () => mk([]), actions: null, models: null };
  assert.match((await handle({ command: "keir", sub: "pause", member: as("junior") }, deps)).content, /not available yet/);
  assert.match((await handle({ command: "keir", sub: "model", member: as("dev") }, deps)).content, /not available yet/);
  const ok = await handle({ command: "keir", sub: "pause", member: as("junior") }, { ...deps, actions: { pause: async () => "Paused." } });
  assert.equal(ok.content, "Paused.");
});
