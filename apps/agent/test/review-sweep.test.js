"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const rs = require("../lib/operator/reviewsweep");
const { createReviewItemTool } = require("../lib/operator/reviewitem");
const shiftlog = require("../lib/operator/shiftlog");
const tc = require("../lib/operator/ticketcase");
const { setup } = require("./keir10-post.helpers");
const w3 = require("../lib/operator/w3tools");

const T0 = 1_800_000_000_000;
const mkLedger = (extra = {}) => {
  const data = { jobs: {}, seen: {}, audit: [], ...extra };
  let n = 0;
  return { data, saves: 0, save() { this.saves++; }, audit(kind, d) { data.audit.push({ at: T0, kind, ...d }); },
    createJob(key, fields) { if (data.seen[key]) return data.jobs[data.seen[key]]; const job = { id: `j${++n}`, state: "queued", at: T0, ...fields }; data.jobs[job.id] = job; data.seen[key] = job.id; return job; } };
};
const askBody = (conflicts = [], answers = []) => ({ generatedAt: "x", counts: { docConflicts: conflicts.length, answers: answers.length }, docConflicts: conflicts, answers });
const conflict = (id, hrsAgo = 5) => ({ kind: "doc_conflict", id, docs: "wiki Bonds", claim: "Bonds pay monthly", actual: "Bonds pay per turn", evidence: "bonds.ts:10", seen: 2, created: new Date(T0 - hrsAgo * 3600000).toISOString() });
const answer = (id, hrsAgo = 2) => ({ kind: "answer", id, flags: ["downvoted"], issues: [], reason: "wrong number", question: "How do bonds pay?", excerpt: "Bonds pay monthly.", ts: new Date(T0 - hrsAgo * 3600000).toISOString() });
const fetchOf = (body, status = 200) => async (url, opts) => { fetchOf.calls.push({ url, opts }); return { ok: status < 400, status, json: async () => body }; };
fetchOf.calls = [];
const config = { askUrl: "https://ask.example", askSecret: "s".repeat(40) };
const make = (ledger, fetcher, extra = {}) => rs.createReviewSweep({ ledger, config, fetcher, now: () => T0, ...extra });

test("sweep makes one internal task per new Ask item and never repeats it", async () => {
  const ledger = mkLedger();
  const sweep = make(ledger, fetchOf(askBody([conflict(1)], [answer(7)])));
  const r1 = await sweep.sweep();
  assert.equal(r1.created.length, 2);
  const jobs = Object.values(ledger.data.jobs);
  assert.ok(jobs.every((j) => j.kind === "finding" && j.role === "support" && !j.channelId && j.reviewItem));
  assert.deepEqual(jobs.map((j) => j.reviewItem.key).sort(), ["ask:answer:7", "ask:doc_conflict:1"]);
  assert.match(jobs.find((j) => j.reviewItem.kind === "doc_conflict").source.content, /Bonds pay monthly/);
  const r2 = await sweep.sweep();
  assert.equal(r2.created.length, 0, "dedup by source+id");
  assert.equal(Object.keys(ledger.data.jobs).length, 2);
  assert.equal(fetchOf.calls.at(-1).url, "https://ask.example/api/keir-ask/review?limit=100");
  assert.match(fetchOf.calls.at(-1).opts.headers.authorization, /^Bearer s+$/);
});

test("caps: 3 new tasks per sweep, 12 per rolling day, the rest wait", async () => {
  const ledger = mkLedger();
  let clock = T0;
  const items = Array.from({ length: 20 }, (_, i) => conflict(i + 1, 40 - i));
  const sweep = make(ledger, fetchOf(askBody(items)), { now: () => clock });
  assert.equal((await sweep.sweep()).created.length, 3);
  assert.equal((await sweep.sweep()).created.length, 3);
  await sweep.sweep(); await sweep.sweep();
  assert.equal(Object.keys(ledger.data.jobs).length, 12);
  assert.equal((await sweep.sweep()).created.length, 0, "daily cap");
  assert.equal(ledger.data.reviewQueue.summary.ask, 20);
  clock += 25 * 3600000;
  const next = await sweep.sweep();
  assert.equal(next.created.length, 3, "a day later the queue moves again");
  assert.equal(Object.keys(ledger.data.jobs).length, 15);
});

