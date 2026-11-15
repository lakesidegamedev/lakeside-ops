'use strict';
// Proves the scenario is solvable under the real broker's rules, and that the grader separates good from bad handling.
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const { createEnv } = require('../../env.cjs'), { grade } = require('../../grade.cjs');
const sc = { ...require('./revise-after-new-info.cjs'), dir: __dirname };
const start = () => { const env = createEnv({ scenario: sc, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'scn-')) }); env.job.state = 'running'; return { env, t: (name, input) => env.broker.tool(env.job, name, input) }; };
const FIRST = 'Lagos port has been closed since turn 216 after storm damage to the docks, so your Liverpool to Lagos route is suspended. Your 6 ships and the 3,200 tonnes of textiles are safe on board and nothing is lost. The route can sail again once the port is open.';

async function firstAnswer(env, t) {
  await t('progress_update', { message: 'Checking your Lagos route and the ports it calls at now.' });
  await t('read_tool', { server: 'gamestate', tool: 'game_overview', args: {} });
  await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  await t('read_tool', { server: 'gamestate', tool: 'trace_sector', args: {} });
  await t('reporter_state', {});
  await t('channel_reply', { message: FIRST });
  await t('finish', { state: 'waiting', summary: 'Explained the Lagos closure.', waitFor: 'player_reply' });
  // run.cjs: the scripted follow-up after activation 0.
  env.playerReply(sc.followUps[0].text); env.job.state = 'running';
}

test('the fixture changes once the player has written', async () => {
  const { env, t } = start();
  const before = await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  assert.equal(before.ports[0].status, 'closed');
  env.playerReply(sc.followUps[0].text);
  const after = await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  assert.equal(after.ports[0].status, 'open'); assert.equal(after.shippingRoutes[0].status, 'suspended'); assert.equal(after.shippingRoutes[0].resumable, true);
});

test('ideal handling under the real broker succeeds', async () => {
  const { env, t } = start();
  await firstAnswer(env, t);
  await t('read_tool', { server: 'gamestate', tool: 'game_overview', args: {} });
  await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  await t('channel_reply', { message: 'Lagos did reopen on turn 219, and that changes the answer. A route paused by a closed port does not restart on its own: open the Liverpool to Lagos route page and press Resume. Your ships sail from the next turn.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, true, JSON.stringify(g, null, 1));
  assert.equal(g.communicationScore, 1, JSON.stringify(g.communication));
});

test('repeating the first answer without a fresh read fails', async () => {
  const { env, t } = start();
  await firstAnswer(env, t);
  await t('channel_reply', { message: 'As I said, the Lagos port is still closed after the storm damage. Your ships will sail once Lagos reopens.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.process.reread_after_reply.ok, false);
  assert.equal(g.state.revised_conclusion.ok, false);
  assert.equal(g.state.no_stale_repeat.ok, false);
});

test('re-reading but keeping the old conclusion fails', async () => {
  const { env, t } = start();
  await firstAnswer(env, t);
  await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  await t('channel_reply', { message: 'The port only reopened this turn. Give it a turn: the route restarts automatically and your ships sail by themselves.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.process.reread_after_reply.ok, true);
  assert.equal(g.state.revised_conclusion.ok, false);
  assert.equal(g.state.no_stale_repeat.ok, false);
});

test('blaming a bug and filing it, then repeating, fails', async () => {
  const { env, t } = start();
  await firstAnswer(env, t);
  await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  await t('raise_to_developers', { kind: 'bug', title: 'Shipping route stays suspended after its port reopens', detail: 'A route suspended by a port closure on turn 216 is still suspended on turn 219 after the port reopened.', force: true,
    issue: { summary: 'A shipping route suspended by a port closure stays suspended after the port reopens.', steps: ['Run a route to a port', 'Wait for the port to close and reopen'], expected: 'The route sails again', actual: 'The route stays suspended', impact: 'Shipping companies with routes to a port that closed' } });
  await t('channel_reply', { message: 'Lagos is open, but the route has not picked it up yet. Wait until the port reopens fully next turn and the ships will move.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.state.no_issue_filed.ok, false);
  assert.equal(g.state.no_stale_repeat.ok, false);
});
