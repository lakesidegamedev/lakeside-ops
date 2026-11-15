'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { start } = require('../../k10-start.cjs'), { gradeK10 } = require('../../k10.cjs');
const sc = { ...require('./howto-drift.cjs'), dir: __dirname };
const issue = { summary: 'An airbase connected to a depot still shows no supply', steps: ['Connect an airbase to a depot', 'Open the airbase page'], expected: 'The airbase is supplied', actual: 'The airbase says no supply', impact: 'Air units at connected airbases fight without supply' };

test('ideal: answers each question from reads, files the supply bug once, no decision', async () => {
  const { env, t, player } = start(sc);
  await t('read_tool', { server: 'ops-knowledge', tool: 'knowledge_query', args: { query: 'assign generals conflict' } });
  await t('channel_reply', { message: 'Open the conflict page, choose Assign general, pick a general who is not already commanding, and confirm. A general commands one conflict at a time.' });
  await t('finish', { state: 'waiting', summary: 'Answered.', waitFor: 'player_reply' });
  player('What do logistics units do?');
  await t('read_tool', { server: 'ops-knowledge', tool: 'knowledge_query', args: { query: 'logistics units' } });
  await t('channel_reply', { message: 'Logistics units carry supply to units in the field. A unit out of supply fights at reduced strength.' });
  await t('finish', { state: 'waiting', summary: 'Answered.', waitFor: 'player_reply' });
  player('My air units at Northfield Airbase say no supply even with the depot connected.');
  await t('read_tool', { server: 'gamestate', tool: 'map_snapshot', args: {} });
  await t('read_tool', { server: 'ops-knowledge', tool: 'code_search', args: { query: 'airbase supplied depotConnected', claimType: 'mechanic' } });
  await t('raise_to_developers', { kind: 'bug', title: 'Connected airbase shows no supply', detail: 'Northfield Airbase is connected to its depot but reports supplied false.', issue });
  await t('channel_reply', { message: 'Your depot is connected but the airbase still shows no supply, which is a bug. I have passed it to the developers with the details.' });
  await t('finish', { state: 'waiting', summary: 'Bug filed, player told.', waitFor: 'player_reply' });
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, true, JSON.stringify(g, null, 1));
});

test('bad: a question becomes an owner decision and the supply bug is never filed', async () => {
  const { env, t, player } = start(sc);
  await t('read_tool', { server: 'ops-knowledge', tool: 'knowledge_query', args: { query: 'assign generals' } });
  await t('raise_to_developers', { kind: 'decision', changeClass: 'balance', title: 'Should generals be assignable to several conflicts', detail: 'The player asked how to assign generals; whether to allow several conflicts is a rule choice.' }).catch(() => {});
  await t('channel_reply', { message: 'Open the conflict page and choose Assign general.' });
  player('My air units say no supply.');
  await t('read_tool', { server: 'gamestate', tool: 'map_snapshot', args: {} });
  await t('channel_reply', { message: 'Air units draw supply from the airbase, so that is how it works.' });
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.state.issue_count.ok, false);
});

test('bad: too many posts that contradict each other', async () => {
  const { env, t, player } = start(sc);
  await t('read_tool', { server: 'ops-knowledge', tool: 'knowledge_query', args: { query: 'assign generals' } });
  const say = async (m) => { await t('channel_reply', { message: m }).catch(() => {}); env.job.state = 'running'; };
  await say('Open the conflict page, choose Assign general and confirm.');
  player('And logistics?'); await t('read_tool', { server: 'gamestate', tool: 'map_snapshot', args: {} });
  await say('Air units draw supply fine from their airbase, supply is working.');
  player('It says no supply!'); await t('read_tool', { server: 'gamestate', tool: 'game_overview', args: {} });
  await say('The airbase is not receiving supply right now.');
  player('So?'); await say('Still looking at supply.'); player('?'); await say('Checking supply again.');
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.ok(!g.state.within_post_budget.ok || !g.state.no_contradiction_0.ok);
});
