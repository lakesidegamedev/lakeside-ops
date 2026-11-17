"use strict";
// Keir 10.1.9 (owner, 2026-11-17): PR 6680 was found on a public-page watch, opened by Keir with green checks, and then
// raised as a plain-text "Needs a person" DM. A merge Keir has no standing authority for is an Approve / Decline question.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { createDecisions } = require("../lib/operator/decisions");

const OWNER = "111111111111111111";
const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function fixture({ conclusion = "success", head = "a".repeat(40), files = ["src/app/corporations/page.tsx"] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-1019-")); dirs.push(dir);
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: OWNER, staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [],
    taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const state = { head, merged: false, merges: [] };
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args);
    const route = args.find((a) => /^repos\//.test(a)) || "";
    const out = (v) => JSON.stringify(v);
    if (/pulls\/6680\/files/.test(route)) return out(files.map((filename) => ({ filename, patch: "" })));
    if (/pulls\/6680\/merge/.test(route)) { state.merged = true; state.merges.push(args); return out({ merged: true, sha: "m".repeat(40) }); }
    if (/pulls\/6680$/.test(route)) return out({ number: 6680, state: "open", merged: state.merged, title: "Make the corporations page redirect in one step", body: "One redirect instead of two.", html_url: "https://github.com/lakesidegamedev/AHDGame/pull/6680", head: { sha: state.head }, base: { ref: "development", sha: "b".repeat(40) }, mergeable: true, mergeable_state: "clean", user: { login: "x" } });
    if (/check-runs/.test(route)) return out({ check_runs: [{ name: "verify", status: "completed", conclusion }, { name: "custom-rules", status: "completed", conclusion }, { name: "dependency-review", status: "completed", conclusion }] });
    return out({});
  };
  const mcp = { servers: () => [], list: async () => [], call: async (server, tool) => tool === "kanban_list" ? [] : tool === "kanban_add" ? { id: 900 } : {} };
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox: {}, now: () => 1_800_000_000_000, exec });
  // A watch task that opened 6680.
  const job = ledger.createJob("finding:watch", { kind: "finding", role: "support", repository: "AHDGame", deadline: 9e15, source: {}, pullRequests: ["https://github.com/lakesidegamedev/AHDGame/pull/6680"] });
  job.state = "running";
  return { ledger, broker, job, calls, state, config };
}
const explanation = (head) => ({ reviewedHead: head, change: "The corporations page now sends visitors to the right place in one step instead of two.", impact: "Visitors reach the page a little faster; nothing else changes for players.", risk: "Low: it only changes where one old web address leads." });

test("a green watch PR with no merge authority asks the owner with buttons and merges on approve", async () => {
  const f = fixture();
  const head = "a".repeat(40);
  const first = await f.broker.tool(f.job, "github", { action: "merge", number: 6680 });
  assert.equal(first.needsExplanation, true, "plain-language explanation is required first");
  assert.equal(first.reviewedHead, head);
  const asked = await f.broker.tool(f.job, "github", { action: "merge", number: 6680, explanation: explanation(head) });
  assert.equal(asked.approvalRequired, true);
  assert.equal(asked.state, "pending");
  assert.equal(f.state.merges.length, 0, "nothing merged before the owner answers");
  const decision = Object.values(f.ledger.data.decisions).find((x) => x.actionId === asked.action);
  assert.ok(decision, "an owner decision with buttons exists");
  const action = f.ledger.data.actions[asked.action];
  assert.equal(action.args.head, head);
  assert.equal(action.args.number, 6680);
  decision.sent = { [OWNER]: { channelId: "dm", messageId: "900000000000000001" } };
  createDecisions({ ledger: f.ledger, config: f.config, discord: async () => null, now: () => 1_800_000_000_000 }).apply(decision, "approve", OWNER);
  assert.equal(f.ledger.data.actions[asked.action].state, "approved");
  assert.equal(f.job.state, "queued", "the approval wakes the waiting task");
  f.job.state = "running";
  const done = await f.broker.tool(f.job, "github", { action: "merge", number: 6680 });
  assert.equal(done.merged, true);
  assert.equal(f.state.merges.length, 1);
  assert.ok(f.state.merges[0].includes(`sha=${head}`), "the merge is pinned to the reviewed head");
});

test("declining records the decision and leaves the PR open", async () => {
  const f = fixture();
  const head = "a".repeat(40);
  const asked = await f.broker.tool(f.job, "github", { action: "merge", number: 6680, explanation: explanation(head) });
  const decision = Object.values(f.ledger.data.decisions).find((x) => x.actionId === asked.action);
  decision.sent = { [OWNER]: { channelId: "dm", messageId: "900000000000000002" } };
  createDecisions({ ledger: f.ledger, config: f.config, discord: async () => null, now: () => 1_800_000_000_000 }).apply(decision, "reject", OWNER);
  f.job.state = "running";
  assert.notEqual(f.ledger.data.actions[asked.action].state, "approved");
  const again = await f.broker.tool(f.job, "github", { action: "merge", number: 6680 }).catch((e) => ({ error: e.message }));
  assert.notEqual(again.merged, true);
  assert.equal(f.ledger.data.actions[asked.action].state, "rejected");
  assert.equal(f.state.merges.length, 0);
});

test("an approval is pinned to the reviewed head: a later push asks again", async () => {
  const f = fixture();
  const asked = await f.broker.tool(f.job, "github", { action: "merge", number: 6680, explanation: explanation("a".repeat(40)) });
  const decision = Object.values(f.ledger.data.decisions).find((x) => x.actionId === asked.action);
  decision.sent = { [OWNER]: { channelId: "dm", messageId: "900000000000000003" } };
  createDecisions({ ledger: f.ledger, config: f.config, discord: async () => null, now: () => 1_800_000_000_000 }).apply(decision, "approve", OWNER);
  f.job.state = "running";
  f.state.head = "c".repeat(40);
  const again = await f.broker.tool(f.job, "github", { action: "merge", number: 6680 });
  assert.notEqual(again.merged, true);
  assert.equal(f.state.merges.length, 0);
});

test("red checks never produce an approval button", async () => {
  const f = fixture({ conclusion: "failure" });
  const out = await f.broker.tool(f.job, "github", { action: "merge", number: 6680, explanation: explanation("a".repeat(40)) });
  assert.notEqual(out.approvalRequired, true);
  assert.equal(out.merged, false);
  assert.equal(Object.keys(f.ledger.data.decisions || {}).length, 0);
  assert.equal(Object.keys(f.ledger.data.actions || {}).length, 0);
});

test("raise_to_developers cannot send a merge request for a PR Keir opened as plain text", async () => {
  const f = fixture();
  await assert.rejects(
    f.broker.tool(f.job, "raise_to_developers", { title: "PR #6680 ready for merge: single-hop corporations redirect", detail: "PR 6680 is green and ready to merge, but I have no authority to merge it. Needs the owner to approve the merge.", needsHuman: true, kind: "question" }),
    /github tool with action merge and number 6680/);
  assert.equal(Object.keys(f.ledger.data.outbox || {}).length, 0, "no plain-text DM went out");
});
