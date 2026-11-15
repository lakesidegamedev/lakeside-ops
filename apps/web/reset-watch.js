// reset-watch.js: the reset tracker for A House Divided. Reads the live game
// database (read-only) plus the deploy pipeline's release records and answers
// four questions about a freshly reset world:
//
//   1. Can a player make a living in every sector?
//   2. Is any host country or company legal form overpowered?
//   3. Is politics alive: enough NPP candidates, close races, no permanent ruler?
//   4. Are turns and releases fast and clean?
//
// Every metric here was chosen against the field it reads. The non-obvious
// choices, so nobody "simplifies" them back into the lookalike field:
//
// - Sector P&L (`corporateSectors.plantsPnl`) is on a per real DAY basis in the
//   host currency. One turn is one real hour (TURNS_PER_DAY = 24), so per-turn
//   profit is plantsPnl.profit / 24, and `exchangeRates.rate` is local per anchor.
// - Return on a new plant uses `capacityBookAnchor` (the paid build cost of the
//   capacity), the same definition the engine uses for its own growth finance
//   (build price per unit over profit per operating unit per turn). It does NOT
//   use `capitalBookAnchor`, which is an NPV-derived valuation, not a cost.
// - A sector is viable when a new plant's yearly return beats the host
//   country's prime rate. Below that a player is better off holding bonds, so
//   "profitable" alone (every seeded site is) does not make a sector worth
//   entering.
// - National state corporations are excluded from sector and balance figures.
//   They are seeded giants no player competes on equal terms with.
// - Country balance is sector-adjusted: each site's margin minus the median
//   margin of its own sector everywhere. A country full of banks would
//   otherwise look "strong" just because banking margins are high.
// - Company legal form only exists on player-founded corporations, so the
//   corp-type view reads player corporations only, and also reports how players
//   actually choose (a form nobody picks, or everybody picks, is the signal).
// - Race closeness compares the top two sides. An independent candidate is its
//   own side, so a party-less country still reads as contested when two
//   independents run.
// - Turn phases overlap inside parallel groups, so phase times never sum to the
//   turn. The page shows the slowest phases as a list, never as shares.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TURNS_PER_DAY = 24;
const TURNS_PER_YEAR = 48;

// The engine's own ceiling for bank-funded growth (shortageGrowthFinance
// maxPaybackTurns default). A plant that cannot pay for itself inside this is
// a plant the game itself would not finance.
const ENGINE_MAX_PAYBACK_TURNS = 100;

// Thresholds live here, in one place, and the page prints them. They are our
// targets for a healthy reset, not engine constants.
const T = Object.freeze({
  // sectors: yearly return on a new plant, in points above the host prime rate
  viableExcessPp: 2,
  weakExcessPp: 0,
  viableProfitableShare: 0.6,
  weakProfitableShare: 0.35,
  minSitesForVerdict: 3,
  // balance: points of yearly plant return above the same sector elsewhere
  edgeWarnPp: 1.5,
  edgeBadPp: 3,
  // legal forms: points of after-tax margin above the same sector
  formEdgeWarnPp: 5,
  formEdgeBadPp: 10,
  choiceWarnShare: 0.6,
  choiceBadShare: 0.8,
  minCorpsForChoice: 8,
  // politics
  closeMarginPp: 10,
  landslideMarginPp: 30,
  supermajorityShare: 2 / 3,
  longHoldTurns: 8 * TURNS_PER_YEAR, // two US-length terms
  emptyRaceAlarmTurns: 6, // empty races this close to the primary deadline are red
  enpWarn: 2.0,
  // infra
  turnP95WarnShare: 0.25, // p95 turn duration as a share of the turn cadence
  turnP95BadShare: 0.5,
  releaseLeadWarnMin: 90,
});

const LANES = [
  ["agriculture", "Agriculture"],
  ["extraction", "Extraction and mining"],
  ["energy", "Energy"],
  ["chemical_industries", "Chemicals"],
  ["manufacturing", "Manufacturing"],
  ["manufacturing_vehicles", "Manufacturing: vehicles"],
  ["construction", "Construction"],
  ["real_estate", "Real estate"],
  ["logistics", "Logistics"],
  ["retail", "Retail"],
  ["healthcare", "Healthcare"],
  ["technology", "Technology"],
  ["telecommunications", "Telecom"],
  ["media", "Media"],
  ["media_entertainment", "Media: entertainment"],
  ["financial", "Financials"],
  ["defense", "Defense"],
];
const LANE_LABEL = Object.fromEntries(LANES);

// The chamber that decides who governs, per country. Single-party states are
// one-party by constitution; they are reported but never flagged for it.
const MAIN_CHAMBER = {
  US: "house", UK: "commons", DE: "bundestag", JP: "shugiin", CA: "caCommons", CN: "npcDelegate",
};
const UPPER_CHAMBER = { US: "senate", JP: "sangiin" };
const PRESIDENTIAL = new Set(["US"]);

// ── small numeric helpers ────────────────────────────────────────────────────

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function quantile(values, q) {
  const xs = values.filter((v) => typeof v === "number" && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo];
  if (!Number.isFinite(xs[lo]) || !Number.isFinite(xs[hi])) return xs[hi];
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}
const median = (values) => quantile(values, 0.5);
const round = (v, d = 1) => (v == null || !Number.isFinite(v) ? v : Math.round(v * 10 ** d) / 10 ** d);
const share = (a, b) => (b > 0 ? a / b : null);

function laneOf(sector) {
  if (sector.sectorType === "manufacturing" && sector.industryModel === "vehicles") return "manufacturing_vehicles";
  if (sector.sectorType === "media" && sector.mediaDiscriminator === "entertainment") return "media_entertainment";
  return sector.sectorType;
}

// Effective number of parties (Laakso-Taagepera) from seat counts.
function effectiveParties(seatCounts) {
  const total = seatCounts.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  return 1 / seatCounts.reduce((a, s) => a + (s / total) ** 2, 0);
}

function level(...levels) {
  if (levels.includes("bad")) return "bad";
  if (levels.includes("warn")) return "warn";
  if (levels.includes("ok")) return "ok";
  return "none";
}

// ── 1. Sectors ───────────────────────────────────────────────────────────────