test("oldest items are worked first", async () => {
  const ledger = mkLedger();
  await make(ledger, fetchOf(askBody([conflict(1, 1), conflict(2, 30), conflict(3, 10), conflict(4, 20)]))).sweep();
  assert.deepEqual(Object.values(ledger.data.jobs).map((j) => j.reviewItem.id), ["2", "4", "3"]);
});

test("unavailable Ask is skipped quietly and counted, Keir items still run", async () => {
  const ledger = mkLedger({ answerFeedback: { votes: { "m1:u1": { vote: "down", voter: "player", ticket: 1900, at: T0 - 3600000, reason: "wrong" } }, wakes: {} } });
  for (const fetcher of [fetchOf({}, 404), async () => { throw new Error("ECONNREFUSED"); }]) {
    const l = mkLedger(structuredClone(ledger.data));
    const r = await make(l, fetcher).sweep();
    assert.equal(l.data.reviewQueue.askUnavailable, true);
    assert.equal(r.created.length, 1);
    assert.equal(Object.values(l.data.jobs)[0].reviewItem.source, "keir");
  }
  const noSecret = await rs.createReviewSweep({ ledger: mkLedger(), config: { askUrl: "https://ask.example" }, fetcher: fetchOf(askBody()), now: () => T0 }).sweep();
  assert.equal(noSecret.summary.askUnavailable, true);
});

test("keir votes: player downvotes not already re-woken, never owner or staff votes", () => {
  const ledger = mkLedger({ answerFeedback: { wakes: { 1902: T0 - 10 }, votes: {
    "a:1": { vote: "down", voter: "player", ticket: 1901, at: T0 - 5000 },
    "b:2": { vote: "report", voter: "player", ticket: 1902, at: T0 - 5000 },   // 10.4 woke it after the vote
    "c:3": { vote: "down", voter: "owner", ticket: 1903, at: T0 - 5000 },
    "d:4": { vote: "up", voter: "player", ticket: 1904, at: T0 - 5000 },
    "e:5": { vote: "down", voter: "player", ticket: 1905, at: T0 - 9 * 86400000 },
  } } });
  assert.deepEqual(rs.keirVotes({ ledger, now: () => T0 }).map((i) => i.ticket), [1901]);
});

test("keir refusals: more than two on one ticket in 24h, from the four guard kinds only", () => {
  const ledger = mkLedger();
  const add = (kind, ticket, ago = 1000) => ledger.data.audit.push({ at: T0 - ago, kind, ticket });
  for (const k of rs.REFUSAL_KINDS.slice(0, 3)) add(k, 2000);
  add("asked_deflection_refused", 2001); add("asked_deflection_refused", 2001);
  add("asked_deflection_refused", 2002, 30 * 3600000); add("asked_deflection_refused", 2002, 30 * 3600000); add("asked_deflection_refused", 2002, 30 * 3600000);
  add("tool_refused", 2003); add("tool_refused", 2003); add("tool_refused", 2003);
  const items = rs.keirRefusals({ ledger, events: null, now: () => T0 });
  assert.deepEqual(items.map((i) => i.ticket), [2000]);
  assert.equal(items[0].data.count, 3);
});

test("task text per kind names the tool path and forbids posting", () => {
  const doc = rs.instructionsFor({ kind: "doc_conflict", id: "4", data: conflict(4) });
  assert.match(doc, /code_search or code_exact with source "dev"/); assert.match(doc, /review_item action resolve with kind doc_conflict, id 4/); assert.match(doc, /Never post to a player/);
  const ans = rs.instructionsFor({ kind: "answer", id: "7", data: answer(7) });
  assert.match(ans, /verdict "good"/); assert.match(ans, /Ask correction/);
  const down = rs.instructionsFor({ kind: "thumbs_down", id: "k", ticket: 1901, data: { vote: "down", reason: "wrong", ticket: 1901 } });
  assert.match(down, /action lesson/); assert.match(down, /wake_ticket/);
  const ref = rs.instructionsFor({ kind: "refusals", id: "2000", ticket: 2000, data: { ticket: 2000, count: 3, kinds: { team_cover_refused: 3 } } });
  assert.match(ref, /team_cover_refused x3/);
  assert.ok(![doc, ans, down, ref].some((t) => /[–—]/.test(t)));
});

