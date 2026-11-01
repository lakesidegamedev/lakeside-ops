"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEffectRecovery, SETTLE_MS } = require("../lib/operator/effectrecovery");
const HEAD = "d9bbd7f1a2bc0eecf6f03e3e9893ef71976942e3";
const NOW = 10 * SETTLE_MS;

function world(job, prs, running = () => false) {
  const audits = [];
  const ledger = { data: { jobs: { [job.id]: job } }, audit: (k, v) => audits.push([k, v]), save() {} };
  const api = async (endpoint) => { const pr = prs[endpoint]; if (!pr) throw new Error("404"); return pr; };
  return { r: createEffectRecovery({ ledger, api, now: () => NOW, running }), audits };
}
const key = `merge:4281:${HEAD}`;

test("a merge GitHub completed settles as done and the held task resumes", async () => {
  const job = { id: "j", state: "blocked", effects: { [key]: { state: "started", at: 0, error: "gh: Merge already in progress (HTTP 405)" } } };
  const w = world(job, { "repos/lakesidegamedev/AHDGame/pulls/4281": { merged: true, state: "closed", head: { sha: HEAD }, merge_commit_sha: "abc" } });
  await w.r.tick();
  assert.equal(job.effects[key].state, "done");
  assert.equal(job.effects[key].result.reconciled, true);
  assert.equal(job.state, "queued");
  assert.match(job.inbox.at(-1).content, /do not repeat a merge/);
  assert.equal(w.audits[0][1].outcome, "merged");
});

test("an open PR at the same head was not merged and may be retried", async () => {
  const job = { id: "j", state: "waiting", effects: { [key]: { state: "started", at: 0 } } };
  const w = world(job, { "repos/lakesidegamedev/AHDGame/pulls/4281": { merged: false, state: "open", head: { sha: HEAD } } });
  await w.r.tick();
  assert.equal(job.effects[key].state, "rejected");
  assert.equal(job.state, "waiting");
});

test("a moved head, a fresh write or a running task stays held", async () => {
  const moved = { id: "j", state: "blocked", effects: { [key]: { state: "started", at: 0 } } };
  await world(moved, { "repos/lakesidegamedev/AHDGame/pulls/4281": { merged: true, head: { sha: "f".repeat(40) } } }).r.tick();
  assert.equal(moved.effects[key].state, "started"); assert.equal(moved.state, "blocked");
  const fresh = { id: "j", state: "blocked", effects: { [key]: { state: "started", at: NOW - 1000 } } };
  await world(fresh, { "repos/lakesidegamedev/AHDGame/pulls/4281": { merged: true, head: { sha: HEAD } } }).r.tick();
  assert.equal(fresh.effects[key].state, "started");
  const live = { id: "j", state: "running", effects: { [key]: { state: "started", at: 0 } } };
  await world(live, { "repos/lakesidegamedev/AHDGame/pulls/4281": { merged: true, head: { sha: HEAD } } }, () => true).r.tick();
  assert.equal(live.effects[key].state, "started");
});

test("non-merge uncertain writes are never touched", async () => {
  const job = { id: "j", state: "blocked", effects: { "ticket-update:x": { state: "started", at: 0 } } };
  await world(job, {}).r.tick();
  assert.equal(job.effects["ticket-update:x"].state, "started"); assert.equal(job.state, "blocked");
});

test("the right repository is found by the PR's exact head", async () => {
  const job = { id: "j", state: "blocked", effects: { [key]: { state: "started", at: 0 } } };
  const w = world(job, { "repos/lakesidegamedev/AHDGame/pulls/4281": { merged: false, state: "open", head: { sha: "e".repeat(40) } },
    "repos/lakesidegamedev/AHDClient/pulls/4281": { merged: true, head: { sha: HEAD }, merge_commit_sha: "c" } });
  await w.r.tick();
  assert.equal(job.effects[key].state, "done");
});

// Keir 7.0.3 (ticket 1730): a payment that landed before its call timed out.
function paymentWorld(owed) {
  const NOW = 10 * 3600000, calls = [];
  const spec = { kind: "compensation", env: "prod", description: "Pay Umbrella", credits: [{ corporationId: "6ae333795a095b0d9e2bb581", amountLocal: 1306621 }], expectedMax: 1306621 };
  const data = { jobs: { j: { id: "j", kind: "ticket", ticket: 1730, state: "blocked", effects: { "action:a1": { state: "started", at: NOW - SETTLE_MS - 1, error: "The operation was aborted due to timeout" } } } },
    actions: { a1: { id: "a1", jobId: "j", kind: "heal", state: "executing", args: { spec, affected: 1 } } } };
  const audits = [];
  const ledger = { data, save() {}, audit(k, v) { audits.push([k, v]); } };
  const mcp = { call: async (server, name, args, write) => { calls.push({ name, write }); return owed === null ? null : { ok: true, plan: { affected: owed } }; } };
  return { data, calls, audits, r: createEffectRecovery({ ledger, api: async () => null, mcp, now: () => NOW }) };
}

test("a payment that landed is settled from a dry run and the task resumes without asking anyone", async () => {
  const w = paymentWorld(0);
  await w.r.tick();
  assert.equal(w.data.jobs.j.effects["action:a1"].state, "done");
  assert.equal(w.data.actions.a1.state, "done");
  assert.equal(w.data.jobs.j.state, "queued");
  assert.deepEqual(w.calls.map(c => [c.name, c.write]), [["heal_compensate_plan", false]], "only a dry run, never an apply");
  assert.ok(w.audits.some(([k, v]) => k === "effect_reconciled" && v.outcome === "paid"));
});

test("a payment that did not land is released for a later approved call, and an unclear answer stays held", async () => {
  const notPaid = paymentWorld(1);
  await notPaid.r.tick();
  assert.equal(notPaid.data.jobs.j.effects["action:a1"].state, "rejected");
  const unclear = paymentWorld(null);
  await unclear.r.tick();
  assert.equal(unclear.data.jobs.j.effects["action:a1"].state, "started");
  assert.equal(unclear.data.jobs.j.state, "blocked");
});

test("a refused dry run never counts as paid", async () => {
  const w = paymentWorld(0);
  w.data.jobs.j.effects["action:a1"].at = 10 * 3600000 - SETTLE_MS - 1;
  const refused = paymentWorld(0);
  refused.r = createEffectRecovery({ ledger: { data: refused.data, save() {}, audit() {} }, api: async () => null, mcp: { call: async () => ({ ok: false, error: "turn in flight" }) }, now: () => 10 * 3600000 });
  await refused.r.tick();
  assert.equal(refused.data.jobs.j.effects["action:a1"].state, "started");
});
