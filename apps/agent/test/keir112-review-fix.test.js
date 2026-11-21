"use strict";
// Keir 11.2 second pass, item 10 (audit P0-3): Ask conflicts #6, #8 and #10 were marked fixed on 18 Nov minutes after
// Keir opened PRs 6791, 6799 and 6798, which then sat unmerged behind a failing check. A review item is now "fix in review"
// until its PR is merged and a deploy receipt shows it live; a PR closed without merging reopens it.
// Verified first: on the current code review_item resolve already refused "fixed" without job.reviewFixLive, which only
// github where sets after verifyLiveFix (merged, deployed, site healthy). The audit's 18 Nov cases predate that gate (#463,
// 17 Nov, reached production after them). What was missing: the in-between state and the reopen on an unmerged close.
const test = require("node:test");
const assert = require("node:assert");
const { createReviewItemTool } = require("../lib/operator/reviewitem");
const { createPrTruth } = require("../lib/operator/prtruth");

const ITEMS = [["6", 6791], ["8", 6799], ["10", 6798]];
const T0 = Date.parse("2026-11-18T02:32:00Z");

function world() {
  let clock = T0;
  const data = { jobs: {}, seen: {}, decisions: {}, actions: {}, audit: [], outbox: {} };
  const ledger = { data, save() {}, audit(kind, x) { data.audit.push({ kind, ...x }); }, notify(k, d, c) { data.outbox[k] ||= { d, c }; } };
  for (const [id, pr] of ITEMS) data.jobs[`r${id}`] = { id: `r${id}`, kind: "finding", role: "support", state: "waiting", at: T0 - 60000, updatedAt: T0, deadline: T0 + 86400000, effects: {}, inbox: [],
    reviewItem: { source: "ask", kind: "doc_conflict", id, key: `ask:doc_conflict:${id}` }, pullRequests: [`https://github.com/lakesidegamedev/AHDGame/pull/${pr}`] };
  const resolved = [];
  const tool = createReviewItemTool({ config: { askUrl: "https://ask.example", askSecret: "s" }, ledger, now: () => clock,
    fetcher: async (url, opts) => { resolved.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ status: "fixed" }) }; } });
  const gh = {};
  const truth = createPrTruth({ ledger, now: () => clock, api: async ([path]) => { const n = Number(path.split("/").pop()); return { number: n, state: gh[n] === "merged" ? "closed" : gh[n] || "open", merged: gh[n] === "merged", merged_at: gh[n] === "merged" ? new Date(clock).toISOString() : null, head: { sha: `h${n}` } }; } });
  return { data, tool, truth, gh, resolved, advance: (m) => { clock += m * 60000; } };
}
const fixed = (w, id) => w.tool.call(w.data.jobs[`r${id}`], { action: "resolve", kind: "doc_conflict", id, note: "guide corrected", outcome: "fixed" });

test("the three 18 Nov review items stay fix in review until their PR is merged and live", async () => {
  const w = world();
  await w.truth.tick();
  for (const [id, pr] of ITEMS) {
    assert.deepEqual([w.data.jobs[`r${id}`].reviewFix.pr, w.data.jobs[`r${id}`].reviewFix.state], [pr, "fix_in_review"]);
    await assert.rejects(fixed(w, id), /"fix in review" until its PR is merged and a deploy receipt shows it live/);
  }
  assert.equal(w.resolved.length, 0, "Ask is never told it is fixed while the PR is open");
  // Merged but not yet shown live: still not fixed.
  w.gh[6799] = "merged"; w.advance(31);
  await w.truth.tick();
  assert.equal(w.data.jobs.r8.reviewFix.state, "merged");
  await assert.rejects(fixed(w, "8"), /fix in review/);
  // github where found it deployed (reviewFixLive): now it may be resolved fixed, once.
  w.data.jobs.r8.reviewFixLive = { number: 6799, at: Date.now() };
  w.advance(31); await w.truth.tick();
  assert.equal(w.data.jobs.r8.reviewFix.state, "live");
  await fixed(w, "8");
  assert.equal(w.resolved.length, 1);
  assert.equal(w.resolved[0].body.action, "fixed");
  assert.equal(w.data.jobs.r8.reviewFix.state, "fixed");
  assert.equal(w.data.audit.filter((a) => a.kind === "review_fix_not_live").length, 4);
});

test("a fix PR closed without merging reopens its item once, wakes the task and keeps it from being marked fixed", async () => {
  const w = world();
  await w.truth.tick();
  const job = w.data.jobs.r10;
  job.state = "dismissed"; // the task had finished, as the 18 Nov review tasks did
  w.gh[6798] = "closed"; w.advance(31);
  await w.truth.tick();
  assert.equal(job.reviewFix.state, "reopened");
  assert.equal(job.state, "queued", "the task comes back for its item");
  assert.match(job.inbox.at(-1).content, /Fix PR #6798 for doc_conflict 10 was closed without merging\. The item is open again: it is not fixed\./);
  assert.equal(w.data.audit.filter((a) => a.kind === "review_fix_reopened").length, 1);
  await assert.rejects(fixed(w, "10"), /fix PR #6798 was closed without merging, so this item is open again/);
  // Once: later passes do not reopen or wake it again.
  job.state = "waiting"; job.inbox = [];
  w.advance(31); await w.truth.tick();
  assert.equal(job.inbox.length, 0);
  assert.equal(w.data.audit.filter((a) => a.kind === "review_fix_reopened").length, 1);
  // A stale live receipt from that PR cannot be used either.
  assert.equal(job.reviewFixLive, undefined);
});

test("a finished review task is followed only while its fix PR is open, and reads stay bounded", async () => {
  const w = world();
  let reads = 0;
  const truth = createPrTruth({ ledger: { data: w.data, save() {}, audit() {} }, now: () => Date.now(), api: async ([p]) => { reads++; return { number: Number(p.split("/").pop()), state: "open", merged: false, head: { sha: "x" } }; } });
  for (let i = 0; i < 12; i++) w.data.jobs[`x${i}`] = { id: `x${i}`, kind: "finding", state: "waiting", effects: {}, inbox: [], closing: { on: { kind: "pr", ref: 7000 + i } } };
  await truth.tick();
  assert.equal(reads, 5, "at most five waited PRs a pass");
  await truth.tick();
  assert.ok(reads <= 10);
});
