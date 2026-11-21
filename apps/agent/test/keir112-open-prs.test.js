"use strict";
// Keir 11.2 items 1 and 7: no Keir pull request sits silently. The fixture is the AHDGame inventory from the
// 2026-11-21 audit (PR numbers, branches and check states as recorded; job ids shortened).
const test = require("node:test");
const assert = require("node:assert");
const { createKeirPrs, foreignCommit, isKeirPr } = require("../lib/operator/keirprs");
const { createOwnerWait } = require("../lib/operator/ownerwait");
const { staticControls } = require("../lib/operator/controls");
// Closes and branch deletions are off by default (review M7); these tests switch them on unless a test says otherwise.
const ALL_ON = staticControls({ openPrCloses: "on", openPrBranchDeletes: "on" });

const DAY = 86400000, T0 = Date.parse("2026-11-21T01:00:00Z");
const REPO = "lakesidegamedev/AHDGame";
const KEIR_EMAIL = "keir@localhost";
const { ledgerIndex } = require("../lib/operator/keirprs");
const keirCommit = (sha) => ({ sha, commit: { author: { email: KEIR_EMAIL }, committer: { email: KEIR_EMAIL }, message: "fix: x\n\nPrepared by Keir for task abc." }, parents: [{}] });
const runs = (state) => ({
  green: [["verify", "success"], ["dependency-review", "success"], ["custom-rules", "success"]],
  coi: [["verify", "success"], ["dependency-review", "success"], ["custom-rules", "failure"]],
  verify: [["verify", "failure"], ["dependency-review", "success"], ["custom-rules", "success"]],
}[state].map(([name, conclusion], i) => ({ id: 1000 + i, name, status: "completed", conclusion, started_at: "2026-11-18T00:00:00Z" })));

function inventory() {
  const pr = (number, ref, { user = "keir-bot", checks = "green", mergeable = true, body = "Change.\n\n## Conflict of interest\n\n- [x] no", title = `PR ${number}`, refs = "", created = "2026-11-18T00:00:00Z" } = {}) =>
    ({ number, title, user: { login: user }, draft: false, state: "open", created_at: created, head: { ref, sha: `h${number}`, repo: { full_name: REPO } }, base: { ref: "development" }, body: `${body}${refs}`, mergeable, _checks: checks });
  const open = [
    pr(6725, "keir/task-dccb90042a93-a30fea03f105", { title: "fix(actions): write batch action logs in one insert" }),
    pr(6781, "keir/task-0f0cef4c5ac7-c238f3459db8", { title: "fix: batch sidebar stock ticker queries" }),
    ...[6784, 6791, 6798, 6799, 6878].map((n) => pr(n, `keir/task-${n}aaaa-bbbb`, { checks: "coi", body: "Docs correction." })),
    pr(6853, "keir/task-89c6301abc54-0954a9d09450", { checks: "verify", title: "feat: frame party and government leadership portraits" }),
    pr(6887, "keir/task-0f6596771978-fc297c569e47", { mergeable: false, title: "fix(wiki): document founding party leadership elections" }),
    pr(6976, "keir/task-4058ef01e823-038900dbceec"),
    pr(6865, "fix/keir-v2re46", { user: "Egg3901", refs: "\n\nRefs #6850", title: "fix(bonds): show the amount the bond market will fund" }),
    // Not Keir's: never touched.
    pr(6757, "feat/compare-share-link", { user: "a-developer", checks: "verify" }),
    pr(6635, "chore/retire-market-mode-control", { user: "Egg3901", checks: "coi", body: "x" }),
    pr(6642, "dependabot/npm_and_yarn/development/next", { user: "dependabot[bot]" }),
  ];
  const merged = [{ number: 6866, title: "fix(bonds): show fundable issuance", body: "Refs #6850", merged_at: "2026-11-19T01:58:00Z", head: { ref: "feat/bond-fundable" } }];
  return { open, merged };
}

