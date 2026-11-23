'use strict';
// Scenario (ticket 1884, synthetic, 2026-11-23). A player asks why their company's revenue fell by about 500k in one turn.
// Three sites feed it; the corp record lists all three and each site's history is readable. Live Keir read one site,
// answered for it, and wrote "I still need the rest of your sites' results", which players read as a request to send them.
// Ideal: read every site, answer for the whole drop in one message (the three site falls add up to it), never ask the
// player for game data Keir can read.
const sites = {
  Texas: { turns: [{ turn: 157, revenue: 900000, contractsSold: 60 }, { turn: 158, revenue: 390000, contractsSold: 26 }] },
  Ohio: { turns: [{ turn: 157, revenue: 410000, contractsSold: 31 }, { turn: 158, revenue: 400000, contractsSold: 30 }] },
  Georgia: { turns: [{ turn: 157, revenue: 300000, contractsSold: 22 }, { turn: 158, revenue: 310000, contractsSold: 23 }] },
};
module.exports = {
  id: 'revenue-all-sites',
  summary: 'Revenue fell across a multi-site company: read every site and answer in full; never ask the player for game data',
  ticket: 4410, player: 'ledger_finch', category: 'question', title: 'Why did my revenue drop 500k?',
  opening: 'My company revenue dropped by about 500k between turn 157 and 158. Why?',
  fallbackAnswer: 'I do not know, that is why I am asking.',
  game: {
    game_overview: { turn: 159, year: 1960 },
    character: { name: 'R. Finch', country: 'United States', region: 'Texas', office: null, corporation: 'Finch Financial' },
    trace_corp: { corporation: { name: 'Finch Financial', currency: 'USD', region: 'US-TX' }, sectors: ['Financial services'],
      sites: Object.keys(sites).map((region) => ({ region, sector: 'Financial services' })),
      revenueByTurn: [{ turn: 157, revenue: 1610000 }, { turn: 158, revenue: 1100000 }] },
    trace_sector: (args) => {
      const region = Object.keys(sites).find((r) => new RegExp(r, 'i').test(JSON.stringify(args || {})));
      return region ? { corporation: 'Finch Financial', sector: 'Financial services', region, currency: 'USD', ...sites[region] }
        : { error: 'name the region: one of Texas, Ohio, Georgia' };
    },
  },
  support: { similar: [] },
  spec: {
    liveReads: ['trace_corp', 'trace_sector'],
    claimRe: /\b(?:revenue|contracts?|Texas|sold)\b/i,
    answerMust: { names_texas_fall: /\bTexas\b/i },
    k10: {
      maxPosts: 3,
      forbidPost: { asks_player_for_game_data: /\b(?:i|we)\s+(?:still\s+)?need\s+(?:the rest of\s+)?your\b|\bneed the rest of your\b|\b(?:could|can) you (?:send|share|give) (?:me )?your (?:sites?|results|figures|numbers|revenue|sales)\b/i },
    },
  },
};
