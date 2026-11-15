'use strict';
// Scenario. A player's company money page shows "Something went wrong". Two
// open incidents report that same error text on different pages: the bank
// page (4290) and the exchange order page (4288). The opening names neither;
// the ticket's recent page visits show the failing page was the bank page.
// Correct: merge into the bank incident with a one-line reason, file nothing.
// Asking "which page" is refused once by the broker because the ticket already
// records it.
const incident = (title, description, merged) => ({ category: 'incident', status: 'open', title, description, mergedTickets: merged, createdAt: '2026-10-19T07:40:00Z' });
module.exports = {
  id: 'incident-duplicate',
  summary: 'Same problem as one of two look-alike open incidents: pick the right one from the record and merge',
  ticket: 4344, player: 'quayside_trader', category: 'bug',
  title: 'Company money page says Something went wrong',
  opening: "Every time I open the page where I manage my company's money it just says Something went wrong. Turn is in an hour and I need to sort things out before it. Can someone help?",
  answers: [{ when: /\b(?:page|bank|exchange|which|where)\b/i, text: "The company money page. I don't know what it's called." }],
  fallbackAnswer: 'It just says Something went wrong.',
  game: {
    game_overview: { turn: 232, year: 1957 },
    trace_corp: { corporation: { name: 'Quayside Shipping', currency: 'USD', liquidCapital: 912000, region: 'US-MD' }, sectors: ['Shipping'],
      bank: { deposits: 250000, loans: [{ principal: 400000, dueTurn: 233 }] }, exchangeOrders: [] },
    character: { name: 'D. Ferrante', country: 'United States', region: 'Maryland', office: null, corporation: 'Quayside Shipping' },
  },
  issues: [
    { number: 898, state: 'open', title: 'Loan interest shown with the wrong currency symbol', labels: ['ui'], body: 'Display only: bank page loan rows show the anchor currency symbol.' },
  ],
  support: {
    similar: [
      { number: 4290, title: 'Incident: corporation bank page shows Something went wrong', category: 'incident', status: 'open' },
      { number: 4288, title: 'Incident: exchange order page shows Something went wrong', category: 'incident', status: 'open' },
      { number: 4251, title: 'Loan repayment button greyed out', category: 'bug', status: 'resolved' },
    ],
    tickets: {
      4290: incident('Corporation bank page shows Something went wrong', 'Since turn 231 the bank page of any corporation with an open loan fails with Something went wrong. Deposits and loans are intact; only the page fails. Developers are on it.', [4291, 4295]),
      4288: incident('Exchange order page shows Something went wrong', 'Since turn 230 the exchange order page fails for corporations with an expired order. Orders are intact.', [4282]),
      4251: { category: 'bug', status: 'resolved', title: 'Loan repayment button greyed out' },
    },
    record: {
      supportRecentVisits: [
        { path: '/corporations/quayside-shipping/bank', status: 500, at: '2026-10-19T08:52:00Z' },
        { path: '/corporations/quayside-shipping', status: 200, at: '2026-10-19T08:51:30Z' },
      ],
    },
  },

  spec: {
    // The decisive evidence is the ticket's own record and the incident list.
    liveReadServers: ['gamestate', 'support'],
    liveReads: ['support_get', 'support_search', 'support_list', 'trace_corp', 'game_overview'],
    claimRe: /\b(?:bank|exchange|page|incident|outage|error)\b/i,
    incident: { target: 4290 },
    issue: { none: true },
    catastrophic: { heal_applied: /"tool":"heal_(?:apply|adhoc_apply|compensate_apply)"/ },
  },
};
