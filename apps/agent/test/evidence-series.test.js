"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { adapt, project, TRACKABLE, TOOLS } = require("../lib/operator/evidence-series");

// MCP wrapper, as the broker receives it.
const wrap = (body) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
const WORLD = { worldEpochId: "6afa2daf7baab47c87a87a4c", telemetryWorldId: "2027-default:Iteration-3", startedAt: "2026-11-15T22:09:31.903Z", currentTurn: 79 };
const env = (o) => ({ schemaVersion: 1, world: WORLD, summary: null, sources: [], gaps: [], ...o });
const ok = (r) => { assert.equal(r.ok, true, r.reason); return r.envelope; };
const PRIVATE = /siteId|corporationId|sequentialId|[0-9a-f]{24}|ticket|character/i;

// --- market_history ---------------------------------------------------------------------

const gdpLevel = (rows, extra = {}) => env({ tool: "market_history", metric: "gdp_level", unit: "local-currency millions", scope: { country: "US", currency: "USD" },
  asOfTurn: rows.at(-1)?.turn ?? null, rows, sources: [{ collection: "macroTelemetry", fields: ["economic.gdp"], basis: "region null = national", note: "recorded GDP" }], ...extra });

test("gdp_level: GDP level stays a level in currency, year is a labelled column and never a series", () => {
  const e = ok(adapt("market_history", wrap(gdpLevel([{ turn: 2, year: 2027, value: 32833360.36 }, { turn: 3, year: null, value: 32475164.89 }, { turn: 4, year: 2027, value: null }]))));
  assert.equal(e.world, "6afa2daf7baab47c87a87a4c");
  assert.deepEqual(e.worldDetail, { telemetryWorldId: "2027-default:Iteration-3", startedAt: "2026-11-15T22:09:31.903Z" });
  assert.equal(e.rows[1].year, null, "a null year is not 0");
  assert.equal(e.rows[2].value, null);
  assert.match(e.sources[0], /macroTelemetry \(economic\.gdp\).*basis: region null = national/);
  const p = project(e);
  assert.equal(p.chart.yLabel, "GDP level (USD millions)");
  assert.deepEqual([...new Set(p.chart.data.map((d) => d.series))], ["GDP level"]);
  assert.equal(p.chart.data.find((d) => d.turn === 4).value, null);
  assert.ok(p.chart.data.every((d) => d.turn >= 2));
  const meta = p.table.columnMeta;
  assert.equal(meta.value.label, "GDP level"); assert.equal(meta.value.unit, "USD millions");
  assert.equal(meta.year.label, "Game year"); assert.equal(meta.year.unit, "year");
  assert.match(p.label, /US \(national\)/);
  assert.equal(p.confidence.level, "medium");
  assert.equal(p.trackable, true);
});

test("gdp_change: chart carries changePct as percent only, levels stay in the table", () => {
  const rows = [{ turn: 3, previousTurn: 2, previousValue: 32833360.36, value: 32475164.89, changePct: -1.09 }, { turn: 4, previousTurn: 3, previousValue: 32475164.89, value: 32511377.04, changePct: 0.11 }];
  const e = ok(adapt("market_history", wrap(env({ tool: "market_history", metric: "gdp_change", unit: "percent", scope: { country: "US", region: "CA", currency: "USD" }, asOfTurn: 4, rows,
    summary: { fromTurn: 2, toTurn: 4, fromValue: 32833360.36, toValue: 32511377.04, changePct: -0.98, junk: "x" } }))));
  const p = project(e);
  assert.deepEqual([...new Set(p.chart.data.map((d) => d.series))], ["Change in GDP level"]);
  assert.deepEqual(p.chart.data.map((d) => d.value), [-1.09, 0.11]);
  assert.equal(p.chart.yLabel, "Change in GDP level (percent)");
  assert.equal(p.table.columnMeta.changePct.unit, "percent");
  assert.equal(p.table.columnMeta.value.unit, "USD millions");
  assert.equal(p.table.columnMeta.previousTurn.unit, "turn");
  assert.equal(p.tables[1].id, "summary");
  assert.equal(p.tables[1].rows[0].changePct, -0.98);
  assert.equal("junk" in e.summary, false);
  assert.match(p.label, /CA \(state or region\)/, "a region is never labelled national");
});

