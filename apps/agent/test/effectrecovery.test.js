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

// Keir 8: uncertain public writes are settled from the source of truth.
const W = 10 * SETTLE_MS;
function writeWorld(effect, { ticket = null, search = null, list = null, state = "blocked" } = {}) {
  const key = "k1", audits = [], calls = [];
  const job = { id: "j", state, effects: { [key]: { state: "started", at: W - SETTLE_MS - 1, error: "The operation was aborted due to timeout", ...effect } } };
  const ledger = { data: { jobs: { j: job } }, audit: (k, v) => audits.push([k, v]), save() {} };
  const mcp = { call: async (s, tool, args, write) => { calls.push([tool, write]);
    if (tool === "support_get") { if (ticket instanceof Error) throw ticket; return typeof ticket === "function" ? ticket(args) : ticket; }
    if (tool === "support_search") { if (search instanceof Error) throw search; return search; }
    throw new Error("unexpected " + tool); } };
  const api = async () => { if (list instanceof Error) throw list; return list; };
  return { job, key, audits, calls, r: createEffectRecovery({ ledger, api, mcp, now: () => W }) };
}
const reply = { settle: { kind: "reply", ticket: 77, text: "The page works again." } };
const posted = { kind: "progress", message: "The page works again.", delivery: { status: "posted", messageId: "9" } };

test("a reply that is on the ticket with a posted delivery settles as done and the task resumes", async () => {
  const w = writeWorld(reply, { ticket: { publicUpdates: [posted] } });
  await w.r.tick();
  assert.equal(w.job.effects[w.key].state, "done");
  assert.equal(w.job.effects[w.key].result.delivery.status, "posted");
  assert.equal(w.job.state, "queued");
  assert.deepEqual(w.calls, [["support_get", false]], "a read, never a write");
  assert.deepEqual(w.audits.map(([k, v]) => [k, v.outcome]), [["effect_reconciled", "posted"]]);
});

test("a reply provably absent from a readable ticket is safe to retry; other updates do not count", async () => {
  const w = writeWorld(reply, { ticket: { publicUpdates: [{ kind: "progress", message: "Something else entirely.", delivery: { status: "posted" } }] } });
  await w.r.tick();
  assert.equal(w.job.effects[w.key].state, "rejected"); assert.equal(w.job.effects[w.key].retryable, true);
  assert.equal(w.audits[0][1].outcome, "not-posted");
});

test("a reply is never settled on a guess: similar text, unposted delivery, unreadable ticket, young receipt, running task", async () => {
  const held = async (effect, opts, reason, run) => {
    const w = writeWorld(effect, opts); if (run) w.r = createEffectRecovery({ ledger: { data: { jobs: { j: w.job } }, audit: (k, v) => w.audits.push([k, v]), save() {} }, api: async () => [], mcp: { call: async () => ({}) }, now: () => W, running: () => true });
    await w.r.tick();
    assert.equal(w.job.effects[w.key].state, "started", reason);
    return w;
  };
  const a = await held(reply, { ticket: { publicUpdates: [{ kind: "progress", message: "The page works again, please refresh.", delivery: { status: "posted" } }] } }, "similar");
  assert.match(a.audits[0][1].reason, /similar/);
  const b = await held(reply, { ticket: { publicUpdates: [{ ...posted, delivery: { status: "failed" } }] } }, "failed delivery");
  assert.match(b.audits[0][1].reason, /delivery is failed/);
  await held(reply, { ticket: new Error("503") }, "read failed");
  await held(reply, { ticket: { status: "open" } }, "no update list");
  await held(reply, { ticket: null }, "empty read");
  await held({ ...reply, at: W - 1000 }, { ticket: { publicUpdates: [] } }, "young");
  await held(reply, { ticket: { publicUpdates: [] } }, "running", true);
});

test("a held receipt is explained once, not on every pass", async () => {
  const w = writeWorld(reply, { ticket: { publicUpdates: [{ ...posted, delivery: { status: "failed" } }] } });
  await w.r.tick(); await w.r.tick(); await w.r.tick();
  assert.equal(w.audits.filter(([k]) => k === "effect_settle_held").length, 1);
  assert.equal(w.job.state, "blocked");
});

const issue = { settle: { kind: "issue", repo: "AHDGame", marker: "<!-- keir:issue:abc -->" } };
const iso = (ms) => new Date(ms).toISOString();
test("an issue found by its marker settles as done with the issue as the result", async () => {
  const w = writeWorld(issue, { list: [{ number: 9, html_url: "u", body: "text\n\n<!-- keir:issue:abc -->", created_at: iso(W - 1000) }, { number: 8, body: "x", created_at: iso(0) }] });
  await w.r.tick();
  assert.equal(w.job.effects[w.key].state, "done"); assert.equal(w.job.effects[w.key].result.number, 9);
  assert.equal(w.audits[0][1].outcome, "filed");
});
test("an issue absent from a list that reaches back past the write is safe to retry; a short list is held", async () => {
  const old = writeWorld(issue, { list: [{ number: 8, body: "x", created_at: iso(0) }] });
  await old.r.tick();
  assert.equal(old.job.effects[old.key].state, "rejected"); assert.equal(old.job.effects[old.key].retryable, true);
  const short = writeWorld(issue, { list: [{ number: 8, body: "x", created_at: iso(W - 1000) }] });
  await short.r.tick();
  assert.equal(short.job.effects[short.key].state, "started");
  assert.match(short.audits[0][1].reason, /reach back/);
  const pr = writeWorld(issue, { list: [{ number: 7, pull_request: {}, body: "<!-- keir:issue:abc -->", created_at: iso(W - 1000) }, { number: 8, body: "x", created_at: iso(0) }] });
  await pr.r.tick();
  assert.equal(pr.job.effects[pr.key].state, "rejected", "a pull request carrying the marker is not the issue");
  const failed = writeWorld(issue, { list: new Error("502") });
  await failed.r.tick();
  assert.equal(failed.job.effects[failed.key].state, "started");
});

const created = { settle: { kind: "ticket", marker: "Request message: 555", needsChannel: false } };
test("a created ticket is found by its marker and settles; no hit stays held because search lags", async () => {
  const found = writeWorld(created, { search: { results: [{ number: 1801 }, { number: 1802 }] }, ticket: ({ number }) => ({ description: number === 1802 ? "Turn stalled\n\nRequest message: 555" : "other", discordChannelId: "c9" }) });
  await found.r.tick();
  assert.equal(found.job.effects[found.key].state, "done"); assert.equal(found.job.effects[found.key].result.ticketNumber, 1802);
  assert.ok(found.calls.every(([, write]) => write === false));
  const none = writeWorld(created, { search: { results: [] } });
  await none.r.tick();
  assert.equal(none.job.effects[none.key].state, "started");
  assert.match(none.audits[0][1].reason, /not proof of absence/);
  const nochan = writeWorld({ settle: { ...created.settle, needsChannel: true } }, { search: { results: [{ number: 5 }] }, ticket: { description: "Request message: 555" } });
  await nochan.r.tick();
  assert.equal(nochan.job.effects[nochan.key].state, "started");
});

test("receipts with no descriptor and unknown kinds are untouched", async () => {
  const w = writeWorld({ settle: { kind: "mystery" } }, { ticket: { publicUpdates: [] } });
  await w.r.tick();
  assert.equal(w.job.effects[w.key].state, "started");
  const plain = writeWorld({}, { ticket: { publicUpdates: [] } });
  await plain.r.tick();
  assert.equal(plain.job.effects[plain.key].state, "started"); assert.equal(plain.calls.length, 0);
});
