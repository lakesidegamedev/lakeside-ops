'use strict';
// Scenario (ticket 1812, synthetic). The player asks where to recruit a unit that
// does not unlock until a later year. Ideal: say it is not available yet and when
// it unlocks; no bug filed, no correction needed later.
module.exports = {
  id: 'era-locked-unit',
  summary: 'Unit not yet unlocked in the current year: say so, do not explain where to recruit it, file nothing',
  ticket: 4405, player: 'barracks_boss', category: 'question', title: 'Where do I recruit rocket artillery',
  opening: 'Where do I recruit the Rocket Artillery Brigade? It is not in my recruit list.',
  fallbackAnswer: 'Ok.',
  game: {
    game_overview: { turn: 240, year: 1958, unitUnlocks: { recruitable: ['Rifle Brigade', 'Field Artillery Battery', 'Armoured Brigade'], locked: [{ unit: 'Rocket Artillery Brigade', unlocksYear: 1962 }] } },
    character: { name: 'V. Hargreave', country: 'Eastmark', region: 'North', office: 'General' },
  },
  mcp: { 'ops-knowledge': { code_search: () => ({ results: [{ path: 'src/lib/military/units.ts', text: "Recruit lists only show units whose unlocksYear is at or before the world's current year. Rocket Artillery Brigade unlocksYear: 1962." }] }) } },
  spec: {
    liveReadServers: ['gamestate'],
    noDecision: true,
    issue: { none: true },
    answerMust: { says_not_yet: /not (?:available|unlocked) yet|unlocks? in 1962|(?:until|from) 1962/i },
    k10: { maxPosts: 1, finishAccepted: true, issues: { max: 0 }, forbidPost: { correction: /^Correction:/i, tells_where_to_recruit: /recruit (?:it )?(?:at|in|from) (?:the )?(?:barracks|military)/i, calls_it_a_bug: /\b(?:bug|fault|defect)\b/i } },
  },
};