// One row per operating site (owner corp x state x lane), turn-matched.
function siteRows({ sectors, corpById, fxByCountry, primeByCountry = new Map(), turn }) {
  const rows = [];
  for (const s of sectors) {
    const corp = corpById.get(String(s.corporationId));
    if (!corp || corp.isPrimaryNationalCorporation) continue;
    const pnl = s.plantsPnl || {};
    const fresh = pnl.turn != null && turn != null && pnl.turn >= turn - 1;
    const rate = num(fxByCountry.get(s.countryId)) || 1;
    const revenueDay = fresh ? num(pnl.revenue) : null;
    const profitDay = fresh ? num(pnl.profit) : (num(s.capitalStock) > 0 ? 0 : null);
    const profitTurnAnchor = profitDay == null ? null : profitDay / TURNS_PER_DAY / rate;
    const capital = num(s.capitalStock) || 0;
    const operating = num(s.operatingCapacityUnits) || capital;
    const book = num(s.capacityBookAnchor);
    // Engine definition: per-unit build price over per-turn profit per operating unit.
    let paybackTurns = null;
    let returnPct = null;
    if (book > 0 && capital > 0 && operating > 0 && profitTurnAnchor != null) {
      const unitPrice = book / capital;
      const unitProfitTurn = profitTurnAnchor / operating;
      paybackTurns = unitProfitTurn > 0 ? unitPrice / unitProfitTurn : Infinity;
      returnPct = (100 * unitProfitTurn * TURNS_PER_YEAR) / unitPrice;
    }
    const prime = num(primeByCountry.get(s.countryId));
    // Built = owns capacity. A built site with no revenue this turn is idle,
    // and counts against its sector: a player owning it would be losing money.
    const built = capital > 0;
    const selling = revenueDay != null && revenueDay > 0;
    rows.push({
      lane: laneOf(s),
      country: s.countryId,
      corpId: String(s.corporationId),
      player: corp.ceoType === "character",
      operating: built,
      idle: built && !selling,
      building: !built && (num(s.constructionInProgressAnchor) || 0) > 0,
      margin: selling && profitDay != null ? (100 * profitDay) / revenueDay : null,
      profitable: built ? (profitDay != null ? profitDay > 0 : false) : null,
      paybackTurns,
      returnPct,
      primePct: prime,
      excessPp: returnPct != null && prime != null ? returnPct - prime : null,
      plantCost: book > 0 && num(s.plantCount) > 0 ? book / s.plantCount : null,
      sellThrough: num(s.soldFraction),
      utilization: num(s.capitalUtilization),
      revenueTurnAnchor: revenueDay == null ? null : revenueDay / TURNS_PER_DAY / rate,
    });
  }
  return rows;
}

function sectorVerdict(m) {
  if (m.sites < T.minSitesForVerdict) return { level: "none", why: "Too few sites to judge" };
  const pr = m.profitableShare;
  const ex = m.excessPp;
  const ret = m.returnPct == null ? "an unknown return" : `${m.returnPct}% a year`;
  if (pr != null && pr < T.weakProfitableShare) return { level: "bad", why: `Only ${Math.round(pr * 100)}% of sites make money` };
  if (ex == null) return { level: "bad", why: "No return can be measured" };
  if (ex < T.weakExcessPp) return { level: "bad", why: `New plants earn ${ret}, ${Math.abs(ex)} points below the local prime rate` };
  if (pr != null && pr < T.viableProfitableShare) return { level: "warn", why: `${Math.round(pr * 100)}% of sites make money` };
  if (ex < T.viableExcessPp) return { level: "warn", why: `New plants earn ${ret}, only ${ex} points above the local prime rate` };
  return { level: "ok", why: `New plants earn ${ret}, ${ex} points above the local prime rate` };
}

function sectorMetrics(rows) {
  const byLane = new Map(LANES.map(([id]) => [id, []]));
  for (const r of rows) {
    if (!byLane.has(r.lane)) byLane.set(r.lane, []);
    byLane.get(r.lane).push(r);
  }
  const lanes = [];
  for (const [lane, all] of byLane) {
    const op = all.filter((r) => r.operating);
    const m = {
      lane,
      label: LANE_LABEL[lane] || lane,
      sites: op.length,
      building: all.filter((r) => r.building).length,
      idle: all.filter((r) => r.idle).length,
      playerSites: all.filter((r) => r.player).length,
      playerCorps: new Set(all.filter((r) => r.player).map((r) => r.corpId)).size,
      profitableShare: share(op.filter((r) => r.profitable).length, op.length),
      marginMedian: round(median(op.map((r) => r.margin))),
      paybackTurns: round(median(op.map((r) => r.paybackTurns)), 0),
      returnPct: round(median(op.map((r) => r.returnPct)), 1),
      primePct: round(median(op.map((r) => r.primePct)), 2),
      excessPp: round(median(op.map((r) => r.excessPp)), 1),
      beatsSafeShare: share(op.filter((r) => r.excessPp != null && r.excessPp > 0).length, op.filter((r) => r.excessPp != null).length),
      plantCostAnchor: round(median(op.map((r) => r.plantCost)), 0),
      sellThrough: round(median(op.filter((r) => !r.idle).map((r) => r.sellThrough)), 2),
      playerProfitableShare: share(op.filter((r) => r.player && r.profitable).length, op.filter((r) => r.player).length),
    };
    m.verdict = sectorVerdict(m);
    lanes.push(m);
  }
  const rank = { bad: 0, warn: 1, none: 2, ok: 3 };
  lanes.sort((a, b) => rank[a.verdict.level] - rank[b.verdict.level] || (a.excessPp ?? -Infinity) - (b.excessPp ?? -Infinity));
  const judged = lanes.filter((l) => l.verdict.level !== "none");
  const rets = judged.map((l) => l.returnPct).filter((v) => Number.isFinite(v));
  return {
    lanes,
    viable: judged.filter((l) => l.verdict.level === "ok").length,
    weak: judged.filter((l) => l.verdict.level === "warn").length,
    failing: judged.filter((l) => l.verdict.level === "bad").length,
    judged: judged.length,
    // Best minus worst sector return, in points a year: 0 means perfectly even.
    returnSpreadPp: rets.length >= 2 ? round(Math.max(...rets) - Math.min(...rets), 1) : null,
    bestLane: judged.length ? judged.reduce((a, b) => ((b.returnPct ?? -Infinity) > (a.returnPct ?? -Infinity) ? b : a)).label : null,
    worstLane: judged.length ? judged.reduce((a, b) => ((b.returnPct ?? Infinity) < (a.returnPct ?? Infinity) ? b : a)).label : null,
    worldReturnPct: round(median(rows.filter((r) => r.operating).map((r) => r.returnPct)), 1),
    worldPaybackTurns: round(median(rows.filter((r) => r.operating).map((r) => r.paybackTurns)), 0),
  };
}

