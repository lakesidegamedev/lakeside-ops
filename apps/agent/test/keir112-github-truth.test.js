"use strict";
// Keir 11.2 item 2: GitHub is the truth for approvals. Fixtures from the 2026-11-21 audit: ticket 1857 (PR 6866 merged by
// another developer while Keir's question was open), and approved merges (6682, 6947 twice, 7001 at two heads) that
// stayed "approved" and were later archived as "orphaned: never executed".
const test = require("node:test");
const assert = require("node:assert");
const { createPrTruth } = require("../lib/operator/prtruth");
const { createDecisions } = require("../lib/operator/decisions");
const { sweepOrphans, GRACE_MS } = require("../lib/operator/orphans");

const OWNER = "100000000000000001", DELEGATE = "100000000000000002";
const T0 = Date.parse("2026-11-19T01:00:00Z");

function setup(prs, { fail = false } = {}) {
  const data = { jobs: {}, actions: {}, decisions: {}, outbox: {}, audit: [] };
  const ledger = { data, save() {}, audit(kind, x) { data.audit.push({ kind, ...x }); }, notify(key, dest, content, extra = {}) { data.outbox[key] ||= { destination: dest, content, ...extra }; } };
  let clock = T0;
  const reads = [];
  const api = async ([route]) => {
    reads.push(route);
    if (fail) throw new Error("gh: connection reset");
    const m = /pulls\/(\d+)$/.exec(route);
    if (m && prs[m[1]]) return prs[m[1]];
    const h = /head=[^:]+:(\S+?)&/.exec(route);
    if (h) return Object.values(prs).filter((p) => p.head?.ref === h[1]);
    throw new Error(`unexpected ${route}`);
  };
  const truth = createPrTruth({ ledger, api, now: () => clock });
  return { data, ledger, truth, reads, advance: (ms) => { clock += ms; }, now: () => clock };
}
const merged = (n, by = "a-developer", head = "h" + n) => ({ number: n, state: "closed", merged: true, merged_at: "2026-11-19T01:58:00Z", merged_by: { login: by }, head: { sha: head, ref: `b${n}` } });
const open = (n, head) => ({ number: n, state: "open", merged: false, head: { sha: head, ref: `b${n}` } });
const closed = (n) => ({ number: n, state: "closed", merged: false, merged_at: null, head: { sha: "c" + n, ref: `b${n}` } });

test("ticket 1857: a PR merged by another developer closes the open question and records the action done", async () => {
  const w = setup({ 6866: merged(6866, "a-developer", "e7f0") });
  w.data.jobs.j1857 = { id: "j1857", ticket: 1857, kind: "command", state: "waiting", ownerDecisionPending: true };
  w.data.actions.a1 = { id: "a1", jobId: "j1857", kind: "github", state: "pending", args: { action: "merge", number: 6866, head: "e7f0", repository: "lakesidegamedev/AHDGame" } };
  w.data.decisions.x1 = { id: "x1", jobId: "j1857", actionId: "a1", state: "pending", at: T0 - 3600000, question: "Merge the bond issue screen fix?", sent: { [OWNER]: { channelId: "dm", messageId: "m1" } } };
  const r = await w.truth.tick();
  assert.equal(r.changed, 1);
  assert.equal(w.data.decisions.x1.state, "withdrawn");
  assert.equal(w.data.decisions.x1.withdrawnReason, "merged on GitHub");
  assert.equal(w.data.actions.a1.state, "done");
  assert.equal(w.data.actions.a1.reconciledFrom, "github");
  assert.equal(w.data.jobs.j1857.ownerDecisionPending, undefined);
  assert.equal(w.data.jobs.j1857.state, "queued");
  assert.match(w.data.jobs.j1857.inbox.at(-1).content, /merged on GitHub by a-developer/);
  // The decision loop then edits the DM to say how it ended, with no buttons, and sends no reminder or escalation.
  const edits = {};
  const decisions = createDecisions({ ledger: w.ledger, config: { ownerId: OWNER, staffIds: [DELEGATE] }, discord: async (m, route, body) => { edits[route] = { m, body }; return {}; }, now: () => T0 + 4 * 3600000 });
  await decisions.tick();
  const e = edits["/channels/dm/messages/m1"];
  assert.equal(e.m, "PATCH");
  assert.match(e.body.content, /The change was merged on GitHub/);
  assert.deepEqual(e.body.components, []);
  assert.ok(!Object.keys(w.data.outbox).some((k) => k.startsWith("ask:x1:")), "no escalation for a merged PR");
});