test("gdp_growth_rate is its own indicator, with a caveat", () => {
  const e = ok(adapt("market_history", wrap(env({ tool: "market_history", metric: "gdp_growth_rate", unit: "percent (game growth indicator)", scope: { country: "FR" }, asOfTurn: 5,
    rows: [{ turn: 4, value: 0.5 }, { turn: 5, value: 0.499 }] }))));
  const p = project(e);
  assert.equal(p.chart.series, "series");
  assert.equal(p.chart.data[0].series, "Game growth indicator");
  assert.ok(p.caveats.some((c) => /not the measured change/.test(c)));
});

test("commodity_volume: offered, demand and sold share the unit axis, percent and unmet stay in the table", () => {
  const rows = [{ turn: 77, offeredUnits: 100, demandUnits: 120, soldUnits: 90, unmetDemandUnits: 30, surplusUnits: null, soldPctOfOffered: 90 },
    { turn: 78, offeredUnits: 110, demandUnits: 125, soldUnits: 100, unmetDemandUnits: null, surplusUnits: null, soldPctOfOffered: 90.9 }];
  const e = ok(adapt("market_history", wrap(env({ tool: "market_history", metric: "commodity_volume", unit: "TEU per turn", scope: { country: "US", commodity: "freight", commodityUnit: "TEU" }, asOfTurn: 78, rows }))));
  const p = project(e);
  assert.deepEqual([...new Set(p.chart.data.map((d) => d.series))], ["Offered", "Demand", "Sold (cleared)"]);
  assert.equal(p.chart.yLabel, "TEU per turn");
  assert.equal(p.table.columnMeta.offeredUnits.unit, "TEU per turn");
  assert.equal(p.table.columnMeta.soldPctOfOffered.unit, "percent");
  assert.equal(p.table.columnMeta.offeredUnits.label, "Offered by producers");
  assert.equal(p.table.columnMeta.soldUnits.label, "Sold (cleared)");
  assert.ok(p.caveats.some((c) => /different measures/.test(c)));
});

test("commodity_price: unit is per commodity unit", () => {
  const e = ok(adapt("market_history", wrap(env({ tool: "market_history", metric: "commodity_price", unit: "anchor currency per MWh", scope: { commodity: "energy", commodityUnit: "MWh" }, asOfTurn: 3,
    rows: [{ turn: 2, price: 10 }, { turn: 3, price: 11 }] }))));
  const p = project(e);
  assert.equal(p.chart.yLabel, "Price (anchor currency per MWh)");
  assert.match(p.label, /Energy, world market/);
  assert.equal(p.table.columnMeta.price.unit, "anchor currency per MWh");
});

test("all-null data: no chart, table kept, low confidence, nothing becomes zero", () => {
  const rows = [{ turn: 5, year: null, value: null }, { turn: 6, year: null, value: null }];
  const e = ok(adapt("market_history", wrap(gdpLevel(rows, { gaps: [{ code: "no_recorded_gdp", message: "No GDP was recorded for these turns", turns: [5, 6] }] }))));
  const p = project(e);
  assert.equal(p.chart, null);
  assert.match(p.why, /no value was recorded/);
  assert.equal(p.confidence.level, "low");
  assert.ok(p.dense);
  assert.deepEqual(p.table.rows.map((r) => r.value), [null, null]);
  assert.match(e.gaps[0], /No GDP was recorded for these turns \(turns 5, 6\) \[no_recorded_gdp\]/);
  assert.equal(e.gapItems[0].code, "no_recorded_gdp");
});

test("asOfTurn null stays null (not 0) for an empty read", () => {
  const e = ok(adapt("market_history", wrap(gdpLevel([], { asOfTurn: null }))));
  assert.equal(e.asOfTurn, null);
  assert.equal(project(e).chart, null);
});