// ── 2. Balance: host country and company legal form ─────────────────────────

function countryBalance(rows, laneStats) {
  const laneReturn = new Map(laneStats.lanes.map((l) => [l.lane, l.returnPct]));
  const byCountry = new Map();
  for (const r of rows) {
    if (!r.operating) continue;
    if (!byCountry.has(r.country)) byCountry.set(r.country, []);
    byCountry.get(r.country).push(r);
  }
  const countries = [...byCountry].map(([country, rs]) => {
    const residuals = rs.map((r) => (r.returnPct != null && laneReturn.get(r.lane) != null ? r.returnPct - laneReturn.get(r.lane) : null));
    const edge = round(median(residuals));
    const lanesPresent = new Set(rs.map((r) => r.lane)).size;
    const abs = Math.abs(edge ?? 0);
    const lvl = rs.length < T.minSitesForVerdict ? "none" : abs >= T.edgeBadPp ? "bad" : abs >= T.edgeWarnPp ? "warn" : "ok";
    return {
      country,
      sites: rs.length,
      lanes: lanesPresent,
      playerSites: rs.filter((r) => r.player).length,
      edgePp: edge,
      profitableShare: share(rs.filter((r) => r.profitable).length, rs.length),
      returnPct: round(median(rs.map((r) => r.returnPct)), 1),
      primePct: round(median(rs.map((r) => r.primePct)), 2),
      marginEdgePp: round(median(rs.map((r) => r.margin))),
      level: lvl,
      why: lvl === "none" ? "Too few sites" : `New plants here return ${Math.abs(edge)} points a year ${edge >= 0 ? "more" : "less"} than the same sector elsewhere`,
    };
  });
  countries.sort((a, b) => Math.abs(b.edgePp ?? 0) - Math.abs(a.edgePp ?? 0));
  return countries;
}

function legalFormBalance({ corps, histByCorp, sinceTurn }) {
  const player = corps.filter((c) => c.ceoType === "character" && !c.isPrimaryNationalCorporation);
  const margins = [];
  for (const c of player) {
    const h = histByCorp.get(String(c._id));
    const rev = num(h && h.revenue);
    const net = num(h && (h.incomePreDividends ?? h.income));
    c._afterTaxMargin = rev > 0 && net != null ? (100 * net) / rev : null;
    if (c._afterTaxMargin != null) margins.push(c);
  }
  // Sector-adjust: compare each corp with player corps of its own primary sector.
  const laneMedian = new Map();
  for (const c of margins) {
    const k = laneOf({ sectorType: c.type, industryModel: c.industryModel, mediaDiscriminator: c.mediaDiscriminator });
    if (!laneMedian.has(k)) laneMedian.set(k, []);
    laneMedian.get(k).push(c._afterTaxMargin);
  }
  for (const [k, xs] of laneMedian) laneMedian.set(k, median(xs));
  const groups = new Map();
  for (const c of player) {
    const form = c.legalStructure || "unspecified";
    if (!groups.has(form)) groups.set(form, []);
    groups.get(form).push(c);
  }
  const newSince = player.filter((c) => (c.foundedAtTurn ?? -Infinity) >= sinceTurn).length;
  const forms = [...groups].map(([form, cs]) => {
    const resid = cs.map((c) => {
      if (c._afterTaxMargin == null) return null;
      const k = laneOf({ sectorType: c.type, industryModel: c.industryModel, mediaDiscriminator: c.mediaDiscriminator });
      return c._afterTaxMargin - laneMedian.get(k);
    });
    const founded = cs.filter((c) => (c.foundedAtTurn ?? -Infinity) >= sinceTurn).length;
    const choice = share(founded, newSince);
    const edge = round(median(resid));
    let lvl = "ok";
    if (newSince >= T.minCorpsForChoice && choice >= T.choiceBadShare) lvl = "bad";
    else if (Math.abs(edge ?? 0) >= T.formEdgeBadPp && cs.length >= T.minSitesForVerdict) lvl = "bad";
    else if (newSince >= T.minCorpsForChoice && choice >= T.choiceWarnShare) lvl = "warn";
    else if (Math.abs(edge ?? 0) >= T.formEdgeWarnPp && cs.length >= T.minSitesForVerdict) lvl = "warn";
    if (cs.length < T.minSitesForVerdict && newSince < T.minCorpsForChoice) lvl = "none";
    return { form, label: legalFormLabel(form), corps: cs.length, foundedSinceReset: founded, choiceShare: choice, edgePp: edge, level: lvl };
  });
  forms.sort((a, b) => b.corps - a.corps);
  return { playerCorps: player.length, foundedSinceReset: newSince, forms };
}

const FORM_LABELS = {
  generic_corp: "Corporation (generic)", us_c_corp: "US C corporation", us_s_corp: "US S corporation", us_llc: "US LLC",
  uk_plc: "UK PLC", uk_ltd: "UK Ltd", uk_llp: "UK LLP", jp_kk: "Japan KK", jp_gk: "Japan GK", de_ag: "German AG",
  de_gmbh: "German GmbH", de_se: "European SE", ca_corp: "Canadian corporation", cn_gufen: "China joint-stock",
  unspecified: "Not recorded",
};
function legalFormLabel(id) {
  return FORM_LABELS[id] || String(id).replace(/_/g, " ").replace(/\b([a-z]{2})\b/, (m) => m.toUpperCase());
}

// ── 3. Politics ──────────────────────────────────────────────────────────────

function partyKey(country, id) {
  return `${country}:${id}`;
}

