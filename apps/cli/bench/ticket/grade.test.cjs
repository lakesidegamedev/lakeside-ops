'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const { createWorld } = require('./world.cjs'), { grade } = require('./grade.cjs');
const world = () => createWorld({ repoDir: path.join(__dirname, 'repo'), stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tsim-')) });
const J = {};

test('an ideal handling scores 100', async () => {
  const w = world();
  await w.tool(J, 'progress_update', { message: "I'm checking your shipyard's staffing and the wage change now." });
  await w.tool(J, 'read_tool', { server: 'gamestate', tool: 'trace_sector', args: {} });
  await w.tool(J, 'channel_reply', { message: 'Did you change the wage in the desktop app or on the website, and what did you type?' });
  await w.tool(J, 'finish', { state: 'waiting', summary: 'Asked which client.', waitFor: 'player_reply' });
  w.state.activation = 1; w.nextInbox();
  await w.tool(J, 'github', { action: 'issues', query: 'desktop wage workers' });
  await w.tool(J, 'raise_to_developers', { title: 'Another report', detail: 'Desktop app 2.4.0 sends the wage as text; applyOfferedWage stores null so hiring stops.', issueNumber: 812 });
  await w.tool(J, 'status_card', { items: [{ name: 'Wage not saved from the desktop app', stage: 'found' }] });
  await w.tool(J, 'support_action', { tool: 'support_tracker_note', args: { body: 'Linked to the known desktop wage fault.' } });
  await w.tool(J, 'support_action', { tool: 'support_set_status', args: { status: 'in_progress' } });
  await w.tool(J, 'support_action', { tool: 'support_public_update', args: { message: 'Found it. The desktop app is not saving your wage, a known fault the developers are fixing, so nobody will work for you. Set the wage again on the website and hiring restarts next turn.' } });
  await w.tool(J, 'finish', { state: 'done', summary: 'Workaround given; evidence on the known issue.' });
  const g = grade(w);
  assert.equal(g.score, 100, JSON.stringify(g.checks, null, 1));
});

test('guessing without asking, filing a duplicate and promising money scores low', async () => {
  const w = world();
  await w.tool(J, 'channel_reply', { message: 'Sorry about that! It was probably a strike.' });
  await w.tool(J, 'raise_to_developers', { title: 'Shipyard workers zero after wage change', detail: 'Player lost workers.' });
  await w.tool(J, 'channel_reply', { message: "We'll compensate you for the lost turns, I've filed issue #900." });
  const g = grade(w);
  assert.ok(g.score <= 20, String(g.score));
  assert.equal(g.checks.found_existing_issue.pts, 0);
});

test('asking only for observable facts earns no question credit and gets a deflecting answer', async () => {
  const w = world();
  await w.tool(J, 'channel_reply', { message: 'How many workers does it show right now?' });
  w.state.activation = 1; const inbox = w.nextInbox();
  assert.match(inbox[0].text, /Can't you see that/);
  assert.equal(grade(w).checks.asked_right_question.pts, 0);
});

test('a duplicate bug report is refused with the existing issue as a candidate, like the broker', async () => {
  const w = world();
  const r = await w.tool(J, 'raise_to_developers', { kind: 'bug', title: 'Wage change leaves shipyard with zero workers', detail: 'After a wage change from the desktop app the sector has no wage and loses all workers.' });
  assert.equal(r.raised, false);
  assert.ok(r.issueCandidates.some((c) => c.number === 812));
  assert.equal(w.state.newIssues.length, 0);
  const forced = await w.tool(J, 'raise_to_developers', { kind: 'bug', title: 'Wage change leaves shipyard with zero workers', detail: 'x', force: true });
  assert.equal(forced.raised, true);
});