test("fail closed: unknown or malformed contract", () => {
  const good = gdpLevel([{ turn: 2, year: 2027, value: 1 }, { turn: 3, year: 2027, value: 2 }]);
  const bad = (o, re) => { const r = adapt("market_history", wrap({ ...good, ...o })); assert.equal(r.ok, false); assert.match(r.reason, re); };
  bad({ schemaVersion: 2 }, /schemaVersion/);
  bad({ schemaVersion: "1" }, /schemaVersion/);
  bad({ schemaVersion: null }, /schemaVersion/);
  bad({ tool: "other" }, /tool/);
  bad({ metric: "catalog" }, /not a presentable/);
  bad({ metric: "gdp_foo" }, /not a presentable/);
  bad({ unit: "percent" }, /unit/);
  bad({ unit: 5 }, /unit/);
  bad({ scope: null }, /scope/);
  bad({ scope: {} }, /country/);
  bad({ asOfTurn: 99 }, /asOfTurn/);
  bad({ asOfTurn: null }, /asOfTurn/);
  assert.equal(adapt("market_history", { isError: true, content: [{ type: "text", text: "boom" }] }).ok, false);
  assert.equal(adapt("market_history", wrap("nope")).ok, false);
  assert.equal(adapt("market_history", { content: [{ type: "text", text: "{not json" }] }).ok, false);
  assert.equal(adapt("character_balance_sheet", wrap(good)).ok, false);
  assert.equal(adapt("market_history", null).ok, false);
});

test("malformed cells become not-recorded with a gap, bad rows are dropped and counted", () => {
  const e = ok(adapt("market_history", wrap(gdpLevel([{ turn: 2, year: 2027, value: "12" }, { turn: 0, value: 1 }, "x", { turn: 3, year: 2027, value: 5 }]))));
  assert.equal(e.rows.length, 2);
  assert.equal(e.rows[0].value, null);
  assert.ok(e.gapItems.some((g) => g.code === "rows_dropped"));
  assert.ok(e.gapItems.some((g) => g.code === "malformed_values"));
});

// --- reporter_operating_results -------------------------------------------------------------

const site = (id, turn, o = {}) => ({ turn, siteId: id.repeat(24).slice(0, 24), corporation: "Fixture Co", corporationSequentialId: 909, corporationId: "c".repeat(24), sectorType: "retail", siteName: null, countryId: "US", stateId: "CA",
  offeredUnits: 2, soldUnits: 1.7, revenue: 100, fees: { operatingServicesPaid: 5, minorInputPremium: null, total: 5 },
  costs: { inputsConsumed: 60, labourPaid: 20, inventoryWriteOff: 0, unpaidOperatingArrears: 0 }, operatingProfit: 15, source: "market_receipt", ...o });
const ops = (rows, summary, extra = {}) => env({ tool: "reporter_operating_results", metric: "site_operating_results", unit: "anchor currency per turn",
  scope: { ticket: 9050, verifiedReporter: { sequentialId: 42, name: "Fixture Reporter" }, companies: [{ corporationId: "c".repeat(24), name: "Fixture Co", sequentialId: 909 }], basis: "settled receipts" },
  asOfTurn: Math.max(...rows.map((r) => r.turn)), rows, summary, gaps: [{ code: "one_off_fees_not_in_operating_results", message: "Permit and construction fees are not included", turns: [] }], ...extra });

