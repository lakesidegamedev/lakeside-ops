"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createOwnerWait } = require("../lib/operator/ownerwait");

function fixture({ runs, reviews = [], mergeable = true, author = "Hyawii" }) {
  const sent = [], ledger = { data: {}, notify: () => { throw new Error("no link DMs"); }, createJob: (key, fields) => { sent.push({ key, ...fields }); return fields; } };
  const api = async ([p]) => p.includes("/check-runs") ? { check_runs: runs } : p.includes("/reviews") ? reviews : /pulls\/\d+$/.test(p) ? { mergeable } : [{ number: 7, title: "Soft ceiling", html_url: "https://github.com/x/y/pull/7", head: { sha: "abc1234" }, user: { login: author } }];
  return { sent, ow: createOwnerWait({ ledger, api }) };
}
const ok = (name, extra = {}) => ({ name, status: "completed", conclusion: "success", started_at: "2026-11-03T20:00:00Z", ...extra });
const gateRed = { name: "custom-rules", status: "completed", conclusion: "failure", started_at: "2026-11-03T20:01:00Z" };

test("a PR green except the owner gate asks through the approval card once per head", async () => {
  const f = fixture({ runs: [ok("verify"), ok("dependency-review"), gateRed] });
  await f.ow.tick(); await f.ow.tick();
  assert.equal(f.sent.length, 1);
  // A Keir task that asks through the approval card, with no owner authority of its own.
  assert.equal(f.sent[0].role, "support");
  assert.equal(f.sent[0].actorId, undefined);
  assert.match(f.sent[0].source.content, /pull request 7\b[^]*abc1234[^]*github merge/);
  assert.doesNotMatch(f.sent[0].source.content, /https:\/\//);
});
test("silent while another check is red or running, on a conflict, or once approved", async () => {
  for (const f of [
    fixture({ runs: [ok("verify"), ok("dependency-review"), gateRed, { name: "build", status: "in_progress" }] }),
    fixture({ runs: [ok("verify"), ok("dependency-review"), gateRed, { name: "test", status: "completed", conclusion: "failure" }] }),
    fixture({ runs: [ok("verify"), ok("dependency-review"), gateRed], mergeable: false }),
    fixture({ runs: [ok("verify"), ok("dependency-review"), gateRed], reviews: [{ user: { login: "Egg3901" }, state: "APPROVED", commit_id: "abc1234" }] }),
    fixture({ runs: [ok("verify"), ok("dependency-review"), ok("custom-rules")] }),
    fixture({ runs: [ok("verify"), ok("dependency-review"), gateRed], author: "Egg3901" }),
  ]) { await f.ow.tick(); assert.equal(f.sent.length, 0); }
});
test("a newer passing custom-rules run replaces an older failed one", async () => {
  const f = fixture({ runs: [ok("verify"), ok("dependency-review"), gateRed, ok("custom-rules", { started_at: "2026-11-03T21:00:00Z" })] });
  await f.ow.tick(); assert.equal(f.sent.length, 0);
});
