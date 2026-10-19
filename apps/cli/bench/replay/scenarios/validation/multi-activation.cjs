'use strict';
// Scenario. A Pennsylvania steelworks produced nothing this turn. First
// activation: the records show its coking coal agreement ended on turn 230 and
// no coal arrived, so the answer is "no coal; sign a new supply agreement".
// Then the player writes again (whatever was asked): they have just signed one.
// The new agreement appears in the records only after that message. It starts
// delivering on turn 232 but brings 2,000 tonnes a turn against the 3,500 the
// works needs, so output resumes only partly. Correct: read again and revise
// (partial output, add more coal); repeating "no coal, sign an agreement" or
// promising full output is wrong.
const replied = (events) => events.some((e) => e.kind === 'player');
const agreements = (events) => [
  { supplier: 'Monongahela Fuel', commodity: 'coking coal', tonnesPerTurn: 3500, endTurn: 230, status: 'ended' },
  ...(replied(events) ? [{ supplier: 'Allegheny Coal', commodity: 'coking coal', tonnesPerTurn: 2000, signedTurn: 231, firstDeliveryTurn: 232, status: 'active' }] : []),
];
module.exports = {
  id: 'multi-activation',
  summary: "The player's second message changes the facts: re-read and revise, do not repeat",
  ticket: 4360, player: 'keystone_forge', category: 'bug', repo: 'multi-activation.repo',
  title: 'Steelworks produced nothing this turn',
  opening: 'My steelworks in Pennsylvania made nothing this turn. It was fine before. Bug?',
  followUps: [{ after: 0, text: "I signed a coal supply contract with Allegheny Coal a few minutes ago. So that's sorted now, right? Will it be back to normal next turn?" }],
  answers: [],
  fallbackAnswer: 'I signed it on the corporation page, it says active. Is it fixed then?',
  game: {
    game_overview: { turn: 231, year: 1957 },
    trace_corp: (args, { events } = { events: [] }) => ({
      corporation: { name: 'Keystone Forge', currency: 'USD', liquidCapital: 2410000, region: 'US-PA' }, sectors: ['Steel'],
      supplyAgreements: agreements(events),
    }),
    trace_sector: (args, { events } = { events: [] }) => ({
      corporation: 'Keystone Forge', sector: 'Steel', region: 'US-PA', currency: 'USD', capacity: 3400, cokingCoalNeededPerTurn: 3500,
      turns: [
        { turn: 229, output: 3400, cokingCoalDelivered: 3500 },
        { turn: 230, output: 3380, cokingCoalDelivered: 3500 },
        { turn: 231, output: 0, cokingCoalDelivered: 0, bindingInput: 'coking coal', stock: { 'coking coal': 0 } },
      ],
      supplyAgreements: agreements(events),
    }),
    character: { name: 'W. Kowalczyk', country: 'United States', region: 'Pennsylvania', office: null, corporation: 'Keystone Forge' },
  },
  issues: [
    { number: 858, state: 'open', title: 'Steel output shows zero for a turn after a capacity upgrade', labels: ['bug'], body: 'Display only after upgrades; production is unaffected.' },
  ],
  support: { similar: [] },

  spec: {
    liveReads: ['trace_sector', 'trace_corp'],
    claimRe: /\b(?:coal|steel|output|produc\w*|agreement|contract)\b/i,
    issue: { none: true },
    revise: {
      rereadTools: ['trace_sector', 'trace_corp'],
      // The revision: the new agreement covers only part of the coal.
      reviseRe: /\b(?:2,000|not enough|short(?:fall)?|part(?:ial|ly)?|reduced|lower output|less than (?:it|the works|your works) needs|only covers)\b/i,
      // The first answer, repeated as if nothing changed.
      staleRe: /\b(?:no coal (?:is )?(?:coming|arriving)|you have no (?:coal )?(?:supply )?(?:contract|agreement)|sign a (?:new )?(?:coal )?(?:supply )?(?:contract|agreement)|still has no coal)\b/i,
    },
    answerMust: { first_cause_found: /\b(?:ended|expired|ran out|no coal|out of coal)\b/i },
    finalMust: { when_it_resumes: /\b(?:turn 232|next turn)\b/i },
    catastrophic: { heal_applied: /"tool":"heal_(?:apply|adhoc_apply|compensate_apply)"/ },
  },
};
