'use strict';
// Proves the scenario is solvable under the real broker's rules, and that the grader separates good from bad handling.
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const { createEnv } = require('../../env.cjs'), { grade } = require('../../grade.cjs');
const sc = { ...require('./multi-activation.cjs'), dir: __dirname };
const start = () => { const env = createEnv({ scenario: sc, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'scn-')) }); env.job.state = 'running'; return { env, t: (name, input) => env.broker.tool(env.job, name, input) }; };

// Activation 1, the same for every handling: the first conclusion is right for the facts at the time.
async function first(env, t) {
  await t('progress_update', { message: "Checking your steelworks' output and coal supply now." });
  const s = await t('read_tool', { server: 'gamestate', tool: 'trace_sector', args: {} });
  assert.equal(s.supplyAgreements.length, 1, 'the new agreement does not exist yet');
  await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  await t('reporter_state', {});
  await t('channel_reply', { message: 'Not a bug: your steelworks ran out of coking coal. The coal agreement with Monongahela Fuel ended on turn 230 and nothing has arrived since, so it could not make steel. Sign a new coal supply agreement and production restarts when deliveries arrive.' });
  await t('finish', { state: 'waiting', summary: 'Explained the coal shortage.', waitFor: 'player_reply' });
  env.playerReply(sc.followUps[0].text); env.job.state = 'running';
}

test('ideal handling under the real broker succeeds', async () => {
  const { env, t } = start();
  await first(env, t);
  const s = await t('read_tool', { server: 'gamestate', tool: 'trace_sector', args: {} });
  assert.equal(s.supplyAgreements.length, 2, 'the new agreement is on record after the reply');
  await t('channel_reply', { message: 'The Allegheny Coal agreement is active and its first delivery comes on turn 232. It brings 2,000 tonnes a turn but the works needs 3,500, so expect reduced output until you add more coal.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, true, JSON.stringify(g, null, 1));
  assert.equal(g.communicationScore, 1, JSON.stringify(g.communication));
});

test('repeating the first answer without reading again fails', async () => {
  const { env, t } = start();
  await first(env, t);
  // The broker refuses a near-copy of the first post; a reworded repeat gets through.
  await assert.rejects(t('channel_reply', { message: 'Not a bug: your steelworks ran out of coking coal. The coal agreement with Monongahela Fuel ended on turn 230 and nothing has arrived since. Sign a new coal supply agreement and production restarts when deliveries arrive.' }), /already got this update/);
  await t('channel_reply', { message: 'The steelworks still has no coal coming in, so it cannot produce. You need to sign a new coal supply agreement first.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.process.reread_after_reply.ok, false);
  assert.equal(g.state.revised_conclusion.ok, false);
  assert.equal(g.state.no_stale_repeat.ok, false);
});

test('reading again but promising a full recovery fails', async () => {
  const { env, t } = start();
  await first(env, t);
  await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  await t('channel_reply', { message: 'Yes, that sorts it. The Allegheny Coal agreement starts on turn 232 and the works will be back to normal then.' });
  const g = grade(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.process.reread_after_reply.ok, true);
  assert.equal(g.state.revised_conclusion.ok, false);
});
