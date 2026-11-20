"use strict";

// support_evidence_lookup: maps a support question to the definition, units,
// scope, source reference and the exact gamestate read that answers it, and
// says plainly what cannot be answered today.
//
// The mappings are seeded by hand from AHDGame source, read on 2026-11-20 on
// origin/development and origin/main (every referenced file is identical on
// both). Nothing here claims a deployed revision; `deployment` is always
// "not_verified" and `lookupHint` is the call that re-checks the code index.
// The ahd-agent-data-dictionary was not used as authority.

const { z } = require("zod");

const VERIFIED_ON = "2026-11-20";
const BRANCHES = [
  { branch: "origin/development", commit: "a73304bbd37c9cdc02efd08e96d2348334f71532" },
  { branch: "origin/main", commit: "e50f76cb7d000687e25295d9626ccb9616ca1b4f" },
];

function ref(path, symbols, role) {
  return { path, symbols, role };
}

const MAPPINGS = [
  {
    id: "national_gdp",
    title: "National GDP level vs GDP growth",
    triggers: [
      [/\bgdp\b/i, 3], [/gross domestic/i, 3], [/\bgrowth\b/i, 1], [/\bgrew\b|\bshrank\b|\bcontract/i, 1],
      [/\blevel\b|\bsize\b|\btotal\b/i, 1], [/economy (is|got|fell|rose)/i, 1], [/national/i, 1],
    ],
    terms: [
      { term: "GDP level", definition: "National GDP: the sum of every region's own GDP.", units: "local-currency millions, own currency, not USD", scope: "country, summed from regions", field: "state.gdp summed (pulse.gdpMillions)" },
      { term: "GDP growth", definition: "The live real annual growth rate the game applies as 1 + rate/100.", units: "percent per year, real", scope: "country", field: "federalBudget.economicFactors.gdpGrowth (hourly series: centralBanks.gdpGrowthHistory)" },
    ],
    distinctions: [
      "Growth is a rate. It is not the level and not the change in level between two turns.",
      "country_fiscal.gdp is federalBudget.gdp, the budget denominator. It is not the national level and trails live GDP when the economy grows.",
      "macro_history gdpGrowth is per region, not national.",
    ],
    references: [
      ref("src/lib/utils/nationalGdp.ts", ["aggregateNationalGdp"], "level: sum of regional gdp, local millions"),
      ref("src/lib/economy/queries/countryEconomyOutlook.ts", ["pulse.gdpMillions", "liveGdpGrowth"], "what the country page shows for level and growth"),
      ref("src/lib/budget/fiscalYear.ts", ["economicFactors.gdpGrowth"], "growth is percent, applied as newGdp * (1 + gdpGrowth / 100)"),
      ref("src/lib/turn/interestRateSnapshot.ts", ["gdpGrowthHistory"], "hourly growth series on the central bank"),
    ],
    lookupHint: { tool: "code_exact", args: { question: "aggregateNationalGdp liveGdpGrowth", source: "prod" } },
    gaps: ["The national GDP level read is market_history gdp_level / gdp_change, planned until it appears in tools/list.", "country_fiscal.gdp is the budget denominator, not the level: do not quote it as national GDP."],
    pick(text, ids) {
      if (GROWTH_ASK.test(text)) {
        return { read: { tool: "country_fiscal", args: { country: ids.country || "<country>" }, status: "existing", argsSource: "rust", returns: "economicFactors.gdpGrowth: live real annual growth, percent. Read the unit from the value; the test fixture's 0.02 is not percent evidence.", limits: ["Growth only. Its gdp field is not the national level."] } };
      }
      const metric = CHANGE_ASK.test(text) ? "gdp_change" : "gdp_level";
      return { read: { tool: "market_history", args: { metric, country: ids.country || "<country>", turns: 24 }, status: "planned", argsSource: "game_contract_v1", returns: metric === "gdp_change" ? "gdp_change: percent change between consecutive turns plus a window summary (fromValue, toValue, changePct)" : "gdp_level: national GDP per turn, local-currency millions, from macroTelemetry economic.gdp", limits: ["Omit region: no region means national, and the tool never falls back between the two.", "turns is 2..60 (hourly turns), so one call cannot span a week; set toTurn for an earlier window.", "The tool uses version 1 of the game evidence schema. Confirm runtime availability through tools/list."] }, gapWhenUnavailable: "National GDP level history cannot be read today. Say it was not checked. Do not substitute country_fiscal or growth; growth is a separate question to ask explicitly." };
    },
    alternatives: [
      { tool: "market_history", args: { metric: "gdp_growth_rate", country: "<country>", turns: 24 }, use: "growth indicator history", caveat: "many countries store no national growth history (gap no_national_growth_history); never compare it with gdp_change" },
      { tool: "macro_history", args: { region: "<region id>", metrics: ["gdpGrowth"], turns: 48 }, use: "growth trend for one region", caveat: "regional growth only, never the national level or a national drop" },
    ],
  },
  {
    id: "market_demand",
    title: "Market listed vs filled vs funded demand",
    triggers: [
      [/\b(?:all|every|across)\s+(?:the\s+)?sectors?\b/i, 3], [/\bdemand\b/i, 3], [/\blisted\b|\bposted\b/i, 2], [/\bfilled\b|\bfulfil/i, 2], [/\bfunded\b|\bafford|\bcash\b/i, 2],
      [/\bmarket\b/i, 1], [/\bunmet\b|\bshortage\b|\bcould ?n.t buy\b/i, 1], [/\bcommodit/i, 1], [/\bsupply\b/i, 1],
    ],
    terms: [
      { term: "listed demand", definition: "Demand on the price row, after the ledger cap. demandTruncatedUnits is what the cap removed.", units: "units per turn", scope: "world (globalDemand) or state (stateDemand)", field: "commodityPrices.globalDemand / stateDemand" },
      { term: "demand (funded book)", definition: "First-choice units a country's buyers requested, less household spillover.", units: "units per turn", scope: "country x commodity", field: "producerMarketOutcomes books[].demand" },
      { term: "funded", definition: "The part of that demand the buyers' cash could pay for. Null on books written before it was recorded.", units: "units per turn", scope: "country x commodity", field: "books[].funded" },
      { term: "filled", definition: "Units buyers actually received, spillover included. Null on older books.", units: "units per turn", scope: "country x commodity", field: "books[].filled" },
    ],
    distinctions: [
      "Compare requested, cash-funded and filled units for the same country, commodity and turn. Spillover and imports can change fills. A market-wide fill does not establish the sales or profit of an individual site.",
      "A turn with no funded book falls back to modelled nationalDemand (nationalBalanceSource: modelled). Say which source a number came from.",
      "Public, military and investment buyers have no state, so they reach the world total and the funded book but not a country's nationalDemand.",
    ],
    references: [
      ref("src/lib/market/producerMarket/fundedCountryViewRules.ts", ["fundedCountryMarket", "FundedCountryMarket"], "demand, spilloverRequested, filled, funded per country and commodity"),
      ref("src/lib/market/producerMarket/loadFundedCountryBooks.ts", ["loadFundedCountryBooks"], "book id is `${worldEpochId}:${turn}` in producerMarketOutcomes"),
      ref("src/lib/corporations/commodityDominanceContext.ts", ["demandTruncatedUnits", "fundedMarkets"], "listed vs funded demand used side by side"),
      ref("src/lib/turn/latentShortage.ts", ["demandTruncatedUnits"], "what the demand cap removes"),
    ],
    lookupHint: { tool: "code_exact", args: { question: "fundedCountryMarket loadFundedCountryBooks", source: "prod" } },
    gaps: ["commodity_market is the current turn only. History needs market_history commodity_volume and a named commodity; it has no funded split."],
    pick(text, ids) {
      if (HISTORY_ASK.test(text) && ids.commodity) {
        const args = { metric: "commodity_volume", commodity: ids.commodity, turns: 24 };
        if (ids.country) args.country = ids.country;
        return { read: { tool: "market_history", args, status: "planned", argsSource: "game_contract_v1", returns: "per turn offeredUnits, demandUnits, soldUnits, unmetDemandUnits, surplusUnits, soldPctOfOffered (no funded split)", limits: ["Omit country for the world market.", "turns is 2..60.", "The tool uses version 1 of the game evidence schema. Confirm runtime availability through tools/list."] }, gapWhenUnavailable: "No history read is available. Give the current turn from commodity_market and say the earlier turns were not checked.", fallback: "commodity_market" };
      }
      const args = {};
      if (ids.commodity) args.commodity = ids.commodity;
      if (ids.country) args.country = ids.country;
      return { read: { tool: "commodity_market", args, status: "existing", argsSource: "rust", returns: "current turn only (use commodity_volume for history, which needs a named commodity). Per commodity row: supply (offered), demand, funded, filled, demandSource (funded_book or modelled), imports, exports, demandTruncatedUnits, unit. No commodity given returns every traded commodity, so it answers all-sector questions.", limits: ["funded and filled are absent on a row when no funded book exists; then demandSource says modelled.", "country is a two-letter id; omit for the world market."] } };
    },
    alternatives: [],
  },
  {
    id: "corp_revenue_profit",
    title: "Realized revenue vs operating profit",
    triggers: [
      [/\brevenue\b|\bsales\b|\bturnover\b/i, 3], [/\bprofit\b|\bincome\b|\bearn/i, 3], [/\boperating\b/i, 2],
      [/\brealized\b|\brealised\b/i, 2], [/\bcorp(oration)?\b|\bcompany\b|\bsector\b/i, 1], [/\bper (day|turn)\b/i, 1], [/\bdividend/i, 1],
    ],
    terms: [
      { term: "realized revenue", definition: "What the engine recorded the corporation took in that turn.", units: "currency of the row (currencyCode), per TURN", scope: "corporation", field: "corporationHistory.revenue" },
      { term: "operating profit", definition: "Realized operating income. Excludes bond coupons, bond interest and dividends received.", units: "currencyCode, per TURN", scope: "corporation", field: "corporationHistory.income" },
      { term: "realized net income", definition: "Operating income plus bond coupons, minus bond drag, plus dividends received.", units: "currencyCode, per TURN", scope: "corporation", field: "realizedNetIncomePerTurn(row)" },
      { term: "corp page financials", definition: "totalRevenue, operatingCosts, operatingIncome (= totalRevenue - operatingCosts) are PROJECTED; realizedIncome is the engine's realized net.", units: "per real DAY = 24 turns", scope: "corporation", field: "corporationDetail financials.*" },
    ],
    distinctions: [
      "Realized is not projected. The page's totalRevenue and operatingIncome cannot see embargo, tariff or clearing haircuts.",
      "Per day vs per turn: page values are x24 the history values. Divide by 24 before comparing with a per-turn row.",
      "Convert history money with the row's fxRateAtWrite, never the live rate.",
    ],
    references: [
      ref("src/lib/corporations/rules/historyFinancials.ts", ["realizedNetIncomePerTurn"], "net = income + coupons - bond drag + dividends received"),
      ref("src/lib/db/types/corporationHistory.ts", ["CorporationHistory.revenue", "income", "currencyCode", "fxRateAtWrite"], "realized per-turn row"),
      ref("src/lib/corporations/queries/corporationDetail/financials.ts", ["realizedIncome", "operatingIncome"], "page values, per day, realizedIncome = net x TURNS_PER_DAY"),
      ref("src/lib/corporations/queries/corporationDetail/incomeStatement.ts", ["operatingIncome"], "operatingIncome = totalRevenue - operatingCosts (projected)"),
    ],
    lookupHint: { tool: "code_exact", args: { question: "realizedNetIncomePerTurn operatingIncome", source: "prod" } },
    gaps: ["The reporter-scoped read is reporter_operating_results, planned until it appears in tools/list. Never use trace_corp or another account's data as a stand-in. One-off market entry, permit and construction fees are not in it."],
    pick() {
      return { read: { tool: "reporter_operating_results", args: { turns: 6 }, status: "planned", argsSource: "game_contract_v1", returns: "per site per turn offeredUnits, soldUnits, revenue, fees, costs, operatingProfit (null when no settled receipt), anchor currency per turn, for the verified reporter's own companies", limits: ["The Keir broker injects ticket and character from the verified ticket. Send neither, and no corporation or account name.", "turns is 1..12.", "The tool uses version 1 of the game evidence schema. Confirm runtime availability through tools/list."] }, gapWhenUnavailable: "The reporter's own results cannot be read yet. Say it was not checked and ask for nothing that names another account." };
    },
    alternatives: [],
  },
  {
    id: "action_points",
    title: "Action point grants vs spending vs balance",
    triggers: [
      [/action ?points?/i, 4], [/\bAP\b/, 3], [/\bactions\b/i, 2], [/\bgrant|\bregen|\brefresh/i, 2],
      [/\bspen[dt]|\bused\b|\bcost\b/i, 1], [/\bbalance\b|\bleft\b|\bremaining\b/i, 1], [/hoard/i, 2], [/\blost\b|\bmissing\b/i, 1],
    ],
    terms: [
      { term: "balance", definition: "Unspent actions the character holds now.", units: "action points", scope: "character", field: "characters.actions" },
      { term: "grant", definition: "Per-turn refresh: base plus office, chair, justice and chamber bonuses, capped by Energy. Above 100 unspent, a hoarding penalty is taken first.", units: "action points per turn", scope: "character", field: "characters.actionGrantLog[] {turn, source personal|party, granted, before, after, hoardPenalty, cap}" },
      { term: "spending", definition: "No dedicated ledger. Implied spend is the balance change minus grants over the log window, or audit_query rows when gameConfig.auditLog is on.", units: "action points", scope: "character", field: "derived" },
      { term: "party pool", definition: "A separate pool a party spends on NPP work (cap 160/80 national, regen 16/8 per turn).", units: "action points", scope: "party", field: "politicalParties.nppActionPoints" },
    ],
    distinctions: [
      "Grant, spend and balance are three different numbers. Balance after = before + granted - hoardPenalty - spent.",
      "actionGrantLog keeps only the last 48 entries, about two days of hourly turns. Older grants cannot be reconstructed from it.",
      "A party's pool is not a player's balance.",
      "actionGrantLog is private. Never put it in a public reply or a public payload.",
    ],
    references: [
      ref("src/lib/turn/actionRefresh.ts", ["processActionRefresh", "hoardPenalty", "baseActionsPerTurn"], "the per-turn grant and hoarding penalty"),
      ref("src/lib/turn/actionGrantLog.ts", ["appendActionGrantLog", "ACTION_GRANT_LOG_LIMIT"], "log of the last 48 grants"),
      ref("src/lib/db/types/character.ts", ["Character.actions", "Character.actionGrantLog"], "balance and log fields; log is private"),
      ref("src/lib/npp/actionPoints.ts", ["nppActionPointCap", "nppActionPointRegen"], "the separate party pool"),
    ],
    lookupHint: { tool: "code_exact", args: { question: "appendActionGrantLog processActionRefresh", source: "prod" } },
    gaps: ["The reporter-scoped read is reporter_action_points, planned until it appears in tools/list.", "Spending older than the 48-entry log window is not recoverable without the audit log."],
    pick() {
      return { read: { tool: "reporter_action_points", args: { turns: 24 }, status: "planned", argsSource: "game_contract_v1", returns: "per grant period opening, grants (personal, party, hoardPenalty, lostToCap, net), recordedSpending, closing, unexplainedDelta; summary.currentBalance for the open period", limits: ["The Keir broker injects ticket and character from the verified ticket. Send neither.", "turns is 1..48.", "The tool uses version 1 of the game evidence schema. Confirm runtime availability through tools/list."] }, gapWhenUnavailable: "The reporter's action point log cannot be read yet. Say it was not checked." };
    },
    alternatives: [],
  },
];