test("approved merges reconcile to done and are archived done, never 'orphaned: never executed'", async () => {
  const w = setup({ 6682: merged(6682, "Egg3901"), 6947: merged(6947, "Egg3901", "0c89e032"), 7001: merged(7001, "Egg3901", "311742") });
  const approved = (id, jobId, number, head) => ({ id, jobId, kind: "github", state: "approved", at: T0 - 91 * 3600000, approvedAt: T0 - 90 * 3600000, args: { action: "merge", number, head, repository: "lakesidegamedev/AHDGame" } });
  Object.assign(w.data.actions, {
    c68a: approved("c68a", "gone1", 6682, "9839"),
    b11b: approved("b11b", "gone2", 6947, "e613506c"), b6ce: approved("b6ce", "gone3", 6947, "0c89e032"),
    c87e: approved("c87e", "gone4", 7001, "036b6c"), c34b: approved("c34b", "gone4", 7001, "311742"),
  });
  await w.truth.tick();
  for (const id of ["c68a", "b11b", "b6ce", "c87e", "c34b"]) assert.equal(w.data.actions[id].state, "done", id);
  assert.equal(w.reads.length, 3, "one read per PR, not per approval");
  const archived = sweepOrphans(w.data, T0 + GRACE_MS + 86400000);
  assert.equal(archived.length, 5);
  assert.ok(archived.every((a) => a.state === "done"), JSON.stringify(archived.map((a) => a.state)));
});

test("an approved merge GitHub never confirmed is archived unverified, not orphaned; a non-PR action is still orphaned", () => {
  const data = { jobs: {}, decisions: {}, actions: {
    g: { id: "g", jobId: "gone", kind: "github", state: "approved", at: 0, args: { action: "merge", number: 6500 } },
    h: { id: "h", jobId: "gone", kind: "heal", state: "approved", at: 0, args: { spec: { kind: "adhoc" } } },
  } };
  const out = sweepOrphans(data, GRACE_MS + 1);
  assert.equal(out.find((a) => a.id === "g").state, "unverified");
  assert.equal(out.find((a) => a.id === "h").state, "orphaned");
});

test("a PR closed without merging withdraws the question and the approval", async () => {
  const w = setup({ 6865: closed(6865) });
  w.data.jobs.j = { id: "j", state: "waiting", kind: "ticket", ticket: 1857 };
  w.data.decisions.x = { id: "x", jobId: "j", state: "pending", at: T0, question: "q", binds: { number: 6865, head: "51fc149b50" }, sent: {} };
  w.data.actions.a = { id: "a", jobId: "j", kind: "github", state: "approved", args: { action: "merge", number: 6865, head: "51fc149b50" } };
  await w.truth.tick();
  assert.equal(w.data.decisions.x.state, "withdrawn");
  assert.match(w.data.decisions.x.withdrawnReason, /closed on GitHub/);
  assert.equal(w.data.actions.a.state, "withdrawn");
});