function candidateFields({ elections, candidates, npps, parties, turn }) {
  const byElection = new Map();
  const standing = new Set();
  for (const c of candidates) {
    if (c.status && c.status !== "active") continue;
    if (c.nppId) standing.add(String(c.nppId));
    const k = String(c.electionId);
    if (!byElection.has(k)) byElection.set(k, []);
    byElection.get(k).push(c);
  }
  const partiesByCountry = new Map();
  for (const p of parties) partiesByCountry.set(p.countryId, (partiesByCountry.get(p.countryId) || 0) + 1);
  const nppByCountry = new Map();
  const freeByCountry = new Map();
  const nppPartiesByCountry = new Map();
  for (const n of npps) {
    if (n.retiredAt) continue;
    nppByCountry.set(n.countryId, (nppByCountry.get(n.countryId) || 0) + 1);
    if (!standing.has(String(n._id))) freeByCountry.set(n.countryId, (freeByCountry.get(n.countryId) || 0) + 1);
    if (n.party && n.party !== "independent") {
      if (!nppPartiesByCountry.has(n.countryId)) nppPartiesByCountry.set(n.countryId, new Set());
      nppPartiesByCountry.get(n.countryId).add(String(n.party));
    }
  }
  const byCountry = new Map();
  for (const e of elections) {
    if (e.status !== "active") continue;
    const c = e.countryId || "US";
    if (!byCountry.has(c)) byCountry.set(c, { country: c, races: 0, empty: 0, uncontested: 0, contested: 0, candidates: 0, nppCandidates: 0, primaryDeadline: null, resultsTurn: null });
    const row = byCountry.get(c);
    const cands = byElection.get(String(e._id)) || [];
    const sides = new Set(cands.map((x) => (!x.party || x.party === "independent" ? `ind:${x.nppId || x.characterId || x._id}` : `p:${x.party}`)));
    row.races += 1;
    row.candidates += cands.length;
    row.nppCandidates += cands.filter((x) => x.isNPP).length;
    if (sides.size === 0) row.empty += 1;
    else if (sides.size === 1) row.uncontested += 1;
    else row.contested += 1;
    if (e.endTurn != null && e.endTurn >= (turn ?? 0)) row.resultsTurn = row.resultsTurn == null ? e.endTurn : Math.min(row.resultsTurn, e.endTurn);
    if (e.primaryEndTurn != null && e.primaryEndTurn >= (turn ?? 0)) {
      row.primaryDeadline = row.primaryDeadline == null ? e.primaryEndTurn : Math.min(row.primaryDeadline, e.primaryEndTurn);
    }
  }
  const rows = [...byCountry.values()].map((r) => {
    const parties = partiesByCountry.get(r.country) || 0;
    const partiesWithNpps = (nppPartiesByCountry.get(r.country) || new Set()).size;
    const turnsLeft = r.primaryDeadline != null && turn != null ? r.primaryDeadline - turn : null;
    let lvl = "ok";
    let why = "Every race has at least two sides";
    if (r.empty > 0 && turnsLeft != null && turnsLeft <= T.emptyRaceAlarmTurns) { lvl = "bad"; why = `${r.empty} races still empty with ${turnsLeft} turns to the primary deadline`; }
    else if (r.empty > 0 || r.uncontested > 0) {
      lvl = share(r.contested, r.races) < 0.75 ? "warn" : "ok";
      why = `${r.empty} empty and ${r.uncontested} one-sided races${turnsLeft != null ? `, ${turnsLeft} turns to the primary deadline` : ""}`;
    }
    if (parties === 0) why += ". No parties exist yet; players found them";
    return {
      ...r,
      parties,
      partiesWithoutNpps: Math.max(0, parties - partiesWithNpps),
      npps: nppByCountry.get(r.country) || 0,
      nppsFree: freeByCountry.get(r.country) || 0,
      nppsFreePerEmptyRace: r.empty > 0 ? round((freeByCountry.get(r.country) || 0) / r.empty, 1) : null,
      nppsPerRace: round(share(nppByCountry.get(r.country) || 0, r.races), 1),
      contestedShare: share(r.contested, r.races),
      turnsToDeadline: turnsLeft,
      level: lvl,
      why,
    };
  });
  rows.sort((a, b) => b.races - a.races);
  return rows;
}

// Winning margin per race: top side's vote share minus the runner-up's.
function raceMargins({ tallies, electionById }) {
  const out = [];
  for (const t of tallies) {
    const e = electionById.get(String(t.electionId));
    if (!e) continue;
    const snap = Array.isArray(t.turnSnapshots) && t.turnSnapshots.length ? t.turnSnapshots[t.turnSnapshots.length - 1] : null;
    const votes = t.totalVotes && Object.keys(t.totalVotes).length ? t.totalVotes : snap && snap.cumulativeVotes;
    if (!votes) continue;
    const sides = new Map();
    for (const [cand, v] of Object.entries(votes)) {
      const party = t.candidateParties && t.candidateParties[cand];
      const key = !party || party === "independent" ? `ind:${cand}` : `p:${party}`;
      sides.set(key, (sides.get(key) || 0) + (num(v) || 0));
    }
    const total = [...sides.values()].reduce((a, b) => a + b, 0);
    if (!(total > 0)) continue;
    const sorted = [...sides.values()].sort((a, b) => b - a);
    out.push({
      country: e.countryId || "US",
      electionType: e.electionType,
      finalized: !!t.finalized,
      marginPp: (100 * (sorted[0] - (sorted[1] || 0))) / total,
      sides: sorted.length,
    });
  }
  return out;
}

function competitiveness(margins) {
  const byCountry = new Map();
  for (const m of margins) {
    if (!byCountry.has(m.country)) byCountry.set(m.country, []);
    byCountry.get(m.country).push(m);
  }
  return [...byCountry].map(([country, ms]) => {
    const close = ms.filter((m) => m.marginPp < T.closeMarginPp).length;
    const landslide = ms.filter((m) => m.marginPp >= T.landslideMarginPp).length;
    const closeShare = share(close, ms.length);
    const lvl = ms.length < T.minSitesForVerdict ? "none" : closeShare < 0.15 ? "bad" : closeShare < 0.3 ? "warn" : "ok";
    return {
      country,
      races: ms.length,
      decided: ms.filter((m) => m.finalized).length,
      marginMedianPp: round(median(ms.map((m) => m.marginPp))),
      closeShare,
      landslideShare: share(landslide, ms.length),
      level: lvl,
    };
  }).sort((a, b) => b.races - a.races);
}

function chamberSeats(officials, country, officeType) {
  const seats = new Map();
  for (const o of officials) {
    if ((o.countryId || "US") !== country || o.officeType !== officeType) continue;
    const k = o.party || "independent";
    seats.set(k, (seats.get(k) || 0) + (num(o.seatsHeld) || 1));
  }
  return seats;
}

