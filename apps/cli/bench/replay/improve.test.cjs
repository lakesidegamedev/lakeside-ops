'use strict';
// The improver's admissibility gate: only the brief and tool descriptions may change.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const { admissible } = require('./improve.cjs');
const AGENT = path.resolve(__dirname, '../../../agent');

function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keir-improve-'));
  fs.mkdirSync(path.join(dir, 'apps/agent'), { recursive: true });
  fs.copyFileSync(path.join(AGENT, 'KEIR.md'), path.join(dir, 'apps/agent/KEIR.md'));
  fs.cpSync(path.join(AGENT, 'lib'), path.join(dir, 'apps/agent/lib'), { recursive: true });
  fs.copyFileSync(path.join(AGENT, 'package.json'), path.join(dir, 'apps/agent/package.json'));
  // agent.js also loads the CLI's headless runners.
  const cli = path.resolve(AGENT, '../cli');
  for (const f of fs.readdirSync(cli)) if (f !== 'bench' && f !== 'node_modules') fs.cpSync(path.join(cli, f), path.join(dir, 'apps/cli', f), { recursive: true });
  fs.writeFileSync(path.join(dir, 'other.js'), 'x\n');
  const g = (a) => cp.execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']); g(['add', '-A']); g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  return { dir, g };
}
const status = (g) => g(['status', '--porcelain']).split('\n').filter(Boolean).map((l) => l.slice(3));
const diff = (g) => g(['diff']);

test('a brief edit is admissible; edits elsewhere, dashes and no change are not', () => {
  const base = tree(), t = tree();
  assert.equal(admissible(t.dir, status(t.g), diff(t.g), base.dir), 'no change');
  fs.appendFileSync(path.join(t.dir, 'apps/agent/KEIR.md'), '\nAsk the player which client they used.\n');
  assert.equal(admissible(t.dir, status(t.g), diff(t.g), base.dir), null);
  fs.appendFileSync(path.join(t.dir, 'apps/agent/KEIR.md'), 'A rule — with a dash.\n');
  assert.match(admissible(t.dir, status(t.g), diff(t.g), base.dir), /dash/);
  const u = tree();
  fs.appendFileSync(path.join(u.dir, 'other.js'), 'y\n');
  fs.appendFileSync(path.join(u.dir, 'apps/agent/KEIR.md'), '\nx\n');
  assert.match(admissible(u.dir, status(u.g), diff(u.g), base.dir), /outside the editable surface/);
});

test('agent.js: a description edit is admissible; a code edit outside TOOLS is not', () => {
  const base = tree(), t = tree(), f = path.join(t.dir, 'apps/agent/lib/operator/agent.js');
  const src = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, src.replace('Read the support, Watchkeeper and engineering states', 'Read the support, Watchkeeper and engineering states first'));
  assert.equal(admissible(t.dir, status(t.g), diff(t.g), base.dir), null);
  const u = tree(), h = path.join(u.dir, 'apps/agent/lib/operator/agent.js');
  fs.writeFileSync(h, fs.readFileSync(h, 'utf8').replace(/module\.exports = \{/, 'const extra = 1;\nmodule.exports = {'));
  assert.match(admissible(u.dir, status(u.g), diff(u.g), base.dir), /outside the TOOLS descriptions/);
});
