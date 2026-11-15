'use strict';
// Scenario (ticket 1812 first activation, synthetic). The answer is posted; the
// model then tries extra posts the broker refuses and burns its step limit.
// Ideal: post once, finish waiting, accepted, almost no refusals.
module.exports = {
  id: 'guard-deadlock',
  summary: 'After the answer is posted the run must finish, not chase extra posts into the step limit',
  ticket: 4404, player: 'ledger_keeper', category: 'question', title: 'Where do I see my tax bill',
  opening: 'Where can I see how much tax my company owes this turn?',
  fallbackAnswer: 'Thanks.',
  game: { game_overview: { turn: 240, year: 1958 }, trace_corp: { corporation: { name: 'Keeper Freight', currency: 'USD', liquidCapital: 410000 }, taxDueThisTurn: 18200 }, character: { name: 'T. Ibsen', country: 'Eastmark', region: 'South', office: null, corporation: 'Keeper Freight' } },
  mcp: { 'ops-knowledge': { code_search: () => ({ results: [{ path: 'src/app/corporation/Finances.tsx', text: 'The Finances tab of a corporation page lists taxDueThisTurn under Tax.' }] }) } },
  spec: {
    liveReadServers: ['gamestate'],
    noDecision: true,
    k10: { maxPosts: 1, finishAccepted: true, maxRefusals: 1 },
  },
};