test("a Keir item is open until its task finishes; the shift log line reads the summary", async () => {
  const ledger = mkLedger({ answerFeedback: { wakes: {}, votes: { "a:1": { vote: "down", voter: "player", ticket: 1901, at: T0 - 3 * 3600000 } } } });
  const sweep = make(ledger, fetchOf(askBody([conflict(1, 6)])));
  await sweep.sweep();
  assert.equal(rs.shiftLine(ledger, T0), "Review queue: 2 open (Ask 1, Keir 1), oldest 6h");
  const keirJob = Object.values(ledger.data.jobs).find((j) => j.reviewItem.source === "keir");
  keirJob.state = "done";
  await sweep.sweep();
  assert.equal(rs.shiftLine(ledger, T0), "Review queue: 1 open (Ask 1, Keir 0), oldest 6h");
  const empty = mkLedger();
  await make(empty, fetchOf(askBody())).sweep();
  assert.equal(rs.shiftLine(empty, T0), "Review queue: 0 open (Ask 0, Keir 0)");
  assert.equal(rs.shiftLine(mkLedger(), T0), null);
  const off = mkLedger(); await make(off, async () => { throw new Error("x"); }).sweep();
  assert.match(rs.shiftLine(off, T0), /Ask feed unavailable/);
});

test("shift log carries the review line in the snapshot text and stays inside the cap", async () => {
  const ledger = mkLedger();
  await make(ledger, fetchOf(askBody([conflict(1, 7)], [answer(2)]))).sweep();
  const sources = shiftlog.sourcesFor({ ledger, mcp: { call: async () => [] }, api: async () => [], releasesFile: "/nonexistent", now: () => T0 });
  const out = await shiftlog.collect({ ...sources, decisions: async () => ["Approve hotfix -> approved"], fixes: async () => ["card 1: Sector tech cap"], releases: async () => ["Keir 10.2.3 (hotfix)"], turn: async () => ["current turn 4 ok"], bugs: async () => ["1 ticket (#5): something broke"] }, { now: () => T0 });
  assert.match(out.text, /\nReview queue: 2 open \(Ask 2, Keir 0\), oldest 7h/);
  assert.ok(out.text.length <= shiftlog.SHIFT_CHARS);
  const blank = await shiftlog.collect({ ...sources, review: async () => [] }, { now: () => T0 });
  assert.match(blank.text, /Review queue: none/);
});

test("review_item: resolves only its own Ask item, with the right body", async () => {
  const ledger = mkLedger();
  const calls = [];
  const fetcher = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, status: "fixed" }) }; };
  const tool = createReviewItemTool({ config, fetcher, ledger, now: () => T0 });
  const job = { id: "j9", reviewItem: { source: "ask", kind: "doc_conflict", id: "4", key: "ask:doc_conflict:4" } };
  assert.deepEqual(await tool.call(job, { action: "resolve", kind: "doc_conflict", id: 4, note: "wiki wrong, card filed", outcome: "fixed" }), { resolved: true, status: "fixed" });
  assert.equal(calls[0].url, "https://ask.example/api/keir-ask/review/doc_conflict/4/resolve");
  assert.deepEqual(calls[0].body, { note: "wiki wrong, card filed", action: "fixed" });
  await assert.rejects(tool.call(job, { action: "resolve", kind: "doc_conflict", id: 5, note: "x" }), /may only resolve/);
  await assert.rejects(tool.call({ id: "j" }, { action: "resolve" }), /only for review tasks/);
  const ans = { id: "j8", reviewItem: { source: "ask", kind: "answer", id: "7", key: "ask:answer:7" } };
  await assert.rejects(tool.call(ans, { action: "resolve", kind: "answer", id: 7 }), /verdict/);
  await tool.call(ans, { action: "resolve", kind: "answer", id: 7, note: "number was right", verdict: "good" });
  assert.deepEqual(calls[1].body, { note: "number was right", verdict: "good" });
  const gone = createReviewItemTool({ config, fetcher: async () => ({ ok: false, status: 404, json: async () => ({}) }), ledger, now: () => T0 });
  assert.equal((await gone.call(ans, { action: "resolve", kind: "answer", id: 7, verdict: "bad" })).already, true);
});

