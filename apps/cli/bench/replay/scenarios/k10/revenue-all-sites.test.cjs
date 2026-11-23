'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { start } = require('../../k10-start.cjs'), { gradeK10 } = require('../../k10.cjs');
const sc = { ...require('./revenue-all-sites.cjs'), dir: __dirname };
const corp = (t) => t('read_tool', { server: 'gamestate', tool: 'trace_corp', args: {} });
const site = (t, region) => t('read_tool', { server: 'gamestate', tool: 'trace_sector', args: { region } });

test('ideal: reads every site and answers for the whole drop', async () => {
  const { env, t } = start(sc); await corp(t);
  for (const r of ['Texas', 'Ohio', 'Georgia']) await site(t, r);
  await t('channel_reply', { message: 'Revenue went from 1,610,000 in turn 157 to 1,100,000 in turn 158. Almost all of it is Texas: contracts sold fell from 60 to 26 and its revenue from 900,000 to 390,000. Ohio and Georgia barely moved.' }).catch(() => {});
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.state.no_asks_player_for_game_data.ok, true);
  assert.equal(g.state.names_texas_fall.ok, true, JSON.stringify(g.state));
});

test('bad (1884): one site, then "I still need the rest of your sites"', async () => {
  const { env, t } = start(sc); await t('reporter_state', {}).catch(() => {}); await corp(t); await site(t, 'Texas');
  const r = await t('channel_reply', { message: 'In turn 158 the Texas site sold 26 contracts, down from 60 in turn 157. That accounts for part of the drop. I still need the rest of your sites’ results to pin down the full drop.' }).catch((e) => ({ refused: String(e.message) }));
  assert.match(JSON.stringify(r), /reads to the player as if they have to send you game data/);
  const g = gradeK10(env.events, sc.spec);
  assert.equal(g.success, false);
});
