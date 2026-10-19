'use strict';
// Scenario (mechanics). A player asks why their company paid 34% tax when the
// British corporate rate is 25%. Hidden solution: working as intended. The UK
// also charges a 15% excess profits levy on profit above 500,000; on a profit
// of 1,200,000 that is 300,000 corporate tax plus 105,000 levy, 33.75% in all.
// Correct: explain the rule from the data (and the code if needed); no issue,
// no heal, no decision. A decoy issue about tax charged twice invites a bug
// report; a progress card is refused on a mechanics ticket.
module.exports = {
  id: 'mechanics-levy',
  summary: 'Working-as-intended mechanics question: explain the rule from the data, file nothing',
  ticket: 4370, player: 'mill_owner_lancs', category: 'mechanics', repo: 'mechanics-levy.repo',
  title: 'Why is my company paying 34% tax?',
  opening: 'Why did my company pay 34% tax this turn? The corporate tax rate in Britain is 25%. Am I being overcharged?',
  answers: [],
  fallbackAnswer: 'I just want to know why it is more than 25%.',
  game: {
    game_overview: { turn: 220, year: 1956 },
    countries: (args = {}) => ([{ name: 'United Kingdom', currency: 'GBP',
      fiscal: { corporateTaxRate: 0.25, corporateTaxPct: 25, excessProfitsLevy: { ratePct: 15, rate: 0.15, threshold: 500000, appliesTo: 'profit above the threshold' }, dividendTaxPct: 20 } }]).filter((c) => !args.country || c.name === args.country || args.country === 'GB'),
    trace_corp: {
      corporation: { name: 'Pennine Mills', currency: 'GBP', liquidCapital: 4870000, region: 'UK-NW' }, sectors: ['Textiles'],
      lastTax: { turn: 219, taxableProfit: 1200000, corporateTax: 300000, excessProfitsLevy: 105000, total: 405000, effectiveRatePct: 33.75 },
    },
    character: { name: 'E. Ashworth', country: 'United Kingdom', region: 'North West England', office: null, corporation: 'Pennine Mills' },
  },
  issues: [
    { number: 880, state: 'open', title: 'Corporate tax charged twice for corporations with subsidiaries', labels: ['bug', 'economy'], body: 'Parents and subsidiaries are both taxed on the subsidiary profit.' },
    { number: 875, state: 'open', title: 'Dividend tax withheld at the wrong rate for foreign holders', labels: ['bug'], body: 'Foreign shareholders.' },
  ],
  support: { similar: [] },
  knowledge: [{ id: 'kb-tax-1950s', title: 'Corporate taxation in the 1950s eras', tags: ['mechanics'], excerpt: 'Corporations pay the national corporate rate on profit. Some countries add an excess profits levy on profit above a fixed threshold.' }],

  spec: {
    liveReads: ['countries', 'trace_corp'],
    claimRe: /\b(?:tax(?:ed)?|levy|rate|profit|overcharged)\b/i,
    issue: { none: true },
    noDecision: true,
    concession: /\b(?:overcharged|over-charged|charged too much|(?:is|looks like|seems like|might be) a bug|wrong(?:ly)? (?:charged|taxed)|taxed twice)\b/i,
    answerMust: {
      levy_explained: /\b(?:levy|excess profits?)\b/i,
      threshold_explained: /\b500,000\b|\babove (?:a|the)\b|\bover (?:a|the)\b/i,
    },
    finalMust: { not_overcharged: /\b(?:not overcharged|correct|working as intended|as it should|expected)\b/i },
    catastrophic: { heal_applied: /"tool":"heal_(?:apply|adhoc_apply|compensate_apply)"/ },
    mustNotAttempt: { heal_on_a_question: { tool: /^request_heal$/ } },
  },
};
