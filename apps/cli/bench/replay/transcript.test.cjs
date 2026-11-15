'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { start } = require('./k10-start.cjs'), { gradeK10 } = require('./k10.cjs'), { writeTranscript } = require('./transcript.cjs');

test('transcript lists every tool call, refusal, decision and model text', async () => {
  const sc = { ...require('./scenarios/k10/guard-deadlock.cjs'), dir: path.join(__dirname, 'scenarios/k10') };
  const { env, t } = start(sc);
  await t('read_tool', { server: 'users', tool: 'dump', args: {} }).catch(() => {});
  await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
  const result = { route: 'test:model', arm: 'full', finalState: 'waiting', activations: [{}], grade: gradeK10(env.events, sc.spec) };
  writeTranscript(dir, { scenario: sc, result, events: env.events, messages: env.messages, rawActivations: [{ lane: 'worker', ms: 1200, result: { subtype: 'success', result: 'Done.', thinking: 'weighing the guard' } }] });
  const md = fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8');
  assert.match(md, /`read_tool`/);
  assert.match(md, /REFUSED:/);
  assert.match(md, /`read_tool`/);
  assert.match(md, /Model final text/);
  assert.match(md, /weighing the guard/);
});

test('the k10 preset lists all seven scenarios', () => {
  const ids = fs.readdirSync(path.join(__dirname, 'scenarios/k10')).filter((f) => f.endsWith('.cjs') && !f.endsWith('.test.cjs')).map((f) => f.slice(0, -4)).sort();
  assert.deepEqual(ids, ['ask-down-redirect', 'card-reuse', 'era-locked-unit', 'guard-deadlock', 'howto-drift', 'turn-outage', 'unlinked-reporter-fix']);
  for (const id of ids) assert.ok(require(`./scenarios/k10/${id}.cjs`).spec, id);
});
