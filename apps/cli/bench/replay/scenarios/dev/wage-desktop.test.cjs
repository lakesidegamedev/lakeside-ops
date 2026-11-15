'use strict';
// Proves the scenario is solvable under the real broker's rules, and that the grader separates good from bad handling.
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const { createEnv } = require('../../env.cjs'), { grade } = require('../../grade.cjs');
const sc = { ...require('./wage-desktop.cjs'), dir: __dirname };
const start = () => { const env = createEnv({ scenario: sc, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'scn-')) }); env.job.state = 'running'; return { env, t: (name, input) => env.broker.tool(env.job, name, input) }; };
const issue = { summary: 'Setting a wage from the desktop app saves no wage', steps: ['Open the desktop app', 'Change a sector wage', 'Next turn the sector has 0 workers'], expected: 'The wage is saved', actual: 'No wage is saved and every worker leaves', impact: 'Players who set wages in the desktop app lose their whole workforce' };

test('ideal handling under the real broker succeeds', async () => {
  const { env, t } = start();
  await t('progress_update', { message: "Checking your shipyard's staffing and the wage change now." });
  await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  await t('read_tool', { server: 'gamestate', tool: 'trace_sector', args: {} });
  await t('reporter_state', {});
  await t('channel_reply', { message: 'Did you change the wage in the desktop app or on the website?' });
  await t('finish', { state: 'waiting', summary: 'Asked which client.', waitFor: 'player_reply' });
  env.playerReply(sc.answers[0].text); env.job.state = 'running';
  await t('raise_to_developers', { kind: 'bug', title: 'Desktop app wage change saves no wage', detail: 'Desktop app sends the wage as text; the server stores no wage; hiring stops.', issueNumber: 812, issue });
  await t('channel_reply', { message: 'Found it. The desktop app is not saving your wage, a known fault the developers are fixing. Set the wage again on the website and hiring restarts next turn.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, true, JSON.stringify(g, null, 1));
});

test('a forced duplicate issue and an invented client fail', async () => {
  const { env, t } = start();
  await t('read_tool', { server: 'gamestate', tool: 'trace_sector', args: {} });
  await t('channel_reply', { message: 'Your desktop app saved the wage as blank. Set it again on the website.' });
  await t('raise_to_developers', { kind: 'bug', title: 'Wage blank after desktop change', detail: 'After a wage change from the desktop app the shipyard has no offered wage on record and every worker left; trace_sector shows offeredWage null from turn 211.', force: true, issue });
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, false); assert.equal(g.unobservable, 'invented'); assert.equal(g.state.no_duplicate_issue.ok, false);
});
