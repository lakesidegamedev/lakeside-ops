'use strict';
// Simulated-ticket benchmark: one realistic support ticket, up to three
// activations, a scripted player between them, graded on a 100-point rubric.
// Arms: loose (all tools, no real instructions), baseline (Keir before the
// 2026-10-18 harness work: full KEIR.md, full skills, every tool, no guard) and
// advanced (lean context, effect guard, workspace prefetch).
// Usage: node apps/cli/bench/ticket/run.cjs --out ABS_DIR [--model sonnet,ds] [--arm loose,baseline,advanced] [--repeat 3] [--concurrency 3]
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const CLI = path.resolve(__dirname, '../..'), AGENT = path.resolve(CLI, '../agent');
const { createToolServer } = require(AGENT + '/lib/operator/toolserver');
const { createWorld, TICKET, PLAYER, OPENING } = require('./world.cjs');
const { grade } = require('./grade.cjs');
const { bounded } = require('../run.cjs');

const MODELS = { sonnet: ['claude', 'claude-sonnet-5-5'], ds: ['ollama', 'deepseek-v4.1-flash'] };
const LOOSE_BRIEF = 'You are a support agent for the online strategy game A House Divided. Use your tools to help the player in this support ticket.';
const LIMIT_MS = 150000, MAX_ACTIVATIONS = 3;

function arm(name) {
  const k = require('../keir-arm.cjs');
  if (name === 'baseline') return { ...k.build('keir-current', 'support'), guard: false, prefetch: false, keirContext: true };
  // live = Keir 5.8.21 as deployed: lean context and effect guard, no prefetch.
  if (name === 'live') return { ...k.build('keir-lean', 'support'), guard: true, prefetch: false, keirContext: true };
  if (name === 'advanced') return { ...k.build('keir-lean', 'support'), guard: true, prefetch: true, keirContext: true };
  const base = k.build('keir-current', 'support');
  return { tools: base.tools, deferred: null, brief: LOOSE_BRIEF, guard: false, prefetch: false, keirContext: false, stats: { briefChars: LOOSE_BRIEF.length, toolSchemaChars: JSON.stringify(base.tools).length, tools: base.tools.length } };
}

function prompt(a, world, inbox, activation, repoDir) {
  if (!a.keirContext) {
    const lines = activation === 0 ? [`Support ticket #${TICKET} (category: bug) opened by player ${PLAYER}:`, `"${OPENING}"`] : ['New message in the ticket:', ...inbox.map((m) => `${PLAYER}: "${m.text}"`)];
    return lines.join('\n');
  }
  const ctx = { taskId: 'sim' + TICKET, kind: 'ticket', authority: 'support', replyInChannel: true, ticket: TICKET, ticketCategory: 'bug',
    source: { author: PLAYER, content: OPENING, at: '2026-10-19T09:00:00Z' }, requestInbox: inbox.map((m) => ({ author: PLAYER, content: m.text })),
    previousActivations: world.log.filter((e) => e.tool === 'finish').map((e) => ({ state: e.input.state, summary: e.input.summary })),
    statusCard: world.state.statusCard || "missing: create this ticket's progress card with status_card in this activation, from what is verified now" };
  let text = JSON.stringify(ctx);
  if (a.prefetch) text += '\n\n' + require(AGENT + '/lib/operator/prefetch').prefetch(repoDir, OPENING + ' wage workers').text;
  return text;
}

