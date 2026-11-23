"use strict";
// Keir 11.1.1 regression: a first ticket reply whose provider process started
// and then produced nothing until the lane deadline (2026-11-20). Drives the
// scheduler slot, the real agent and the real CLI runtime against a provider
// that hangs silently, then the same lifecycle rule operator.js applies.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { createAgent } = require("../lib/operator/agent");
const { startActivation } = require("../lib/operator/activationslot");
const lifecycle = require("../lib/operator/lifecycle");

const OWNER = "100000000000000001", BOT = "100000000000000002", PLAYER = "100000000000000003", CHANNEL = "100000000000000004";

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-deadline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: OWNER, staffIds: [], botId: BOT, guildId: "100000000000000005", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000,
    maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const posts = [];
  const mcp = { servers: () => ["support", "gamestate"], list: async () => [], call: async (server, tool, args) => { posts.push([server, tool, args]); return { ok: true }; } };
  const discord = async () => [];
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: { run: async () => ({ code: 0, output: "" }) } });
  const pids = [];
  // The provider starts, writes nothing and never exits: what the OpenCode worker did after its session lookup.
  const spawnImpl = (cmd, args, opts) => { const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { ...opts, env: { PATH: process.env.PATH } }); pids.push(child.pid); return child; };
  t.after(() => pids.forEach((pid) => { try { process.kill(pid, "SIGKILL"); } catch {} }));
  const agent = createAgent({ ledger, broker, spawnImpl,
    config: { briefFile: path.join(__dirname, "../KEIR.md"), model: "claude-opus-5-5", maxRounds: 2, maxTurnMs: 60000, stateDir: dir, orientation: false } });
  const job = ledger.createJob("ticket:4242", { kind: "ticket", role: "support", ticket: 4242, channelId: CHANNEL, replyChannel: CHANNEL, deadline: Date.now() + 86400000,
    source: { channelId: CHANNEL, channelName: "ticket-mechanics-fixture-4242", authorId: PLAYER, content: "New ticket intake; read support_get and ticket_history before acting.", at: new Date().toISOString() } });
  ledger.save();
  const holds = { claimed: false, staff: false };
  // The settle rule operator.js drain() passes, with this world's holds.
  const settle = (e, info) => {
    const out = lifecycle.onRunError(job, e, { now: Date.now(), ...info, stopping: false, paused: ledger.data.paused,
      supportDeferred: () => false, staffHeld: () => holds.staff, claimedBy: () => holds.claimed ? "staff" : null,
      pauseFor: () => null, staffActiveUntil: () => 0, redact: (s) => s });
    if (out) { lifecycle.applyEffects(ledger, out.effects); ledger.save(); }
  };
  const activate = (timeoutMs, active = {}) => { job.state = "running"; return { active, ...startActivation({ lane: "investigation", job, active, timeoutMs, run: (signal) => agent.run(job, signal), settle }) }; };
  const alive = (pid) => { try { return !/[ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0]); } catch { return false; } };
  return { ledger, job, posts, pids, holds, activate, alive };
}
const audits = (w, kind) => w.ledger.data.audit.filter((a) => a.kind === kind && a.job === w.job.id);
const ownerNotices = (w) => [...Object.values(w.ledger.data.outbox), ...(w.ledger.data.alerts || [])].filter((x) => String(x.key || "").startsWith(`error:${w.job.id}`));
const channelPosts = (w) => Object.values(w.ledger.data.outbox).filter((x) => x.destination === `channel:${w.job.id}`);

test("a ticket run that hangs silently until its lane deadline retries once, then blocks; nothing is posted twice", { timeout: 60000 }, async (t) => {
  const w = world(t);
  const first = w.activate(10000); // 10s: the agent must reach spawn before the deadline on a loaded host
  await first.done;
  assert.ok(w.pids.length >= 1, "the provider process was launched");
  assert.ok(w.pids.every((pid) => !w.alive(pid)), "the hung provider is killed");
  assert.equal(first.active.investigation, null, "the lane is released");
  assert.equal(w.job.state, "waiting", w.job.summary);
  assert.equal(w.job.deadlineRetries, 1);
  assert.ok(w.job.wakeAt > Date.now() && w.job.wakeAt <= Date.now() + 60000);
  assert.equal(audits(w, "deadline_retry").length, 1);
  assert.equal(ownerNotices(w).length, 0);
  assert.equal(channelPosts(w).length, 0);
  assert.equal(w.posts.filter(([, tool]) => /public_update|resolve|set_status/.test(tool)).length, 0);

  // The retry hangs the same way: blocked, the owner is told, no loop.
  const second = w.activate(10000);
  await second.done;
  assert.equal(w.job.state, "blocked");
  assert.match(w.job.summary, /turn limit/);
  assert.equal(w.job.deadlineRetries, 1);
  assert.equal(audits(w, "deadline_retry").length, 1);
  assert.equal(ownerNotices(w).length, 1);
  assert.equal(channelPosts(w).length, 0);
});

test("a staff claim that aborts the run before its deadline takes the hold, not a deadline retry", { timeout: 60000 }, async (t) => {
  const w = world(t);
  const run = w.activate(30000);
  while (!w.pids.length) await new Promise((r) => setTimeout(r, 25));
  w.holds.claimed = true; run.slot.controller.abort();
  await run.done;
  assert.equal(run.slot.timedOut, false);
  assert.equal(w.job.state, "waiting");
  assert.equal(w.job.deadlineRetries, undefined);
  assert.equal(audits(w, "deadline_retry").length, 0);
});

test("a ticket the owner stopped while it ran is never revived by its deadline", { timeout: 60000 }, async (t) => {
  const w = world(t);
  const run = w.activate(3000);
  while (!w.pids.length) await new Promise((r) => setTimeout(r, 25));
  w.job.state = "cancelled";
  await run.done;
  assert.equal(w.job.state, "cancelled");
  assert.equal(w.job.deadlineRetries, undefined);
  assert.equal(audits(w, "deadline_retry").length, 0);
});