const MAPPING_IDS = MAPPINGS.map((m) => m.id);

function scoreMapping(mapping, question) {
  let score = 0;
  for (const [pattern, weight] of mapping.triggers) if (pattern.test(question)) score += weight;
  return score;
}

const MIN_SCORE = 3;
const GROWTH_ASK = /growth rate|gdp growth|\bgdpGrowth\b|growing (at|by)|rate of growth|how fast/i;
const CHANGE_ASK = /\b(drop|dropped|fell|fall|crash|crashed|plunge|plunged|decline|declined|shrank|change|changed|rose|jump)\b/i;
const HISTORY_ASK = /\b(week|weeks|days?|turns|history|trend|over time|lately|recent(ly)?|dropped|drop|fell|rose|changed)\b/i;

function toolState(tool, availableTools) {
  return Array.isArray(availableTools) ? availableTools.includes(tool) : "unknown";
}

function recommend(mapping, text, ids, availableTools) {
  const picked = mapping.pick(text, ids);
  const callable = toolState(picked.read.tool, availableTools);
  const out = { ...picked.read, callable, ...(callable === true && picked.read.status === "planned" ? { status: "available" } : {}) };
  if (callable === false) {
    // Unavailable: a gap, or the named current-turn read, never a different metric.
    if (picked.fallback) {
      const fb = mapping.pick("", ids).read;
      if (toolState(fb.tool, availableTools)) return { ...fb, callable: true, note: picked.gapWhenUnavailable };
    }
    return { gap: true, wanted: picked.read.tool, callable, note: picked.gapWhenUnavailable };
  }
  return out;
}