function setup({ fail = false, open, merged, branches = [], closedPrs = {}, commits = {}, comments = {}, reviews = {}, events = {}, issues = {}, files = {}, controls = ALL_ON, token = "keir-bot-token", graceHours = 48 } = {}) {
  const inv = inventory();
  open ||= inv.open; merged ||= inv.merged;
  const data = { jobs: {}, actions: {}, decisions: {}, outbox: {}, audit: [], seen: {}, codingWorkers: { runs: { r1: { id: "r1", branch: "fix/keir-v2re46", pr: 6865, state: "needs_owner", ticket: 1857 } } } };
  data.jobs.j4058 = { id: "j4058", state: "waiting", pullRequests: [`https://github.com/${REPO}/pull/6976`] }; // a live task still owns 6976
  data.jobs.jdccb = { id: "jdccb", state: "done", pullRequests: [`https://github.com/${REPO}/pull/6725`] };
  let clock = T0;
  const ledger = { data, save() {}, audit(kind, x) { data.audit.push({ kind, ...x }); }, notify(key, dest, content) { data.outbox[key] ||= { destination: dest, content }; },
    createJob(key, fields) { if (data.seen[key]) return data.jobs[data.seen[key]]; const id = `job${Object.keys(data.jobs).length}`; data.jobs[id] = { id, state: "queued", ...fields }; data.seen[key] = id; return data.jobs[id]; } };
  const writes = [];
  const byNumber = Object.fromEntries(open.map((p) => [p.number, p]));
  const api = async ([route]) => {
    if (fail) throw new Error("gh: HTTP 502");
    let m;
    if (/pulls\?state=open&base=development/.test(route)) return open;
    if (/pulls\?state=closed&base=development/.test(route)) return merged;
    if ((m = /pulls\/(\d+)\/commits/.exec(route))) return commits[m[1]] || [keirCommit("c" + m[1])];
    if ((m = /issues\/(\d+)\/events/.exec(route))) return events[m[1]] || [];
    if ((m = /issues\/(\d+)\/comments/.exec(route))) return comments[m[1]] || [];
    if ((m = /pulls\/(\d+)\/reviews/.exec(route))) return reviews[m[1]] || [];
    if ((m = /pulls\/(\d+)\/files/.exec(route))) return files[m[1]] || [{ filename: `src/${m[1]}.ts` }];
    if ((m = /issues\/(\d+)$/.exec(route))) return issues[m[1]] || { number: Number(m[1]), state: "open" };
    if ((m = /commits\/h(\d+)\/check-runs/.exec(route))) return { check_runs: runs(byNumber[m[1]]._checks) };
    if ((m = /pulls\/(\d+)$/.exec(route))) return byNumber[m[1]] || closedPrs[m[1]];
    if ((m = /git\/matching-refs\/heads\/(.+?)\?/.exec(route))) return branches.filter((b) => b.ref.startsWith(m[1])).map((b) => ({ ref: `refs/heads/${b.ref}`, object: { sha: b.sha } }));
    if ((m = /git\/ref\/heads\/(.+)$/.exec(route))) { const b = branches.find((x) => x.ref === m[1]) || Object.values(byNumber).find((p) => p.head.ref === m[1])?.head; return b ? { object: { sha: b.sha } } : Promise.reject(new Error("HTTP 404 Not Found")); }
    if ((m = /pulls\?state=all&head=[^:]+:(.+?)&/.exec(route))) return branches.find((b) => b.ref === m[1])?.prs || [];
    throw new Error(`unrouted ${route}`);
  };
  const write = async (args) => {
    writes.push(args.join(" "));
    const del = /git\/refs\/heads\/(.+)$/.exec(args[2] || "");
    if (args[1] === "DELETE" && del) { const i = branches.findIndex((b) => b.ref === del[1]); if (i >= 0) branches.splice(i, 1); }
    const body = args.find((a) => a.startsWith("body=")), pr = /pulls\/(\d+)$/.exec(args[2] || "");
    if (args[1] === "PATCH" && pr && body && byNumber[pr[1]]) { byNumber[pr[1]].body = body.slice(5); byNumber[pr[1]]._checks = byNumber[pr[1]]._checks === "coi" ? "green" : byNumber[pr[1]]._checks; }
    if (args[1] === "PATCH" && pr && args.includes("state=closed") && byNumber[pr[1]]) { const i = open.indexOf(byNumber[pr[1]]); if (i >= 0) open.splice(i, 1); }
    return {};
  };
  const prs = createKeirPrs({ ledger, api, write, config: { keirGitEmail: KEIR_EMAIL, githubReviewerToken: token }, now: () => clock, controls, graceHours });
  return { data, ledger, prs, writes, api, open, branches, byNumber, advance: (ms) => { clock += ms; }, now: () => clock };
}
const asked = (w) => Object.values(w.data.jobs).filter((j) => j.adoptedPr).map((j) => j.adoptedPr).sort();
const notices = (w) => Object.keys(w.data.outbox).filter((k) => k.startsWith("pr-blocked:"));

