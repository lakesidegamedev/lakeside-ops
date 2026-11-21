"use strict";
// Keir 11.2 fourth pass, review N7: preview is a faithful no-op. Every new pass runs in preview on one ledger; afterwards
// the ledger is unchanged apart from the preview record itself, no write function was called (GitHub write, owner line,
// new job, kanban, player post), and turning preview off afterwards behaves exactly as if preview had never run.
const test = require("node:test");
const assert = require("node:assert");
const { staticControls } = require("../lib/operator/controls");
const closing = require("../lib/operator/closing");
const { wakeStep } = require("../lib/operator/lifecycle");

const NOW = Date.parse("2026-11-21T03:00:00Z"), H = 3600000, REPO = "lakesidegamedev/AHDGame";
const KEIR = { commit: { author: { email: "keir@localhost" }, committer: { email: "keir@localhost" } }, parents: [{}] };

function fixture() {
  return {
    seen: { "ticket:1868": "j1868" }, channels: {}, outbox: {}, paused: false,
    watch: { turnClock: { turn: 99, iteration: 3, at: NOW } },
    jobs: {
      j1868: { id: "j1868", kind: "ticket", ticket: 1868, state: "waiting", wakeAt: NOW - 1, deadline: NOW + 99 * H, inbox: [], effects: {},
        closing: { closesWhen: "x", waitingOn: "PR 7001 going live", on: { kind: "deploy", ref: 7001 }, mark: "pr:7001:merged:h:not-main", timerAt: NOW - 1, timerMs: 3600000, quietWakes: 2 }, pullRequests: [`https://github.com/${REPO}/pull/7001`] },
      f1: { id: "f1", kind: "finding", state: "blocked", at: NOW - 400 * H, stateAt: NOW - 200 * H, summary: "old finding", effects: {}, history: [{ at: new Date(NOW - 200 * H).toISOString(), kind: "finish", state: "blocked" }] },
      done: { id: "done", state: "done", pullRequests: [`https://github.com/${REPO}/pull/7100`] },
    },
    actions: {
      a1: { id: "a1", jobId: "j1868", kind: "github", state: "approved", approvedAt: NOW - 2 * H, args: { action: "merge", number: 7001, repository: REPO } },
      p1: { id: "p1", jobId: "j1868", kind: "publish_patch", state: "executing", at: NOW - 2 * H, args: { repository: REPO } },
    },
    decisions: {
      a: { id: "a", jobId: "j1868", state: "approve", answeredBy: "o", answeredAt: NOW - 2 * H, decisionKey: "kanban:255573", question: "Ship it?", sent: {} },
      q: { id: "q", jobId: "j1868", state: "pending", at: NOW - 3 * H, question: "Merge PR 7002?", binds: { repository: REPO, number: 7002, head: "old" }, askKey: "pr:AHDGame:7002" },
    },
    ticketPromises: { 1868: [{ id: "1868-x", at: NOW - 3 * H, jobId: "j1868", state: "open", wakes: 0, kind: "plain", text: "I'll check this again and tell you.", dueAt: NOW - H }] },
    prTruth: { prs: {}, reasked: {} },
  };
}
function github(calls) {
  const pr = (n, extra = {}) => ({ number: n, title: `PR ${n}`, user: { login: "keir-bot" }, draft: false, state: "open", created_at: "2026-11-01T00:00:00Z", head: { ref: `keir/task-${n}`, sha: `h${n}`, repo: { full_name: REPO } }, body: "x", mergeable: true, ...extra });
  return async ([route]) => {
    calls.push(route);
    if (/pulls\?state=open/.test(route)) return [pr(7100), pr(7101, { body: "Refs #1" })];
    if (/pulls\?state=closed/.test(route)) return [];
    if (/pulls\?state=all/.test(route)) return [];
    if (/check-runs/.test(route)) return { check_runs: ["verify", "dependency-review", "custom-rules"].map((name) => ({ name, status: "completed", conclusion: name === "custom-rules" ? "failure" : "success" })) };
    if (/pulls\/\d+\/commits/.test(route)) return [KEIR];
    if (/pulls\/7001$/.test(route)) return { number: 7001, state: "closed", merged: true, merged_at: "2026-11-21T01:00:00Z", merge_commit_sha: "abc1234def", head: { sha: "h" } };
    if (/pulls\/7002$/.test(route)) return { number: 7002, state: "open", merged: false, head: { sha: "new" } };
    if (/pulls\/(\d+)$/.test(route)) return pr(Number(/(\d+)$/.exec(route)[1]));
    if (/compare\//.test(route)) return { status: "ahead" };
    if (/matching-refs/.test(route)) return [];
    if (/issues\/\d+\/(comments|events)|reviews/.test(route)) return [];
    throw new Error(`HTTP 404 ${route}`);
  };
}

async function runAll(data, controls, writes) {
  const ledger = { data, save() { writes.push("save"); }, audit(kind) { writes.push(`audit ${kind}`); }, notify(key) { writes.push(`notify ${key}`); }, createJob(key) { writes.push(`createJob ${key}`); return { id: "x" }; } };
  const calls = [];
  const api = github(calls);
  const write = async (args) => { writes.push(`github ${args.join(" ")}`); return {}; };
  await require("../lib/operator/keirprs").createKeirPrs({ ledger, api, write, config: { keirGitEmail: "keir@localhost", githubReviewerToken: "t" }, now: () => NOW, controls }).tick();
  await require("../lib/operator/prtruth").createPrTruth({ ledger, api, now: () => NOW, controls }).tick();
  const cards = require("../lib/operator/decisioncards").createDecisionCards({ ledger, mcp: { call: async () => { writes.push("kanban"); return {}; } }, config: { ownerId: "o", staffIds: [] }, now: () => NOW, controls, readTicket: async () => ({ status: "closed" }) });
  await cards.tick(); await cards.sweepClosedTickets();
  await require("../lib/operator/promises").createPromises({ ledger, now: () => NOW, controls, held: () => null, post: async () => { writes.push("player post"); } }).tick();
  closing.expireFindings(ledger, { now: NOW, config: closing.DEFAULTS, controls });
  for (const j of Object.values(data.jobs)) wakeStep(j, { now: NOW, config: { controls, taskLifetimeMs: 9e15 }, data, closing: { ...closing.DEFAULTS, handoffReady: () => controls.gate("openPrPass").act }, claimedBy: () => null, directiveHeld: () => false });
  // The gateway's channel answer path in preview works on a copy (gateway.js); the standdown call it makes is pure there.
  return calls;
}
const strip = (d) => { const { preview, ...rest } = JSON.parse(JSON.stringify(d)); return rest; };

test("every new pass in preview leaves the ledger unchanged apart from the preview record, and writes nothing", async () => {
  const data = fixture();
  const before = strip(data);
  const writes = [];
  const reads = await runAll(data, staticControls({ openPrCloses: "on", openPrBranchDeletes: "on" }, { preview: true }), writes);
  assert.ok(reads.length > 5, "the passes did read GitHub");
  // Saving the ledger (to keep the preview record) is allowed; nothing outward is.
  assert.deepEqual(writes.filter((w) => w !== "save"), [], "no write function called");
  // wakeStep moves a due timer to queued (that is the old behaviour preview keeps); everything else is unchanged.
  const after = strip(data);
  for (const j of Object.values(after.jobs)) { delete j.state; }
  for (const j of Object.values(before.jobs)) { delete j.state; }
  assert.deepEqual(after, before);
  assert.ok(Object.keys(data.preview.items).length >= 5, Object.keys(data.preview.items).join("\n"));
  const passes = new Set(Object.values(data.preview.items).map((x) => x.pass));
  for (const p of ["open-prs", "github-reconcile", "decision-cards", "promises", "finding-expiry"]) assert.ok(passes.has(p), p);
});

test("turning preview off afterwards behaves exactly as if preview had never run", async () => {
  const fresh = fixture(), previewed = fixture();
  await runAll(previewed, staticControls({}, { preview: true }), []);
  delete previewed.preview;
  for (const j of Object.values(previewed.jobs)) j.state = fresh.jobs[j.id].state;
  const a = [], b = [];
  await runAll(fresh, staticControls({}), a);
  await runAll(previewed, staticControls({}), b);
  assert.deepEqual(b, a, "the same actions, in the same order");
  assert.deepEqual(strip(previewed), strip(fresh));
});

test("N7: the live-notice repeat check belongs to the post budget switch; off or in preview the code notice goes out as before", async () => {
  const { setup } = require("./keir10-post.helpers");
  const run = async (controls) => {
    const f = setup({ config: { controls } });
    const d = f.ledger.data;
    f.job.pullRequests = ["https://github.com/lakesidegamedev/AHDGame/pull/7001"];
    f.job.releaseEvidence = { abc1234def: { at: f.now() - 60000, main: true, development: true, staging: true, repository: "AHDGame", pr: 7001 } };
    d.statusCards = { 123: { messageId: "9", channelId: f.job.channelId, items: [], liveNotified: [] } };
    d.ticketPosts = { 123: [{ at: f.now() - 30000, text: "The fix is now live on the main server.", jobId: f.job.id }] };
    f.advance(20);
    await f.broker.liveNotice(f.job, 123, [], [{ name: "Margins", stage: "main", blocked: false }]);
    return { d, live: f.calls.filter((c) => c[1] === "support_public_update" && /now live on the main server: Margins/.test(c[2]?.message || "")).length };
  };
  assert.equal((await run(staticControls({}))).live, 0, "on: the model already said it, the notice is held");
  assert.equal((await run(staticControls({ postBudget: "off" }))).live, 1, "off: the notice goes out as before 11.2");
  const p = await run(staticControls({ postBudget: "preview" }));
  assert.equal(p.live, 1, "preview: goes out too");
  assert.ok(Object.keys(p.d.preview.items).some((k) => k.startsWith("post-rules:would hold live notice")));
});

test("N7: with the open-PR pass in preview or off, ownerwait still asks about an orphaned green Keir PR", async () => {
  const { createOwnerWait } = require("../lib/operator/ownerwait");
  for (const [controls, asks] of [[staticControls({}), 0], [staticControls({}, { preview: true }), 1], [staticControls({ openPrPass: "off" }), 1]]) {
    const created = [];
    const data = { jobs: {}, actions: {}, decisions: {}, seen: {} };
    const ledger = { data, save() {}, audit() {}, createJob(key) { created.push(key); return { id: key }; } };
    const pr = { number: 7100, draft: false, user: { login: "keir-bot" }, head: { sha: "h", ref: "keir/task-x", repo: { full_name: REPO } } };
    const api = async ([route]) => {
      if (/pulls\?state=open/.test(route)) return [pr];
      if (/check-runs/.test(route)) return { check_runs: [{ name: "verify", status: "completed", conclusion: "success" }, { name: "dependency-review", status: "completed", conclusion: "success" }, { name: "custom-rules", status: "completed", conclusion: "failure" }] };
      if (/reviews/.test(route)) return [];
      return { mergeable: true };
    };
    await createOwnerWait({ ledger, api, controls }).tick();
    assert.equal(created.length, asks);
  }
});
