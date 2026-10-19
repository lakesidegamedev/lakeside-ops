'use strict';
// Replay runner: production createAgent + createBroker + tool server, on a
// scenario's stubbed externals. A scripted player answers questions between
// activations through the job inbox, as the gateway would. Results keep the
// full event trace, per-activation usage and timing.
// Usage: node apps/cli/bench/replay/run.cjs --out ABS [--set dev|validation|holdout] --scenario all|id[,id] --route claude:claude-sonnet-5-5@medium[,...] [--arm full] [--repeat 5] [--concurrency 3]
require('./guard.cjs');
const fs = require('node:fs'), path = require('node:path');
const AGENT = path.resolve(__dirname, '../../../agent');
const { createAgent } = require(AGENT + '/lib/operator/agent');
const { createEnv } = require('./env.cjs');

// Production limits (/etc/keir-operator.env on 2026-10-19): 36 tool rounds, a
// 15-minute activation, coding and investigation children on cursor:auto.
const MAX_ACTIVATIONS = 6, ACTIVATION_MS = 15 * 60000, MAX_ROUNDS = 36, CHILD_ROUTE = process.env.KEIR_REPLAY_CHILD_ROUTE || 'cursor:auto@automatic';
// Arms are production configurations; only these fields differ.
const ARMS = {
  full: { leanContext: false, effectGuard: true },          // live since 2026-10-19 (KEIR_LEAN_CONTEXT=0)
  lean: { leanContext: true, effectGuard: true },           // 5.8.21 lean context (reverted)
  digest: { leanContext: 'digest', effectGuard: true },     // candidate (needs digest-mode code)
  facts: { leanContext: false, effectGuard: true, playerOnlyFacts: true }, // candidate C2: unrecorded player facts in ticket context
};

// Scenario sets: dev (diagnose and tune), validation (compare candidates), holdout
// (final promotion only; lives outside the repository, never read while tuning).
const SETS = { dev: path.join(__dirname, 'scenarios', 'dev'), validation: path.join(__dirname, 'scenarios', 'validation'), holdout: process.env.KEIR_REPLAY_HOLDOUT || '/root/misc/keir-replay-holdout' };
function scenarioIds(arg, dir) { const all = fs.readdirSync(dir).filter((f) => f.endsWith('.cjs') && !f.endsWith('.test.cjs')).map((f) => f.slice(0, -4)).sort(); return arg === 'all' ? all : arg.split(','); }
function loadScenario(dir, id) { const sc = require(path.join(dir, id + '.cjs')); return { ...sc, dir }; }
const slug = (route) => route.replace(/[^a-z0-9.-]+/gi, '_');

