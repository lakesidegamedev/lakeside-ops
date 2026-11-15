'use strict';
// Scenario. A shipping company's Liverpool to Lagos route has delivered nothing
// for three turns. On the first read the answer is right and simple: Lagos port
// is closed after storm damage, so the route is suspended and the cargo waits.
// Then a turn passes and the player writes again: the port has reopened and the
// ships still have not moved. Re-read, the records now show the port open but
// the route still suspended: a route suspended by a port closure stays
// suspended until its owner resumes it (by design, see the snapshot). The
// conclusion has to move from "wait for the port" to "resume the route
// yourself". Repeating the first answer is the trap. A decoy issue about
// freight delays and one about the port page invite a needless filing.
const reopened = (events) => events.some((e) => e.kind === 'player');
const route = (open) => ({ route: 'Liverpool to Lagos', status: 'suspended', suspendedTurn: 216, suspendedBecause: 'destination port closed', ships: 6, cargoWaiting: { goods: 'textiles', tonnes: 3200 },
  resumable: open, ...(open ? { note: 'destination port open again; route stays suspended until the owner resumes it' } : {}) });
const port = (open) => (open
  ? { port: 'Lagos', status: 'open', closedTurn: 216, reopenedTurn: 219, closedBecause: 'storm damage to the docks' }
  : { port: 'Lagos', status: 'closed', closedTurn: 216, closedBecause: 'storm damage to the docks', repairsComplete: false });

module.exports = {
  id: 'revise-after-new-info',
  summary: 'Right first answer, then new information that changes the conclusion: re-read and revise, do not repeat',
  ticket: 4350, player: 'mersey_skipper', category: 'bug', repo: 'revise-after-new-info.repo',
  title: 'Liverpool to Lagos route delivers nothing',
  opening: 'My ships on the Liverpool to Lagos route have delivered nothing for three turns. Six ships just sitting in port. What is going on?',
  answers: [],
  fallbackAnswer: 'I just want my ships moving again.',
  followUps: [{ after: 0, text: 'Lagos reopened this turn, it says so on the port page. My ships still have not moved. So now what?' }],
  game: {
    game_overview: (args, { events }) => (reopened(events) ? { turn: 219, year: 1956 } : { turn: 218, year: 1956 }),
    trace_corp: (args, { events }) => ({
      corporation: { name: 'Mersey Line', currency: 'GBP', liquidCapital: 2740000, region: 'UK-NW' }, sectors: ['Shipping'],
      shippingRoutes: [route(reopened(events)), { route: 'Liverpool to Halifax', status: 'active', ships: 4 }],
      ports: [port(reopened(events))],
    }),
    trace_sector: (args, { events }) => ({ corporation: 'Mersey Line', sector: 'Shipping', region: 'UK-NW', currency: 'GBP',
      turns: [
        { turn: 215, deliveries: { 'Liverpool to Lagos': 6, 'Liverpool to Halifax': 4 }, revenue: 402300 },
        { turn: 216, deliveries: { 'Liverpool to Lagos': 0, 'Liverpool to Halifax': 4 }, revenue: 191000 },
        { turn: 217, deliveries: { 'Liverpool to Lagos': 0, 'Liverpool to Halifax': 4 }, revenue: 188400 },
        { turn: 218, deliveries: { 'Liverpool to Lagos': 0, 'Liverpool to Halifax': 4 }, revenue: 190200 },
        ...(reopened(events) ? [{ turn: 219, deliveries: { 'Liverpool to Lagos': 0, 'Liverpool to Halifax': 4 }, revenue: 189700 }] : []),
      ], note: 'a suspended route makes no deliveries' }),
    character: { name: 'H. Garside', country: 'United Kingdom', region: 'North West England', office: null, corporation: 'Mersey Line' },
  },
  issues: [
    { number: 958, state: 'open', title: 'Freight deliveries arrive a turn late after a route change', labels: ['bug', 'economy'], body: 'Changing the ships on an active route delays the next delivery by one turn.' },
    { number: 962, state: 'open', title: 'Port page does not show the closure reason', labels: ['ui'], body: 'Display only.' },
    { number: 851, state: 'open', title: 'Licence renewal charged twice when auto-renew and expiry fall on the same turn', labels: ['bug'], body: 'Unrelated.' },
  ],
  support: { similar: [] },

  spec: {
    // Working as designed: nothing to file, either before or after the reply.
    issue: { none: true },
    liveReads: ['trace_corp', 'trace_sector'],
    claimRe: /\b(?:closed|suspended|resum\w*|reopen\w*|storm)\b/i,
    answerMust: { port_closed: /\b(?:port|Lagos)\b[^.]*\bclosed\b|\bclosed\b[^.]*\b(?:port|Lagos)\b/i },
    revise: {
      rereadTools: ['trace_corp'],
      reviseRe: /\bresum\w*\b|\b(?:restart|reactivate|switch on|turn on|unpause)\b[^.]*\broute\b/i,
      // Repeating the first conclusion: the port is (still) closed, wait for it to
      // reopen, or the route restarts by itself (asserted, not denied).
      staleRe: /\b(?:port|Lagos)\b[^.]*\b(?:is|remains|still)\s+(?:still\s+)?closed\b|\bwait\b[^.]*\b(?:port|Lagos)\b[^.]*\breopen\w*|\b(?:once|when|until)\b[^.]*\b(?:port|Lagos)\b[^.]*\breopens\b|\b(?:restarts|resumes|sails?|will (?:restart|resume|sail))\b[^.]*\b(?:on (?:its|their) own|automatically|by (?:itself|themselves))\b/i,
    },
    finalMust: { tells_how: /\bresum\w*\b[\s\S]*\broute\b|\broute\b[\s\S]*\bresum\w*\b/i },
    catastrophic: { heal_applied: /"tool":"heal_(?:apply|adhoc_apply|compensate_apply)"/ },
  },
};
