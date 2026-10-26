"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");

const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-issues-search-")); dirs.push(dir);
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444",
    scanChannels: ["555555555555555555"], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {} };
  const calls = [];
  const broker = createBroker({ ledger, config, mcp: { servers: () => [], list: async () => [], call: async () => ({}) }, discord: async () => [],
    sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => 5000,
    exec: async (_bin, args) => {
      calls.push(args.join(" "));
      return JSON.stringify({ total_count: 1, incomplete_results: false,
        items: [{ number: 42, title: "Promote development to staging", state: "open", html_url: "https://github.com/lakesidegamedev/AHDGame/pull/42", pull_request: { url: "https://api.github.com/x" }, assignees: [] }] });
    } });
  return { dir, ledger, config, broker, calls };
}
function running(f) { const j = f.ledger.createJob("fixture", { role: "owner", kind: "command", source: {}, deadline: 9999999999999 }); j.state = "running"; return j; }

// Self-review 2026-10-26: the broker refused a pull request search twelve times
// across seven tasks. The guard treated every is: and type: qualifier as a
// repository override, so the model could not find the open promotion PR it was
// asked to watch, and the refusal never said which word to remove.
test("github issues search accepts the pull request shapes the model actually sends", async () => {
  const f = fixture(), j = running(f), out = [];
  for (const query of ["is:pr is:open promote in:title", "is:open slow page load in:title", "state:open promote in:title"]) {
    out.push(await f.broker.tool(j, "github", { action: "issues", query }));
  }
  assert.equal(out.length, 3);
  for (const result of out) {
    assert.equal(result.total, 1);
    assert.equal(result.issues[0].number, 42);
    assert.equal(result.issues[0].pullRequest, true, "a pull request hit is labelled so it is not closed as an issue");
  }
  const asked = f.calls.map((c) => decodeURIComponent(c));
  for (const q of asked) assert.match(q, /repo:lakesidegamedev\/AHDGame/, "every search stays in this task's repository");
  assert.ok(!/is:issue/.test(asked[0]), "a request for pull requests must not also demand issues");
  assert.match(asked[2], /is:issue/, "a plain issue search stays bounded to issues");
});

test("github issues search still refuses a repository override and names the exact fix", async () => {
  const f = fixture(), j = running(f);
  await assert.rejects(f.broker.tool(j, "github", { action: "issues", query: "repo:someone-else/their-repo 1234 in:title" }),
    (e) => /remove repo:, org: or user:/.test(e.message) && /scoped to this task's repository/.test(e.message));
  assert.equal(f.calls.length, 0, "a refused query never reaches GitHub");
});
