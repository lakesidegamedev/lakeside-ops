"use strict";
// Keir 11.2 items 1 and 7: no Keir pull request sits silently. The fixture is the AHDGame inventory from the
// 2026-11-21 audit (PR numbers, branches and check states as recorded; job ids shortened).
const test = require("node:test");
const assert = require("node:assert");
const { createKeirPrs, foreignCommit, isKeirPr } = require("../lib/operator/keirprs");
const { createOwnerWait } = require("../lib/operator/ownerwait");

const DAY = 86400000, T0 = Date.parse("2026-11-21T01:00:00Z");
const REPO = "lakesidegamedev/AHDGame";
const KEIR_EMAIL = "keir@localhost";
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

function setup({ fail = false, open, merged, branches = [], closedPrs = {}, commits = {} } = {}) {
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
  const prs = createKeirPrs({ ledger, api, write, config: { keirGitEmail: KEIR_EMAIL }, now: () => clock });
  return { data, ledger, prs, writes, api, advance: (ms) => { clock += ms; } };
}
const asked = (w) => Object.values(w.data.jobs).filter((j) => j.adoptedPr).map((j) => j.adoptedPr).sort();
const notices = (w) => Object.keys(w.data.outbox).filter((k) => k.startsWith("pr-blocked:"));

test("first pass over the 21 Nov inventory: superseded closed, descriptions repaired, green asked once, blocked reported once", async () => {
  const w = setup();
  await w.prs.tick();
  // 6865 is superseded by 6866 (same issue): closed with a note and its branch deleted.
  assert.ok(w.writes.some((x) => /issues\/6865\/comments .*Closing as superseded: #6866 is merged/.test(x)));
  assert.ok(w.writes.includes(`-X PATCH repos/${REPO}/pulls/6865 -f state=closed`));
  assert.ok(w.writes.includes(`-X DELETE repos/${REPO}/git/refs/heads/fix/keir-v2re46`));
  // Missing Conflict of interest section on Keir's own PRs: repaired (three per pass), and the check re-run.
  const repaired = w.writes.filter((x) => /-X PATCH .*pulls\/(\d+) -f body=.*## Conflict of interest/s.test(x));
  assert.equal(repaired.length, 3);
  // Green, no live task: one ask each, budget two per pass. 6976 has a live task and is left to it.
  assert.deepEqual(asked(w), [6725, 6781]);
  // Red verify and conflict: one plain line each.
  assert.deepEqual(notices(w).sort(), ["pr-blocked:6853:verify:h6853", "pr-blocked:6887:conflict:h6887"]);
  assert.match(w.data.outbox["pr-blocked:6853:verify:h6853"].content, /PR #6853 \(feat: frame party and government leadership portraits\) is blocked: the build and test check failed\. No Keir task is working on it\. Keir will close it on 2026-11-26/);
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
  assert.deepEqual(asked(w), [6725, 6781, 6784, 6791, 6798, 6799, 6878]);
  assert.equal(notices(w).length, 2);
  assert.equal(w.writes.filter((x) => /state=closed/.test(x)).length, 1);
});

test("after the stale period an unanswered or blocked orphan is closed with a note; a foreign commit keeps it open", async () => {
  const commits = { 6887: [keirCommit("a"), { sha: "b", commit: { author: { email: "dev@example.com" }, committer: { email: "dev@example.com" }, message: "rebase" }, parents: [{}] }] };
  const w = setup({ commits });
  await w.prs.tick();
  // The ask tasks ended without an answer (their action expired); the PRs are orphaned again.
  for (const j of Object.values(w.data.jobs)) if (j.adoptedPr) j.state = "done";
  w.advance(5 * DAY + 3600000);
  await w.prs.tick();
  assert.ok(w.writes.some((x) => /issues\/6853\/comments .*Closing as stale: the build and test check failed/.test(x)));
  assert.ok(w.writes.includes(`-X PATCH repos/${REPO}/pulls/6853 -f state=closed`));
  assert.ok(w.writes.some((x) => /issues\/6725\/comments .*Closing as stale: this change was put to the owner/.test(x)));
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
