'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { start } = require('../../k10-start.cjs'), { gradeK10 } = require('../../k10.cjs');
const sc = { ...require('./era-locked-unit.cjs'), dir: __dirname };
const reads = async (t) => {
  await t('read_tool', { server: 'ops-knowledge', tool: 'code_search', args: { question: 'when does rocket artillery unlock', claimType: 'mechanic', source: 'dev' } });
  await t('read_tool', { server: 'gamestate', tool: 'game_overview', args: {} });
};

test('ideal: not available yet, unlocks in 1962, nothing filed', async () => {
  const { env, t } = start(sc); await reads(t);
  await t('channel_reply', { message: 'The Rocket Artillery Brigade is not available yet. It unlocks in 1962 and the world is in 1958. Until then it stays out of the recruit list.' });
  await t('finish', { state: 'waiting', summary: 'Explained the unit is locked until 1962.', waitFor: 'player_reply' });
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, true, JSON.stringify(g, null, 1));
});

test('bad: explains where to recruit a unit that is locked', async () => {
  const { env, t } = start(sc); await reads(t);
  await t('channel_reply', { message: 'Recruit it at the barracks on your military page, choose Rocket Artillery Brigade and confirm.' }).catch(() => {});
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, false);
});

test('bad: files a bug for the missing unit', async () => {
  const { env, t } = start(sc); await reads(t);
  await t('raise_to_developers', { kind: 'bug', title: 'Rocket Artillery missing from recruit list', detail: 'The unit is missing from the recruit list.', force: true,
    issue: { summary: 'Rocket Artillery Brigade is not in the recruit list', steps: ['Open recruit list'], expected: 'The unit is listed', actual: 'Not listed', impact: 'Players cannot recruit the unit' } }).catch(() => {});
  await t('channel_reply', { message: 'That looks like a bug, I have reported it to the developers.' }).catch(() => {});
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.state.issue_count.ok, false);
});
