"use strict";

const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const WINDOW = 48;
const OUT = process.argv[2] || path.join(__dirname, "..", "reports", "research", "economy-snapshot.json");

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const sum = (values) => values.reduce((total, value) => total + finite(value), 0);
const mean = (values) => values.length ? sum(values) / values.length : 0;
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
};
const gini = (values) => {
  const sorted = values.map((v) => Math.max(0, finite(v))).sort((a, b) => a - b);
  const total = sum(sorted);
  if (!sorted.length || total <= 0) return 0;
  let weighted = 0;
  sorted.forEach((value, index) => { weighted += (index + 1) * value; });
  return (2 * weighted) / (sorted.length * total) - (sorted.length + 1) / sorted.length;
};
const shareOfTop = (values, fraction) => {
  const sorted = values.map((v) => Math.max(0, finite(v))).sort((a, b) => b - a);
  const total = sum(sorted);
  const count = Math.max(1, Math.ceil(sorted.length * fraction));
  return { count, share: total > 0 ? sum(sorted.slice(0, count)) / total : 0 };
};
const hhi = (values) => {
  const total = sum(values);
  return total > 0 ? sum(values.map((value) => (value / total) ** 2)) * 10_000 : 0;
};
const pearson = (xs, ys) => {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const xm = mean(xs);
  const ym = mean(ys);
  const numerator = sum(xs.map((x, i) => (x - xm) * (ys[i] - ym)));
  const xd = Math.sqrt(sum(xs.map((x) => (x - xm) ** 2)));
  const yd = Math.sqrt(sum(ys.map((y) => (y - ym) ** 2)));
  return xd > 0 && yd > 0 ? numerator / (xd * yd) : null;
};
const round = (value, digits = 4) => Number(finite(value).toFixed(digits));
const positive = (value) => Math.max(0, finite(value));

function latestRate(history, turn) {
  return [...(history || [])]
    .filter((point) => finite(point.turn, -1) <= turn && Number.isFinite(Number(point.rate)))
    .sort((a, b) => finite(b.turn) - finite(a.turn))[0]?.rate ?? null;
}