function dominance({ officials, formations, partyByKey, parties, turn, history }) {
  const countries = new Set([...Object.keys(MAIN_CHAMBER)]);
  const formationByCountry = new Map(formations.map((f) => [f.countryId, f]));
  const singleParty = new Set(parties.filter((p) => p.regimeStatus === "ruling").map((p) => p.countryId));
  const rows = [];
  for (const country of countries) {
    const main = chamberSeats(officials, country, MAIN_CHAMBER[country]);
    const total = [...main.values()].reduce((a, b) => a + b, 0);
    const ranked = [...main].sort((a, b) => b[1] - a[1]);
    const largest = ranked[0] || null;
    let executive = null;
    if (PRESIDENTIAL.has(country)) {
      const pres = officials.find((o) => (o.countryId || "US") === country && o.officeType === "president");
      executive = pres ? pres.party || "independent" : null;
    } else {
      const f = formationByCountry.get(country);
      if (f && f.governingPartyId != null && f.status !== "pending") executive = String(f.governingPartyId);
    }
    // Tenure and handovers come from the per-turn history the collector keeps.
    let since = null;
    let handovers = 0;
    let prev;
    for (const h of history) {
      const ex = h.politics && h.politics.exec && h.politics.exec[country];
      if (ex === undefined) continue;
      if (prev !== undefined && ex !== prev && ex != null && prev != null) handovers += 1;
      if (ex !== prev) since = h.turn;
      prev = ex;
    }
    if (executive != null && prev !== executive) since = turn;
    const tenureTurns = executive != null && since != null && turn != null ? turn - since : null;
    let trifecta = null;
    if (UPPER_CHAMBER[country] && executive) {
      const upper = [...chamberSeats(officials, country, UPPER_CHAMBER[country])].sort((a, b) => b[1] - a[1]);
      const upperTotal = upper.reduce((a, [, s]) => a + s, 0);
      trifecta = !!(largest && largest[0] === executive && largest[1] > total / 2 && upper[0] && upper[0][0] === executive && upper[0][1] > upperTotal / 2);
    }
    const largestShare = largest && total > 0 ? largest[1] / total : null;
    const byDesign = singleParty.has(country);
    let lvl = "none";
    let why = "No one seated yet";
    if (total > 0 || executive) {
      lvl = "ok";
      why = "Power is contested";
      if (!byDesign && largestShare != null && largestShare >= T.supermajorityShare) { lvl = "bad"; why = `One party holds ${Math.round(largestShare * 100)}% of the ${MAIN_CHAMBER[country]} seats`; }
      else if (!byDesign && tenureTurns != null && tenureTurns >= T.longHoldTurns) { lvl = "warn"; why = `Same party has governed for ${round(tenureTurns / TURNS_PER_YEAR, 1)} game years`; }
      else if (!byDesign && trifecta) { lvl = "warn"; why = "One party holds the presidency and both chambers"; }
      if (byDesign) { lvl = "ok"; why = "One-party state by constitution"; }
    }
    const label = (id) => {
      if (id == null) return null;
      const p = partyByKey.get(partyKey(country, id));
      return p ? { id: String(id), name: p.name, abbr: p.abbreviation, color: p.color } : { id: String(id), name: id === "independent" ? "Independents" : String(id), abbr: null, color: null };
    };
    rows.push({
      country,
      chamber: MAIN_CHAMBER[country],
      seated: total,
      enp: round(effectiveParties([...main.values()]), 2),
      largest: largest ? { ...label(largest[0]), seats: largest[1], share: largestShare } : null,
      seats: ranked.slice(0, 6).map(([id, s]) => ({ ...label(id), seats: s })),
      executive: label(executive),
      tenureTurns,
      handovers,
      trifecta,
      byDesign,
      level: lvl,
      why,
    });
  }
  return rows;
}

// ── 4. Infra ─────────────────────────────────────────────────────────────────

function phaseDurations(log) {
  const out = [];
  for (const [phase, p] of Object.entries(log.phaseStatuses || {})) {
    const a = p && p.startedAt ? new Date(p.startedAt).getTime() : null;
    const b = p && p.completedAt ? new Date(p.completedAt).getTime() : null;
    if (a && b && b >= a) out.push({ phase, ms: b - a, status: p.status });
  }
  return out.sort((x, y) => y.ms - x.ms);
}

function turnRecord(log) {
  return {
    turn: log.turn,
    at: log.realTime || log.createdAt || null,
    ms: num(log.durationMs),
    outcome: log.outcome || (log.success === false ? "failed" : "clean"),
    failedPhases: Array.isArray(log.failedPhases) ? log.failedPhases.length : 0,
    rssMb: num(log.memory && log.memory.peakRssMb),
    commit: log.build && log.build.commit ? String(log.build.commit).slice(0, 10) : null,
  };
}

function turnMetrics({ turns, cadenceMin }) {
  const recent = turns.slice(-48);
  const ms = recent.map((t) => t.ms).filter((v) => v != null);
  const gaps = [];
  for (let i = 1; i < recent.length; i++) {
    const a = recent[i - 1].at && new Date(recent[i - 1].at).getTime();
    const b = recent[i].at && new Date(recent[i].at).getTime();
    if (a && b && recent[i].turn === recent[i - 1].turn + 1) gaps.push((b - a) / 60000);
  }
  const cadence = cadenceMin || median(gaps) || 60;
  const p95 = quantile(ms, 0.95);
  const failures = recent.filter((t) => t.outcome !== "clean" || t.failedPhases > 0).length;
  const late = gaps.filter((g) => g > cadence * 1.25).length;
  const p95Share = p95 != null ? p95 / 60000 / cadence : null;
  const lvl = failures > 0 || (p95Share != null && p95Share >= T.turnP95BadShare)
    ? "bad"
    : p95Share != null && p95Share >= T.turnP95WarnShare ? "warn" : ms.length ? "ok" : "none";
  return {
    count: recent.length,
    last: turns[turns.length - 1] || null,
    p50Ms: round(median(ms), 0),
    p95Ms: round(p95, 0),
    maxMs: ms.length ? Math.max(...ms) : null,
    failures,
    late,
    cadenceMin: round(cadence, 0),
    p95Share: round(p95Share, 3),
    peakRssMb: recent.reduce((m, t) => Math.max(m, t.rssMb || 0), 0) || null,
    level: lvl,
  };
}

