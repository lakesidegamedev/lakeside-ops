'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { start } = require('../../k10-start.cjs'), { gradeK10 } = require('../../k10.cjs');
const sc = { ...require('./ask-down-redirect.cjs'), dir: __dirname };
const reads = async (t) => { await t('read_tool', { server: 'ops-knowledge', tool: 'code_search', args: { question: 'where is army supply shown', claimType: 'mechanic', source: 'dev' } }); await t('read_tool', { server: 'engine', tool: 'engine_health', args: {} }); await t('read_tool', { server: 'gamestate', tool: 'wars', args: {} }); };

test('ideal: facts answered, strategy help honestly unavailable, no Ask redirect', async () => {
  const { env, t } = start(sc); await reads(t);
  await t('channel_reply', { message: 'Your army supply level is on the war page, under your front line. It shows low on the North front right now. Strategy help is temporarily unavailable, so I cannot weigh pushing against holding for you today.' });
  await t('finish', { state: 'waiting', summary: 'Answered the factual part; strategy help is down.', waitFor: 'player_reply' });
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, true, JSON.stringify(g, null, 1));
});

test('bad: sends the player to Ask while it is failing', async () => {
  const { env, t } = start(sc); await reads(t);
  await t('channel_reply', { message: 'For strategy, use Ask: https://ask.lakesidegames.net. Your supply level is on the war page.' }).catch(() => {});
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, false);
});

test('bad: invents strategy advice and never says help is down', async () => {
  const { env, t } = start(sc); await reads(t);
  await t('channel_reply', { message: 'You should push north, the front looks weak. Supply is shown on the war page.' }).catch(() => {});
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.state.says_strategy_unavailable.ok, false);
});