test("operating results: nested fees and costs are flattened with units, private ids never appear", () => {
  const rows = [site("a", 78), site("a", 79, { revenue: 120, operatingProfit: 20 })];
  const e = ok(adapt("reporter_operating_results", wrap(ops(rows, { byTurn: [{ turn: 78, sites: 1, revenue: 100, operatingProfit: 15 }, { turn: 79, sites: 1, revenue: 120, operatingProfit: 20 }], sitesWithoutHistory: [] }))));
  const p = project(e);
  assert.equal(p.table.columnMeta.feesTotal.unit, "anchor currency per turn");
  assert.equal(p.table.columnMeta.soldUnits.unit, "site units");
  assert.notEqual(p.table.columnMeta.soldUnits.unit, p.table.columnMeta.revenue.unit, "volume is not currency");
  assert.equal(p.table.rows[0].costsLabour, 20);
  assert.equal(p.table.rows[0].feesMinorInputPremium, null);
  assert.equal(p.table.rows[0].source, "Settled market receipt");
  assert.equal(p.table.rows[0].site, "Fixture Co Retail (CA)");
  assert.deepEqual([...new Set(p.chart.data.map((d) => d.series))], ["Revenue", "Operating profit"]);
  assert.equal(p.chart.yLabel, "Anchor currency per turn");
  { const m = JSON.stringify({ rows: e.rows, scope: e.scope, summary: e.summary, p }).match(new RegExp(".{25}(" + PRIVATE.source + ").{25}", "i")); assert.equal(m, null, String(m)); }
  assert.equal(e.scope.companies, "Fixture Co");
  assert.equal(p.confidence.level, "medium", "a null minor input premium is a value that was not recorded");
  assert.ok(p.confidence.reasons.some((r) => /not recorded/.test(r)));
  assert.ok(!p.confidence.reasons.some((r) => /one_off/.test(r)), "the one-off fees gap is informational");
  const clean = project(ok(adapt("reporter_operating_results", wrap(ops([site("a", 78, { fees: { operatingServicesPaid: 5, minorInputPremium: 0, total: 5 } }), site("a", 79, { fees: { operatingServicesPaid: 5, minorInputPremium: 0, total: 5 } })], null)))));
  assert.equal(clean.confidence.level, "high");
  assert.equal(p.trackable, true);
});

test("several sites with the same display name get distinct stable labels, no cross-site line merge", () => {
  const rows = [site("a", 78), site("b", 78), site("a", 79), site("b", 79), site("c", 79, { siteName: "Harbour Store" })];
  const e = ok(adapt("reporter_operating_results", wrap(ops(rows, { byTurn: [], sitesWithoutHistory: [] }))));
  const labels = e.rows.map((r) => `${r.turn}:${r.site}`);
  assert.deepEqual(labels, ["78:Fixture Co Retail (CA) #1", "78:Fixture Co Retail (CA) #2", "79:Fixture Co Retail (CA) #1", "79:Fixture Co Retail (CA) #2", "79:Harbour Store"]);
  assert.equal(new Set(e.rows.filter((r) => r.turn === 79).map((r) => r.site)).size, 3);
});

test("several sites: chart only recorded per-turn totals, when every turn is complete", () => {
  const rows = [site("a", 78, { revenue: 100, operatingProfit: 10 }), site("b", 78, { revenue: 50, operatingProfit: -5 }), site("a", 79, { revenue: 110, operatingProfit: 12 }), site("b", 79, { revenue: 60, operatingProfit: 1 })];
  const summary = { byTurn: [{ turn: 78, sites: 2, revenue: 150, operatingProfit: 5 }, { turn: 79, sites: 2, revenue: 170, operatingProfit: 13 }], sitesWithoutHistory: [] };
  const p = project(ok(adapt("reporter_operating_results", wrap(ops(rows, summary)))));
  assert.deepEqual(p.chart.data.map((d) => `${d.turn}|${d.series}|${d.value}`), ["78|Revenue, all sites|150", "78|Operating profit, all sites|5", "79|Revenue, all sites|170", "79|Operating profit, all sites|13"]);
  assert.equal(p.table.rows.length, 4, "the table keeps one row per site and turn");
  assert.equal(p.tables.find((t) => t.id === "totals").rows.length, 2);
  assert.ok(p.dense);
  assert.match(p.chart.subtitle, /2 sites, recorded totals/);
});

