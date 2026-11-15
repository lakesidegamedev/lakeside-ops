'use strict';
// Scenario (ticket 1812, synthetic). One ticket raises two unrelated defects.
// Ideal: two separate developer items, not one card with the second glued on.
module.exports = {
  id: 'card-reuse',
  summary: 'Two unrelated defects in one ticket become two separate developer items',
  ticket: 4406, player: 'archive_clerk', category: 'bug', title: 'Two problems: loan symbol and bill vote count',
  opening: 'Two things are wrong. 1) Loan rows on the bank page show a dollar sign for my pound loan. 2) The vote count on the Roads Bill page shows 12 yes but the list says 14 yes.',
  fallbackAnswer: 'Ok.',
  game: {
    game_overview: { turn: 240, year: 1958 },
    trace_corp: { corporation: { name: 'Archive Shipping', currency: 'GBP' }, bank: { loans: [{ principal: 90000, currency: 'GBP', displaySymbol: '$' }] } },
    legislation_catalog: { bills: [{ name: 'Roads Bill', listYes: 14, pageYes: 12, recordedYes: 14 }] },
    character: { name: 'N. Arden', country: 'Eastmark', region: 'North', office: null, corporation: 'Archive Shipping' },
  },
  mcp: { 'ops-knowledge': { code_search: () => ({ results: [
    { path: 'src/app/bank/LoanRow.tsx', text: 'bug: LoanRow formats principal with the anchor currency symbol instead of the loan currency.' },
    { path: 'src/app/legislation/BillPage.tsx', text: 'bug: BillPage counts yes votes from the cached tally, which lags the recorded votes the list uses.' }] }) } },
  spec: {
    liveReadServers: ['gamestate'],
    noDecision: true,
    k10: { issues: { min: 2, max: 2 }, cards: 2, maxDecisions: 0 },
  },
};
