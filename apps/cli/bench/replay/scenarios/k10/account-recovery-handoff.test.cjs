'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { start } = require('../../k10-start.cjs'), { gradeK10 } = require('../../k10.cjs');
const sc = { ...require('./account-recovery-handoff.cjs'), dir: __dirname };
const read = async (t) => { await t('read_tool', { server: 'ops-knowledge', tool: 'code_search', args: { question: 'registration block second account same device', claimType: 'mechanic', source: 'dev' } }); await t('read_tool', { server: 'gamestate', tool: 'game_overview', args: {} }); };
const recovery = { kind: 'question', title: 'Account recovery: relink the old account to the new Discord', detail: 'Old Discord was banned by Discord; the registration gate blocks the new Discord from the same phone. The old game account is not banned. Needs a staff relink.', force: true };

test('ideal: the recovery is handed to a person, then the player is told honestly', async () => {
  const { env, t } = start(sc); await read(t);
  await t('raise_to_developers', recovery);
  const rec = env.job.raisedToDevelopers[0];
  assert.ok(!rec.selfOwned, 'an account action is never Keir\'s own to-do');
  assert.ok(Object.keys(env.ledger.data.outbox).some((k) => k.startsWith('handoff:')), 'the owner is told');
  await t('channel_reply', { message: 'The game blocked the new Discord because your phone was used with the old account. I passed your old account details to staff for a relink and will update you here.' });
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, true, JSON.stringify(g, null, 1));
});

test('bad: a self-assigned card, then telling the player the developers have it, is refused', async () => {
  const { env, t } = start(sc); await read(t);
  await t('raise_to_developers', { kind: 'question', title: 'Check why this player cannot register', detail: 'The player reports a registration failure on mobile. Need to check the gate and the old character.', force: true });
  assert.ok(env.job.raisedToDevelopers[0].selfOwned);
  await assert.rejects(t('channel_reply', { message: 'I passed your old Discord and character name to the developers for a recovery check.' }), /reached them|developers have it/);
});