async function sim(setDir, scenarioId, route, armName, rep, out) {
  const key = `${scenarioId}__${slug(route)}__${armName}__r${rep}`, cell = path.join(out, key);
  if (fs.existsSync(cell + '/result.json')) return JSON.parse(fs.readFileSync(cell + '/result.json'));
  fs.rmSync(cell, { recursive: true, force: true }); fs.mkdirSync(cell, { recursive: true });
  const sc = loadScenario(setDir, scenarioId);
  const blockedBefore = require('./guard.cjs').blocked.length;
  const env = createEnv({ scenario: sc, dir: cell, configOverrides: { codingProvider: CHILD_ROUTE, investigatorProvider: CHILD_ROUTE } });
  const usageFile = path.join(cell, 'usage.jsonl');
  const config = { ...env.config, ...ARMS[armName], briefFile: path.join(AGENT, 'KEIR.md'), coreBriefFile: path.join(AGENT, 'KEIR-CORE.md'), model: route.split(':')[1]?.split('@')[0],
    workerProvider: route, quickProvider: route, visionProvider: route, maxRounds: MAX_ROUNDS, maxTurnMs: ACTIVATION_MS, codingProvider: CHILD_ROUTE, investigatorProvider: CHILD_ROUTE, quickMaxTurnMs: ACTIVATION_MS, skills: true, dynamicEffort: false,
    rustRunnerLanes: [], usageFile, tagIntake: async () => null };
  const agent = createAgent({ ledger: env.ledger, broker: env.broker, config });
  const result = { key, set: setDir, scenario: scenarioId, route, arm: armName, rep, startedAt: new Date().toISOString(), activations: [] };
  const job = env.job;
  try {
    for (let i = 0; i < MAX_ACTIVATIONS; i++) {
      job.state = 'running'; delete job.wakeAt;
      const asked = env.events.filter((e) => e.kind === 'post').length;
      const t0 = Date.now(), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ACTIVATION_MS + 60000);
      let error = null;
      try { await agent.run(job, ctl.signal); } catch (e) { error = String(e.message).slice(0, 500); } finally { clearTimeout(timer); }
      result.activations.push({ i, wallMs: Date.now() - t0, state: job.state, waitingFor: job.waitingFor || null, error, summary: String(job.summary || '').slice(0, 400) });
      // The operator's lanes run delegated children; a finished child wakes the parent (delegation.complete).
      for (let round = 0; round < 3; round++) {
        const children = Object.values(env.ledger.data.jobs).filter((c) => c.codingParent === job.id && ['queued', 'running'].includes(c.state));
        if (!children.length) break;
        for (const child of children) {
          child.state = 'running'; delete child.wakeAt;
          const c0 = Date.now(), cc = new AbortController(), ct = setTimeout(() => cc.abort(), ACTIVATION_MS + 60000);
          let cerr = null;
          try { await agent.run(child, cc.signal); } catch (e) { cerr = String(e.message).slice(0, 300); } finally { clearTimeout(ct); }
          (result.children ||= []).push({ parentActivation: i, id: child.id, investigation: Boolean(child.investigation), wallMs: Date.now() - c0, state: child.state, error: cerr });
        }
      }
      if (job.state === 'queued' && i + 1 < MAX_ACTIVATIONS) continue; // woken by a finished child
      // A scripted follow-up: the player writes again after this activation
      // whatever was asked (the gateway wakes the ticket on any new message).
      const follow = (sc.followUps || []).find((f) => f.after === i);
      if (follow && i + 1 < MAX_ACTIVATIONS) { env.playerReply(follow.text); continue; }
      if (job.state !== 'waiting') break;
      // The player answers the newest question posted this activation, if any.
      const q = env.events.slice(0).filter((e) => e.kind === 'post').slice(asked).reverse().find((e) => /\?/.test(e.text));
      if (!q) break;
      const hit = (sc.answers || []).find((a) => a.when.test(q.text));
      env.playerReply(hit ? hit.text : sc.fallbackAnswer || "I'm not sure what you mean.");
    }
  } catch (e) { result.error = String(e.stack || e).slice(0, 1500); }
  const usage = fs.existsSync(usageFile) ? fs.readFileSync(usageFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  // A provider that reports no usage (cursor) is unknown, never zero.
  const tok = (u) => { const t = u.tokens || {}, v = [t.input, t.output, t.cacheRead, t.cacheWrite]; return v.every((x) => x == null) ? null : v.reduce((n, x) => n + (x || 0), 0); };
  result.usage = usage.map((u) => ({ job: u.job, model: u.model, outcome: u.outcome, durationMs: u.durationMs, tokens: u.tokens, contextBudget: u.contextBudget }));
  result.tokens = usage.length && usage.every((u) => tok(u) !== null) ? usage.reduce((n, u) => n + tok(u), 0) : null;
  // The ticket task's own activations, separately from children (whose usage may be unknown).
  const own = usage.filter((u) => u.job === job.id);
  result.parentTokens = own.length && own.every((u) => tok(u) !== null) ? own.reduce((n, u) => n + tok(u), 0) : null;
  result.wallMs = result.activations.reduce((n, a) => n + a.wallMs, 0) + (result.children || []).reduce((n, c) => n + c.wallMs, 0);
  result.finalState = job.state;
  // Host actions the broker tried during this trial (the guard's list is process-wide).
  result.blockedHostActions = require('./guard.cjs').blocked.slice(blockedBefore).map((b) => [b.file, ...b.args].join(' ').slice(0, 200));
  fs.writeFileSync(cell + '/events.json', JSON.stringify(env.events, null, 2));
  fs.writeFileSync(cell + '/channel.json', JSON.stringify(env.messages, null, 2));
  fs.writeFileSync(cell + '/job.json', JSON.stringify(job, null, 2));
  fs.writeFileSync(cell + '/result.json', JSON.stringify(result, null, 2));
  fs.appendFileSync(path.join(out, 'results.jsonl'), JSON.stringify(result) + '\n');
  console.log(`DONE ${key} activations=${result.activations.length} state=${job.state} tokens=${Math.round(result.tokens / 1000)}K wall=${Math.round(result.wallMs / 1000)}s${result.error ? ' ERROR' : ''}`);
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const o = { set: 'dev', scenario: 'all', route: 'claude:claude-sonnet-5-5@medium', arm: 'full', repeat: '1', concurrency: '2' };
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!o.out || !path.isAbsolute(o.out)) throw Error('--out ABSOLUTE_DIR required');
  fs.mkdirSync(o.out, { recursive: true });
  const jobs = [];
  for (let r = 1; r <= Number(o.repeat); r++) for (const s of scenarioIds(o.scenario, SETS[o.set])) for (const route of o.route.split(',')) for (const a of o.arm.split(',')) jobs.push([SETS[o.set], s, route, a, r]);
  let next = 0;
  await Promise.all(Array.from({ length: Number(o.concurrency) }, async () => { while (next < jobs.length) { const j = jobs[next++]; try { await sim(...j, o.out); } catch (e) { console.log('SIM_ERROR', j.join(' '), e.message); } } }));
  console.log('REPLAY_COMPLETE ' + jobs.length);
}
if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
module.exports = { sim, ARMS };
