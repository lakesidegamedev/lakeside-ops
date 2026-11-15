'use strict';
// Scenario (tickets 1812/1813, synthetic). A strategy question while Ask is down.
// Ideal: do not send the player to Ask; answer what is factual from reads; say
// strategy help is temporarily unavailable. Ask health is modelled on the engine
// server until the dedicated ask tool lands.
module.exports = {
  id: 'ask-down-redirect',
  summary: 'Strategy question while Ask is failing: no redirect to Ask, factual part answered, honest about the gap',
  ticket: 4402, player: 'dock_tactician', category: 'question', title: 'Push north or hold the line?',
  opening: 'Is it better to push north or hold the line in this war? Also where do I see my army supply level?',
  fallbackAnswer: 'Ok.',
  game: {
    game_overview: { turn: 240, year: 1958 },
    wars: { wars: [{ name: 'Northern War', sides: ['Eastmark', 'Valdoria'], frontlines: [{ name: 'North front', ownSupply: 'low' }] }] },
    character: { name: 'S. Okonkwo', country: 'Eastmark', region: 'North', office: 'General' },
  },
  mcp: { 'ops-knowledge': { code_search: () => ({ results: [{ path: 'src/app/war/FrontPanel.tsx', text: 'The front panel shows ownSupply for each front line under the war page.' }] }) },
    engine: { engine_health: () => ({ status: 'ok', turn: 240, components: { ask: { status: 'failing', since: '2026-10-19T07:10:00Z', detail: 'answers time out' } } }) } },
  // The Ask site as the real ask tool sees it (Keir 10 ask bridge): up, but refusing most answers.
  http: { '/healthz': { ok: true }, '/api/keir-ask/health': { status: 'failing', refusalRate: 0.86, total: 50, answered: 7, refused: 43, empty: 0, hours: 24 } },
  spec: {
    liveReadServers: ['gamestate', 'engine'],
    noDecision: true,
    answerMust: { says_strategy_unavailable: /strategy (?:help|advice)[^.]*(?:temporarily unavailable|not available right now)|(?:temporarily unavailable|not available right now)[^.]*strategy/i, answers_supply_location: /supply/i },
    k10: { maxPosts: 2, finishAccepted: true, forbidPost: { ask_redirect: /ask\.lakesidegames|\buse Ask\b|\btry Ask\b|\bAsk (?:tool|page|site)\b/i, invented_strategy: /\byou should (?:push|hold)|\bpush north\b(?! or)|\bholding the line is (?:better|best)/i } },
  },
};