function readJsonl(file, limit) {
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

const RELEASE_OK = new Set(["deployed", "adopted"]);

// The deploy loop retries a failing release every couple of minutes, so raw
// rows overcount failures. Group attempts into one release per (service, sha).
function groupReleases(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (r.row !== "ahd-us-worker" && r.row !== "ahd-us-web") continue;
    const kind = r.kind || (r.row === "ahd-us-web" ? "web" : "worker");
    const key = `${kind}:${r.sha}`;
    if (!byKey.has(key)) byKey.set(key, { kind, sha: String(r.sha || "").slice(0, 10), attempts: [], committedAt: r.committed_at || null });
    byKey.get(key).attempts.push(r);
  }
  return [...byKey.values()].map((g) => {
    const ok = g.attempts.find((a) => RELEASE_OK.has(a.result));
    const last = g.attempts[g.attempts.length - 1];
    const final = ok || last;
    const st = final.stages || {};
    return {
      kind: g.kind,
      sha: g.sha,
      result: ok ? ok.result : last.result,
      ok: !!ok,
      attempts: g.attempts.length,
      retries: g.attempts.length - 1,
      finishedAt: final.finished_at || null,
      buildS: num(st.build_s),
      shipS: num(st.ship_s),
      swapS: num(st.swap_s),
      totalS: num(final.total_s),
      leadS: ok ? num(ok.lead_s) : null,
      message: last.message || null,
    };
  }).sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
}

function buildMetrics({ autodeployDir }) {
  const all = groupReleases(readJsonl(path.join(autodeployDir, "ahd-us-releases.jsonl"), 4000));
  const releases = all.slice(-20);
  const ship = readJsonl(path.join(autodeployDir, "ship-latency.jsonl"), 50).filter((r) => r.sha);
  const worker = releases.filter((r) => r.kind === "worker" && r.ok);
  const failed = releases.filter((r) => !r.ok).length;
  const retried = releases.filter((r) => r.retries > 0).length;
  const devToLive = ship.map((s) => num(s.dev_to_live_min)).filter((v) => v != null);
  const leadMin = median(worker.map((r) => (r.leadS != null ? r.leadS / 60 : null)));
  const lastFailed = releases.length && !releases[releases.length - 1].ok;
  const lvl = lastFailed ? "bad" : failed > 0 || (leadMin != null && leadMin > T.releaseLeadWarnMin) ? "warn" : releases.length ? "ok" : "none";
  return {
    releases: releases.slice().reverse().slice(0, 10),
    // Commit-to-live per successful release, for the over-time chart.
    series: all.slice(-60).filter((r) => r.ok && r.finishedAt && r.leadS != null).map((r) => ({ kind: r.kind, at: r.finishedAt, leadMin: Math.round(r.leadS / 6) / 10, buildS: r.buildS })),
    count: releases.length,
    buildMedianS: round(median(worker.map((r) => r.buildS)), 0),
    shipMedianS: round(median(worker.map((r) => r.shipS)), 0),
    totalMedianS: round(median(worker.map((r) => r.totalS)), 0),
    commitToLiveMedianMin: round(leadMin, 0),
    devToLiveMedianMin: round(median(devToLive), 0),
    failed,
    retried,
    level: lvl,
  };
}

// ── collection ───────────────────────────────────────────────────────────────

// A reset is identified by its world epoch, not its label: a re-run reset can
// keep the same preset and iteration number (it did on 2026-11-15), and keying
// by label mixed two worlds' turns into one history.
const GAME_STATE_PROJECTION = { currentTurn: 1, currentYear: 1, iteration: 1, preset: 1, startingYear: 1, nextScheduledTurn: 1, pausedAt: 1, pauseReason: 1, worldEpochId: 1, worldEpochStartedAt: 1, resetWorldId: 1 };

function worldIdentity(gs) {
  const it = (gs && gs.iteration) || {};
  const label = `${(gs && gs.preset) || "world"} · ${it.type || "Iteration"} ${it.number ?? "?"}`;
  const epoch = gs && (gs.worldEpochId || gs.resetWorldId);
  const id = epoch ? `${(gs && gs.preset) || "world"}-${String(epoch)}` : `${(gs && gs.preset) || "world"}:${it.type || "Iteration"}-${it.number ?? "?"}`;
  const startedAt = gs && gs.worldEpochStartedAt ? new Date(gs.worldEpochStartedAt) : null;
  return { id, label, startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null };
}

async function readGameState(db) {
  return (await db.collection("gameState").findOne({ _id: "current" }, { projection: GAME_STATE_PROJECTION })) || {};
}

