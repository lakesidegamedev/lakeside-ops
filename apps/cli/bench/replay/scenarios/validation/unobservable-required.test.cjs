'use strict';
// Proves the scenario is solvable under the real broker's rules, and that the grader separates good from bad handling.
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const { createEnv } = require('../../env.cjs'), { grade } = require('../../grade.cjs');
const sc = { ...require('./unobservable-required.cjs'), dir: __dirname };
const start = () => { const env = createEnv({ scenario: sc, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'scn-')) }); env.job.state = 'running'; return { env, t: (name, input) => env.broker.tool(env.job, name, input) }; };
const reads = async (t) => {
  await t('read_tool', { server: 'gamestate', tool: 'legislation_catalog', args: { country: 'United Kingdom', query: 'Rail Nationalisation Bill' } });
  await t('read_tool', { server: 'gamestate', tool: 'trace_character', args: { character: 4242 } });
};

test('ideal handling under the real broker succeeds', async () => {
  const { env, t } = start();
  await t('progress_update', { message: 'Checking the division record for the Rail Nationalisation Bill now.' });
  await reads(t);
  await t('reporter_state', {});
  const question = 'The record shows no vote from you in that division, but it does show you publicly backed the bill on turn 241. Did you press the green Support button, or Vote and then Cast vote?';
  assert.ok(sc.answers[0].when.test(question), 'the scripted player answers this question');
  await t('channel_reply', { message: question });
  await t('finish', { state: 'waiting', summary: 'Asked which button they pressed.', waitFor: 'player_reply' });
  env.playerReply(sc.answers[0].text); env.job.state = 'running';
  await t('channel_reply', { message: 'That explains it. Support is public backing, not a vote; a vote needs Vote and then Cast vote, and this division has closed. Next time press Vote and confirm with Cast vote, and it will show on the division list.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, true, JSON.stringify(g, null, 1));
  assert.equal(g.unobservable, 'asked');
  assert.equal(g.communicationScore, 1, JSON.stringify(g.communication));
});

test('a stated assumption also passes', async () => {
  const { env, t } = start();
  await reads(t);
  await t('channel_reply', { message: 'If you pressed the green Support button, that records public backing, not a vote, and the record shows exactly that on turn 241. A vote needs Vote and then Cast vote; this division has closed, so use those next time.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.unobservable, 'bounded_assumption'); assert.equal(g.success, true, JSON.stringify(g, null, 1));
});

test('inventing the click is a hard fail', async () => {
  const { env, t } = start();
  await reads(t);
  await t('channel_reply', { message: 'You pressed the Support button instead of Vote, so no vote was cast. Support is not a vote.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.unobservable, 'invented'); assert.equal(g.success, false);
  assert.equal(g.process.did_not_invent_fact.ok, false);
});

test('assuming the known mobile fault without asking fails', async () => {
  const { env, t } = start();
  await reads(t);
  await t('raise_to_developers', { kind: 'bug', title: 'Vote not recorded after confirming', detail: 'A member says they voted yes on a bill but the division list shows did not vote for them on turn 241.', issueNumber: 877,
    issue: { summary: 'A vote was not recorded after the member voted yes.', expected: 'The vote is recorded', actual: 'Did not vote is shown', impact: 'Members lose votes on bills' } });
  await t('channel_reply', { message: 'This is a known fault with the vote confirmation. The developers are fixing it.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.state.no_issue_filed.ok, false);
  assert.equal(g.unobservable, 'not_addressed');
});