function render(mapping, score, text, ids, availableTools) {
  return {
    id: mapping.id,
    title: mapping.title,
    score,
    terms: mapping.terms,
    distinctions: mapping.distinctions,
    implementation: {
      repo: "AHDGame",
      verification: { verifiedOn: VERIFIED_ON, branches: BRANCHES, sameOnBranches: true, deployment: "not_verified" },
      references: mapping.references,
      lookupHint: mapping.lookupHint,
    },
    recommendation: recommend(mapping, text, ids, availableTools),
    alternatives: mapping.alternatives.map((alt) => ({ ...alt, callable: toolState(alt.tool, availableTools) })),
    gaps: mapping.gaps,
  };
}

/** Pure lookup. No I/O. availableTools is the caller's own tools/list. */
function lookupEvidence({ question, topic, availableTools, identifiers = {}, max = 2 }) {
  const text = String(question || "");
  let ranked;
  if (topic) {
    const mapping = MAPPINGS.find((m) => m.id === topic);
    ranked = mapping ? [{ mapping, score: Math.max(scoreMapping(mapping, text), MIN_SCORE) }] : [];
  } else {
    ranked = MAPPINGS.map((mapping) => ({ mapping, score: scoreMapping(mapping, text) }))
      .filter((r) => r.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score || MAPPING_IDS.indexOf(a.mapping.id) - MAPPING_IDS.indexOf(b.mapping.id));
  }
  if (ranked.length === 0) {
    return { matched: false, ambiguous: false, results: [], topics: MAPPINGS.map((m) => ({ id: m.id, title: m.title })), note: "No verified mapping fits this question. Do not guess a definition; investigate from source." };
  }
  const ambiguous = ranked.length > 1 && ranked[0].score - ranked[1].score <= 1;
  return { matched: true, ambiguous, results: ranked.slice(0, max).map((r) => render(r.mapping, r.score, text, identifiers, availableTools)) };
}

