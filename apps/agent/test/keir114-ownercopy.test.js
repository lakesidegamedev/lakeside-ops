"use strict";
// Keir 11.4 (owner, 2026-11-21): the iPhone Inbox showed "Next: Keir must record the next milestone." on every row,
// "Reconfirmed the cause from main e67daa9db9" and "Read live turn state at 14:26Z". Rows are plain now, times are ET.
const test = require("node:test");
const assert = require("node:assert");
const { workStatus } = require("../lib/operator/workqueue");
const oc = require("../lib/operator/ownercopy");
const knowledge = require("../lib/operator/knowledge");

const NOW = Date.parse("2026-11-21T15:40:00Z"); // 10:40 AM ET
const UTC_OR_HASH = /\b\d{1,2}:\d{2}(?::\d{2})?Z\b|\bUTC\b|\b[0-9a-f]{10,40}\b|\.tsx?:\d+|\bcw-\d+-\d+\b/;
const data = (jobs) => ({ jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), decisions: {}, actions: {}, channels: {} });

test("no row shows the placeholder 'Next' line, and a finished row has no Next line at all", () => {
  const done = { id: "aaaaaaaaaaaa", kind: "ticket", role: "support", ticket: 1872, state: "done", summary: "Reconfirmed the cause from main e67daa9db9: the response is compressed. Read live turn state at 14:26Z.", at: NOW - 3600000 };
  const waiting = { id: "bbbbbbbbbbbb", kind: "ticket", role: "support", ticket: 1873, state: "waiting", summary: "Waiting.", at: NOW - 600000 };
  for (const j of [done, waiting]) {
    const s = workStatus(data([done, waiting]), j, { now: NOW });
    assert.ok(!/must record the next milestone/i.test(s.next), s.next);
    assert.ok(!UTC_OR_HASH.test(`${s.reason} ${s.next} ${s.milestone}`), `${s.reason} | ${s.next} | ${s.milestone}`);
  }
  assert.equal(workStatus(data([done]), done, { now: NOW }).next, "");
  assert.equal(workStatus(data([waiting]), waiting, { now: NOW }).next, "");
});

test("a row states what the work waits on, from its closing condition, in plain words and ET", () => {
  const j = { id: "cccccccccccc", kind: "ticket", role: "support", ticket: 1872, state: "waiting", at: NOW - 600000, wakeAt: NOW + 600000,
    summary: "Internal note: re-read src/components/corp/Detail.tsx:142 at 14:26Z, worker cw-1872-55.",
    closing: { closesWhen: "The company page loads for the player after the fix is live.", waitingOn: "My fix reaching the main server; staging verified since the 14:25Z update (commit e67daa9db9).", on: { kind: "pr", ref: 7073 } } };
  const s = workStatus(data([j]), j, { now: NOW });
  assert.match(s.reason, /^My fix reaching the main server/);
  assert.match(s.reason, /9:25 AM ET/);
  assert.ok(!UTC_OR_HASH.test(s.reason), s.reason);
  assert.equal(s.milestone, "The company page loads for the player after the fix is live.");
});

test("a working row names the step, not the tool or Keir's own note", () => {
  const j = { id: "dddddddddddd", kind: "ticket", role: "support", ticket: 1875, state: "running", at: NOW - 60000, summary: "x", liveLog: [{ tool: "read_tool", what: "support_get", title: "Read ticket" }] };
  const s = workStatus(data([j]), j, { now: NOW });
  assert.equal(s.reason, "Working: read ticket.");
  assert.equal(s.next, "");
});

test("plain(): hashes, paths with lines, worker and task ids become what they mean; ET times", () => {
  assert.equal(oc.plain("Reconfirmed the cause from main e67daa9db9.", NOW), "Reconfirmed the cause from the live version.");
  assert.equal(oc.plain("Read live turn state at 14:26Z.", NOW), "Read live turn state at 9:26 AM ET.");
  assert.equal(oc.plain("Bug in src/lib/turn/x.ts:42.", NOW), "Bug in the code.");
  assert.equal(oc.plain("Worker cw-1872-55 opened the fix.", NOW), "The coding worker opened the fix.");
  assert.equal(oc.plain("Due 2026-11-20T23:10:00.000Z.", NOW), "Due Nov 20, 6:10 PM ET.");
  assert.equal(oc.plain("Ticket 1872 and PR 7073 are open.", NOW), "Ticket 1872 and PR 7073 are open.", "ticket and PR numbers stay");
  assert.equal(oc.plain("It is 9:30 AM ET.", NOW), "It is 9:30 AM ET.", "ET times are left alone");
});

test("owner DMs and app messages get ET; player messages get Discord timestamp markup, which the number check ignores", () => {
  assert.equal(oc.etTimes("Next turn at 2:00 PM UTC.", NOW), "Next turn at 9:00 AM ET.");
  const player = oc.discordTimes("The next turn runs at 16:00 UTC.", NOW);
  assert.match(player, /<t:\d+:t>/);
  assert.ok(!/UTC/.test(player));
  assert.deepEqual(knowledge.numbersIn(player), []);
});

// ---------- Keir 11.4 release review, M4 ----------
test("M4: a UTC time later today stays today, and times with no zone or already in ET are left as written", () => {
  const at1740 = Date.parse("2026-11-21T17:40:00Z");
  assert.equal(oc.etTimes("I will check the checks again at 21:00Z.", at1740), "I will check the checks again at 4:00 PM ET.");
  assert.equal(oc.etTimes("It ran at 23:50 UTC.", at1740), "It ran at 6:50 PM ET.");
  assert.equal(oc.etTimes("It failed at 02:10Z.", Date.parse("2026-11-22T01:00:00Z")), "It failed at 9:10 PM ET.");
  for (const t of ["the owner window, 09:00-23:00 ET", "10:30 a.m. ET", "it broke at 21:00 their time", "since the 14:25 update", "The turn runs at 18:00 game time."])
    assert.equal(oc.etTimes(t, at1740), t);
});

test("M4: the original UTC leak is still converted: Z and UTC clock times and UTC timestamps never reach the owner", () => {
  const at1740 = Date.parse("2026-11-21T17:40:00Z");
  const out = oc.plain("Read live turn state at 14:26Z; next check 2026-11-21T19:00:00Z; deploy at 16:05 UTC.", at1740);
  assert.ok(!/\d{1,2}:\d{2}Z|UTC/.test(out), out);
  assert.match(out, /9:26 AM ET/); assert.match(out, /2:00 PM ET/); assert.match(out, /11:05 AM ET/);
});

test("minor: stripping a job id leaves no dangling word; ticket and PR numbers stay", () => {
  assert.equal(oc.plain("Started job j_e52f2a6086cb8c3c to merge. Ticket 1872 and PR 512 stay."), "Started the task to merge. Ticket 1872 and PR 512 stay.");
});