test("a new head withdraws the question and asks the task to re-ask once", async () => {
  const prs = { 6947: open(6947, "0c89e032") };
  const w = setup(prs);
  w.data.jobs.j = { id: "j", state: "waiting", kind: "finding" };
  const ask = () => ({ id: "x" + Math.random(), jobId: "j", state: "pending", at: T0, question: "q", binds: { number: 6947, head: "e613506c" }, sent: {} });
  const x1 = ask(); w.data.decisions[x1.id] = x1;
  await w.truth.tick();
  assert.equal(x1.state, "withdrawn");
  assert.match(x1.withdrawnReason, /new commits/);
  assert.equal(w.data.jobs.j.inbox.filter((m) => /new commits/.test(m.content)).length, 1);
  // The task asks for the old head again by mistake: withdrawn again, but no second re-ask message for the same head.
  const x2 = ask(); w.data.decisions[x2.id] = x2;
  w.advance(5 * 60000);
  await w.truth.tick();
  assert.equal(x2.state, "withdrawn");
  assert.equal(w.data.jobs.j.inbox.filter((m) => /new commits/.test(m.content)).length, 1);
  // An ask for the current head stays pending.
  const x3 = { ...ask(), binds: { number: 6947, head: "0c89e032" } }; w.data.decisions[x3.id] = x3;
  w.advance(5 * 60000);
  await w.truth.tick();
  assert.equal(x3.state, "pending");
});

test("GitHub unreachable: nothing is guessed and nothing changes", async () => {
  const w = setup({}, { fail: true });
  w.data.jobs.j = { id: "j", state: "waiting" };
  w.data.decisions.x = { id: "x", jobId: "j", state: "pending", at: T0, question: "q", binds: { number: 6866, head: "e7f0" }, sent: {} };
  w.data.actions.a = { id: "a", jobId: "j", kind: "github", state: "approved", args: { action: "merge", number: 7001, head: "h" } };
  const r = await w.truth.tick();
  assert.equal(r.changed, 0);
  assert.equal(w.data.decisions.x.state, "pending");
  assert.equal(w.data.actions.a.state, "approved");
});

test("reads are bounded per pass and cached between passes", async () => {
  const prs = {}; for (let n = 1; n <= 40; n++) prs[n] = open(n, "h");
  const w = setup(prs);
  w.data.jobs.j = { id: "j", state: "waiting" };
  for (let n = 1; n <= 40; n++) w.data.actions["a" + n] = { id: "a" + n, jobId: "j", kind: "github", state: "approved", args: { action: "merge", number: n, head: "h" } };
  await w.truth.tick();
  assert.equal(w.reads.length, 15);
  await w.truth.tick();
  assert.equal(w.reads.length, 30, "cached PRs are not re-read; the next ones are");
});

test("a publish_patch stuck executing after its PR reached GitHub is recorded done", async () => {
  const w = setup({ 6900: { number: 6900, state: "open", html_url: "https://github.com/lakesidegamedev/AHDGame/pull/6900", head: { sha: "x", ref: "keir/task-5e4788d1ba7d-66f1a21ddb" } } });
  w.data.jobs["5e4788d1ba7d"] = { id: "5e4788d1ba7d", state: "done" };
  w.data.actions["66f1a21ddb"] = { id: "66f1a21ddb", jobId: "5e4788d1ba7d", kind: "publish_patch", state: "executing", at: T0 - 78 * 3600000, args: { repository: "AHDGame" } };
  await w.truth.tick();
  assert.equal(w.data.actions["66f1a21ddb"].state, "done");
  assert.deepEqual(w.data.jobs["5e4788d1ba7d"].pullRequests, ["https://github.com/lakesidegamedev/AHDGame/pull/6900"]);
});

test("an mcp_write that merges a PR is reconciled when the PR merged (ticket 1864, PR 6938)", async () => {
  const w = setup({ 6938: merged(6938, "Egg3901") });
  w.data.actions.m = { id: "m", jobId: "gone", kind: "mcp_write", state: "executing", args: { args: { action: "merge", number: 6938 } } };
  await w.truth.tick();
  assert.equal(w.data.actions.m.state, "done");
});