async function collect(db, { autodeployDir = "/var/lib/autodeploy", history = [], turnHistory = [], now = new Date(), gameState = null } = {}) {
  const gs = gameState || (await readGameState(db));
  const turn = gs.currentTurn ?? null;
  const it = gs.iteration || {};
  const world = worldIdentity(gs);
  const worldId = world.id;
  // Only this world's documents: rows left over from before the reset share
  // turn numbers with the new world.
  const since = world.startedAt ? { createdAt: { $gte: world.startedAt } } : {};

  const [fx, banks, corps, sectors, histTurnDoc, npps, parties, elections, candidates, officials, formations, turnLogs, lastLog, gameConfig] = await Promise.all([
    db.collection("exchangeRates").find({}, { projection: { countryId: 1, rate: 1 } }).toArray(),
    db.collection("centralBanks").find({}, { projection: { countryId: 1, primeRate: 1 } }).toArray(),
    db.collection("corporations").find({}, { projection: { type: 1, industryModel: 1, mediaDiscriminator: 1, ceoType: 1, countryId: 1, legalStructure: 1, foundedAtTurn: 1, isPrimaryNationalCorporation: 1 } }).toArray(),
    db.collection("corporateSectors").find({}, { projection: { corporationId: 1, countryId: 1, sectorType: 1, industryModel: 1, mediaDiscriminator: 1, "plantsPnl.profit": 1, "plantsPnl.revenue": 1, "plantsPnl.turn": 1, capacityBookAnchor: 1, constructionInProgressAnchor: 1, capitalStock: 1, operatingCapacityUnits: 1, plantCount: 1, soldFraction: 1, capitalUtilization: 1 } }).toArray(),
    db.collection("corporationHistory").find({ turn: { $lte: turn ?? 0 }, ...since }, { projection: { turn: 1 } }).sort({ turn: -1 }).limit(1).next(),
    db.collection("npps").find({ retiredAt: null }, { projection: { countryId: 1, party: 1, retiredAt: 1 } }).toArray(),
    db.collection("politicalParties").find({}, { projection: { countryId: 1, sequentialId: 1, name: 1, abbreviation: 1, color: 1, regimeStatus: 1 } }).toArray(),
    // Live races plus anything decided in the last two game years: enough for
    // margins and tenure, without re-reading every election the world has held.
    db.collection("elections").find({ $or: [{ status: "active" }, { endTurn: { $gte: (turn ?? 0) - 2 * TURNS_PER_YEAR } }], ...since }, { projection: { countryId: 1, electionType: 1, status: 1, primaryEndTurn: 1, endTurn: 1, totalSeats: 1 } }).toArray(),
    db.collection("electionCandidates").find({ status: "active" }, { projection: { electionId: 1, party: 1, status: 1, isNPP: 1, nppId: 1, characterId: 1 } }).toArray(),
    db.collection("electedOfficials").find({}, { projection: { countryId: 1, officeType: 1, party: 1, seatsHeld: 1 } }).toArray(),
    db.collection("governmentFormations").find({}, { projection: { countryId: 1, governingPartyId: 1, status: 1, formedTurn: 1 } }).toArray(),
    // Turn logs are ~45 KB each because of phaseStatuses; only the newest needs them.
    // Sorted by time, not turn number: the previous world's logs (24 h TTL) carry higher turn numbers.
    db.collection("turnLogs").find(since, { projection: { turn: 1, realTime: 1, createdAt: 1, durationMs: 1, outcome: 1, success: 1, failedPhases: 1, "memory.peakRssMb": 1, "build.commit": 1 } }).sort({ createdAt: -1 }).limit(48).toArray(),
    db.collection("turnLogs").find(since, { projection: { turn: 1, phaseStatuses: 1 } }).sort({ createdAt: -1 }).limit(1).next(),
    db.collection("gameConfig").findOne({}, { projection: { turnLengthMinutes: 1 } }),
  ]);
  const histTurn = histTurnDoc ? histTurnDoc.turn : null;
  const corpHist = histTurn == null ? [] : await db.collection("corporationHistory")
    .find({ turn: histTurn, ...since }, { projection: { corporationId: 1, revenue: 1, income: 1, incomePreDividends: 1 } }).toArray();
  const electionIds = elections.map((e) => e._id);
  const tallies = await db.collection("electionVoteTallies")
    .find({ electionId: { $in: electionIds } }, { projection: { electionId: 1, finalized: 1, totalVotes: 1, candidateParties: 1, turnSnapshots: { $slice: -1 } } }).toArray();

  const fxByCountry = new Map(fx.map((r) => [r.countryId || r._id, r.rate]));
  const primeByCountry = new Map(banks.map((b) => [b.countryId || b._id, num(b.primeRate)]));
  const corpById = new Map(corps.map((c) => [String(c._id), c]));
  const histByCorp = new Map(corpHist.map((h) => [String(h.corporationId), h]));
  // Offices store the party number as a string; accept a record id too.
  const partyByKey = new Map();
  for (const p of parties) {
    partyByKey.set(partyKey(p.countryId, p.sequentialId), p);
    partyByKey.set(partyKey(p.countryId, String(p._id)), p);
  }
  const electionById = new Map(elections.map((e) => [String(e._id), e]));

  const rows = siteRows({ sectors, corpById, fxByCountry, primeByCountry, turn });
  const sectorsOut = sectorMetrics(rows);
  const countriesOut = countryBalance(rows, sectorsOut);
  const firstTurn = history.length ? history[0].turn : turn;
  const formsOut = legalFormBalance({ corps, histByCorp, sinceTurn: firstTurn ?? 0 });

  const fields = candidateFields({ elections, candidates, npps, parties, turn });
  const margins = raceMargins({ tallies, electionById });
  const compOut = competitiveness(margins);
  const domOut = dominance({ officials, formations, partyByKey, parties, turn, history });

  // Turn logs expire after a day, so every turn seen is kept in the world's
  // turns file (turnHistory) and merged here.
  const turnRecs = turnLogs.slice().reverse().map(turnRecord);
  const known = new Map(turnHistory.map((r) => [r.turn, r]));
  for (const r of turnRecs) known.set(r.turn, r);
  const allTurns = [...known.values()].sort((a, b) => a.turn - b.turn);
  const turnsOut = turnMetrics({ turns: allTurns, cadenceMin: null });
  const slowPhases = lastLog ? phaseDurations(lastLog).slice(0, 6) : [];
  const buildsOut = buildMetrics({ autodeployDir });

  const snapshot = {
    v: 1,
    generatedAt: now.toISOString(),
    world: { id: worldId, label: world.label, startedAt: world.startedAt ? world.startedAt.toISOString() : null, preset: gs.preset || null, turn, year: gs.currentYear ?? null, startingYear: gs.startingYear ?? null, iteration: it, paused: !!gs.pausedAt, pauseReason: gs.pauseReason || null, nextTurn: gs.nextScheduledTurn || null, firstTrackedTurn: firstTurn, turnLengthMinutes: gameConfig && gameConfig.turnLengthMinutes },
    thresholds: { ...T, enginePaybackTurns: ENGINE_MAX_PAYBACK_TURNS, turnsPerYear: TURNS_PER_YEAR },
    sectors: sectorsOut,
    balance: { countries: countriesOut, forms: formsOut },
    politics: { fields, competitiveness: compOut, dominance: domOut, racesWithVotes: margins.length },
    infra: { turns: turnsOut, turnSeries: allTurns.slice(-400), slowPhases, builds: buildsOut },
  };
  Object.defineProperty(snapshot, "turnRecords", { value: turnRecs, enumerable: false });
  snapshot.verdicts = verdicts(snapshot);
  return snapshot;
}

