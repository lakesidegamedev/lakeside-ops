"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createFeedbackLog, createDailyReview, reviewBrief } = require("../lib/operator/selfimprove");

const ledgerOf = (data = {}) => {
  const jobs = {}; let n = 0;
  return { data: { jobs, ...data }, audit() {}, save() {}, createJob(key, fields) { const j = { id: `j${++n}`, state: "queued", key, ...fields }; jobs[j.id] = j; return j; } };
};

test("feedback about Keir is logged with kind and severity; banter and game talk are not", async () => {
  const ledger = ledgerOf();
  const answers = {
    m1: { feedback: { noul: 0.92 }, kind: { choice: "slow_or_silent" }, severity: { score: 2 } },
    m2: { feedback: { noul: 0.1 }, kind: { choice: "not_feedback" }, severity: { score: 0 } },
  };
  const asked = [];
  const log = createFeedbackLog({ ledger, now: () => 1000, ask: async (spec) => { asked.push(spec.state.text); return { answers: answers[spec.state.text === "are you still lobotomized" ? "m1" : "m2"] }; } });
  await log.observe({ text: "are you still lobotomized", role: "player", ticket: 1575, channelId: "c", messageId: "m1" });
  await log.observe({ text: "Milk DeGrasse Tyson", role: "player", ticket: 1575, channelId: "c", messageId: "m2" });
  await log.observe({ text: "are you still lobotomized", role: "player", ticket: 1575, channelId: "c", messageId: "m1" });
  assert.equal(asked.length, 2);
  assert.equal(ledger.data.feedbackLog.length, 1);
  assert.deepEqual([ledger.data.feedbackLog[0].kind, ledger.data.feedbackLog[0].severity, ledger.data.feedbackLog[0].ticket], ["slow_or_silent", "serious", 1575]);
});

test("unrelated community chatter is never sent to Jev, and no verdict logs nothing", async () => {
  const ledger = ledgerOf(); let calls = 0;
  const log = createFeedbackLog({ ledger, ask: async () => { calls++; return null; } });
  await log.observe({ text: "anyone want to form a coalition", role: "player", ticket: null, channelId: "g", messageId: "x1" });
  assert.equal(calls, 0);
  await log.observe({ text: "keir you lied about adding this", role: "player", ticket: 1560, channelId: "c", messageId: "x2" });
  assert.equal(calls, 1); assert.equal((ledger.data.feedbackLog || []).length, 0);
});

test("the daily review runs once per Eastern day after its hour, with the day's feedback, tickets and recoveries", () => {
  const t = Date.parse("2026-10-16T10:00:00Z"); // 06:00 New York
  const ledger = ledgerOf({ feedbackLog: [{ at: t - 3600000, kind: "wrong_or_misleading", severity: "serious", ticket: 1560, role: "player", text: "you lied about adding this" }],
    recoveries: [{ at: t - 7200000, action: "woken", ticket: 1578, reason: "unknown wait" }] });
  ledger.data.jobs.t1 = { id: "t1", kind: "ticket", ticket: 1578, state: "waiting", rounds: 40, updatedAt: t - 600000, summary: "Await production release" };
  let clock = t;
  const r = createDailyReview({ ledger, config: { ownerId: "o" }, now: () => clock, hour: 5 });
  const job = r.tick();
  assert.ok(job); assert.equal(job.role, "owner"); assert.equal(job.noOwnerDm, true);
  assert.match(job.source.content, /you lied about adding this/); assert.match(job.source.content, /Ticket 1578/); assert.match(job.source.content, /woken ticket 1578/);
  assert.match(job.source.content, /Do not post in any ticket/);
  assert.equal(r.tick(), null);
  clock = t + 3600000; assert.equal(r.tick(), null);
  job.state = "done"; job.summary = "Learned: do not wait on releases."; r.tick();
  assert.equal(ledger.data.selfReview.runs[0].summary, "Learned: do not wait on releases.");
  clock = t + 24 * 3600000; assert.ok(r.tick());
});

test("the review waits for its hour", () => {
  const ledger = ledgerOf();
  const r = createDailyReview({ ledger, config: { ownerId: "o" }, now: () => Date.parse("2026-10-16T07:00:00Z"), hour: 5 }); // 03:00 New York
  assert.equal(r.tick(), null);
});

test("reviewBrief limits itself to the window", () => {
  const b = reviewBrief({ jobs: {}, feedbackLog: [{ at: 5, kind: "praise", role: "player", text: "old" }, { at: 50, kind: "tone", role: "player", text: "new" }] }, 10, 100);
  assert.equal(b.feedback.length, 1); assert.doesNotMatch(b.text, /"old"/);
});

test("an answered ticket in its closing grace or with Keir speaking last is a legit wait, not an owner escalation", () => {
  const { createRecovery } = require("../lib/operator/selfrecovery");
  let t = 50 * 3600000;
  const closing = { id: "c", kind: "ticket", ticket: 1576, state: "waiting", resolutionReadyAt: t - 3600000, lastPublishedAt: t - 3600000, wakeAt: t + 3 * 3600000 };
  const answered = { id: "a", kind: "ticket", ticket: 1583, state: "waiting", lastPublishedAt: t - 3600000, lastPlayerAt: t - 4000000, wakeAt: t + 3 * 3600000 };
  const ledger = { data: { jobs: { c: closing, a: answered }, decisions: {} }, audit() {}, save() {}, notify() {} };
  const r = createRecovery({ ledger, config: { ownerId: "o" }, now: () => t });
  for (let i = 0; i < 4; i++) { t += 46 * 60000; r.tick({}); if (closing.state === "queued") break; }
  assert.equal(Object.keys(ledger.data.decisions).length, 0);
  assert.equal(answered.state, "waiting");
  assert.equal(closing.state, "queued"); assert.match(closing.inbox.at(-1).content, /Resolve it now/);
});

test("reviewBrief lists the worst closed tickets of the last 3 days, max 4, and routes lessons to lanes", () => {
  const DAY = 86400000, until = 10 * DAY;
  const sc = (n, score, age) => [n, { ticket: n, score, lane: "bug", closedAt: until - age, penalties: { reopened: 25 } }];
  const d = { jobs: {}, feedbackLog: [], ticketScores: Object.fromEntries([sc(1, 15, DAY), sc(2, 30, DAY), sc(3, 45, DAY), sc(4, 50, DAY), sc(5, 55, DAY), sc(6, 5, 5 * DAY), sc(7, 95, DAY)]) };
  const b = reviewBrief(d, until - DAY, until);
  const lines = b.text.split("\n").filter((l) => /^- Ticket \d+ \(bug, score/.test(l));
  assert.equal(lines.length, 4);
  assert.match(lines[0], /Ticket 1 \(bug, score 15\/100\): reopened -25/);
  assert.ok(!/Ticket (5|6|7) \(bug/.test(b.text));
  assert.match(b.text, /\[lane:question\].*never added to the brief/);
});
