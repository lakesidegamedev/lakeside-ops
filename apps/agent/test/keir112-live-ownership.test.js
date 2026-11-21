"use strict";
// Keir 11.2 fifth pass, review 3 F1 (the blocker): code declares a fix live only for a pull request the ticket's own
// records tie to its fix, confirmed merged, with a main receipt for that exact merge. A number read out of wait text, a
// ticket number, an issue number or the same number in another repository is never evidence.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const closing = require("../lib/operator/closing");
const { createPrTruth } = require("../lib/operator/prtruth");
const { ownMainReceipt, jobOwnsPr } = require("../lib/operator/livecoverage");

const HOUR = 3600000, MIN = 60000;
const T0 = Date.parse("2026-11-21T10:00:00Z");
const REPO = "lakesidegamedev/AHDGame";
const url = (n, repo = REPO) => `https://github.com/${repo}/pull/${n}`;

function world() {
  let clock = T0;
  const data = { jobs: {}, seen: {}, decisions: {}, actions: {}, outbox: {}, audit: [], prTruth: { prs: {}, reasked: {} }, watch: {}, codingWorkers: { runs: {} } };
  const ledger = { data, save() {}, audit(kind, detail) { data.audit.push({ kind, ...detail }); }, notify(key, destination, content) { data.outbox[key] ||= { destination, content }; } };
  return { data, ledger, now: () => clock, advance: (ms) => { clock += ms; } };
}
function ticketJob(w, id, ticket, extra = {}) {
  const job = { id, kind: "ticket", ticket, role: "support", state: "running", at: T0 - HOUR, deadline: T0 + 60 * 24 * HOUR, effects: {}, inbox: [], ...extra };
  w.data.jobs[id] = job; w.data.seen[`ticket:${ticket}`] = id;
  return job;
}
function finish(w, job, input) {
  const why = closing.fromFinish(w.data, job, input, w.now());
  if (why) throw new Error(why);
  job.state = "waiting"; job.wakeAt = w.now() + 60 * MIN;
  closing.afterFinish(w.data, job, { now: w.now(), config: closing.DEFAULTS });
}
// GitHub with every listed PR merged long ago and on main.
function github(merged) {
  const reads = [];
  const api = async ([route]) => {
    reads.push(route);
    const pr = /repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(route);
    if (pr && merged[pr[1]]) return { number: Number(pr[1]), state: "closed", merged: true, merged_at: "2025-01-01T00:00:00Z", merge_commit_sha: merged[pr[1]], head: { sha: `h${pr[1]}` } };
    if (/compare\//.test(route)) return { status: "ahead" };
    throw new Error(`unrouted ${route}`);
  };
  return { api, reads };
}
const compares = (g) => g.reads.filter((r) => /compare/.test(r));

test("F1 reproduction: \"the fix for ticket #1900 to go live\" is not PR 1900, and no live receipt is written", async () => {
  const w = world();
  const g = github({ 1900: "old1900sha00" });
  const job = ticketJob(w, "j1900", 1900); // the coding worker is still building; no PR yet
  finish(w, job, { state: "waiting", summary: "s", closesWhen: "closes when the fix is live and the player confirms", waitingOn: "the fix for ticket #1900 to go live" });
  assert.notEqual(job.closing.on.ref, 1900, "a bare #1900 is not a PR");
  const truth = createPrTruth({ ledger: w.ledger, api: g.api, now: w.now });
  await truth.tick();
  assert.deepEqual(compares(g), [], "nothing read as live");
  assert.equal(job.releaseEvidence, undefined);
  assert.equal(job.inbox.length, 0, "the job is not told anything is live");
  assert.equal(w.data.audit.filter((a) => a.kind === "deploy_wait_reached_main").length, 0);
  // Code cannot resolve this wait: the wake goes to the model, and it may not park.
  assert.equal(closing.observe(w.data, job, w.now()).checkable, false);
  assert.equal(closing.parkable(w.data, job, w.now()).ok, false);
  assert.equal(ownMainReceipt([job], []), false);
});

test("F1: a ticket number given as an explicit deploy wait on an old merged PR, and an issue number, change nothing", async () => {
  for (const [ticket, ref, text] of [[1900, 1900, "PR 1900 to go live"], [1901, 4412, "issue 4412 to be live on the main server"]]) {
    const w = world();
    const g = github({ [ref]: `old${ref}sha000` });
    const job = ticketJob(w, `j${ticket}`, ticket, { pullRequests: [url(7001)] }); // its own fix is a different PR
    finish(w, job, { state: "waiting", summary: "s", closesWhen: "closes when live", waitingOn: text, waitOn: { kind: "deploy", ref } });
    assert.deepEqual(job.closing.on, { kind: "deploy", ref });
    await createPrTruth({ ledger: w.ledger, api: g.api, now: w.now }).tick();
    assert.deepEqual(compares(g), [], `${ref}: not this job's PR, never read as live`);
    assert.equal(job.releaseEvidence, undefined);
    const seen = closing.observe(w.data, job, w.now());
    assert.equal(seen.checkable, false);
    assert.match(seen.why, new RegExp(`PR ${ref} is not one this job opened`));
  }
});

test("F1: the same number in another repository is not the job's AHDGame PR", async () => {
  const w = world();
  const g = github({ 7001: "ahdgame7001s" });
  const job = ticketJob(w, "j1902", 1902, { pullRequests: [url(7001, "lakesidegamedev/AHDClient")] });
  assert.equal(jobOwnsPr(w.data, job, REPO, 7001), false);
  assert.equal(jobOwnsPr(w.data, job, "lakesidegamedev/AHDClient", 7001), true);
  finish(w, job, { state: "waiting", summary: "s", closesWhen: "closes when live", waitingOn: "PR 7001 reaching the main server", waitOn: { kind: "deploy", ref: 7001 } });
  await createPrTruth({ ledger: w.ledger, api: g.api, now: w.now }).tick();
  assert.deepEqual(compares(g), []);
  assert.equal(job.releaseEvidence, undefined);
  // A receipt for AHDGame 7001 (say from a lookup that was not this job's) does not cover the AHDClient PR.
  job.releaseEvidence = { ahdgame700: { main: true, repository: REPO, pr: 7001, source: "github-truth" } };
  assert.equal(ownMainReceipt([job], []), false);
});

test("F1: the job's own merged PR with a main receipt for an earlier commit is not live", () => {
  const job = { id: "j", state: "waiting", pullRequests: [url(7001)], releaseEvidence: {
    earlier000: { main: true, repository: "AHDGame", source: "coding-workers" },          // no PR named: an earlier change
    other69900: { main: true, repository: "AHDGame", pr: 6990, source: "github-truth" },   // a different PR
  } };
  assert.equal(ownMainReceipt([job], []), false, "a count of receipts is not this merge on main");
  // The genuine receipt for PR 7001's own merge makes it live.
  job.releaseEvidence.merge7001x = { main: true, repository: "AHDGame", pr: 7001, mergeSha: "merge7001xyz", source: "github-truth" };
  assert.equal(ownMainReceipt([job], []), true);
  // Two own PRs need both.
  job.pullRequests.push(url(7002));
  assert.equal(ownMainReceipt([job], []), false);
});

test("F1 genuine case: a deploy wait on the job's own PR reaches main, writes a receipt for that merge and wakes the job", async () => {
  const w = world();
  const g = github({ 7001: "merge7001abcdef" });
  const job = ticketJob(w, "j1903", 1903, { pullRequests: [url(7001)] });
  finish(w, job, { state: "waiting", summary: "s", closesWhen: "closes when live", waitingOn: "PR 7001 reaching the main server" });
  await createPrTruth({ ledger: w.ledger, api: g.api, now: w.now }).tick();
  assert.equal(compares(g).length, 1);
  const r = job.releaseEvidence.merge7001a;
  assert.deepEqual({ main: r.main, pr: r.pr, mergeSha: r.mergeSha, source: r.source }, { main: true, pr: 7001, mergeSha: "merge7001abcdef", source: "github-truth" });
  assert.equal(job.state, "queued");
  assert.equal(ownMainReceipt([job], []), true);
});

test("F1: an approved merge of a developer's PR is the job's own; an unapproved one is not", async () => {
  const w = world();
  const g = github({ 6865: "merge6865abcdef" });
  const job = ticketJob(w, "j1904", 1904);
  w.data.actions.a1 = { id: "a1", jobId: job.id, kind: "github", state: "pending", args: { action: "merge", number: 6865, repository: REPO } };
  finish(w, job, { state: "waiting", summary: "s", closesWhen: "closes when live", waitingOn: "PR 6865 on the main server", waitOn: { kind: "deploy", ref: 6865 } });
  await createPrTruth({ ledger: w.ledger, api: g.api, now: w.now }).tick();
  assert.deepEqual(compares(g), [], "a merge nobody approved is not this job's fix");
  w.data.actions.a1.state = "done";
  w.advance(HOUR);
  await createPrTruth({ ledger: w.ledger, api: g.api, now: w.now }).tick();
  assert.equal(compares(g).length, 1);
  assert.equal(ownMainReceipt([job], Object.values(w.data.actions)), true);
});

// The status card: the code's "This is now live on the main server" notice follows only the own-PR receipt.
async function cardWorld() {
  const { createLedger } = require("../lib/operator/store");
  const { createBroker } = require("../lib/operator/broker");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-f1-"));
  process.env.KEIR_DEPLOYED_SHA_CMD = "/fixture/probe.sh";
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: [], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const updates = [];
  const discord = async (method, route) => {
    if (method === "GET" && /\/guilds\//.test(route)) return [{ id: "777777777777777777", name: "ticket-bug-x-1900", guild_id: config.guildId }];
    if (method === "GET" && /\/users\/@me$/.test(route)) return { id: config.botId, avatar: null };
    if (method === "GET" && /\/channels\/777777777777777777$/.test(route)) return { id: "777777777777777777", name: "ticket-bug-x-1900", guild_id: config.guildId };
    if (method === "POST") return { id: "901" };
    return [];
  };
  const mcp = { servers: () => ["support"], list: async () => [], call: async (s, tool, args) => { if (tool === "support_public_update") updates.push(args); return { ok: true, delivery: { posted: true } }; } };
  let clock = 5000;
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: {}, now: () => (clock += 1000), exec: async () => "" });
  const job = ledger.createJob("ticket:1900", { kind: "ticket", role: "support", ticket: 1900, channelId: "777777777777777777", source: { channelId: "777777777777777777", channelName: "ticket-bug-x-1900" }, deadline: 9e15 });
  job.state = "waiting"; job.investigatedReads = 5; ledger.data.seen["ticket:1900"] = job.id;
  await broker.adminStatusCard(1900, { items: [{ name: "Factory panel shows zero", stage: "found", blocked: false, note: "" }], status: "" });
  return { dir, ledger, broker, job, updates };
}