function registerSupportEvidenceTools(server, { jsonResult }) {
  server.tool(
    "support_evidence_lookup",
    "Map a support question to its verified definition, units, scope, AHDGame source reference and the one gamestate read that answers it (or a gap when it cannot be read). Seeded: national GDP level vs growth, market listed vs filled vs funded demand, realized revenue vs operating profit, action point grants vs spending vs balance. Reporter-scoped reads take no identifier: the Keir broker supplies the reporter. Pass availableTools from tools/list so unavailable reads come back as gaps. An unmatched question returns the topic list, never a guess. Static; it makes no claim about what is deployed.",
    {
      question: z.string().min(3).max(1000).describe("The support question in the reporter's words"),
      topic: z.enum(MAPPING_IDS).optional().describe("Force a mapping instead of matching the wording"),
      availableTools: z.array(z.string().max(80)).max(200).optional().describe("Tool names from the caller's tools/list"),
      identifiers: z.object({
        country: z.string().max(40).optional().describe("Two-letter country id"),
        commodity: z.string().max(60).optional(),
      }).optional().describe("Public identifiers only, filled into read args when given"),
    },
    async ({ question, topic, availableTools, identifiers }) => jsonResult(lookupEvidence({ question, topic, availableTools, identifiers: identifiers || {} }))
  );
}

module.exports = { MAPPINGS, MAPPING_IDS, lookupEvidence, registerSupportEvidenceTools };