test("first pass over the 21 Nov inventory: nothing closed on first sight, descriptions repaired, green asked once, blocked reported once", async () => {
  const w = setup();
  await w.prs.tick();
  // 6865 and merged 6866 share only "Refs #6850": that is weak evidence (review B2). One question to the owner, no close.
  assert.ok(!w.writes.some((x) => /state=closed|DELETE/.test(x)), w.writes.join("\n"));
  assert.match(w.data.outbox["pr-blocked:6865:superseded?:6866"].content, /may overlap merged PR #6866 \(both mention issue #6850\)\. Keir will not close it on that alone/);
  // Missing Conflict of interest section on Keir's own PRs: repaired (three per pass), and the check re-run.
  const repaired = w.writes.filter((x) => /-X PATCH .*pulls\/(\d+) -f body=.*## Conflict of interest/s.test(x));
  assert.equal(repaired.length, 3);
  // Green, no live task: one ask each, budget two per pass. 6976 has a live task and is left to it.
  assert.deepEqual(asked(w), [6725, 6781]);
  // Red verify and conflict: one plain line each.
  assert.deepEqual(notices(w).sort(), ["pr-blocked:6853:verify:h6853", "pr-blocked:6865:superseded?:6866", "pr-blocked:6887:conflict:h6887"]);
  assert.match(w.data.outbox["pr-blocked:6853:verify:h6853"].content, /PR #6853 \(feat: frame party and government leadership portraits\) is blocked: the build and test check failed\. No Keir task is working on it\. Keir may close it after 2026-11-26 if nobody picks it up, and will warn first/);
  // Nobody else's PR is touched.
  for (const n of [6757, 6635, 6642, 6976]) assert.ok(!w.writes.some((x) => new RegExp(`/${n}\\b`).test(x)), String(n));
  for (const text of Object.values(w.data.outbox).map((o) => o.content)) assert.doesNotMatch(text, /[\u2013\u2014]/);
});

test("later passes finish the repairs and never repeat an ask, a notice or a close", async () => {
  const w = setup();
  await w.prs.tick();
  w.advance(3600000); await w.prs.tick();
  w.advance(3600000); await w.prs.tick();
  assert.equal(w.writes.filter((x) => /-X PATCH .*pulls\/\d+ -f body=/.test(x)).length, 5, "all five repaired, each once");
  // Once repaired and green, each gets its one ask, two per pass.
  assert.deepEqual(asked(w), [6725, 6781, 6784, 6791, 6798, 6799]);
  w.advance(3600000); await w.prs.tick(); w.advance(3600000); await w.prs.tick();
  // Review N5: 6865 only weakly overlaps merged 6866 (both "Refs #6850"), so it is asked about too, with the three choices.
  assert.deepEqual(asked(w), [6725, 6781, 6784, 6791, 6798, 6799, 6865, 6878]);
  assert.equal(notices(w).length, 3);
  assert.equal(w.writes.filter((x) => /state=closed/.test(x)).length, 0);
});

// Stale: the owner is warned first, the close comes a grace period later, with a note that says how to undo it.
async function toStaleClose(w) {
  await w.prs.tick();
  for (const j of Object.values(w.data.jobs)) if (j.adoptedPr) j.state = "done";
  w.advance(5 * DAY + 3600000); await w.prs.tick(); // warning
  w.advance(49 * 3600000); await w.prs.tick(); // close
}

test("after the stale period an orphan is warned about, then closed with a note after the grace; a foreign commit keeps it open", async () => {
  const commits = { 6887: [keirCommit("a"), { sha: "b", commit: { author: { email: "dev@example.com" }, committer: { email: "dev@example.com" }, message: "rebase" }, parents: [{}] }] };
  const w = setup({ commits });
  await w.prs.tick();
  for (const j of Object.values(w.data.jobs)) if (j.adoptedPr) j.state = "done";
  w.advance(5 * DAY + 3600000);
  await w.prs.tick();
  assert.ok(!w.writes.some((x) => /state=closed/.test(x)), "warned, not closed");
  assert.match(w.data.outbox["pr-blocked:6853:will-close:stale"].content, /Keir plans to close PR #6853 on 2026-11-28 with a note\. To keep it, comment on it or tell Keir/);
  w.advance(49 * 3600000);
  await w.prs.tick();
  assert.ok(w.writes.some((x) => /issues\/6853\/comments .*Closing as stale: the build and test check failed.*If it is still wanted, reopen it; Keir will then leave it alone/s.test(x)));
  assert.ok(w.writes.includes(`-X PATCH repos/${REPO}/pulls/6853 -f state=closed`));
  assert.ok(!w.writes.some((x) => /pulls\/6887 -f state=closed/.test(x)), "a person pushed to 6887: never closed");
});

test("a PR a live Keir task or worker owns is left alone; GitHub unreachable changes nothing", async () => {
  const w = setup({ fail: true });
  await w.prs.tick();
  assert.deepEqual(w.writes, []);
  assert.deepEqual(asked(w), []);
});

test("branches of closed, unmerged Keir PRs are deleted, ten per pass; others are kept", async () => {
  const closed = (n, ref, extra = {}) => ({ number: n, state: "closed", merged_at: null, user: { login: "keir-bot" }, head: { ref, sha: `s${n}`, repo: { full_name: REPO } }, ...extra });
  const branches = [];
  for (let i = 0; i < 22; i++) { const ref = `keir/task-old${i}-x`; branches.push({ ref, sha: `s${5900 + i}`, prs: [closed(5900 + i, ref)] }); }
  branches.push({ ref: "keir/task-merged-x", sha: "sm", prs: [closed(5960, "keir/task-merged-x", { merged_at: "2026-11-10T00:00:00Z", head: { ref: "keir/task-merged-x", sha: "sm" } })] });
  branches.push({ ref: "keir/task-moved-x", sha: "after-close", prs: [closed(5961, "keir/task-moved-x")] });
  branches.push({ ref: "keir/task-open-x", sha: "so", prs: [{ ...closed(5962, "keir/task-open-x"), state: "open" }] });
  branches.push({ ref: "keir/task-nopr-x", sha: "sn", prs: [] });
  const w = setup({ open: [], merged: [], branches });
  await w.prs.tick();
  assert.equal(w.writes.filter((x) => /DELETE .*git\/refs\/heads\/keir\/task-old/.test(x)).length, 10);
  w.advance(3600000); await w.prs.tick();
  w.advance(3600000); await w.prs.tick();
  w.advance(3600000); await w.prs.tick();
  const deleted = w.writes.filter((x) => /DELETE/.test(x));
  assert.equal(deleted.length, 22, deleted.join("\n"));
  for (const kept of ["merged", "moved", "open", "nopr"]) assert.ok(!deleted.some((x) => x.includes(`task-${kept}-x`)), kept);
});

test("foreign commits: another author, a GitHub web edit or a merge commit", () => {
  assert.equal(foreignCommit([keirCommit("a")], KEIR_EMAIL), null);
  assert.match(foreignCommit([keirCommit("a"), { commit: { author: { email: "x@y" }, committer: { email: "noreply@github.com" }, message: "Update" }, committer: { login: "web-flow" }, parents: [{}] }], KEIR_EMAIL), /on GitHub/);
  assert.match(foreignCommit([keirCommit("a"), { commit: { author: { email: KEIR_EMAIL }, committer: { email: KEIR_EMAIL }, message: "Merge" }, parents: [{}, {}] }], KEIR_EMAIL), /merge/);
  assert.equal(foreignCommit(null, KEIR_EMAIL), "commits unreadable");
});

test("the owner-wait watcher skips Keir's own PRs and PRs a task is already asking about", async () => {
  const { open } = inventory();
  const data = { jobs: {}, decisions: { q: { id: "q", jobId: "jx", state: "pending", askKey: "pr:AHDGame:6757" } }, actions: {}, seen: {}, codingWorkers: { runs: { r1: { branch: "fix/keir-v2re46", pr: 6865, state: "needs_owner" } } } };
  const created = [];
  const ledger = { data, createJob: (key) => { created.push(key); return {}; }, save() {} };
  const greenExceptOwner = { check_runs: [{ name: "verify", status: "completed", conclusion: "success" }, { name: "dependency-review", status: "completed", conclusion: "success" }, { name: "custom-rules", status: "completed", conclusion: "failure" }] };
  const api = async ([route]) => (/pulls\?state=open/.test(route) ? open : /check-runs/.test(route) ? greenExceptOwner : /reviews/.test(route) ? [] : { mergeable: true });
  await createOwnerWait({ ledger, api }).tick();
  assert.ok(!created.some((k) => /ownerwait:(67|68|69)\d\d:/.test(k) && !/6635|6642/.test(k)), created.join(","));
  assert.ok(!created.some((k) => k.startsWith("ownerwait:6757:")), "already being asked about");
  assert.ok(!created.some((k) => k.startsWith("ownerwait:6865:")), "Keir worker PR");
});

test("isKeirPr: a keir/ branch by keir-bot, or a recorded worker branch; a person's branch never", () => {
  const d = { jobs: {}, actions: {}, decisions: {}, codingWorkers: { runs: { r: { branch: "fix/keir-abc", pr: 1 } } } };
  assert.equal(isKeirPr({ number: 9, user: { login: "keir-bot" }, head: { ref: "keir/task-1-2" } }, d), true);
  assert.equal(isKeirPr({ number: 9, user: { login: "someone" }, head: { ref: "keir/task-1-2" } }, d), false);
  assert.equal(isKeirPr({ number: 1, user: { login: "Egg3901" }, head: { ref: "fix/keir-abc" } }, d), true);
  assert.equal(isKeirPr({ number: 2, user: { login: "Egg3901" }, head: { ref: "fix/keir-zzz" } }, d), false);
  assert.equal(isKeirPr({ number: 3, user: { login: "keir-bot" }, head: { ref: "feat/x" } }, d), false);
});

test("a close that fails after its note is retried once without a second note, then given up with one owner line (m5)", async () => {
  const w = setup();
  let failClose = true;
  const prs = createKeirPrs({ ledger: w.ledger, api: w.api, now: w.now, config: { keirGitEmail: KEIR_EMAIL, githubReviewerToken: "t" }, controls: ALL_ON,
    write: async (args) => { w.writes.push(args.join(" ")); if (failClose && args.includes("state=closed")) throw new Error("HTTP 403"); return {}; } });
  await prs.tick();
  for (const j of Object.values(w.data.jobs)) if (j.adoptedPr) j.state = "done";
  w.advance(5 * DAY + 3600000); await prs.tick();
  w.advance(49 * 3600000); await prs.tick();
  w.advance(3600000); await prs.tick();
  w.advance(3600000); await prs.tick();
  w.advance(3600000); await prs.tick();
  assert.equal(w.writes.filter((x) => /issues\/6725\/comments/.test(x)).length, 1);
  assert.equal(w.writes.filter((x) => /pulls\/6725 -f state=closed/.test(x)).length, 2, "two tries, never a third");
  assert.match(w.data.outbox["keir-pr-close-failed:6725"].content, /tried 2 times to close PR #6725/);
  failClose = false;
  w.advance(3600000); await prs.tick();
  assert.equal(w.writes.filter((x) => /pulls\/6725 -f state=closed/.test(x)).length, 2);
});

// ---- Third pass: the independent review's scenarios (B1, B2, M4, M5, m6, M7) ----
const one = (number, ref, { checks = "verify", body = "Part.\n\n## Conflict of interest\n\n- [x] no", created = "2026-11-10T00:00:00Z", mergeable = true } = {}) =>
  ({ number, title: `PR ${number}`, user: { login: "keir-bot" }, draft: false, state: "open", created_at: created, head: { ref, sha: `h${number}`, repo: { full_name: REPO } }, base: { ref: "development" }, body, mergeable, _checks: checks });
const closesOf = (w, n) => w.writes.filter((x) => new RegExp(`pulls/${n} -f state=closed`).test(x)).length;
const deletesOf = (w, ref) => w.writes.filter((x) => x === `-X DELETE repos/${REPO}/git/refs/heads/${ref}`).length;

test("B1: a PR a person reopens after Keir closed it is never closed again, its branch never deleted again, and the owner hears once", async () => {
  const pr = one(7001, "keir/task-a");
  const w = setup({ open: [pr], merged: [] });
  await w.prs.tick();
  w.advance(5 * DAY + 3600000); await w.prs.tick(); // warned
  w.advance(49 * 3600000); await w.prs.tick(); // closed, branch deleted
  assert.equal(closesOf(w, 7001), 1);
  assert.equal(deletesOf(w, "keir/task-a"), 1);
  // The owner restores the branch and reopens the PR, meaning to merge it.
  w.open.push(pr); w.branches.push({ ref: "keir/task-a", sha: "h7001" });
  for (let i = 0; i < 6; i++) { w.advance(3600000); await w.prs.tick(); }
  w.advance(10 * DAY); await w.prs.tick();
  assert.equal(closesOf(w, 7001), 1, "never closed again");
  assert.equal(deletesOf(w, "keir/task-a"), 1, "never deleted again");
  assert.equal(w.writes.filter((x) => /issues\/7001\/comments/.test(x)).length, 1);
  const told = Object.keys(w.data.outbox).filter((k) => /^keir-pr-reversed:7001$|keir-branch-restored/.test(k));
  assert.deepEqual(told, ["keir-pr-reversed:7001"]);
  assert.match(w.data.outbox["keir-pr-reversed:7001"].content, /reopened after Keir closed it\. Keir takes that as a person's decision and will not close, delete or ask about it again/);
  assert.ok(w.data.keirPrs.prs[7001].handsOff);
});

test("B1: a branch Keir deleted that a person restores is never deleted again", async () => {
  const closed = { number: 5900, state: "closed", merged_at: null, user: { login: "keir-bot" }, head: { ref: "keir/task-old", sha: "s1", repo: { full_name: REPO } } };
  const branches = [{ ref: "keir/task-old", sha: "s1", prs: [closed] }];
  const w = setup({ open: [], merged: [], branches });
  await w.prs.tick();
  assert.equal(deletesOf(w, "keir/task-old"), 1);
  w.branches.push({ ref: "keir/task-old", sha: "s1", prs: [closed] });
  for (let i = 0; i < 4; i++) { w.advance(3600000); await w.prs.tick(); }
  assert.equal(deletesOf(w, "keir/task-old"), 1);
  assert.equal(Object.keys(w.data.outbox).filter((k) => /keir-branch-restored:keir\/task-old/.test(k)).length, 1);
  assert.ok(w.data.keirPrs.branches["keir/task-old"].handsOff);
});

test("B1: a close Keir started but never confirmed is checked against the PR's events: a reopen is a person's decision", async () => {
  const w = setup({ open: [one(7002, "keir/task-b")], merged: [], events: { 7002: [{ event: "closed" }, { event: "reopened", actor: { login: "Egg3901" } }] } });
  w.data.keirPrs = { prs: { 7002: { number: 7002, firstSeenAt: T0 - 9 * DAY, orphanSince: T0 - 9 * DAY, asked: {}, notices: {}, warned: { stale: T0 - 3 * DAY }, closeStartedAt: T0 - DAY, closeAttempts: 1 } }, actions: [], branches: {} };
  await w.prs.tick();
  assert.equal(closesOf(w, 7002), 0);
  assert.ok(w.data.keirPrs.prs[7002].handsOff);
  assert.ok(w.data.outbox["keir-pr-reversed:7002"]);
});

test("B2: two parts of one fix that both say Refs #6850 are never closed as superseded, however long they sit", async () => {
  const part1 = { number: 7000, title: "part 1", body: "Refs #6850", merged_at: "2026-11-20T00:00:00Z", head: { ref: "keir/task-p1" } };
  const w = setup({ open: [one(7001, "keir/task-p2", { checks: "green", body: "Part 2.\n\n## Conflict of interest\n\n- [x] no\n\nRefs #6850", created: "2026-11-19T00:00:00Z" })], merged: [part1] });
  for (let i = 0; i < 12; i++) { await w.prs.tick(); w.advance(DAY); }
  assert.equal(closesOf(w, 7001), 0);
  assert.equal(deletesOf(w, "keir/task-p2"), 0);
  assert.match(w.data.outbox["pr-blocked:7001:superseded?:7000"].content, /may overlap merged PR #7000 \(both mention issue #6850\)\. Keir will not close it on that alone/);
  assert.equal(Object.keys(w.data.outbox).filter((k) => k.startsWith("pr-blocked:7001")).length, 1, "one question, never repeated");
});

test("B2: a shared closing keyword is not enough when the issue is open or the files differ", async () => {
  for (const [issues, files] of [[{ 6850: { state: "open" } }, {}], [{ 6850: { state: "closed" } }, { 7001: [{ filename: "a.ts" }], 7000: [{ filename: "b.ts" }] }]]) {
    const merged = [{ number: 7000, body: "Fixes #6850", merged_at: "2026-11-20T00:00:00Z", head: { ref: "x" } }];
    const w = setup({ open: [one(7001, "keir/task-c", { body: "Fix.\n\n## Conflict of interest\n\n- [x] no\n\nFixes #6850", created: "2026-11-19T00:00:00Z" })], merged, issues, files });
    for (let i = 0; i < 6; i++) { await w.prs.tick(); w.advance(DAY); }
    assert.equal(closesOf(w, 7001), 0);
    assert.ok(w.data.outbox["pr-blocked:7001:superseded?:7000"]);
  }
});

test("B2: a true duplicate is closed only after first-sight grace and a warning, with a note saying why and how to undo it", async () => {
  const merged = [{ number: 7000, body: "Fixes #6850", merged_at: "2026-11-20T00:00:00Z", head: { ref: "x" } }];
  const w = setup({ open: [one(7001, "keir/task-d", { checks: "green", body: "Fix.\n\n## Conflict of interest\n\n- [x] no\n\nFixes #6850", created: "2026-11-19T00:00:00Z" })], merged,
    issues: { 6850: { state: "closed" } }, files: { 7001: [{ filename: "a.ts" }], 7000: [{ filename: "a.ts" }, { filename: "b.ts" }] } });
  await w.prs.tick();
  assert.equal(closesOf(w, 7001), 0, "never on first sight");
  w.advance(47 * 3600000); await w.prs.tick();
  assert.equal(closesOf(w, 7001), 0);
  w.advance(2 * 3600000); await w.prs.tick();
  assert.match(w.data.outbox["pr-blocked:7001:will-close:superseded:7000"].content, /looks superseded by merged PR #7000: both close issue #6850, which is closed, and #7000 changes every file this PR changes\. Keir plans to close PR #7001 on/);
  assert.equal(closesOf(w, 7001), 0);
  w.advance(49 * 3600000); await w.prs.tick();
  assert.equal(closesOf(w, 7001), 1);
  assert.ok(w.writes.some((x) => /issues\/7001\/comments .*Closing as superseded by #7000: both close issue #6850.*If this change is still wanted, reopen the PR; Keir will then leave it alone\./s.test(x)));
});

test("M4: a rebase, an amend or a cherry-pick by a person is someone else's work", () => {
  const rebased = { commit: { author: { email: KEIR_EMAIL }, committer: { email: "owner@example.com" }, message: "fix: x\n\nPrepared by Keir for task abc." }, parents: [{}] };
  assert.equal(foreignCommit([keirCommit("a"), rebased], KEIR_EMAIL), "a commit rebased or amended by someone else");
  const picked = { commit: { author: { email: "dev@example.com" }, committer: { email: "dev@example.com" }, message: "fix: y\n\nPrepared by Keir for task abc." }, parents: [{}] };
  assert.equal(foreignCommit([picked], KEIR_EMAIL), "a commit by someone else", "the message proves nothing and the first author is not trusted on a keir/ branch");
  assert.equal(foreignCommit([picked], KEIR_EMAIL, { worker: true }), null, "a worker branch's own identity");
});

test("M4: a push while no Keir task owned the PR, or a person's comment, stops any close", async () => {
  const pr = one(7003, "keir/task-e");
  const w = setup({ open: [pr], merged: [] });
  await w.prs.tick();
  w.advance(4 * DAY); pr.head.sha = "h7003b"; await w.prs.tick(); // a person resolved the conflict and pushed
  w.advance(DAY + 3600000); await w.prs.tick();
  w.advance(3 * DAY); await w.prs.tick();
  w.advance(3 * DAY); await w.prs.tick();
  assert.equal(closesOf(w, 7003), 0);
  assert.match(w.data.keirPrs.prs[7003].personTouched, /new commits pushed/);
  const pr2 = one(7004, "keir/task-f");
  const w2 = setup({ open: [pr2], merged: [], comments: { 7004: [{ user: { login: "Egg3901" }, body: "I'll take this one" }] } });
  await toStaleClose(w2); w2.advance(3 * DAY); await w2.prs.tick();
  assert.equal(closesOf(w2, 7004), 0);
  assert.match(w2.data.keirPrs.prs[7004].personTouched, /a comment by Egg3901/);
});

test("M5: a PR red only on custom-rules with the section present is reported blocked, never asked about as green", async () => {
  const w = setup({ open: [one(7005, "keir/task-g", { checks: "coi" })], merged: [] });
  await w.prs.tick(); w.advance(3600000); await w.prs.tick();
  assert.deepEqual(asked(w), []);
  assert.match(w.data.outbox["pr-blocked:7005:custom-rules:h7005"].content, /is blocked: the description check failed/);
});

test("m6: without Keir's own token no GitHub write is made; the would-be writes are previewed", async () => {
  const w = setup({ token: "" });
  await w.prs.tick();
  assert.deepEqual(w.writes, []);
  const items = Object.values(w.data.preview.items);
  assert.ok(items.some((x) => x.action === "repair description" && /KEIR_GITHUB_TOKEN is not set/.test(x.reason)));
});

test("M7: closes are off by default (previewed, the owner is not warned); the pass switch and the kill switch stop everything", async () => {
  const w = setup({ open: [one(7006, "keir/task-h")], merged: [], controls: staticControls() });
  await toStaleClose(w); w.advance(3 * DAY); await w.prs.tick();
  assert.equal(closesOf(w, 7006), 0);
  assert.ok(!w.data.outbox["pr-blocked:7006:will-close:stale"], "no warning about a close that will not happen");
  assert.match(w.data.preview.items["open-prs:close:#7006"].reason, /stale: blocked \(verify\) \(not done: openPrCloses is off\)/);
  for (const controls of [staticControls({ openPrPass: "off" }), staticControls({ openPrCloses: "on" }, { held: "owner" }), staticControls({ openPrCloses: "on" }, { preview: true })]) {
    const x = setup({ controls });
    await x.prs.tick();
    assert.deepEqual(x.writes, []);
    assert.deepEqual(Object.keys(x.data.outbox), []);
    assert.deepEqual(asked(x), []);
  }
});

test("N5: a weak overlap never leaves a green PR ownerless: the ask offers merge, close as duplicate or keep open, and the PR stays owned", async () => {
  const w = setup();
  for (let i = 0; i < 6; i++) { await w.prs.tick(); w.advance(3600000); }
  const job = Object.values(w.data.jobs).find((j) => j.adoptedPr === 6865);
  assert.ok(job, "6865 is asked about");
  assert.match(job.source.content, /may overlap merged PR #6866/);
  assert.match(job.source.content, /"Merge PR 6865", "Close PR 6865 as a duplicate of #6866", "Keep PR 6865 open for now"/);
  assert.equal(ledgerIndex(w.data).get(6865).live, true, "owned by the ask until a choice is made");
  // The owner line no longer tells him to close it.
  const line = w.data.outbox["pr-blocked:6865:superseded?:6866"].content;
  assert.doesNotMatch(line, /Close it if it is no longer needed/);
  assert.match(line, /may simply still be wanted/);
  assert.ok(!w.writes.some((x) => /pulls\/6865 -f state=closed/.test(x)), "never closed on a weak match");
});

test("N6: a PR Keir closed is remembered after its record would have been pruned, so a late reopen is still hands-off", async () => {
  const w = setup({ controls: require("../lib/operator/controls").staticControls({ openPrCloses: "on", openPrBranchDeletes: "on" }) });
  const s = () => w.data.keirPrs.prs;
  await w.prs.tick();
  // Keir closed 6853 long ago (as the stale path does), then the PR left the open list.
  s()[6853] = { ...s()[6853], closedAt: w.now(), closeStartedAt: w.now(), closedReason: "stale" };
  const i = w.open.findIndex((p) => p.number === 6853); const pr = w.open.splice(i, 1)[0];
  w.advance(21 * DAY); await w.prs.tick();
  assert.ok(s()[6853], "kept past 14 days");
  assert.equal(s()[6853].compact, true);
  // Three weeks later a developer reopens it.
  w.open.push(pr); w.advance(3600000); await w.prs.tick();
  assert.ok(s()[6853].handsOff, "a person's reopen is recognised");
  assert.match(w.data.outbox["keir-pr-reversed:6853"].content, /will not close, delete or ask about it again/);
  // The other side: a record of a PR Keir never acted on is still pruned.
  s()[9999] = { number: 9999, asked: {}, notices: {}, checkedAt: w.now() - 15 * DAY };
  w.advance(3600000); await w.prs.tick();
  assert.equal(s()[9999], undefined);
});

test("m5: a description repair that keeps failing is given up after two tries at a head, with one owner line", async () => {
  const w = setup();
  const tries = {};
  const failing = createKeirPrs({ ledger: w.ledger, api: w.api, write: async (args) => { const m = /pulls\/(\d+)$/.exec(args[2] || ""); if (m && args.some((a) => a.startsWith("body="))) { tries[m[1]] = (tries[m[1]] || 0) + 1; throw new Error("HTTP 502"); } return {}; },
    config: { keirGitEmail: KEIR_EMAIL, githubReviewerToken: "t" }, now: w.now, controls: ALL_ON });
  for (let i = 0; i < 8; i++) { await failing.tick(); w.advance(3600000); }
  assert.ok(Object.keys(tries).length >= 1);
  for (const [n, k] of Object.entries(tries)) {
    assert.equal(k, 2, `#${n}: two tries, then no more`);
    assert.ok(w.data.outbox[`pr-blocked:${n}:repair-failed:h${n}`], `#${n}: one owner line`);
  }
});
