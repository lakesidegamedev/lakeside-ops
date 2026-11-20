"use strict";
// Envelopes in the game's real contract shape (schemaVersion 1, world object, contract units), with invented values.
const WORLD = (epoch = "epoch-a", turn = 131) => ({ worldEpochId: epoch, telemetryWorldId: "preset:Fixture-1", startedAt: "2026-11-15T22:09:31.903Z", currentTurn: turn });
const market = (shift = 0, n = 14, commodity = "steel", world = WORLD()) => ({ schemaVersion: 1, tool: "market_history", metric: "commodity_volume", unit: "t per turn",
  scope: { commodity, commodityName: commodity, commodityUnit: "t", market: "country:US", country: "US", fromTurn: 117 + shift, toTurn: 116 + n + shift }, world, asOfTurn: 116 + n + shift,
  rows: Array.from({ length: n }, (_, i) => ({ turn: 117 + i + shift, offeredUnits: 1000 + i * 10, demandUnits: 1200 + i * 5, soldUnits: i === 3 ? null : 700 + i * 8, unmetDemandUnits: null, surplusUnits: null, soldPctOfOffered: i === 3 ? null : 70 + i })),
  summary: null, sources: [{ collection: "commodityFlows", fields: ["supplyUnits", "demandUnits", "clearedUnits"], basis: "one row per commodity per turn", note: "fixture" }], gaps: [] });
const operating = (bump = 0) => ({ schemaVersion: 1, tool: "reporter_operating_results", metric: "site_operating_results", unit: "anchor currency per turn",
  scope: { ticket: 123, verifiedReporter: { sequentialId: 9, name: "Fixture Reporter" }, companies: [{ corporationId: "c0ffee000000000000000001", name: "Fixture Co", sequentialId: 5 }], basis: "companies the reporter runs as CEO" },
  world: WORLD(), asOfTurn: 130,
  rows: [128, 129, 130].map((turn, i) => ({ turn, siteId: "5174e000000000000000aa01", corporation: "Fixture Co", corporationSequentialId: 5, corporationId: "c0ffee000000000000000001", sectorType: "retail", siteName: "Fixture Shop",
    countryId: "US", stateId: "CA", offeredUnits: 100, soldUnits: 100, revenue: 100 + i + bump, fees: { operatingServicesPaid: 10, minorInputPremium: 0, total: 10 },
    costs: { inputsConsumed: 20, labourPaid: 10, inventoryWriteOff: 0, unpaidOperatingArrears: 0 }, operatingProfit: 60 + i + bump, source: "market_receipt", ownerEmail: "player@example.invalid" })),
  summary: { byTurn: [128, 129, 130].map((turn, i) => ({ turn, sites: 1, revenue: 100 + i + bump, operatingProfit: 60 + i + bump })), sitesWithoutHistory: [] },
  sources: [{ collection: "producerEconomyTurns", fields: ["offeredUnits"], basis: "settled producer turn receipts", note: "fixture" }],
  gaps: [{ code: "one_off_fees_not_in_operating_results", message: "One-off fees are not in these rows.", turns: [] }] });
// The commodity_market read has no world and no date of its own.
const snapshotMarket = (o = {}) => ({ currentTurn: 79, marketTurn: 79, scope: "country", demandSource: "funded_book", country: "US", balancedBandPct: 5, summary: { traded: 1, shortages: 1, surpluses: 0, balanced: 0, capped: 0 }, notes: ["x"], ...o,
  commodities: [{ commodity: "freight", name: "Freight", label: "Freight", unit: "TEU", kind: "services", supply: 1800, demand: 2200, demandSource: "funded_book", filled: 1700, funded: 2400, substitutionOrders: 0, imports: 0, exports: 0, gap: 400, demandPctOfSupply: 122, balancePct: 18.8,
    balance: "shortage", price: 5888.23, previousPrice: 5772.77, previousTurn: 78, priceChange: 115.46, priceChangePct: 2, basePrice: 3000, priceVsBase: 1.9, scarcityMult: 3, capped: false, pegged: false, pinned: false, uncappedDemandPctOfSupply: 122, uncappedBalancePct: 18.8 }] });
module.exports = { WORLD, market, operating, snapshotMarket };
