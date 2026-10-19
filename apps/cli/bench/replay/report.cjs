'use strict';
// Replay report: re-grades every saved trial with the current frozen grader,
// then summarises each (route, arm) and compares a candidate arm to a baseline
// arm on paired trials (same scenario, route and repeat index).
// Usage: node report.cjs DIR [--baseline full] [--candidate digest] [--margin 0.05] [--json]
const fs = require('node:fs'), path = require('node:path');
const { grade, VERSION } = require('./grade.cjs');

function load(dir) {
  const rows = [];
  for (const d of fs.readdirSync(dir)) {
    const cell = path.join(dir, d), r = path.join(cell, 'result.json'), e = path.join(cell, 'events.json');
    if (!fs.existsSync(r) || !fs.existsSync(e)) continue;
    const result = JSON.parse(fs.readFileSync(r)), events = JSON.parse(fs.readFileSync(e));
    const sc = require(path.join(result.set || path.join(__dirname, 'scenarios', 'dev'), result.scenario + '.cjs'));
    rows.push({ ...result, grade: grade(events, sc.spec), toolCalls: events.filter((x) => x.kind === 'mcp' || x.kind === 'exec' || x.kind === 'discord').length });
  }
  return rows;
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
// Wilson score interval for a proportion.
function wilson(k, n, z = 1.96) { if (!n) return [NaN, NaN]; const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; return [c - h, c + h]; }
// Deterministic PRNG so bootstrap intervals are reproducible.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function summary(rows) {
  const groups = {};
  for (const r of rows) (groups[`${r.route} | ${r.arm}`] ||= []).push(r);
  return Object.entries(groups).sort().map(([k, v]) => {
    const n = v.length, ok = v.filter((r) => r.grade.success).length, [lo, hi] = wilson(ok, n);
    const succ = v.filter((r) => r.grade.success);
    return { group: k, n, success: ok / n, ci: [lo, hi], state: mean(v.map((r) => +r.grade.statePass)), process: mean(v.map((r) => +r.grade.processPass)),
      communication: mean(v.map((r) => r.grade.communicationScore ?? 0)), catastrophic: v.filter((r) => r.grade.catastrophic.length).length,
      // Unknown usage (null, or 0 from runs saved before that was recorded) stays out of token figures.
      tokensKnown: v.filter((r) => r.tokens).length, tokensPerTask: mean(v.filter((r) => r.tokens).map((r) => r.tokens)), tokensPerSuccess: succ.length && v.every((r) => r.tokens) ? v.reduce((x, r) => x + r.tokens, 0) / succ.length : NaN,
      wallP50: pct(v.map((r) => r.wallMs), 0.5), wallP95: pct(v.map((r) => r.wallMs), 0.95), toolCalls: mean(v.map((r) => r.toolCalls)),
      unobservable: Object.fromEntries(Object.entries(v.reduce((m, r) => ((m[r.grade.unobservable || 'n/a'] = (m[r.grade.unobservable || 'n/a'] || 0) + 1), m), {}))) };
  });
}

// Paired comparison, bootstrapped over scenarios (trials within a scenario are not independent).
function compare(rows, route, base, cand, margin, B = 4000) {
  const by = (arm) => rows.filter((r) => r.route === route && r.arm === arm);
  const key = (r) => `${r.scenario}#${r.rep}`;
  const bm = new Map(by(base).map((r) => [key(r), r])), pairs = by(cand).filter((r) => bm.has(key(r))).map((r) => ({ scenario: r.scenario, c: r, b: bm.get(key(r)) }));
  if (!pairs.length) return null;
  const scen = [...new Set(pairs.map((p) => p.scenario))];
  const stat = (ps, f) => mean(ps.map((p) => f(p.c) - f(p.b)));
  const metrics = { success: (r) => +r.grade.success, tokens: (r) => r.tokens, wallMs: (r) => r.wallMs };
  const out = { route, base, cand, pairs: pairs.length, scenarios: scen.length };
  const rand = rng(42);
  for (const [name, f] of Object.entries(metrics)) {
    const obs = stat(pairs, f), boots = [];
    for (let i = 0; i < B; i++) { const pick = scen.map(() => scen[Math.floor(rand() * scen.length)]); boots.push(stat(pick.flatMap((s) => pairs.filter((p) => p.scenario === s)), f)); }
    boots.sort((x, y) => x - y);
    out[name] = { diff: obs, ci: [boots[Math.floor(0.025 * B)], boots[Math.floor(0.975 * B)]] };
  }
  out.tokenRatio = mean(pairs.map((p) => p.c.tokens)) / mean(pairs.map((p) => p.b.tokens));
  out.nonInferiorSuccess = out.success.ci[0] > -margin;
  out.catastrophicCandidate = pairs.filter((p) => p.c.grade.catastrophic.length).length;
  return out;
}

function main(argv = process.argv.slice(2)) {
  const dir = argv[0], opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const rows = load(dir), s = summary(rows), routes = [...new Set(rows.map((r) => r.route))];
  const base = opt('--baseline', 'full'), cand = opt('--candidate', null), margin = Number(opt('--margin', '0.05'));
  const cmp = cand ? routes.map((r) => compare(rows, r, base, cand, margin)).filter(Boolean) : [];
  if (argv.includes('--json')) { console.log(JSON.stringify({ grader: VERSION, summary: s, compare: cmp }, null, 2)); return; }
  console.log(`grader ${VERSION}, ${rows.length} trials`);
  for (const g of s) console.log(`${g.group.padEnd(48)} n=${String(g.n).padStart(3)} success=${(100 * g.success).toFixed(0).padStart(3)}% [${(100 * g.ci[0]).toFixed(0)}-${(100 * g.ci[1]).toFixed(0)}] state=${(100 * g.state).toFixed(0)}% process=${(100 * g.process).toFixed(0)}% comm=${(100 * g.communication).toFixed(0)}% cat=${g.catastrophic} tok/task=${Number.isNaN(g.tokensPerTask) ? 'unknown' : (g.tokensPerTask / 1000).toFixed(0) + 'K'}${g.tokensKnown < g.n ? ` (${g.tokensKnown}/${g.n} known)` : ''} tok/success=${(g.tokensPerSuccess / 1000).toFixed(0)}K wall p50/p95=${(g.wallP50 / 1000).toFixed(0)}/${(g.wallP95 / 1000).toFixed(0)}s unobs=${JSON.stringify(g.unobservable)}`);
  for (const c of cmp) console.log(`\n${c.route}: ${c.cand} vs ${c.base}, ${c.pairs} pairs over ${c.scenarios} scenarios\n  success diff ${(100 * c.success.diff).toFixed(1)} pts [${(100 * c.success.ci[0]).toFixed(1)}, ${(100 * c.success.ci[1]).toFixed(1)}] non-inferior(${margin}): ${c.nonInferiorSuccess}\n  tokens x${c.tokenRatio.toFixed(2)} (diff ${(c.tokens.diff / 1000).toFixed(0)}K [${(c.tokens.ci[0] / 1000).toFixed(0)}, ${(c.tokens.ci[1] / 1000).toFixed(0)}])  wall diff ${(c.wallMs.diff / 1000).toFixed(1)}s [${(c.wallMs.ci[0] / 1000).toFixed(1)}, ${(c.wallMs.ci[1] / 1000).toFixed(1)}]  catastrophic(candidate)=${c.catastrophicCandidate}`);
}
if (require.main === module) main();
module.exports = { load, summary, compare, wilson };