test("several sites: a null total, a site without history or totals that disagree with rows means no chart", () => {
  const rows = [site("a", 78), site("b", 78, { operatingProfit: null, source: "unavailable", revenue: null }), site("a", 79), site("b", 79)];
  const withNull = { byTurn: [{ turn: 78, sites: 2, revenue: null, operatingProfit: null }, { turn: 79, sites: 2, revenue: 200, operatingProfit: 30 }], sitesWithoutHistory: [] };
  const p1 = project(ok(adapt("reporter_operating_results", wrap(ops(rows, withNull)))));
  assert.equal(p1.chart, null); assert.match(p1.why, /incomplete/);
  assert.equal(p1.confidence.level, "low", p1.confidence.reasons.join("; "));
  assert.equal(p1.table.rows.length, 4);

  const full = [site("a", 78), site("b", 78), site("a", 79), site("b", 79)];
  const totals = (rev) => ({ byTurn: [{ turn: 78, sites: 2, revenue: 200, operatingProfit: 30 }, { turn: 79, sites: 2, revenue: rev, operatingProfit: 30 }], sitesWithoutHistory: [] });
  assert.ok(project(ok(adapt("reporter_operating_results", wrap(ops(full, totals(200)))))).chart);
  const p2 = project(ok(adapt("reporter_operating_results", wrap(ops(full, totals(999))))));
  assert.equal(p2.chart, null); assert.match(p2.why, /do not match/);
  const p3 = project(ok(adapt("reporter_operating_results", wrap(ops(full, { ...totals(200), sitesWithoutHistory: ["z".repeat(24)] })))));
  assert.equal(p3.chart, null); assert.match(p3.why, /no history/);
  const p4 = project(ok(adapt("reporter_operating_results", wrap(ops(full, null)))));
  assert.equal(p4.chart, null); assert.match(p4.why, /totals/);
});

test("operating results: repeated site/turn rows and rows without a site are dropped with a gap; site_latest lowers confidence", () => {
  const rows = [site("a", 78), site("a", 78, { revenue: 1 }), { ...site("a", 79), siteId: null }, site("a", 79, { source: "site_latest" })];
  const e = ok(adapt("reporter_operating_results", wrap(ops(rows, null))));
  assert.equal(e.rows.length, 2);
  assert.ok(e.gapItems.some((g) => g.code === "duplicate_site_turn_rows"));
  assert.ok(e.gapItems.some((g) => g.code === "rows_dropped"));
  const p = project(e);
  assert.equal(p.confidence.level, "low");
  assert.ok(p.confidence.reasons.some((r) => /settled market receipt/.test(r)));
});

test("operating results: wrong metric or unit fails closed", () => {
  const good = ops([site("a", 79)], null);
  assert.equal(adapt("reporter_operating_results", wrap({ ...good, metric: "operating_results" })).ok, false);
  assert.equal(adapt("reporter_operating_results", wrap({ ...good, unit: "percent" })).ok, false);
});

// --- reporter_action_points -------------------------------------------------------------------

const period = (turn, o = {}) => ({ turn, nextGrantTurn: turn + 1, turnsCovered: 1, complete: true, opening: 12, grants: { personal: 4, party: 2, hoardPenalty: 0, lostToCap: 0, net: 6 },
  recordedSpending: 9, recordedActions: 3, closing: 9, unexplainedDelta: 0, incompleteReason: null, ...o });
const ap = (rows, extra = {}) => env({ tool: "reporter_action_points", metric: "action_point_reconciliation", unit: "action points", scope: { ticket: 9050, verifiedReporter: { sequentialId: 42, name: "T" } },
  asOfTurn: rows.at(-1).turn, rows, summary: { currentBalance: 11, periods: rows.length, completePeriods: rows.filter((r) => r.complete).length, totalUnexplained: 0 }, ...extra });

test("action points: nested grants, open period retained, nextGrantTurn and counts never charted", () => {
  const rows = [period(77), period(78, { opening: 9, closing: 11 + 3 }), period(79, { complete: false, closing: null, unexplainedDelta: null, incompleteReason: "period_open", opening: 11, recordedSpending: 0, recordedActions: 0 })];
  rows[1].grants = { personal: 4, party: null, hoardPenalty: 1, lostToCap: 2, net: 5 }; rows[1].closing = 9 + 5 - 9; rows[1].unexplainedDelta = 0;
  const e = ok(adapt("reporter_action_points", wrap(ap(rows))));
  const p = project(e);
  assert.equal(p.table.rows.length, 3);
  const open = p.table.rows[2];
  assert.equal(open.complete, false); assert.equal(open.closing, null); assert.equal(open.unexplainedDelta, null); assert.equal(open.incompleteReason, "Period still open"); assert.equal(open.opening, 11);
  assert.equal(p.table.rows[1].grantsParty, null); assert.equal(p.table.rows[1].grantsHoardPenalty, 1); assert.equal(p.table.rows[1].grantsLostToCap, 2);
  assert.deepEqual([...new Set(p.chart.data.map((d) => d.series))], ["Balance before the grant", "Balance before the next grant"]);
  assert.equal(p.chart.data.find((d) => d.turn === 79 && d.series === "Balance before the next grant").value, null, "no closing balance for the open period");
  assert.equal(p.chart.yLabel, "Action points");
  assert.equal(p.table.columnMeta.recordedActions.unit, "actions");
  assert.equal(p.table.columnMeta.nextGrantTurn.unit, "turn");
  assert.deepEqual(p.facts, [{ label: "Current balance (open period, not a closing balance)", value: 11, unit: "action points" }]);
  assert.ok(p.caveats.some((c) => /still open/.test(c)));
  assert.equal(p.tables[1].rows[0].currentBalance, 11);
  assert.ok(p.confidence.reasons.some((r) => /still open/.test(r)));
  assert.equal(PRIVATE.test(JSON.stringify({ rows: e.rows, scope: e.scope, p })), false);
});

