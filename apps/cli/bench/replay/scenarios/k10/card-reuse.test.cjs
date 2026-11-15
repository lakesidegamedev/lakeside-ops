'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { start } = require('../../k10-start.cjs'), { gradeK10 } = require('../../k10.cjs');
const sc = { ...require('./card-reuse.cjs'), dir: __dirname };
const reads = async (t) => {
  await t('read_tool', { server: 'ops-knowledge', tool: 'code_search', args: { question: 'loan row currency symbol and bill page vote count', claimType: 'mechanic', source: 'dev' } });
  await t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
  await t('read_tool', { server: 'gamestate', tool: 'legislation_catalog', args: {} });
};
const loan = { kind: 'bug', title: 'Loan rows show the wrong currency symbol', detail: 'LoanRow formats a GBP loan with the dollar sign.', issue: { summary: 'Bank page loan rows use the anchor currency symbol', steps: ['Open the bank page of a corporation with a GBP loan'], expected: 'A pound sign', actual: 'A dollar sign', impact: 'Players misread loan sizes' } };
const votes = { kind: 'bug', title: 'Bill page yes count lags the bill list', detail: 'BillPage reads a cached tally; the list reads recorded votes.', issue: { summary: 'Roads Bill page shows 12 yes while the list shows 14', steps: ['Open a bill with recent votes'], expected: 'The same count as the list', actual: 'A lower count', impact: 'Players misjudge whether a bill will pass' } };

test('ideal: two defects, two separate items', async () => {
  const { env, t } = start(sc); await reads(t);
  await t('raise_to_developers', loan);
  // Keir 10: the issue this task just filed for the other defect is no longer offered back as a duplicate, so it files at once.
  const second = await t('raise_to_developers', votes);
  assert.equal(second.raised, true);
  await t('channel_reply', { message: 'I have raised both as separate items for the developers: the pound loan showing a dollar sign, and the Roads Bill count that is lower on the page than in the list.' });
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, true, JSON.stringify(g, null, 1));
});

test('bad: both defects crammed into one item', async () => {
  const { env, t } = start(sc); await reads(t);
  await t('raise_to_developers', { ...loan, title: 'Loan symbol and bill vote count are wrong', detail: `${loan.detail} Also ${votes.detail}` });
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, false);
  assert.equal(g.state.issue_count.ok, false);
});

test('bad: the second defect is glued onto the first item', async () => {
  const { env, t } = start(sc); await reads(t);
  const first = await t('raise_to_developers', loan);
  await t('raise_to_developers', { ...votes, issueNumber: first.issue }).catch(() => {});
  await t('channel_reply', { message: 'Both are logged with the developers.' }).catch(() => {});
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, false);
});
