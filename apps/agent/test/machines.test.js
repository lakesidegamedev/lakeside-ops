"use strict";
delete process.env.KEIR_STATE_TRACE; // this file makes unlisted moves on purpose; keep them out of states:observed
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { MACHINES, allowed, track, describe, actionStanding, isTerminal } = require("../lib/operator/machines");
const { createLedger } = require("../lib/operator/store");

const tmpLedger = () => createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keir-machines-")), "ledger.json"));

test("every transition names declared states", () => {
  for (const [name, m] of Object.entries(MACHINES)) {
    for (const s of m.terminal) assert.ok(m.states[s], `${name}: terminal ${s}`);
    for (const [from, tos] of Object.entries(m.transitions)) for (const s of [from, ...tos]) assert.ok(m.states[s], `${name}: ${from} -> ${s}`);
    assert.deepEqual(Object.keys(m.transitions).sort(), Object.keys(m.states).sort(), `${name}: every state has a row`);
  }
});

test("the job rules that matter are pinned", () => {
  assert.ok(allowed("job", "queued", "running"));
  assert.ok(!allowed("job", "paused", "running"), "a paused job never starts without a resume");
  assert.ok(!allowed("job", "done", "running"), "a finished job never starts without being reopened");
  assert.ok(allowed("job", "done", "queued") && allowed("job", "cancelled", "queued"));
  assert.ok(!allowed("job", "queued", "finished"));
  assert.ok(!allowed("action", "done", "approved") && !allowed("action", "executing", "approved"));
});

test("track sees a plain assignment, stamps it, and reports an unlisted move once without refusing it", () => {
  const seen = [], job = { id: "j1", state: "paused", ticket: 7 };
  track(job, "job", (machine, record, from, to) => seen.push([machine, record.id, from, to]), () => 1234);
  assert.deepEqual(Object.keys(job), ["id", "state", "ticket"]);
  job.state = "queued";
  assert.deepEqual([job.state, job.statePrev, job.stateAt, seen.length], ["queued", "paused", 1234, 0]);
  job.state = "paused"; job.state = "running"; job.state = "paused"; job.state = "running";
  assert.equal(job.state, "running");
  assert.deepEqual(seen, [["job", "j1", "paused", "running"]]);
  assert.equal(JSON.parse(JSON.stringify(job)).state, "running");
  assert.equal({ ...job }.state, "running");
});

test("the ledger tracks jobs it creates, records added by other modules, and records loaded from disk", () => {
  const ledger = tmpLedger();
  const job = ledger.createJob("k", { kind: "ticket", ticket: 9 });
  ledger.data.actions.a1 = { id: "a1", jobId: job.id, state: "done" };
  ledger.save();
  job.state = "done"; job.state = "running";
  ledger.data.actions.a1.state = "approved";
  const rows = ledger.data.audit.filter((r) => r.kind === "unexpected_transition");
  assert.deepEqual(rows.map((r) => [r.machine, r.from, r.to]), [["job", "done", "running"], ["action", "done", "approved"]]);
  assert.equal(rows[0].job, job.id); assert.equal(rows[0].ticket, 9);
});

test("restart marks an executing action failed when its effect was rejected, and leaves a real in-flight one alone", () => {
  const ledger = tmpLedger();
  const job = ledger.createJob("k", { kind: "finding" });
  job.state = "waiting";
  job.effects["action:a1"] = { state: "rejected" };
  ledger.data.actions.a1 = { id: "a1", jobId: job.id, state: "executing" };
  ledger.data.actions.a2 = { id: "a2", jobId: job.id, state: "executing" };
  ledger.recover();
  assert.equal(ledger.data.actions.a1.state, "failed");
  assert.equal(ledger.data.actions.a2.state, "executing");
});

test("actionStanding reads through a stale stored state", () => {
  const now = 1000, live = { state: "waiting" };
  assert.equal(actionStanding({ state: "approved", expiresAt: 2000 }, live, now), "approved");
  assert.equal(actionStanding({ state: "approved", expiresAt: 500 }, live, now), "expired");
  assert.equal(actionStanding({ state: "pending", expiresAt: 2000 }, { state: "done" }, now), "orphaned");
  assert.equal(actionStanding({ state: "approved", expiresAt: 2000 }, undefined, now), "orphaned");
  assert.equal(actionStanding({ state: "executing", expiresAt: 2000 }, undefined, now), "stuck");
  assert.equal(actionStanding({ state: "executing", expiresAt: 2000 }, { state: "running" }, now), "executing");
  assert.equal(actionStanding({ state: "done", expiresAt: 500 }, undefined, now), "done");
});

test("describe answers where, since when and what next", () => {
  const d = describe("job", { state: "paused", stateAt: 5, statePrev: "running" });
  assert.deepEqual([d.state, d.since, d.previous, d.terminal], ["paused", 5, "running", false]);
  assert.ok(d.next.includes("queued") && !d.next.includes("running"));
  assert.ok(isTerminal("job", "dismissed"));
});

// Guard: a job or action state written anywhere in the operator must be declared.
test("no source file assigns an undeclared job or action state", () => {
  const root = path.join(__dirname, ".."), files = [path.join(root, "operator.js")];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") && files.push(path.join(dir, e.name)); };
  walk(path.join(root, "lib"));
  const receivers = { job: /\b(?:job|j|child|parent|root|dupJob|ticketJob|victim)\.state\s*=\s*"([a-z_]+)"/g, action: /\baction\.state\s*=\s*"([a-z_]+)"/g };
  const bad = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const [machine, re] of Object.entries(receivers)) for (const m of text.matchAll(re)) if (!MACHINES[machine].states[m[1]]) bad.push(`${path.relative(root, file)}: ${machine} "${m[1]}"`);
  }
  assert.deepEqual(bad, []);
});