test("action points: an unexplained delta that does not follow from the columns is flagged", () => {
  const e = ok(adapt("reporter_action_points", wrap(ap([period(77), period(78, { unexplainedDelta: 4 })]))));
  assert.ok(e.gapItems.some((g) => g.code === "unexplained_delta_mismatch"));
});

test("action points: all-null balances give no chart; a real unexplained difference is shown, not hidden", () => {
  const rows = [period(77, { opening: null, closing: null, unexplainedDelta: null, grants: { personal: null, party: null, hoardPenalty: null, lostToCap: null, net: null }, recordedSpending: null, incompleteReason: "action_without_cost" }),
    period(78, { opening: null, closing: null, unexplainedDelta: null, grants: { personal: null, party: null, hoardPenalty: null, lostToCap: null, net: null }, recordedSpending: null })];
  const p = project(ok(adapt("reporter_action_points", wrap(ap(rows)))));
  assert.equal(p.chart, null);
  assert.equal(p.confidence.level, "low");
  const q = project(ok(adapt("reporter_action_points", wrap(ap([period(77), period(78, { opening: 10, closing: 0, unexplainedDelta: 10 - 9 + 6 - 6 })]))))); // 10+6-9-0=7 vs 1: mismatch
  assert.ok(q.confidence.reasons.some((r) => /unexplained_delta_mismatch/.test(r)));
});

// --- commodity_market ------------------------------------------------------------------------

const freight = { commodity: "freight", name: "Freight", label: "Freight & Transportation", unit: "TEU", kind: "services", supply: 1824.2, demand: 2247.22, demandSource: "funded_book", filled: 1736.42, funded: 2488.92,
  substitutionOrders: 243.93, imports: 0, exports: 0, gap: 423.02, demandPctOfSupply: 123.2, balancePct: 18.8, balance: "shortage", price: 5888.23, previousPrice: 5772.77, previousTurn: 78, priceChange: 115.46, priceChangePct: 2,
  basePrice: 3000, priceVsBase: 1.963, scarcityMult: 3, capped: true, pegged: false, pinned: true, demandTruncatedUnits: 86268.23, uncappedDemandPctOfSupply: 3131, uncappedBalancePct: 96.8, pinnedNote: "Demand is capped" };
const market = (commodities, o = {}) => ({ currentTurn: 79, marketTurn: 79, scope: "country", demandSource: "funded_book", country: "US", balancedBandPct: 5, summary: { traded: commodities.length, shortages: 1, surpluses: 1, balanced: 0, capped: 1 }, commodities, notes: ["x"], ...o });
const electronics = { ...freight, commodity: "electronics", name: "Electronics", unit: "units", kind: "goods", supply: 500, demand: 400, balancePct: -20, balance: "surplus", capped: false, uncappedBalancePct: -20, price: 12 };