test("F1 on the card: a github-truth receipt for a PR the ticket does not own never moves the card to live or posts", async () => {
  const f = await cardWorld();
  try {
    // What cd02bd2 wrote for "the fix for ticket #1900 to go live": a main receipt for old PR 1900.
    f.job.releaseEvidence = { old1900sha: { development: true, staging: true, main: true, repository: "AHDGame", source: "github-truth", pr: 1900 } };
    assert.deepEqual((await f.broker.stageTick()).filter((m) => m.stage === "main"), []);
    const live = () => f.updates.filter((u) => u.deliver && u.update_kind === "production");
    assert.equal(live().length, 0, "no live notice");
    // Its own PR merged, but the receipt is for an earlier commit: still not live.
    f.job.pullRequests = [url(7001)];
    f.job.releaseEvidence.earlier00 = { development: true, staging: true, main: true, repository: "AHDGame", source: "coding-workers" };
    assert.deepEqual((await f.broker.stageTick()).filter((m) => m.stage === "main"), []);
    assert.equal(live().length, 0);
    // The genuine receipt for PR 7001's merge: the card moves and the player hears once.
    f.job.releaseEvidence.merge7001a = { development: true, staging: true, main: true, repository: "AHDGame", source: "github-truth", pr: 7001, mergeSha: "merge7001abcdef" };
    const moved = await f.broker.stageTick();
    assert.equal(moved.at(-1).stage, "main");
    assert.equal(live().length, 1);
    assert.match(live()[0].message, /now live on the main server/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