async function sim(modelKey, armName, rep, out) {
  const key = `${modelKey}__${armName}__r${rep}`, cell = path.join(out, key);
  if (fs.existsSync(cell + '/result.json')) return JSON.parse(fs.readFileSync(cell + '/result.json'));
  fs.rmSync(cell, { recursive: true, force: true }); fs.mkdirSync(cell + '/state', { recursive: true });
  const repoDir = cell + '/repo'; fs.cpSync(path.join(__dirname, 'repo'), repoDir, { recursive: true });
  cp.execFileSync('git', ['init', '-q', repoDir]); cp.execFileSync('git', ['-C', repoDir, 'add', '-A']); cp.execFileSync('git', ['-C', repoDir, '-c', 'user.name=sim', '-c', 'user.email=sim@localhost', 'commit', '-qm', 'snapshot']);
  const [runner, model] = MODELS[modelKey], a = arm(armName), world = createWorld({ repoDir, stateDir: cell });
  const job = { id: 'a1b2c3d4e5f6', kind: 'ticket', role: 'support', ticket: TICKET, state: 'running' };
  const server = createToolServer({ broker: { tool: world.tool }, normalizeImage: () => { throw Error('No images'); }, effectGuard: a.guard });
  const result = { key, model: modelKey, arm: armName, rep, activations: [], startedAt: new Date().toISOString(), arm_stats: a.stats };
  let inbox = [];
  try {
    for (let i = 0; i < MAX_ACTIVATIONS; i++) {
      world.state.activation = i; world.state.finish = null;
      const ctl = new AbortController(), session = await server.open(job, a.tools, ctl.signal, a.deferred);
      const request = { version: 1, runner, model, effort: 'medium', brief: a.brief, prompt: prompt(a, world, inbox, i, repoDir), tools: session.tools, url: session.url, completionUrl: session.completionUrl,
        maxTurns: 40, timeoutMs: LIMIT_MS, stateDir: cell + '/state', job: { id: job.id }, lane: 'ticket-sim' };
      const t0 = Date.now(), r = await bounded(process.execPath, [CLI + '/bin/activation.cjs'], { cwd: repoDir, env: { ...process.env, PATH: '/root/bin/agent-guard-bin:/root/.hermes/node/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin' }, input: JSON.stringify(request), timeoutMs: LIMIT_MS + 20000, log: cell + `/runtime-${i}.log` });
      session.close();
      let act = null; try { act = JSON.parse(r.out.trim().split('\n').at(-1)); } catch { act = { error: (r.err + r.out).slice(-800) }; }
      const u = act?.usage || {};
      result.activations.push({ i, wallMs: Date.now() - t0, timeout: r.timeout, subtype: act?.subtype, finish: world.state.finish, tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0), error: act?.is_error ? String(act.result || act.error || '').slice(0, 300) : undefined });
      if (world.state.finish?.state !== 'waiting') break;
      inbox = world.nextInbox();
      if (!inbox.length) break;
    }
  } catch (e) { result.error = String(e.stack || e).slice(0, 1500); }
  finally { server.close?.(); }
  result.grade = grade(world);
  result.tokens = result.activations.reduce((n, x) => n + x.tokens, 0);
  result.wallMs = result.activations.reduce((n, x) => n + x.wallMs, 0);
  result.toolCalls = world.log.length;
  fs.writeFileSync(cell + '/world.json', JSON.stringify({ log: world.log, channel: world.channel, state: world.state }, null, 2));
  fs.writeFileSync(cell + '/result.json', JSON.stringify(result, null, 2));
  fs.appendFileSync(out + '/results.jsonl', JSON.stringify(result) + '\n');
  console.log(`DONE ${key} score=${result.grade.score} tokens=${Math.round(result.tokens / 1000)}K wall=${Math.round(result.wallMs / 1000)}s activations=${result.activations.length}`);
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const o = { model: 'sonnet,ds', arm: 'loose,baseline,advanced', repeat: '3', concurrency: '3' };
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!o.out || !path.isAbsolute(o.out)) throw Error('--out ABSOLUTE_DIR required');
  fs.mkdirSync(o.out, { recursive: true });
  const jobs = [];
  for (let r = 1; r <= Number(o.repeat); r++) for (const m of o.model.split(',')) for (const a of o.arm.split(',')) jobs.push([m, a, r]);
  let next = 0; const results = [];
  await Promise.all(Array.from({ length: Number(o.concurrency) }, async () => { while (next < jobs.length) { const j = jobs[next++]; results.push(await sim(...j, o.out)); } }));
  console.log('SIM_COMPLETE ' + results.length);
}
if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
module.exports = { sim, arm };