function verdicts(s) {
  const sec = s.sectors;
  const sectorLevel = sec.judged ? (sec.failing ? "bad" : sec.weak ? "warn" : "ok") : "none";
  const countries = s.balance.countries.filter((c) => c.level !== "none");
  const forms = s.balance.forms.forms.filter((f) => f.level !== "none");
  const balanceLevel = level(...countries.map((c) => c.level), ...forms.map((f) => f.level));
  const worstCountry = countries.find((c) => c.level === balanceLevel && balanceLevel !== "ok");
  const worstForm = forms.find((f) => f.level === balanceLevel && balanceLevel !== "ok");
  const f = s.politics.fields;
  const races = f.reduce((a, r) => a + r.races, 0);
  const empty = f.reduce((a, r) => a + r.empty, 0);
  const contested = f.reduce((a, r) => a + r.contested, 0);
  const polLevel = level(...f.map((r) => r.level), ...s.politics.competitiveness.map((r) => r.level), ...s.politics.dominance.map((r) => r.level));
  const t = s.infra.turns;
  const b = s.infra.builds;
  const infraLevel = level(t.level, b.level);
  const secs = (ms) => (ms == null ? "?" : `${Math.round(ms / 1000)}s`);
  return {
    sectors: { level: sectorLevel, headline: `${sec.viable} of ${sec.judged} sectors viable`, detail: sec.failing ? `${sec.failing} return less than the prime rate` : sec.weak ? `${sec.weak} barely beat the prime rate` : "Every sector beats the prime rate" },
    balance: { level: balanceLevel, headline: worstCountry ? `${worstCountry.country} ${worstCountry.edgePp > 0 ? "+" : ""}${worstCountry.edgePp} pts` : worstForm ? `${worstForm.label} ${Math.round((worstForm.choiceShare || 0) * 100)}% of picks` : "No country or form stands out", detail: `${countries.length} host countries, ${s.balance.forms.playerCorps} player companies` },
    politics: { level: polLevel, headline: `${contested} of ${races} races contested`, detail: empty ? `${empty} races have no candidate yet` : "Every race has a candidate" },
    infra: { level: infraLevel, headline: `Turns p95 ${secs(t.p95Ms)}`, detail: `${t.failures} failed of the last ${t.count}; releases ${b.commitToLiveMedianMin ?? "?"} min commit to live` },
  };
}

// Compact per-turn record for trends. Kept small: one line per turn per world.
function historyRecord(s) {
  const exec = {};
  for (const d of s.politics.dominance) exec[d.country] = d.executive ? d.executive.id : null;
  return {
    turn: s.world.turn,
    at: s.generatedAt,
    // [profitable share, median margin, return %/yr, points over prime]
    lanes: Object.fromEntries(s.sectors.lanes.map((l) => [l.lane, [l.profitableShare == null ? null : round(l.profitableShare, 2), l.marginMedian, l.returnPct, l.excessPp]])),
    sectors: { viable: s.sectors.viable, thin: s.sectors.weak, below: s.sectors.failing, worldReturn: s.sectors.worldReturnPct },
    countries: Object.fromEntries(s.balance.countries.map((c) => [c.country, c.edgePp])),
    forms: Object.fromEntries(s.balance.forms.forms.map((f) => [f.form, [f.choiceShare == null ? null : round(f.choiceShare, 3), f.edgePp]])),
    playerCorps: s.balance.forms.playerCorps,
    politics: {
      exec,
      contested: s.politics.fields.reduce((a, r) => a + r.contested, 0),
      uncontested: s.politics.fields.reduce((a, r) => a + r.uncontested, 0),
      empty: s.politics.fields.reduce((a, r) => a + r.empty, 0),
      races: s.politics.fields.reduce((a, r) => a + r.races, 0),
      enp: Object.fromEntries(s.politics.dominance.map((d) => [d.country, d.enp])),
      largest: Object.fromEntries(s.politics.dominance.map((d) => [d.country, d.largest ? round(d.largest.share, 3) : null])),
      close: Object.fromEntries(s.politics.competitiveness.map((c) => [c.country, c.closeShare == null ? null : round(c.closeShare, 3)])),
    },
    v: Object.fromEntries(Object.entries(s.verdicts).map(([k, v]) => [k, v.level])),
  };
}

function safeName(worldId) {
  return String(worldId).replace(/[^A-Za-z0-9._-]+/g, "_");
}

function historyPath(dir, worldId) {
  return path.join(dir, `history-${safeName(worldId)}.jsonl`);
}

function loadHistory(dir, worldId) {
  return readJsonl(historyPath(dir, worldId), 5000);
}

function turnsPath(dir, worldId) {
  return path.join(dir, `turns-${safeName(worldId)}.jsonl`);
}

function loadTurns(dir, worldId) {
  return readJsonl(turnsPath(dir, worldId), 20000);
}

function writeJsonlAtomic(file, rows) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, rows.map((h) => JSON.stringify(h)).join("\n") + (rows.length ? "\n" : ""));
  fs.renameSync(tmp, file);
}

// Upserts every turn record seen this run, keyed by turn.
function saveTurns(dir, worldId, records) {
  const byTurn = new Map(loadTurns(dir, worldId).map((r) => [r.turn, r]));
  for (const r of records || []) if (r && r.turn != null) byTurn.set(r.turn, r);
  const rows = [...byTurn.values()].sort((a, b) => a.turn - b.turn);
  writeJsonlAtomic(turnsPath(dir, worldId), rows);
  return rows.length;
}

// Appends at most one record per turn. Rewrites atomically so a crash mid-write
// never leaves a torn line.
function appendHistory(dir, snapshot) {
  const file = historyPath(dir, snapshot.world.id);
  const existing = loadHistory(dir, snapshot.world.id);
  const rec = historyRecord(snapshot);
  if (rec.turn == null) return { appended: false, file };
  const kept = existing.filter((h) => h.turn !== rec.turn);
  kept.push(rec);
  kept.sort((a, b) => a.turn - b.turn);
  writeJsonlAtomic(file, kept);
  if (snapshot.turnRecords) saveTurns(dir, snapshot.world.id, snapshot.turnRecords);
  return { appended: !existing.some((h) => h.turn === rec.turn), file, turns: kept.length };
}

function writeLatest(dir, snapshot) {
  const file = path.join(dir, "latest.json");
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot));
  fs.renameSync(tmp, file);
  return file;
}

function readLatest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "latest.json"), "utf8")); } catch { return null; }
}

module.exports = {
  TURNS_PER_DAY, TURNS_PER_YEAR, ENGINE_MAX_PAYBACK_TURNS, THRESHOLDS: T, LANES,
  quantile, median, effectiveParties, laneOf,
  siteRows, sectorMetrics, sectorVerdict, countryBalance, legalFormBalance, legalFormLabel,
  candidateFields, raceMargins, competitiveness, dominance,
  turnRecord, turnMetrics, phaseDurations, buildMetrics, groupReleases,
  collect, verdicts, historyRecord, appendHistory, loadHistory, writeLatest, readLatest, historyPath,
  worldIdentity, readGameState, loadTurns, saveTurns, turnsPath,
};
