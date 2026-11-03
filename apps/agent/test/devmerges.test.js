"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createDevMerges } = require("../lib/operator/devmerges");

function setup({ prs, ask = async () => null, compare = () => "behind" }) {
  const data = { jobs: {}, seen: {}, audit: [] };
  const ledger = { data, save() {}, audit: (kind, d) => data.audit.push({ kind, ...d }) };
  const ticket = (n, extra = {}) => (data.jobs[`j${n}`] = { id: `j${n}`, kind: "ticket", ticket: n, state: "waiting", wakeAt: 9e15, evidenceText: `report ${n}`, summary: "", ...extra });
  const api = async ([route]) => route.includes("/pulls?") ? prs : { status: compare(route) };
  return { data, ticket, dm: createDevMerges({ ledger, api, ask, now: () => Date.parse("2026-10-14T18:00:00Z") }) };
}
const pr = (n, title, extra = {}) => ({ number: n, title, body: "", merged_at: "2026-10-14T17:50:00Z", merge_commit_sha: `sha${n}`, head: { ref: `fix/${n}` }, user: { login: "arle-bina" }, ...extra });

test("a merged developer change that names an open ticket tells that ticket, then each stage", async () => {
  let stage = "behind";
  const s = setup({ prs: [pr(10, "fix(funds): spread bond picks (ticket 1545)")], compare: (r) => (r.endsWith("...staging") && stage !== "behind" ? "ahead" : "behind") });
  const t = s.ticket(1545), other = s.ticket(1553);
  await s.dm.tick();
  assert.equal(t.state, "queued"); assert.match(t.inbox[0].content, /PR #10 by arle-bina.*names this ticket.*in testing on dev/);
  assert.equal(other.inbox, undefined, "an unnamed ticket is not woken without a match");
  t.state = "waiting"; stage = "staging";
  await s.dm.tick();
  assert.match(t.inbox.at(-1).content, /now on the sandbox/);
  await s.dm.tick();
  assert.equal(t.inbox.length, 2, "a stage is reported once");
});

test("an unnamed change links only where Jev judges it the same problem; Keir's own, promote and bot PRs are skipped", async () => {
  const asked = [];
  const ask = async (spec) => { asked.push(spec); return { answers: { t1522: { noul: 0.78 }, t1552: { noul: 0.21 } } }; };
  const s = setup({ ask, prs: [pr(11, "feat: cross-state supply for wholly owned subsidiaries"), pr(12, "promote", { head: { ref: "development" } }), pr(13, "bump", { user: { login: "dependabot[bot]" } }), pr(14, "keir fix")] });
  const a = s.ticket(1522), b = s.ticket(1552, { pullRequests: ["https://github.com/lakesidegamedev/AHDGame/pull/14"] });
  await s.dm.tick();
  assert.equal(asked.length, 1, "one Jev call, for the developer PR only");
  assert.match(a.inbox[0].content, /looks related.*check before saying so/);
  assert.equal(b.inbox, undefined);
  assert.deepEqual(Object.keys(s.data.devMerges.links), ["11"]);
});

test("a change merged before the watermark is not reported again after a restart", async () => {
  const s = setup({ prs: [pr(15, "fix (ticket 1545)", { merged_at: "2026-10-14T16:00:00Z" })] });
  s.data.devMerges = { since: "2026-10-14T17:00:00Z", links: {} };
  const t = s.ticket(1545);
  await s.dm.tick();
  assert.equal(t.inbox, undefined);
});

test("a named merge leaves the release receipt its message relies on; an unnamed one leaves none (KBX5)", async () => {
  let stage = "behind";
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const s = setup({ prs: [pr(16, "fix: budget page (ticket 1560)", { merge_commit_sha: sha })], compare: (r) => (r.endsWith("...staging") && stage !== "behind" ? "ahead" : "behind") });
  const t = s.ticket(1560);
  await s.dm.tick();
  assert.deepEqual({ development: t.releaseEvidence["0123456789"].development, staging: t.releaseEvidence["0123456789"].staging, main: t.releaseEvidence["0123456789"].main }, { development: true, staging: false, main: false });
  t.state = "waiting"; stage = "staging";
  await s.dm.tick();
  assert.equal(t.releaseEvidence["0123456789"].staging, true, "the stage move updates the receipt");
  assert.equal(t.releaseEvidence["0123456789"].main, false);

  const ask = async () => ({ answers: { t1561: { noul: 0.8 } } });
  const u = setup({ ask, prs: [pr(17, "feat: related change", { merge_commit_sha: sha })] });
  const j = u.ticket(1561);
  await u.dm.tick();
  assert.match(j.inbox[0].content, /looks related/);
  assert.equal(j.releaseEvidence, undefined, "an unnamed change is not a receipt for this ticket");
});
