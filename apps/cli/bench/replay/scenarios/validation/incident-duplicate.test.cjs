'use strict';
// Proves the scenario is solvable under the real broker's rules, and that the grader separates good from bad handling.
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const { createEnv } = require('../../env.cjs'), { grade } = require('../../grade.cjs');
const sc = { ...require('./incident-duplicate.cjs'), dir: __dirname };
const start = () => { const env = createEnv({ scenario: sc, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'scn-')) }); env.job.state = 'running'; return { env, t: (name, input) => env.broker.tool(env.job, name, input) }; };

test('ideal handling under the real broker succeeds', async () => {
  const { env, t } = start();
  const record = await t('read_tool', { server: 'support', tool: 'support_get', args: { kind: 'ticket', number: 4344 } });
  assert.equal(record.supportRecentVisits[0].status, 500);
  const similar = await t('similar_reports', { text: 'company money page says Something went wrong' });
  assert.equal(similar.tickets.length, 3);
  await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  const r = await t('merge_into_incident', { incident: 4290, reason: 'Same bank page error: the reporter\'s last bank page visit failed and their company has an open loan.' });
  assert.equal(r.merged, true);
  // The ticket is closed now; the broker refuses further posts from this task.
  await assert.rejects(t('channel_reply', { message: 'Moved you to the bank page incident.' }), /inactive/);
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, true, JSON.stringify(g, null, 1));
  assert.equal(g.communication.merge_reason_one_line.ok, true);
});

test('asking which page is refused once because the ticket already shows it', async () => {
  const { t } = start();
  await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  await assert.rejects(t('channel_reply', { message: 'Which page is it, the bank page or the exchange page?' }), /already points at/);
});

test('merging into the look-alike incident fails', async () => {
  const { env, t } = start();
  await t('similar_reports', { text: 'company money page says Something went wrong' });
  await t('merge_into_incident', { incident: 4288, reason: 'Same Something went wrong error on a company money page.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.state.merged_into_incident.ok, false);
  assert.equal(g.state.no_wrong_merge.ok, false);
});

test('filing a fresh issue and answering in place instead of merging fails', async () => {
  const { env, t } = start();
  await t('read_tool', { server: 'support', tool: 'support_get', args: { kind: 'ticket', number: 4344 } });
  await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  await t('raise_to_developers', { kind: 'bug', title: 'Company bank page shows Something went wrong', detail: 'The reporter\'s bank page returns an error on every visit since turn 231; their deposits and loan are intact.', force: true,
    issue: { summary: 'The corporation bank page fails with Something went wrong for a company with an open loan.', steps: ['Open a corporation bank page'], expected: 'The page loads', actual: 'Something went wrong', impact: 'Companies with loans cannot manage them before the turn' } });
  await t('channel_reply', { message: 'Your bank page is failing, but your money and loan are safe. The developers have it.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.state.merged_into_incident.ok, false);
  assert.equal(g.state.no_issue_filed.ok, false);
});