test("review_item: lesson lands in the case file, wake goes through the ticket inbox once an hour, never for another ticket", async () => {
  const root = { id: "root", kind: "ticket", ticket: 1901, state: "waiting" };
  const ledger = mkLedger({ jobs: { root }, seen: { "ticket:1901": "root" } });
  let clock = T0;
  const tool = createReviewItemTool({ config, fetcher: fetchOf({}), ledger, now: () => clock });
  const job = { id: "r1", reviewItem: { source: "keir", kind: "thumbs_down", id: "a:1", key: "k", ticket: 1901 } };
  await tool.call(job, { action: "lesson", ticket: 1901, text: "Answered the wrong problem: the player asked about pensions, not tax." });
  assert.match(tc.render(ledger.data, 1901), /Lessons from review[\s\S]*pensions/);
  await assert.rejects(tool.call(job, { action: "lesson", ticket: 1999, text: "Not this ticket at all." }), /this review item is about/);
  const w = await tool.call(job, { action: "wake_ticket", ticket: 1901, note: "answer the pension question" });
  assert.equal(w.woken, true);
  assert.equal(root.state, "queued");
  assert.match(root.inbox[0].content, /pension question/);
  assert.equal(root.inbox[0].role, "system");
  assert.equal((await tool.call(job, { action: "wake_ticket", ticket: 1901 })).woken, false, "rate limit");
  clock += 3700000; root.state = "done";
  assert.equal((await tool.call(job, { action: "wake_ticket", ticket: 1901 })).why, "ticket not live");
  await assert.rejects(tool.call(job, { action: "wake_ticket", ticket: 1999 }), /only the ticket/);
});

test("review_item is visible only to review tasks, and the tool is registered", () => {
  assert.ok(w3.NAMES.has("review_item"));
  assert.equal(w3.createVisible({ role: "support", reviewItem: { source: "ask" } }, "review_item"), true);
  assert.equal(w3.createVisible({ role: "support", kind: "finding" }, "review_item"), false);
  assert.equal(w3.createVisible({ role: "support", kind: "ticket", ticket: 5 }, "review_item"), false);
});

test("kill switch, pause and the off switch stop task creation but not the count", async () => {
  for (const [name, mk] of [["held", (l) => make(l, fetchOf(askBody([conflict(1)])), { held: () => true })], ["disabled", (l) => make(l, fetchOf(askBody([conflict(1)])), { enabled: false })], ["paused", (l) => { l.data.paused = true; return make(l, fetchOf(askBody([conflict(1)]))); }]]) {
    const l = mkLedger(); const r = await mk(l).sweep();
    assert.equal(r.created.length, 0, name); assert.equal(r.summary.open, 1, name);
  }
});

test("through the real broker: a review finding resolves and learns but cannot post to a player", async () => {
  const f = setup({});
  const root = f.job; root.state = "waiting";
  const item = { source: "keir", kind: "refusals", id: "123", key: "keir:refusals:123:d", ticket: 123 };
  const review = f.ledger.createJob(`review:${item.key}`, { kind: "finding", role: "support", reviewItem: item, source: { role: "system", content: "review", at: new Date().toISOString() } });
  review.state = "running";
  await assert.rejects(f.broker.tool(review, "channel_reply", { message: "Hello player" }), /finding tasks never post/);
  const lesson = await f.broker.tool(review, "review_item", { action: "lesson", ticket: 123, text: "Refused three times because the post repeated a standing claim." });
  assert.equal(lesson.saved, true);
  assert.match(tc.render(f.ledger.data, 123), /standing claim/);
  const wake = await f.broker.tool(review, "review_item", { action: "wake_ticket", ticket: 123, note: "answer the plant question" });
  assert.equal(wake.woken, true);
  assert.equal(root.state, "queued");
  assert.equal(f.posts().length, 0, "nothing reached the player");
  root.state = "running";
  await assert.rejects(f.broker.tool(f.job, "review_item", { action: "lesson", ticket: 123, text: "not a review task at all" }), /not available to this task/);
});