test("commodity_market: one dated public table, no world id, never tracked, no chart across units", () => {
  const e = ok(adapt("commodity_market", wrap(market([freight, electronics])), { at: Date.parse("2026-11-20T10:00:00Z") }));
  assert.equal(e.world, null); assert.equal(e.worldDetail, null);
  assert.equal(e.trackable, false); assert.equal(e.kind, "snapshot"); assert.equal(e.visibility, "public");
  assert.equal(e.asOfTurn, 79); assert.equal(e.capturedAt, "2026-11-20");
  const p = project(e);
  assert.equal(p.chart, null); assert.match(p.why, /different units/);
  assert.equal(p.trackable, false);
  assert.match(p.label, /Commodity market, US, settled turn 79 \(read 2026-11-20\)/);
  assert.deepEqual(p.table.rows.map((r) => r.name), ["Freight", "Electronics"], "largest shortage first");
  assert.deepEqual(p.table.rows.map((r) => r.unit), ["TEU", "units"]);
  assert.equal(p.table.columnMeta.supply.unit, "per row, see Unit column");
  assert.equal(p.table.columnMeta.balancePct.unit, "percent");
  assert.equal(p.table.rows[0].demandCapped, true);
  assert.equal(p.table.rows[0].funded, 2488.92); assert.equal(p.table.rows[0].demand, 2247.22, "posted demand and funded orders stay separate");
  assert.ok(p.caveats[0].includes("does not show any company's profitability"));
  assert.ok(p.caveats[0].includes("room a sector has to grow"));
  assert.ok(p.caveats.some((c) => /before the demand cap/.test(c)));
  assert.equal(p.confidence.level, "high");
  assert.equal(TRACKABLE.commodity_market, false); assert.equal(TOOLS.commodity_market, "public");
  assert.equal("pinnedNote" in p.table.rows[0], false);
});

test("commodity_market: all-sectors coverage, mismatches and gaps are reported, bad shapes fail closed", () => {
  const many = Array.from({ length: 27 }, (_, i) => ({ ...electronics, commodity: `c_${i}`, name: `C ${i}`, balancePct: i % 3 ? null : i }));
  const e = ok(adapt("commodity_market", wrap(market(many))));
  assert.equal(e.rows.length, 27);
  const p = project(e);
  assert.equal(p.table.rows.length, 27);
  assert.equal(p.confidence.level, "medium");
  const mm = ok(adapt("commodity_market", wrap(market([freight], { summary: { traded: 27 } }))));
  assert.ok(mm.gapItems.some((g) => g.code === "coverage_mismatch"));
  const behind = ok(adapt("commodity_market", wrap(market([freight], { currentTurn: 80 }))));
  assert.ok(behind.gapItems.some((g) => g.code === "market_turn_behind"));
  for (const bad of [{ marketTurn: null }, { marketTurn: 0 }, { marketTurn: 90 }, { scope: "galaxy" }, { country: null }, { commodities: "x" }]) assert.equal(adapt("commodity_market", wrap(market([freight], bad))).ok, false, JSON.stringify(bad));
  const e2 = ok(adapt("commodity_market", wrap(market([freight, freight, { ...freight, commodity: "Bad Key" }]))));
  assert.equal(e2.rows.length, 1); assert.ok(e2.gapItems.some((g) => g.code === "rows_dropped"));
  const world = ok(adapt("commodity_market", wrap(market([freight], { scope: "world", country: undefined }))));
  assert.equal(project(world).label.includes("world"), true);
});

test("project fails safe on anything that is not a clean envelope", () => {
  assert.equal(project(null).chart, null);
  assert.equal(project({ tool: "market_history", rows: "x" }).confidence.level, "low");
  assert.equal(project({ tool: "bogus", rows: [] }).trackable, false);
});

test("projection is a pure function of the envelope: same input, same output", () => {
  const e = ok(adapt("market_history", wrap(gdpLevel([{ turn: 2, year: 2027, value: 1 }, { turn: 3, year: 2027, value: 2 }]))));
  assert.deepEqual(project(e), project(JSON.parse(JSON.stringify(e))));
});

test("plain (unwrapped), text and structuredContent results are all accepted", () => {
  const body = gdpLevel([{ turn: 2, year: 2027, value: 1 }]);
  assert.ok(adapt("market_history", body).ok);
  assert.ok(adapt("market_history", { text: JSON.stringify(body) }).ok);
  assert.ok(adapt("market_history", { structuredContent: body }).ok);
});
