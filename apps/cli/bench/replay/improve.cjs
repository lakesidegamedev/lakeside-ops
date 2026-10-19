'use strict';
// Harness improver (after Harness², google-research/harness2): the model stays
// frozen, the harness is edited. One improvement round:
//   probe    run the base agent tree on the dev set and collect the evidence
//            (failed grader checks, broker refusals, the failing posts)
//   propose  k candidate edits, each by an external coding agent (OpenCode,
//            DeepSeek by default) in its own disposable worktree; candidate i
//            alternates a scenario-specific fix and an invariant (general) one
//   probe    run every admissible candidate on the same dev set
//   compose  apply the improving candidates together; probe the composition
//   record   append the round to the lessons library, which the next round's
//            proposer reads (harnessing-level recursion)
// Editable surface: the brief (KEIR.md) and tool descriptions in agent.js.
// Tool names and schemas, broker code, skills (vendored) and the grader are
// frozen; a candidate touching anything else is rejected unprobed.
// Output: the best patch and a report. Nothing here changes live Keir; the
// validation and holdout gates in the pre-registration still decide shipping.
//
// node apps/cli/bench/replay/improve.cjs --out ABS [--scenario all|ids] [--k 2]
//   [--route opencode:opencode-go/deepseek-v4.1-flash@medium] [--repeat 1]
//   [--proposer opencode-go/deepseek-v4.1-flash] [--base origin/main]
//   [--library /root/misc/keir-harness-library.json]
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const REPO = path.resolve(__dirname, '../../../..');
// Disposable worktrees belong to the main checkout's worktrees/ directory.
const MAIN = path.dirname(cp.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' }).trim());
const RUN = path.join(__dirname, 'run.cjs');
const { grade } = require('./grade.cjs');
const EDITABLE = ['apps/agent/KEIR.md', 'apps/agent/lib/operator/agent.js'];

const sh = (cmd, args, opts = {}) => cp.execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
const git = (args, cwd = REPO) => sh('git', args, { cwd });

function scenarioIds(arg) {
  const dir = path.join(__dirname, 'scenarios', 'dev');
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.cjs') && !f.endsWith('.test.cjs')).map((f) => f.slice(0, -4)).sort();
  return arg === 'all' ? all : arg.split(',');
}

// Run the dev set on one agent tree (child process: run.cjs loads the agent at require time).
function probe(o, label, agentDir) {
  const out = path.join(o.out, 'probe');
  const env = { ...process.env, KEIR_REPLAY_AGENT: agentDir, KEIR_REPLAY_LABEL: label, KEIR_PROD_HOLD_FILE: '/nonexistent', KEIR_JEV: 'off' };
  try {
    sh('node', [RUN, '--out', out, '--set', 'dev', '--scenario', o.scenarios.join(','), '--route', o.route, '--arm', 'full', '--repeat', String(o.repeat), '--concurrency', String(o.concurrency)],
      { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: o.probeTimeoutMs });
  } catch (e) { fs.appendFileSync(path.join(o.out, 'improve.log'), `probe ${label} failed: ${String(e.message).slice(0, 400)}\n`); }
  return summarize(out, label);
}

function summarize(out, label) {
  const rows = fs.existsSync(path.join(out, 'results.jsonl')) ? fs.readFileSync(path.join(out, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((r) => r.arm === label) : [];
  const trials = rows.map((r) => {
    const spec = require(path.join(__dirname, 'scenarios', 'dev', r.scenario + '.cjs')).spec;
    const events = JSON.parse(fs.readFileSync(path.join(out, r.key, 'events.json'), 'utf8'));
    const g = grade(events, spec);
    const failed = [...Object.entries(g.state), ...Object.entries(g.process)].filter(([, v]) => v.required && !v.ok).map(([k, v]) => `${k} (${v.why})`);
    const refusals = events.filter((e) => e.kind === 'tool' && e.ok === false).map((e) => `${e.name}: ${String(e.error).slice(0, 160)}`);
    const posts = events.filter((e) => e.kind === 'post' && e.text && !/^Hi, I'm Keir/.test(e.text)).map((e) => e.text.slice(0, 500));
    return { scenario: r.scenario, rep: r.rep, success: g.success, catastrophic: g.catastrophic, failed, refusals, posts, tokens: r.tokens, wallMs: r.wallMs, error: r.error || r.activations?.find((a) => a.error)?.error || null };
  });
  const ok = trials.filter((t) => t.success).length;
  return { label, n: trials.length, success: ok, rate: trials.length ? ok / trials.length : 0, catastrophic: trials.reduce((n, t) => n + t.catastrophic.length, 0),
    tokens: trials.every((t) => t.tokens != null) ? trials.reduce((n, t) => n + t.tokens, 0) : null, infraErrors: trials.filter((t) => t.error && /model request failed|authenticate|unavailable/i.test(t.error)).length, trials };
}

// Evidence for the proposer: dev scenarios only (validation and holdout never feed the loop).
function evidence(base) {
  const lines = [`Base: ${base.success}/${base.n} dev trials succeeded.`];
  for (const t of base.trials.filter((x) => !x.success)) {
    lines.push(`\n## ${t.scenario} r${t.rep}: FAILED\nFailed checks: ${t.failed.join('; ') || 'none (catastrophic: ' + t.catastrophic.join(', ') + ')'}`);
    if (t.refusals.length) lines.push(`Broker refusals:\n- ${[...new Set(t.refusals)].slice(0, 8).join('\n- ')}`);
    if (t.posts.length) lines.push(`Posts to the player:\n> ${t.posts.slice(0, 3).join('\n> ')}`);
  }
  return lines.join('\n');
}

const library = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { rounds: [], lessons: [] }; } };

function promptFor(o, ev, lib, i) {
  const style = i % 2 === 0
    ? 'Make a SPECIFIC change aimed at the most common failure above.'
    : 'Make an INVARIANT change: a general rule that would prevent this class of failure on tickets you have not seen, without naming these scenarios.';
  return `You improve the harness of Keir, a support agent for the game A House Divided. The model is frozen; you edit its harness.

Editable, and nothing else:
- apps/agent/KEIR.md (the brief every activation reads)
- tool descriptions in apps/agent/lib/operator/agent.js: only the description strings inside the TOOLS array. Never change a tool name, an input schema or any code.

Do not edit broker code, tests, skills, the grader or the scenarios. Do not run the benchmark. Keep the brief no longer than it is now: when you add a sentence, tighten or remove one elsewhere. Plain language, no em or en dashes.

${style} One focused change. Then stop; do not commit.

Evidence from the replay benchmark (failed grader checks, broker refusals, what Keir posted):
${ev}

Lessons from earlier rounds (accepted and rejected edits):
${lib.lessons.slice(-12).map((l) => `- ${l}`).join('\n') || '- none yet'}
`;
}

// One candidate: a disposable worktree, an external coding agent, an admissibility check.
function propose(o, ev, lib, i) {
  const name = `improve-${o.stamp}-${i}`, wt = path.join(MAIN, 'worktrees', name);
  git(['worktree', 'add', '-q', '--detach', wt, o.base]);
  const promptFile = path.join(o.out, `${name}.prompt.md`), log = path.join(o.out, `${name}.log`);
  fs.writeFileSync(promptFile, promptFor(o, ev, lib, i));
  try { sh('/root/bin/provider-agent-run.sh', ['opencode', MAIN, wt, promptFile, o.proposer, log], { stdio: ['ignore', 'pipe', 'pipe'], timeout: o.proposeTimeoutMs }); }
  catch (e) { fs.appendFileSync(path.join(o.out, 'improve.log'), `propose ${i} exited: ${String(e.message).slice(0, 300)}\n`); }
  // The runner checkpoints the agent's output as commits: compare with the base commit.
  const baseSha = git(['rev-parse', o.base]).trim();
  const diff = git(['diff', baseSha, '--', ...EDITABLE], wt);
  const all = [...new Set([...git(['diff', '--name-only', baseSha], wt).split('\n'), ...git(['status', '--porcelain'], wt).split('\n').map((l) => l.slice(3))].filter(Boolean))];
  const why = admissible(wt, all, diff, o.baseWt, baseSha);
  fs.writeFileSync(path.join(o.out, `${name}.patch`), diff);
  return { i, name, wt, agentDir: path.join(wt, 'apps/agent'), diff, files: all, rejected: why };
}

function admissible(wt, files, diff, baseWt = REPO, baseSha = 'HEAD') {
  if (!diff.trim()) return 'no change';
  const outside = files.filter((f) => !EDITABLE.includes(f));
  if (outside.length) return `edited outside the editable surface: ${outside.join(', ')}`;
  if (/[–—]/.test(diff.split('\n').filter((l) => l.startsWith('+')).join('\n'))) return 'introduced an em or en dash';
  if (files.includes('apps/agent/lib/operator/agent.js')) {
    try { sh('node', ['--check', path.join(wt, 'apps/agent/lib/operator/agent.js')]); } catch { return 'agent.js no longer parses'; }
    const shape = (dir) => sh('node', ['-e', `const {TOOLS}=require(${JSON.stringify(path.join(dir, 'apps/agent/lib/operator/agent.js'))});console.log(JSON.stringify(TOOLS.map(t=>[t.name,t.input_schema])))`], { env: { ...process.env, NODE_PATH: process.env.NODE_PATH || '' } });
    try { if (shape(wt) !== shape(baseWt)) return 'changed a tool name or schema'; } catch (e) { return 'agent.js failed to load: ' + String(e.message).slice(0, 120); }
    const outsideTools = git(['diff', '-U0', baseSha, '--', 'apps/agent/lib/operator/agent.js'], wt).split('\n').filter((l) => l.startsWith('@@')).some((h) => { const m = /-(\d+)(?:,(\d+))?/.exec(h); const a = Number(m[1]), n = Number(m[2] ?? 1); return a < 18 || a + n > toolsEnd(baseWt); });
    if (outsideTools) return 'edited agent.js outside the TOOLS descriptions';
  }
  return null;
}
function toolsEnd(baseWt) { const lines = fs.readFileSync(path.join(baseWt, 'apps/agent/lib/operator/agent.js'), 'utf8').split('\n'); return lines.findIndex((l, n) => n > 18 && /^\]/.test(l)) + 1; }

function compose(o, winners) {
  const name = `improve-${o.stamp}-composed`, wt = path.join(MAIN, 'worktrees', name);
  git(['worktree', 'add', '-q', '--detach', wt, o.base]);
  for (const c of winners) { try { git(['apply', '--3way', path.join(o.out, `${c.name}.patch`)], wt); } catch { return { name, wt, agentDir: path.join(wt, 'apps/agent'), rejected: `${c.name} conflicts with the others` }; } }
  const diff = git(['diff', git(['rev-parse', o.base]).trim(), '--', ...EDITABLE], wt);
  fs.writeFileSync(path.join(o.out, `${name}.patch`), diff);
  return { name, wt, agentDir: path.join(wt, 'apps/agent'), diff, rejected: null };
}

async function main(argv = process.argv.slice(2)) {
  const o = { scenario: 'all', k: '2', route: 'opencode:opencode-go/deepseek-v4.1-flash@medium', repeat: '1', concurrency: '2', proposer: 'opencode-go/deepseek-v4.1-flash', base: 'origin/main', library: '/root/misc/keir-harness-library.json', keep: '0' };
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!o.out || !path.isAbsolute(o.out)) throw Error('--out ABSOLUTE_DIR required');
  Object.assign(o, { k: Number(o.k), repeat: Number(o.repeat), concurrency: Number(o.concurrency), scenarios: scenarioIds(o.scenario), stamp: Date.now().toString(36), probeTimeoutMs: 4 * 3600000, proposeTimeoutMs: 40 * 60000 });
  fs.mkdirSync(o.out, { recursive: true });
  const say = (m) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); fs.appendFileSync(path.join(o.out, 'improve.log'), line + '\n'); };
  const lib = library(o.library), made = [];
  try {
    const baseWt = path.join(MAIN, 'worktrees', `improve-${o.stamp}-base`); git(['worktree', 'add', '-q', '--detach', baseWt, o.base]); made.push(baseWt); o.baseWt = baseWt;
    const base = probe(o, 'base', path.join(baseWt, 'apps/agent'));
    say(`base ${base.success}/${base.n} (infra errors ${base.infraErrors})`);
    if (base.infraErrors) throw Error('base probe hit provider errors; fix the route before proposing');
    const ev = evidence(base); fs.writeFileSync(path.join(o.out, 'evidence.md'), ev);
    const cands = [];
    for (let i = 0; i < o.k; i++) { const c = propose(o, ev, lib, i); made.push(c.wt); say(`candidate ${i}: ${c.rejected ? 'rejected: ' + c.rejected : c.files.join(', ')}`); cands.push(c); }
    for (const c of cands.filter((x) => !x.rejected)) { c.score = probe(o, c.name, c.agentDir); say(`candidate ${c.i}: ${c.score.success}/${c.score.n}, catastrophic ${c.score.catastrophic}`); }
    const better = cands.filter((c) => c.score && !c.score.catastrophic && !c.score.infraErrors && c.score.success > base.success).sort((a, b) => b.score.success - a.score.success);
    let best = better[0] || null;
    if (better.length > 1) {
      const comp = compose(o, better); made.push(comp.wt);
      if (!comp.rejected) { comp.score = probe(o, comp.name, comp.agentDir); say(`composed: ${comp.score.success}/${comp.score.n}`); if (comp.score.success >= best.score.success && !comp.score.catastrophic) best = comp; }
      else say(`compose rejected: ${comp.rejected}`);
    }
    if (best) fs.copyFileSync(path.join(o.out, `${best.name}.patch`), path.join(o.out, 'best.patch'));
    const round = { at: new Date().toISOString(), base: git(['rev-parse', o.base]).trim(), route: o.route, proposer: o.proposer, scenarios: o.scenarios, repeat: o.repeat,
      baseScore: `${base.success}/${base.n}`, candidates: cands.map((c) => ({ name: c.name, files: c.files, rejected: c.rejected, score: c.score ? `${c.score.success}/${c.score.n}` : null, patch: path.join(o.out, `${c.name}.patch`) })),
      best: best ? { name: best.name, score: `${best.score.success}/${best.score.n}`, patch: path.join(o.out, 'best.patch') } : null };
    lib.rounds.push(round);
    for (const c of cands) {
      const first = (c.diff || '').split('\n').filter((l) => /^\+[^+]/.test(l)).map((l) => l.slice(1).trim()).filter(Boolean).slice(0, 2).join(' / ').slice(0, 240);
      lib.lessons.push(`${round.at.slice(0, 10)} ${c.rejected ? 'REJECTED (' + c.rejected + ')' : c.score && c.score.success > base.success ? `IMPROVED dev ${base.success}->${c.score.success}/${c.score.n}` : `NO GAIN dev ${base.success}->${c.score?.success}/${c.score?.n}`}: ${first || '(no text)'}`);
    }
    fs.writeFileSync(o.library, JSON.stringify(lib, null, 2));
    fs.writeFileSync(path.join(o.out, 'round.json'), JSON.stringify(round, null, 2));
    say(best ? `best ${best.name} ${best.score.success}/${best.score.n} vs base ${base.success}/${base.n}: ${path.join(o.out, 'best.patch')}. Dev only: validation and holdout gates still decide.` : 'no candidate beat the base on dev');
  } finally {
    if (o.keep !== '1') for (const wt of made) { try { git(['worktree', 'remove', '--force', wt], MAIN); } catch {} }
  }
}
if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
module.exports = { admissible, evidence, summarize, promptFor };