function safeDivision(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  const client = new MongoClient(process.env.MONGODB_URI, { appName: "outside-economist-report-readonly" });
  await client.connect();
  try {
    const db = client.db();
    const game = await db.collection("gameState").findOne({ _id: "current" });
    if (!game) throw new Error("gameState/current not found");
    const turn = finite(game.currentTurn);
    const fromTurn = Math.max(1, turn - WINDOW + 1);

    const [
      currentFlows,
      flowHistory,
      currentPrices,
      priceHistory,
      sourcing,
      sectors,
      corporations,
      corporationHistory,
      marketCaps,
      exchangeSnapshots,
      wealthSnapshot,
      oldWealthSnapshot,
      trades,
      openOrders,
      money,
      centralBanks,
      macroMetrics,
      macroCountries,
      states,
      reconciliation,
      activeBonds,
      exchangeRates,
    ] = await Promise.all([
      db.collection("commodityFlows").find({ turn }).toArray(),
      db.collection("commodityFlows").find({ turn: { $gte: fromTurn, $lte: turn } }).toArray(),
      db.collection("commodityPrices").find({}).toArray(),
      db.collection("commodityPriceHistory").find({ turn: { $gte: fromTurn, $lte: turn } }).toArray(),
      db.collection("commoditySourcingFlows").find({ turn }).toArray(),
      db.collection("corporateSectors").find({}).toArray(),
      db.collection("corporations").find({}).toArray(),
      db.collection("corporationHistory").find({ turn }).toArray(),
      db.collection("marketCapHistory").findOne({ turn }),
      db.collection("stockExchangeSnapshots").find({ turn }).toArray(),
      db.collection("wealthListSnapshots").findOne({ _id: "global", turn }),
      db.collection("wealthListHistory").findOne({ exchange: "global", turn: { $lte: turn - 24 } }, { sort: { turn: -1 } }),
      db.collection("shareTradeHistory").find({ turn: { $gte: fromTurn, $lte: turn } }).toArray(),
      db.collection("shareOrders").find({ status: "open" }).toArray(),
      db.collection("moneySupplySnapshots").find({ turn }).toArray(),
      db.collection("centralBanks").find({}).toArray(),
      db.collection("macroMetrics").find({}).toArray(),
      db.collection("macroCountries").find({}).toArray(),
      db.collection("states").find({}).toArray(),
      db.collection("ledgerReconciliations").findOne({ turn }),
      db.collection("bonds").find({ matured: { $ne: true } }).toArray(),
      db.collection("exchangeRates").find({}).toArray(),
    ]);

    const baseByCommodity = new Map(currentPrices.map((row) => [row.commodity, positive(row.basePrice)]));
    const priceByCommodity = new Map(currentPrices.map((row) => [row.commodity, positive(row.globalPrice)]));

    const flowRows = currentFlows.map((row) => {
      const demand = positive(row.demandUnits);
      const supply = positive(row.supplyUnits);
      const cleared = positive(row.clearedUnitsPooled ?? row.clearedUnits);
      const base = baseByCommodity.get(row.commodity) || 0;
      const price = priceByCommodity.get(row.commodity) || positive(row.price);
      return {
        commodity: row.commodity,
        supply,
        demand,
        cleared,
        fill: safeDivision(cleared, demand),
        supplyDemand: safeDivision(supply, demand),
        priceMultiple: safeDivision(price, base),
        valueDemand: demand * price,
      };
    });
    const totalDemand = sum(flowRows.map((row) => row.demand));
    const totalSupply = sum(flowRows.map((row) => row.supply));
    const totalCleared = sum(flowRows.map((row) => row.cleared));
    const priceMultiples = flowRows.map((row) => row.priceMultiple).filter((value) => value > 0);
    const signalRows = flowRows.filter((row) => row.priceMultiple > 0 && row.supplyDemand > 0);

    const countryBook = new Map();
    for (const flow of currentFlows) {
      for (const [country, leg] of Object.entries(flow.byCountry || {})) {
        const entry = countryBook.get(country) || { country, demand: 0, cleared: 0, valueDemand: 0 };
        const demand = positive(leg.demand);
        entry.demand += demand;
        entry.cleared += positive(leg.cleared);
        entry.valueDemand += demand * positive(leg.price);
        countryBook.set(country, entry);
      }
    }
    const countryRows = [...countryBook.values()].map((row) => ({
      ...row,
      fill: safeDivision(row.cleared, row.demand),
    })).sort((a, b) => a.fill - b.fill);
    const worldValueDemand = sum(countryRows.map((row) => row.valueDemand));

    let scopedSupply = 0;
    let scopedDemand = 0;
    let scopedCleared = 0;
    for (const price of currentPrices) {
      const nationalSupply = price.nationalSupply || {};
      const nationalDemand = price.nationalDemand || {};
      for (const [country, rawDemand] of Object.entries(nationalDemand)) {
        const demand = positive(rawDemand);
        const supply = positive(nationalSupply[country]);
        scopedSupply += supply;
        scopedDemand += demand;
        scopedCleared += Math.min(supply, demand);
      }
    }

    const sourcingTotals = sourcing.reduce((acc, row) => {
      acc.demand += positive(row.demandUnitsIntent);
      acc.intra += positive(row.intraStateUnits);
      acc.inter += positive(row.interStateUnits);
      acc.imports += positive(row.importUnits);
      acc.unmet += positive(row.unmetUnits);
      acc.tolerance += positive(row.toleranceBoundUnits);
      acc.capacity += positive(row.capacityBoundUnits);
      return acc;
    }, { demand: 0, intra: 0, inter: 0, imports: 0, unmet: 0, tolerance: 0, capacity: 0 });
    const deliveredSourcing = sourcingTotals.intra + sourcingTotals.inter + sourcingTotals.imports;

    const turns = [...new Set(flowHistory.map((row) => finite(row.turn)))].sort((a, b) => a - b);
    const priceHistoryByTurn = new Map();
    for (const row of priceHistory) {
      const base = baseByCommodity.get(row.commodity) || 0;
      if (!base || !positive(row.globalPrice)) continue;
      const list = priceHistoryByTurn.get(row.turn) || [];
      list.push(positive(row.globalPrice) / base);
      priceHistoryByTurn.set(row.turn, list);
    }
    const flowTrend = turns.map((historyTurn) => {
      const rows = flowHistory.filter((row) => row.turn === historyTurn);
      const demand = sum(rows.map((row) => positive(row.demandUnits)));
      const supply = sum(rows.map((row) => positive(row.supplyUnits)));
      const cleared = sum(rows.map((row) => positive(row.clearedUnitsPooled ?? row.clearedUnits)));
      return {
        turn: historyTurn,
        demand,
        supply,
        fill: safeDivision(cleared, demand),
        medianPriceMultiple: median(priceHistoryByTurn.get(historyTurn) || []),
      };
    });

    const sectorRows = sectors.filter((row) => Number.isFinite(Number(row.throughputFactor)));
    const totalProduced = sum(sectorRows.map((row) => positive(row.producedUnits)));
    const totalSold = sum(sectorRows.map((row) => positive(row.soldUnits)));
    const pinnedRows = sectorRows.filter((row) => Math.abs(finite(row.throughputFactor) - 0.85) < 1e-9);
    const pinnedOutput = sum(pinnedRows.map((row) => positive(row.producedUnits)));
    const desiredWorkers = sum(sectors.map((row) => positive(row.workersDesired ?? row.workers)));
    const staffedWorkers = sum(sectors.map((row) => positive(row.workers)));
    // The legacy clearing pass still stamps soldFraction, lowFillTurns and
    // deliveryLimitedFraction on funded turns, measured against its own lagged
    // book. A sector whose funded settlement is at least as recent as that
    // stamp was paid on the settlement, so it is judged on the settlement only.
    const fundedRecord = (row) => {
      const record = row.producerSettlement;
      if (!record || !Number.isFinite(Number(record.turn))) return null;
      const legacyTurn = Number(row.soldByCommodityTurn);
      return Number.isFinite(legacyTurn) && legacyTurn > Number(record.turn) ? null : record;
    };
    const settledTakenShare = (record) => {
      let offered = 0;
      let taken = 0;
      for (const p of record.products || []) {
        offered += positive(p.offeredUnits);
        taken += positive(p.soldUnits) + positive(p.internalDeliveredUnits);
      }
      return offered > 0 ? taken / offered : null;
    };
    const lowSaleSector = (row) => {
      const record = fundedRecord(row);
      if (!record) return positive(row.lowFillTurns) >= 12;
      const share = settledTakenShare(record);
      return share != null && share < 0.5;
    };
    const deliveryLimitedUnits = sum(sectors.filter((row) => !fundedRecord(row)).map((row) => positive(row.producedUnits) * Math.min(1, positive(row.deliveryLimitedFraction))));
    const bindingCounts = new Map();
    for (const row of sectorRows) {
      const key = row.throughputBindingInput || "none";
      bindingCounts.set(key, (bindingCounts.get(key) || 0) + 1);
    }

    const historyByCorp = new Map(corporationHistory.map((row) => [String(row.corporationId), row]));
    const corpById = new Map(corporations.map((row) => [String(row._id), row]));
    const normalizedCorpHistory = corporationHistory.map((row) => {
      const rate = positive(row.fxRateAtWrite) || 1;
      return {
        corporationId: String(row.corporationId),
        revenue: finite(row.revenue) / rate,
        costs: finite(row.totalCosts) / rate,
        income: finite(row.income) / rate,
        liquidCapital: finite(row.liquidCapital) / rate,
        marketCap: finite(row.marketCap) / rate,
      };
    });
    const operatingRows = normalizedCorpHistory.filter((row) => row.revenue > 0 || row.costs > 0);
    const distress = corporations.filter((row) => row.financialDistressSinceTurn != null || row.nppInsolventSinceTurn != null);

    const globalExchange = exchangeSnapshots.find((snapshot) => snapshot.exchangeName === "Global Markets");
    const publicListings = (globalExchange?.listings || []).filter((row) => positive(row.marketCapAnchor) > 0).map((listing) => ({
      key: String(listing.sequentialId ?? listing.name),
      name: listing.name,
      sector: listing.type,
      exchange: globalExchange.exchangeName,
      marketCapAnchor: positive(listing.marketCapAnchor),
    }));
    const listedValues = publicListings.map((row) => row.marketCapAnchor);
    const listedTotal = sum(listedValues);
    const listedTop = [...publicListings].sort((a, b) => b.marketCapAnchor - a.marketCapAnchor).slice(0, 10).map((row) => ({
      ...row,
      share: safeDivision(row.marketCapAnchor, listedTotal),
    }));

    const wealthEntries = wealthSnapshot?.entries || [];
    const wealthValues = wealthEntries.map((entry) => positive(entry.totalWealth));
    const oldWealthEntries = oldWealthSnapshot?.entries || [];
    const oldWealthValues = oldWealthEntries.map((entry) => positive(entry.totalWealth));
    const wealthTotal = sum(wealthValues);
    const wealthTop1 = shareOfTop(wealthValues, 0.01);
    const wealthTop10 = shareOfTop(wealthValues, 0.10);
    const wealthComponents = wealthEntries.reduce((acc, entry) => {
      acc.stock += positive(entry.stockValue);
      acc.bonds += positive(entry.bondValue);
      acc.cash += positive(entry.cashValue);
      acc.debt += positive(entry.locDebtValue);
      return acc;
    }, { stock: 0, bonds: 0, cash: 0, debt: 0 });

    const marketTradeKinds = new Set(["market_buy", "market_sell", "limit_fill", "peer_fill", "listing_fill", "takeover_buyout"]);
    const marketTrades = trades.filter((row) => marketTradeKinds.has(row.kind));
    const tradeNotional = sum(marketTrades.map((row) => positive(row.totalAnchor)));
    const activeTradeCorps = new Set(marketTrades.map((row) => String(row.corporationId))).size;
    const fxByCurrency = new Map(exchangeRates.map((row) => [row.currencyCode, positive(row.rate) || 1]));
    let openOrderNotional = 0;
    for (const order of openOrders) {
      const corp = corpById.get(String(order.corporationId));
      const rate = fxByCurrency.get(corp?.liquidCurrencyCode || "USD") || 1;
      openOrderNotional += positive(order.sharesRemaining) * positive(order.pricePerShare) / rate;
    }

    const moneyRows = money.filter((row) => positive(row.m2) > 0);
    const moneyGrowth = moneyRows.map((row) => finite(row.annualizedM2GrowthPct, NaN)).filter(Number.isFinite);
    const moneyComposition = moneyRows.map((row) => ({
      country: row.countryId,
      currency: row.currencyCode,
      growth: finite(row.annualizedM2GrowthPct, NaN),
      savingsShare: safeDivision(positive(row.householdSavings) + positive(row.externalBroadMoney) + positive(row.bankDeposits), positive(row.m2)),
      creditToM2: safeDivision(positive(row.creditOutstanding), positive(row.m2)),
      bondsToM2: safeDivision(positive(row.sovereignBondsOutstanding), positive(row.m2)),
    }));
    const inflationRows = centralBanks.map((bank) => ({
      country: bank.countryId,
      inflation: latestRate(bank.inflationHistory, turn),
      primeRate: finite(bank.primeRate, NaN),
    })).filter((row) => Number.isFinite(Number(row.inflation)));

    const populationByEntity = new Map([
      ...macroCountries.map((row) => [String(row._id), positive(row.population)]),
      ...states.map((row) => [String(row._id), positive(row.population)]),
    ]);
    const macroRows = macroMetrics.filter((row) => !String(row._id).endsWith("_national")).map((row) => ({
      entity: String(row._id),
      country: row.countryId,
      population: populationByEntity.get(String(row._id)) || 0,
      gdpGrowth: finite(row.economic?.gdpGrowth?.value, NaN),
      unemployment: finite(row.economic?.unemploymentRate?.value, NaN),
      poverty: finite(row.economic?.povertyRate?.value, NaN),
      costOfLiving: finite(row.economic?.costOfLiving?.value, NaN),
      wageGrowth: finite(row.economic?.wageGrowth?.value, NaN),
      debtToGdp: finite(row.governance?.debtToGdp?.value, NaN),
    }));
    const weightedMacro = (field) => {
      const rows = macroRows.filter((row) => row.population > 0 && Number.isFinite(row[field]));
      return safeDivision(sum(rows.map((row) => row[field] * row.population)), sum(rows.map((row) => row.population)));
    };

    const sovereignBonds = activeBonds.filter((bond) => bond.issuerType === "sovereign");
    const corporateBonds = activeBonds.filter((bond) => bond.issuerType !== "sovereign");
    const heldBondUnits = (bond) => sum((bond.holders || []).map((holder) => positive(holder.units)));
    const bondHolderCounts = activeBonds.map((bond) => (bond.holders || []).filter((holder) => positive(holder.units) > 0).length);

    const data = {
      metadata: {
        generatedAt: new Date().toISOString(),
        turn,
        year: game.currentYear,
        iteration: game.iteration,
        windowTurns: WINDOW,
        fromTurn,
        basis: "Read-only production snapshot; monetary stocks compared within currency; cross-country wealth and public-equity values use the system's anchor-normalized snapshots.",
      },
      allocation: {
        commodities: flowRows.length,
        pooledFill: round(safeDivision(totalCleared, totalDemand)),
        aggregateSupplyDemand: round(safeDivision(totalSupply, totalDemand)),
        countryScopedFill: round(safeDivision(scopedCleared, scopedDemand)),
        countryScopedSupplyDemand: round(safeDivision(scopedSupply, scopedDemand)),
        medianCommodityPriceMultiple: round(median(priceMultiples)),
        p25CommodityPriceMultiple: round(percentile(priceMultiples, 0.25)),
        p75CommodityPriceMultiple: round(percentile(priceMultiples, 0.75)),
        commoditiesAbove2xBase: priceMultiples.filter((value) => value >= 2).length,
        commoditiesAbove4xBase: priceMultiples.filter((value) => value >= 4).length,
        priceScarcityCorrelation: round(pearson(
          signalRows.map((row) => Math.log(row.demand / Math.max(row.supply, 1))),
          signalRows.map((row) => Math.log(row.priceMultiple))
        )),
        windowFillMedian: round(median(flowTrend.map((row) => row.fill))),
        windowFillP10: round(percentile(flowTrend.map((row) => row.fill), 0.10)),
        windowFillP90: round(percentile(flowTrend.map((row) => row.fill), 0.90)),
        recent12TurnFillMedian: round(median(flowTrend.slice(-12).map((row) => row.fill))),
        recent12TurnFillLow: round(Math.min(...flowTrend.slice(-12).map((row) => row.fill))),
        recent12TurnFillHigh: round(Math.max(...flowTrend.slice(-12).map((row) => row.fill))),
        worstCommodities: [...flowRows].sort((a, b) => a.fill - b.fill).slice(0, 10).map((row) => ({
          commodity: row.commodity,
          fill: round(row.fill),
          supplyDemand: round(row.supplyDemand),
          priceMultiple: round(row.priceMultiple),
          valueDemand: round(row.valueDemand, 2),
        })),
        largestCommodities: [...flowRows].sort((a, b) => b.valueDemand - a.valueDemand).slice(0, 10).map((row) => ({
          commodity: row.commodity,
          fill: round(row.fill),
          priceMultiple: round(row.priceMultiple),
          valueDemand: round(row.valueDemand, 2),
        })),
        countryValueDemandHhi: round(hhi(countryRows.map((row) => row.valueDemand)), 1),
        topCountryValueDemandShare: round(Math.max(...countryRows.map((row) => safeDivision(row.valueDemand, worldValueDemand)), 0)),
        worstCountries: countryRows.slice(0, 8).map((row) => ({
          country: row.country,
          fill: round(row.fill),
          valueDemandShare: round(safeDivision(row.valueDemand, worldValueDemand)),
        })),
        flowTrend: flowTrend.filter((row, index) => index % 3 === 0 || row.turn === turn).map((row) => ({
          turn: row.turn,
          demandM: round(row.demand / 1e6, 2),
          supplyM: round(row.supply / 1e6, 2),
          fill: round(row.fill),
          medianPriceMultiple: round(row.medianPriceMultiple),
        })),
      },
      trade: {
        sourcingIntentUnits: round(sourcingTotals.demand, 2),
        sourcingFulfillment: round(safeDivision(deliveredSourcing, sourcingTotals.demand)),
        intraStateShare: round(safeDivision(sourcingTotals.intra, deliveredSourcing)),
        interStateShare: round(safeDivision(sourcingTotals.inter, deliveredSourcing)),
        importShare: round(safeDivision(sourcingTotals.imports, deliveredSourcing)),
        unmetUnits: round(sourcingTotals.unmet, 2),
        toleranceBoundShareOfUnmet: round(safeDivision(sourcingTotals.tolerance, sourcingTotals.unmet)),
        capacityBoundShareOfUnmet: round(safeDivision(sourcingTotals.capacity, sourcingTotals.unmet)),
      },
      production: {
        sectors: sectors.length,
        measuredSectors: sectorRows.length,
        throughputFloorShare: round(safeDivision(pinnedRows.length, sectorRows.length)),
        throughputFloorOutputShare: round(safeDivision(pinnedOutput, totalProduced)),
        physicalSellThrough: round(safeDivision(totalSold, totalProduced)),
        deliveryLimitedOutputShare: round(safeDivision(deliveryLimitedUnits, totalProduced)),
        labourStaffingRate: round(safeDivision(staffedWorkers, desiredWorkers)),
        // Funded sectors: latest settled sale under half. Others: legacy 12 turn streak.
        chronicLowFillSectors: sectors.filter(lowSaleSector).length,
        fundedSectors: sectors.filter((row) => fundedRecord(row)).length,
        stockpilingSectors: sectors.filter((row) => row.stockpileUnsold === true).length,
        leadingBindingInputs: [...bindingCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([input, count]) => ({ input, count })),
      },
      firms: {
        corporations: corporations.length,
        corporationsObservedThisTurn: normalizedCorpHistory.length,
        operatingCorporations: operatingRows.length,
        distressedCorporations: distress.length,
        negativeIncomeCorporations: operatingRows.filter((row) => row.income < 0).length,
        aggregateRevenueAnchor: round(sum(operatingRows.map((row) => row.revenue)), 2),
        aggregateIncomeAnchor: round(sum(operatingRows.map((row) => row.income)), 2),
        publicMarketCapAnchor: round(listedTotal, 2),
        publishedMarketCapHistoryAnchor: round(marketCaps?.globalMarketCap, 2),
        publicListings: publicListings.length,
        publicFirmHhi: round(hhi(listedValues), 1),
        top1FirmShare: round(listedTop[0]?.share || 0),
        top4FirmShare: round(sum(listedTop.slice(0, 4).map((row) => row.share))),
        top10FirmShare: round(sum(listedTop.map((row) => row.share))),
        largestPublicFirms: listedTop,
      },
      households: {
        observedPlayers: wealthEntries.length,
        totalNetWorthAnchor: round(wealthTotal, 2),
        meanNetWorthAnchor: round(mean(wealthValues), 2),
        medianNetWorthAnchor: round(median(wealthValues), 2),
        gini: round(gini(wealthValues)),
        top1PctCount: wealthTop1.count,
        top1PctShare: round(wealthTop1.share),
        top10PctCount: wealthTop10.count,
        top10PctShare: round(wealthTop10.share),
        largestFortuneShare: round(safeDivision(Math.max(...wealthValues, 0), wealthTotal)),
        wealthComponents: wealthComponents,
        oldSnapshotTurn: oldWealthSnapshot?.turn ?? null,
        oldGini: round(gini(oldWealthValues)),
        oldTop1PctShare: round(shareOfTop(oldWealthValues, 0.01).share),
      },
      equityLiquidity: {
        windowTurns: WINDOW,
        marketTrades: marketTrades.length,
        tradeNotionalAnchor: round(tradeNotional, 2),
        turnoverToMarketCap: round(safeDivision(tradeNotional, listedTotal)),
        activeTradedCorporations: activeTradeCorps,
        activeTradedShare: round(safeDivision(activeTradeCorps, publicListings.length)),
        openOrders: openOrders.length,
        openOrderNotionalAnchor: round(openOrderNotional, 2),
        tradeKinds: Object.fromEntries([...marketTradeKinds].map((kind) => [kind, marketTrades.filter((row) => row.kind === kind).length])),
      },
      money: {
        countries: moneyRows.length,
        annualizedM2GrowthMedian: round(median(moneyGrowth)),
        annualizedM2GrowthP10: round(percentile(moneyGrowth, 0.10)),
        annualizedM2GrowthP90: round(percentile(moneyGrowth, 0.90)),
        inflationMedian: round(median(inflationRows.map((row) => finite(row.inflation)))),
        inflationP10: round(percentile(inflationRows.map((row) => finite(row.inflation)), 0.10)),
        inflationP90: round(percentile(inflationRows.map((row) => finite(row.inflation)), 0.90)),
        medianSavingsShareOfM2: round(median(moneyComposition.map((row) => row.savingsShare))),
        medianCreditToM2: round(median(moneyComposition.map((row) => row.creditToM2))),
        m2GrowthInflationCorrelation: round(pearson(
          moneyComposition.filter((row) => Number.isFinite(row.growth) && inflationRows.some((inflation) => inflation.country === row.country)).map((row) => row.growth),
          moneyComposition.filter((row) => Number.isFinite(row.growth) && inflationRows.some((inflation) => inflation.country === row.country)).map((row) => inflationRows.find((inflation) => inflation.country === row.country).inflation)
        )),
        fastestM2Growth: [...moneyComposition].filter((row) => Number.isFinite(row.growth)).sort((a, b) => b.growth - a.growth).slice(0, 5),
        slowestM2Growth: [...moneyComposition].filter((row) => Number.isFinite(row.growth)).sort((a, b) => a.growth - b.growth).slice(0, 5),
        ledger: {
          turn: reconciliation?.turn ?? null,
          trialBalanceStatus: reconciliation?.trialBalance?.status ?? "missing",
          unbalancedCount: reconciliation?.trialBalance?.unbalancedCount ?? null,
          stockVsFlowStatus: reconciliation?.stockVsFlow?.status ?? "missing",
          divergentAccountCount: reconciliation?.stockVsFlow?.divergentCount ?? null,
          moneySupplyStatus: reconciliation?.moneySupply?.status ?? "missing",
          moneySupplyFindingCount: reconciliation?.moneySupply?.findings?.length ?? null,
        },
      },
      macro: {
        entities: macroRows.length,
        populationWeightedGdpGrowth: round(weightedMacro("gdpGrowth")),
        populationWeightedUnemployment: round(weightedMacro("unemployment")),
        populationWeightedPoverty: round(weightedMacro("poverty")),
        populationWeightedCostOfLiving: round(weightedMacro("costOfLiving")),
        populationWeightedWageGrowth: round(weightedMacro("wageGrowth")),
        medianDebtToGdp: round(median(macroRows.map((row) => row.debtToGdp).filter(Number.isFinite))),
        rows: macroRows,
      },
      bonds: {
        activeBonds: activeBonds.length,
        corporateBonds: corporateBonds.length,
        sovereignBonds: sovereignBonds.length,
        defaultedActiveBonds: activeBonds.filter((bond) => bond.defaulted === true).length,
        bondsWithNoHolder: activeBonds.filter((bond) => heldBondUnits(bond) <= 0).length,
        medianHoldersPerBond: round(median(bondHolderCounts)),
      },
      confidence: {
        strengths: [
          "All headline values are pinned to one production turn.",
          "Player wealth and public equity values use the game's own anchor-normalized snapshots.",
          "Commodity allocation uses settled ledger flows; physical reach uses the separately labeled sourcing-intent book.",
        ],
        limitations: [
          "No counterfactual identifies causal effects of recent changes.",
          "Commodity units are not commensurable across categories, so aggregate fill is an operational index rather than a welfare measure.",
          "The shadow ledger's stock-versus-flow reconciliation is amber, so money-flow attribution is less reliable than balance snapshots.",
          "Player wealth is a stock measure and does not capture consumption, utility, or off-market political power.",
        ],
      },
    };

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
