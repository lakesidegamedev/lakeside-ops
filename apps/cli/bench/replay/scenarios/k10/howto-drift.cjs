'use strict';
// Scenario (from ticket 1812, synthetic data). A how-to question, then follow-ups
// that drift: logistics units, then an air supply problem that is a real bug.
// Ideal: each question answered from reads, the supply bug becomes ONE issue,
// no owner decision for a question, no contradicting posts, within 4 posts.
module.exports = {
  id: 'howto-drift',
  summary: 'How-to question with drifting follow-ups; the real supply bug gets its own issue, questions never reach the owner',
  ticket: 4401, player: 'harbour_marshal', category: 'question', title: 'How do I assign generals to a conflict',
  opening: 'How do I assign generals to a conflict?',
  answers: [{ when: /\b(?:logistics|supply|airbase)\b/i, text: 'It still says no supply.' }],
  fallbackAnswer: 'Thanks.',
  game: {
    game_overview: { turn: 240, year: 1958 },
    map_snapshot: { airbases: [{ name: 'Northfield Airbase', depotConnected: true, supplied: false, supplySource: 'Northfield Depot', airUnits: 3 }] },
    character: { name: 'R. Calder', country: 'Eastmark', region: 'North', office: 'Minister of Defence' },
  },
  knowledge: [{ id: 'k-generals', title: 'Generals and conflicts', text: 'Open the conflict page, choose Assign general, pick a general who is not already commanding, and confirm. A general commands one conflict at a time.' },
    { id: 'k-logistics', title: 'Logistics units', text: 'Logistics units carry supply to units in the field. A unit out of supply fights at reduced strength. Air units draw supply from the airbase they are stationed at.' }],
  mcp: { 'ops-knowledge': { code_search: () => ({ results: [{ path: 'src/lib/military/supply.ts', text: 'export const airbaseSupplied = (b) => b.supplyRange > 0 // bug: ignores depotConnected, so connected airbases with range 0 read as unsupplied' }] }) } },
  spec: {
    liveReadServers: ['gamestate', 'ops-knowledge'],
    noDecision: true,
    k10: { maxPosts: 4, issues: { min: 1, max: 1, re: /supply/i }, finishAccepted: true, maxDecisions: 0,
      contradicts: [[/air units? (?:draw|get) supply (?:fine|normally)|supply is working/i, /not (?:getting|receiving) supply|supply is broken|supply bug/i]] },
  },
};
