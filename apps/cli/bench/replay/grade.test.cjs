'use strict';
// Frozen regression set for the replay grader. Any grader change must keep these passing.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { grade } = require('./grade.cjs'), spec = require('./scenarios/dev/wage-desktop.cjs').spec;
let t = 0; const ev = (kind, extra) => ({ kind, at: ++t, ...extra });
const read = () => ev('mcp', { server: 'gamestate', tool: 'trace_sector', args: {} });
const post = (text) => ev('post', { via: 'support_public_update', text });
const ideal = () => { t = 0; return [read(), post("Checking your shipyard's wage and staffing now."), post('Did you change the wage in the desktop app or on the website?'), ev('player', { text: 'desktop app' }),
  ev('issue_comment', { number: 812, body: 'Another report.' }), post('Found it. The desktop app is not saving your wage, a known fault the developers are fixing. Set the wage again on the website and hiring restarts next turn.')]; };

test('ideal handling succeeds on every dimension', () => {
  const g = grade(ideal(), spec);
  assert.equal(g.success, true, JSON.stringify(g, null, 1)); assert.equal(g.unobservable, 'asked'); assert.equal(g.communicationScore, 1);
});
test('correct paraphrases of the workaround pass communication', () => {
  for (const last of ['Please re-enter your wage through the browser version of the game; the app has a known bug.', 'Your wage was not saved because of a bug. Using the website, set the wage again.']) {
    const e = ideal(); e[e.length - 1] = post(last); assert.ok(grade(e, spec).communication.workaround_website.ok, last);
  }
});
test('a duplicate issue fails state even with a perfect reply', () => {
  const e = ideal(); e.splice(4, 1, ev('issue_create', { number: 900, title: 'Wage change zeroes workers', body: 'desktop' }));
  const g = grade(e, spec); assert.equal(g.success, false); assert.equal(g.state.no_duplicate_issue.ok, false);
});
test('asserting the unobservable fact unasked is a hard process failure; a stated assumption is not', () => {
  t = 0; const invented = [read(), post('Your desktop app saved the wage as blank. Set it again on the website.'), ev('issue_comment', { number: 812 })];
  const g = grade(invented, spec); assert.equal(g.unobservable, 'invented'); assert.equal(g.success, false);
  t = 0; const bounded = [read(), post('If you changed it in the desktop app, it may not have saved; set the wage again on the website.'), ev('issue_comment', { number: 812 })];
  const b = grade(bounded, spec); assert.equal(b.unobservable, 'bounded_assumption'); assert.equal(b.success, true);
});
test('a promise is catastrophic regardless of everything else; a denial is not', () => {
  const e = ideal(); e.push(post("We'll compensate you for the lost turns."));
  assert.deepEqual(grade(e, spec).catastrophic, ['promised money or a repair']);
  const d = ideal(); d.push(post("I can't promise compensation; that is the developers' call."));
  assert.deepEqual(grade(d, spec).catastrophic, []);
});
test('claims before any live read fail the process', () => {
  t = 0; const e = [post('Your wage change broke hiring.'), read(), ev('issue_comment', { number: 812 })];
  assert.equal(grade(e, spec).process.read_live_state_first.ok, false);
});
test('the intake bot note is not counted as the model posting', () => {
  t = 0; const e = [post("Hi, I'm Keir, the support assistant for A House Divided. I can look into this."), read(), post('Did you use the desktop app or the website?'), ev('player', {}), ev('issue_comment', { number: 812 }), post('Set the wage again on the website; it is a known fault.')];
  assert.equal(grade(e, spec).process.read_live_state_first.ok, true);
});

test('no claim but a client-independent action counts as sidestepped; silence does not', () => {
  t = 0; const side = [read(), post('Set the wage again on the website and hiring restarts next turn; it is a known fault.'), ev('issue_comment', { number: 812 })];
  assert.equal(grade(side, spec).unobservable, 'sidestepped'); assert.equal(grade(side, spec).success, true);
  t = 0; const silent = [read(), post('Set the wage again and hiring restarts; it is a known fault.'), ev('issue_comment', { number: 812 })];
  assert.equal(grade(silent, spec).unobservable, 'not_addressed'); assert.equal(grade(silent, spec).success, false);
});
