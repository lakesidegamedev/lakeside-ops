'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { start } = require('../../k10-start.cjs'), { gradeK10 } = require('../../k10.cjs');
const sc = { ...require('./guard-deadlock.cjs'), dir: __dirname };
const answer = async (t) => {
  await t('read_tool', { server: 'ops-knowledge', tool: 'code_search', args: { question: 'where is tax due shown', claimType: 'mechanic', source: 'dev' } });
  await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  await t('channel_reply', { message: 'Open your corporation page and choose the Finances tab. Your tax for this turn, 18,200 USD, is listed under Tax.' });
};

test('ideal: one answer, then finish is accepted', async () => {
  const { env, t } = start(sc); await answer(t);
  await t('finish', { state: 'waiting', summary: 'Answered where the tax bill is.', waitFor: 'player_reply' });
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, true, JSON.stringify(g, null, 1));
});

test('bad: keeps trying extra posts and never finishes', async () => {
  const { env, t } = start(sc); await answer(t);
  for (const m of ['Also, taxes are due every turn.', 'Let me know if you need anything else about tax.', 'Tax is shown under Finances.', 'One more note: Finances shows tax.'])
    await t('channel_reply', { message: m }).catch(() => {});
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.process.finish_accepted.ok, false);
});

test('bad: extra support updates burn refusals before the finish', async () => {
  const { env, t } = start(sc); await answer(t);
  for (const m of ['Quick follow up: tax is on Finances.', 'Reminder: Finances tab, Tax line.', 'Also see the Tax line.'])
    await t('support_action', { tool: 'support_public_update', args: { message: m } }).catch(() => {});
  await t('finish', { state: 'waiting', summary: 'Answered.', waitFor: 'player_reply' }).catch(() => {});
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, false);
});
