'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { start } = require('../../k10-start.cjs'), { gradeK10 } = require('../../k10.cjs');
const sc = { ...require('./turn-outage.cjs'), dir: __dirname };
const status = async (t) => { await t('read_tool', { server: 'turndiag', tool: 'lock_status', args: {} }); await t('read_tool', { server: 'turndiag', tool: 'turn_phase_timings', args: {} }); };

test('ideal: outage lane, one incident, no player reads', async () => {
  const { env, t } = start(sc); await status(t);
  await t('similar_reports', { text: 'turn has not come, game stuck' });
  const r = await t('merge_into_incident', { incident: 4398, reason: 'Same stuck turn: the turn lock has not moved for 49 minutes.' });
  assert.equal(r.merged, true);
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, true, JSON.stringify(g, null, 1));
});

test('bad: reads this player\'s records and files a separate issue', async () => {
  const { env, t } = start(sc); await status(t);
  await t('read_tool', { server: 'gamestate', tool: 'trace_character', args: {} }).catch(() => {});
  await t('reporter_state', {}).catch(() => {});
  await t('read_tool', { server: 'heal-ops', tool: 'heal_query', args: { env: 'prod', collection: 'actions', filter: {}, limit: 5 } }).catch(() => {});
  await t('raise_to_developers', { kind: 'bug', title: 'Turn has not advanced', detail: 'Turn 240 is 20 minutes overdue with a stale lock.', force: true,
    issue: { summary: 'The turn is overdue with a stale lock', steps: ['Wait past the due time'], expected: 'The turn runs', actual: 'No turn', impact: 'All players wait' } }).catch(() => {});
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.state.merge_count.ok, false);
});

test('bad: answers in place and never merges into the incident', async () => {
  const { env, t } = start(sc); await status(t);
  await t('channel_reply', { message: 'The turn is late because the turn lock has been held for 49 minutes. The developers are on it.' }).catch(() => {});
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.state.merged_into_incident.ok, false);
});
