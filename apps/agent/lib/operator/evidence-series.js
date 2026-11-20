"use strict";
// Keir 11.1: typed presentation for the REAL gamestate envelopes.
//
// evidencepages.js used a generic flattener: it dropped the world object, the
// sources/gaps detail and every nested object (grants, fees, costs), charted
// year and nextGrantTurn next to currency, mixed units on one axis and turned
// a null into 0 through Number(null). This module replaces that with a closed
// field list per tool and metric. Every column here has a label and a unit,
// a field that is not listed is dropped (so private ids can never reach a
// page or a chart), and anything that does not match the contract exactly
// fails closed: the caller gets { ok: false, reason } and answers in words.
//
// Pure functions only: no ledger, no clock, no network. Contract sources:
// game-contract.md (market_history, reporter_operating_results,
// reporter_action_points) and the existing commodity_market read.
const { redactSecrets } = require("../text");

const SCHEMA_VERSION = 1;
const MAX_ROWS = 500, MAX_GAPS = 12, MAX_SOURCES = 8, DENSE_ROWS = 12;
const TOOLS = Object.freeze({
  market_history: "public", commodity_market: "public",
  reporter_operating_results: "reporter", reporter_action_points: "reporter",
});
// A tracker needs a repeatable, scoped, multi-turn read. commodity_market is a
// single settled turn with no world id, so it can only ever be one dated table.
const TRACKABLE = Object.freeze({ market_history: true, commodity_market: false, reporter_operating_results: true, reporter_action_points: true });

const short = (v, n) => String(v ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const clean = (v, n) => short(redactSecrets(String(v ?? "")), n);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => typeof v === "number" && Number.isSafeInteger(v);
const isTurn = (v) => isInt(v) && v >= 1;
// Strict: null, undefined, "", "12" and NaN are all "not recorded", never 0.
const num = (v) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e16 ? v : null);
const human = (key) => String(key).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,39}$/;

// --- column vocabulary -------------------------------------------------------------
// kind: x (the turn axis), label (what splits rows), measure (a number),
// flag (boolean), text, count (a number of events, not points or currency).
const col = (label, kind, unit = null, extra = {}) => ({ label, kind, unit, ...extra });

const GDP_NOTE = "GDP level is the measured size of the economy in local currency. Growth indicator and change in level are different measures.";

// Per tool/metric: closed row fields, expected unit, chart selection.
const METRICS = {
  gdp_level: {
    expectUnit: (u) => u === "local-currency millions",
    fields: { turn: col("Turn", "x"), year: col("Game year", "text", "year", { notCharted: true }), value: col("GDP level", "measure", "@gdp") },
    chart: { keys: ["value"], names: { value: "GDP level" }, unit: "@gdp", yLabel: "GDP level (@gdp)" },
    title: "GDP level", note: GDP_NOTE,
  },
  gdp_change: {
    expectUnit: (u) => u === "percent",
    fields: { turn: col("Turn", "x"), previousTurn: col("Compared with turn", "text", "turn", { notCharted: true }),
      previousValue: col("GDP level, earlier turn", "measure", "@gdp", { notCharted: true }), value: col("GDP level", "measure", "@gdp", { notCharted: true }),
      changePct: col("Change in GDP level", "measure", "percent") },
    // Percent only: the levels stay in the table, never on this axis.
    chart: { keys: ["changePct"], names: { changePct: "Change in GDP level" }, unit: "percent", yLabel: "Change in GDP level (percent)" },
    title: "Change in GDP level", note: GDP_NOTE,
    summaryFields: { fromTurn: col("From turn", "text", "turn"), toTurn: col("To turn", "text", "turn"), fromValue: col("GDP level at start", "measure", "@gdp"),
      toValue: col("GDP level at end", "measure", "@gdp"), changePct: col("Change over the window", "measure", "percent") },
  },
  gdp_growth_rate: {
    expectUnit: (u) => u === "percent (game growth indicator)",
    fields: { turn: col("Turn", "x"), value: col("Game growth indicator", "measure", "percent") },
    chart: { keys: ["value"], names: { value: "Game growth indicator" }, unit: "percent", yLabel: "Game growth indicator (percent)" },
    title: "Game growth indicator", note: "This is the game's own growth indicator, not the measured change in GDP level.",
  },
  commodity_price: {
    expectUnit: (u) => /^anchor currency per \S.{0,38}$/.test(u),
    fields: { turn: col("Turn", "x"), price: col("Price", "measure", "@unit") },
    chart: { keys: ["price"], names: { price: "Price" }, unit: "@unit", yLabel: "Price (@unit)" },
    title: "Commodity price", note: null,
  },
  commodity_volume: {
    expectUnit: (u) => /^\S.{0,38} per turn$/.test(u),
    fields: { turn: col("Turn", "x"), offeredUnits: col("Offered by producers", "measure", "@unit"), demandUnits: col("Demand", "measure", "@unit"),
      soldUnits: col("Sold (cleared)", "measure", "@unit"), unmetDemandUnits: col("Unmet demand", "measure", "@unit", { notCharted: true }),
      surplusUnits: col("Surplus", "measure", "@unit", { notCharted: true }), soldPctOfOffered: col("Sold as share of offered", "measure", "percent", { notCharted: true }) },
    // Volumes share one unit; the percent column stays in the table.
    chart: { keys: ["offeredUnits", "demandUnits", "soldUnits"], names: { offeredUnits: "Offered", demandUnits: "Demand", soldUnits: "Sold (cleared)" }, unit: "@unit", yLabel: "@unit" },
    title: "Commodity volume", note: "Offered is what producers put up; sold is what cleared. They are different measures.",
  },
};
const MARKET_HISTORY_SCOPE = ["country", "region", "commodity", "commodityUnit", "currency"];

const OPERATING = {
  expectUnit: (u) => u === "anchor currency per turn",
  // Source field (dotted = nested) -> output column.
  map: { turn: "turn", siteName: "_siteName", sectorType: "_sector", corporation: "_corp", countryId: "_country", stateId: "_state",
    offeredUnits: "offeredUnits", soldUnits: "soldUnits", revenue: "revenue", "fees.total": "feesTotal",
    "fees.operatingServicesPaid": "feesOperatingServices", "fees.minorInputPremium": "feesMinorInputPremium",
    "costs.inputsConsumed": "costsInputs", "costs.labourPaid": "costsLabour", "costs.inventoryWriteOff": "costsInventoryWriteOff",
    "costs.unpaidOperatingArrears": "costsUnpaidArrears", operatingProfit: "operatingProfit", source: "source" },
  fields: {
    turn: col("Turn", "x"), site: col("Site", "label"), corporation: col("Company", "text"), sectorType: col("Sector", "text"),
    region: col("Location", "text"),
    offeredUnits: col("Offered (site units)", "measure", "site units", { notCharted: true }), soldUnits: col("Sold (site units)", "measure", "site units", { notCharted: true }),
    revenue: col("Revenue", "measure", "anchor currency per turn"),
    feesTotal: col("Fees, total", "measure", "anchor currency per turn", { notCharted: true }),
    feesOperatingServices: col("Fees: operating services", "measure", "anchor currency per turn", { notCharted: true }),
    feesMinorInputPremium: col("Fees: minor input premium", "measure", "anchor currency per turn", { notCharted: true }),
    costsInputs: col("Costs: inputs consumed", "measure", "anchor currency per turn", { notCharted: true }),
    costsLabour: col("Costs: labour paid", "measure", "anchor currency per turn", { notCharted: true }),
    costsInventoryWriteOff: col("Costs: inventory write-off", "measure", "anchor currency per turn", { notCharted: true }),
    costsUnpaidArrears: col("Costs: unpaid operating arrears", "measure", "anchor currency per turn", { notCharted: true }),
    operatingProfit: col("Operating profit (settled)", "measure", "anchor currency per turn"),
    source: col("Where the figure came from", "text"),
  },
  totalFields: { turn: col("Turn", "x"), sites: col("Sites with a row", "count", "sites"), revenue: col("Revenue, all sites", "measure", "anchor currency per turn"),
    operatingProfit: col("Operating profit, all sites", "measure", "anchor currency per turn") },
  scope: ["basis"],
};
const SOURCE_LABEL = { market_receipt: "Settled market receipt", site_latest: "Site's newest settlement", unavailable: "Not available" };

const POINTS = "action points";
const ACTION = {
  expectUnit: (u) => u === POINTS,
  map: { turn: "turn", nextGrantTurn: "nextGrantTurn", turnsCovered: "turnsCovered", complete: "complete", opening: "opening",
    "grants.personal": "grantsPersonal", "grants.party": "grantsParty", "grants.hoardPenalty": "grantsHoardPenalty", "grants.lostToCap": "grantsLostToCap", "grants.net": "grantsNet",
    recordedSpending: "recordedSpending", recordedActions: "recordedActions", closing: "closing", unexplainedDelta: "unexplainedDelta", incompleteReason: "incompleteReason" },
  fields: {
    turn: col("Grant turn (period start)", "x"), nextGrantTurn: col("Next grant turn", "text", "turn", { notCharted: true }),
    turnsCovered: col("Turns covered", "count", "turns", { notCharted: true }), complete: col("Period closed", "flag"),
    opening: col("Balance before the grant", "measure", POINTS),
    grantsPersonal: col("Granted: personal", "measure", POINTS, { notCharted: true }), grantsParty: col("Granted: party", "measure", POINTS, { notCharted: true }),
    grantsHoardPenalty: col("Hoarding penalty", "measure", POINTS, { notCharted: true }), grantsLostToCap: col("Lost to the cap", "measure", POINTS, { notCharted: true }),
    grantsNet: col("Net gained from grants", "measure", POINTS, { notCharted: true }),
    recordedSpending: col("Recorded spending", "measure", POINTS, { notCharted: true }), recordedActions: col("Recorded actions", "count", "actions", { notCharted: true }),
    closing: col("Balance before the next grant", "measure", POINTS),
    unexplainedDelta: col("Unexplained change", "measure", POINTS, { notCharted: true }), incompleteReason: col("Why the period is not closed", "text"),
  },
  chart: { keys: ["opening", "closing"], names: { opening: "Balance before the grant", closing: "Balance before the next grant" }, unit: POINTS, yLabel: "Action points" },
  summaryFields: { currentBalance: col("Current balance (open period, not a closing balance)", "measure", POINTS), periods: col("Periods", "count", "periods"),
    completePeriods: col("Closed periods", "count", "periods"), totalUnexplained: col("Total unexplained", "measure", POINTS) },
};
const INCOMPLETE = { period_open: "Period still open", spending_log_truncated: "Spending log was cut off", action_without_cost: "An action has no recorded cost" };

// --- result parsing ----------------------------------------------------------------

function parseResult(result) {
  if (!isObj(result) || result.isError || result.error) return null;
  const hasBody = (r) => isObj(r) && ("rows" in r || "commodities" in r);
  if (hasBody(result)) return result;
  if (hasBody(result.structuredContent)) return result.structuredContent;
  let text = typeof result.text === "string" ? result.text : null;
  if (text === null && Array.isArray(result.content)) text = result.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
  if (text === null) return null;
  try { const r = JSON.parse(text); return hasBody(r) ? r : null; } catch { return null; }
}
const fail = (reason) => ({ ok: false, reason });

// --- shared pieces -----------------------------------------------------------------

function sourcesOf(raw) {
  return (Array.isArray(raw) ? raw : []).filter(isObj).slice(0, MAX_SOURCES).map((s) => {
    const fields = Array.isArray(s.fields) ? s.fields.filter((f) => typeof f === "string").slice(0, 6).map((f) => clean(f, 40)).join(", ") : "";
    return clean([s.collection && `${s.collection}${fields ? ` (${fields})` : ""}`, s.basis && `basis: ${s.basis}`, s.note].filter((p) => typeof p === "string" && p).join(". "), 240);
  }).filter(Boolean);
}
function gapsOf(raw) {
  const items = (Array.isArray(raw) ? raw : []).filter(isObj).slice(0, MAX_GAPS).map((g) => ({
    code: typeof g.code === "string" && /^[a-z][a-z0-9_]{0,59}$/.test(g.code) ? g.code : "unspecified",
    message: clean(g.message, 200),
    turns: Array.isArray(g.turns) ? g.turns.filter(isInt).slice(0, 24) : [],
  }));
  return items;
}
const gapText = (g) => `${g.message || human(g.code)}${g.turns.length ? ` (turns ${g.turns.join(", ")})` : ""} [${g.code}]`;
// Informational gaps describe what the tool never covers; they do not lower confidence.
const INFO_GAPS = new Set(["one_off_fees_not_in_operating_results"]);

function worldOf(w) {
  // The real world object, reduced to the stable epoch id. currentTurn would
  // change the fingerprint every turn; telemetry id and start are kept apart.
  if (!isObj(w)) return { id: null, detail: null };
  const epoch = typeof w.worldEpochId === "string" && /^[A-Za-z0-9_.:\-]{1,80}$/.test(w.worldEpochId) ? w.worldEpochId : null;
  const detail = { telemetryWorldId: typeof w.telemetryWorldId === "string" ? clean(w.telemetryWorldId, 80) : null,
    startedAt: typeof w.startedAt === "string" && !Number.isNaN(Date.parse(w.startedAt)) ? new Date(w.startedAt).toISOString() : null };
  return { id: epoch, detail };
}
// Tokens: @gdp = GDP level unit, @unit = the contract unit of this series.
function resolveUnit(u, ctx) {
  return typeof u === "string" ? u.replace("@gdp", ctx.gdp).replace("@unit", ctx.unit) : u;
}
const unitCtx = (env) => ({ gdp: `${env.scope?.currency || "local currency"} millions`, unit: env.unitLabel || "" });

// --- adapters ----------------------------------------------------------------------

function get(obj, dotted) { return dotted.split(".").reduce((o, k) => (isObj(o) ? o[k] : undefined), obj); }

function baseEnvelope(tool, raw, metric) {
  if (raw.tool !== tool) return fail(`envelope tool is ${JSON.stringify(raw.tool)}, expected ${tool}`);
  if (raw.schemaVersion !== SCHEMA_VERSION) return fail(`unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}; only ${SCHEMA_VERSION} is understood`);
  if (typeof raw.metric !== "string" || raw.metric !== metric) return fail(`metric ${JSON.stringify(raw.metric)} does not match the metric requested`);
  if (typeof raw.unit !== "string") return fail("envelope has no unit");
  if (!Array.isArray(raw.rows)) return fail("envelope has no rows array");
  if (!isObj(raw.scope)) return fail("envelope has no scope");
  return null;
}
function finish(env) {
  // Rows must agree with the declared newest turn; null stays null.
  const turns = env.rows.map((r) => r.turn).filter(isTurn);
  const newest = turns.length ? Math.max(...turns) : null;
  if (env._asOf !== null && env._asOf !== undefined && !isTurn(env._asOf)) return fail("asOfTurn is not a turn number");
  if (newest !== null && env._asOf !== newest) return fail(`asOfTurn ${env._asOf} does not match the newest row turn ${newest}`);
  const asOfTurn = newest !== null ? newest : null;
  delete env._asOf;
  return { ok: true, envelope: { ...env, asOfTurn } };
}

function unitMap(fields, ctx) {
  return Object.fromEntries(Object.entries(fields).filter(([, f]) => f.unit).map(([k, f]) => [k, resolveUnit(f.unit, ctx)]));
}

// market_history
function adaptMarketHistory(raw, at) {
  const metric = raw.metric;
  const spec = METRICS[metric];
  if (!spec) return fail(`metric ${JSON.stringify(metric)} is not a presentable series`);
  const bad = baseEnvelope("market_history", raw, metric);
  if (bad) return bad;
  if (!spec.expectUnit(raw.unit)) return fail(`unit ${JSON.stringify(raw.unit)} is not the contract unit for ${metric}`);
  const scope = {};
  for (const k of MARKET_HISTORY_SCOPE) if (typeof raw.scope[k] === "string" && raw.scope[k]) scope[k] = clean(raw.scope[k], 60);
  if (/^gdp_/.test(metric) && !scope.country) return fail("GDP series scope has no country");
  if (/^commodity_/.test(metric) && !scope.commodity) return fail("commodity series scope has no commodity");
  const unitLabel = metric.startsWith("gdp_") && metric !== "gdp_growth_rate" ? `${scope.currency || "local currency"} millions` : raw.unit;
  const ctx = { gdp: `${scope.currency || "local currency"} millions`, unit: unitLabel };
  const gaps = gapsOf(raw.gaps);
  const rows = [];
  let dropped = 0, malformed = 0;
  for (const r of raw.rows.slice(0, MAX_ROWS)) {
    if (!isObj(r) || !isTurn(r.turn)) { dropped++; continue; }
    const row = {};
    for (const [k, f] of Object.entries(spec.fields)) {
      if (k === "turn") row.turn = r.turn;
      else if (f.kind === "text") {
        // year / previousTurn are turn-like integers: null stays null, never 0.
        const v = r[k];
        if (v !== null && v !== undefined && !isInt(v)) malformed++;
        row[k] = isInt(v) ? v : null;
      } else {
        const v = num(r[k]);
        if (v === null && r[k] !== null && r[k] !== undefined) malformed++;
        row[k] = v;
      }
    }
    rows.push(row);
  }
  if (dropped) gaps.push({ code: "rows_dropped", message: `${dropped} row(s) without a valid turn were not shown`, turns: [] });
  if (malformed) gaps.push({ code: "malformed_values", message: `${malformed} value(s) were not numbers and are shown as not recorded`, turns: [] });
  const summary = metric === "gdp_change" && isObj(raw.summary) ? Object.fromEntries(Object.keys(spec.summaryFields).map((k) => [k, k.endsWith("Turn") ? (isInt(raw.summary[k]) ? raw.summary[k] : null) : num(raw.summary[k])])) : null;
  const world = worldOf(raw.world);
  const env = { tool: "market_history", schemaVersion: SCHEMA_VERSION, metric, unit: unitMap(spec.fields, ctx), unitLabel, scope,
    world: world.id, worldDetail: world.detail, _asOf: raw.asOfTurn === null ? null : raw.asOfTurn, rows, summary, truncated: raw.rows.length > MAX_ROWS,
    sources: sourcesOf(raw.sources), gaps: gaps.map(gapText), gapItems: gaps, visibility: "public", trackable: true, kind: "series" };
  return finish(env);
}

// Shared row mapper for the two reporter tools.
function mapRow(r, map, fields) {
  const out = {};
  let malformed = 0;
  for (const [src, dst] of Object.entries(map)) {
    const v = get(r, src);
    const f = fields[dst];
    if (dst.startsWith("_")) { out[dst] = typeof v === "string" ? clean(v, 80) : null; continue; }
    if (dst === "turn") { out.turn = v; continue; }
    if (f.kind === "flag") { out[dst] = typeof v === "boolean" ? v : null; if (typeof v !== "boolean" && v != null) malformed++; continue; }
    if (f.kind === "text") {
      if (dst === "nextGrantTurn") out[dst] = isInt(v) ? v : null;
      else out[dst] = typeof v === "string" ? clean(v, 80) : null;
      if (v != null && (dst === "nextGrantTurn" ? !isInt(v) : typeof v !== "string")) malformed++;
      continue;
    }
    const n = num(v);
    if (n === null && v !== null && v !== undefined) malformed++;
    out[dst] = n;
  }
  return { out, malformed };
}

// reporter_operating_results
function adaptOperating(raw) {
  const bad = baseEnvelope("reporter_operating_results", raw, "site_operating_results");
  if (bad) return bad;
  if (!OPERATING.expectUnit(raw.unit)) return fail(`unit ${JSON.stringify(raw.unit)} is not the contract unit for operating results`);
  const gaps = gapsOf(raw.gaps);
  const bySite = new Map(); // internal siteId -> { first, base }
  const prepared = [];
  let dropped = 0, malformed = 0, dup = 0;
  const seen = new Set();
  for (const r of raw.rows.slice(0, MAX_ROWS)) {
    if (!isObj(r) || !isTurn(r.turn) || typeof r.siteId !== "string" || !r.siteId) { dropped++; continue; }
    const key = `${r.siteId}|${r.turn}`;
    if (seen.has(key)) { dup++; continue; }
    seen.add(key);
    const { out, malformed: m } = mapRow(r, OPERATING.map, OPERATING.fields);
    malformed += m;
    const sector = out._sector ? human(out._sector) : null;
    const region = [out._state, out._country].filter(Boolean).join(", ") || null;
    const base = out._siteName || [out._corp || "Company", sector || "site"].join(" ") + (out._state ? ` (${out._state})` : "");
    const prev = bySite.get(r.siteId);
    if (!prev) bySite.set(r.siteId, { first: r.turn, base });
    else if (r.turn < prev.first) prev.first = r.turn;
    prepared.push({ siteId: r.siteId, out, sector, region, turn: r.turn });
  }
  // One display label per site, never the id. Two different sites with the same
  // name get "#1/#2" in order of first turn seen, so lines cannot merge.
  const byBase = new Map();
  for (const [id, s] of bySite) (byBase.get(s.base) || byBase.set(s.base, []).get(s.base)).push([id, s]);
  const label = new Map();
  for (const [base, list] of byBase) {
    list.sort((a, b) => a[1].first - b[1].first || (a[0] < b[0] ? -1 : 1));
    list.forEach(([id], i) => label.set(id, list.length > 1 ? `${base} #${i + 1}` : base));
  }
  const rows = prepared.map(({ siteId, out, sector, region }) => ({
    turn: out.turn, site: label.get(siteId), corporation: out._corp, sectorType: sector, region,
    ...Object.fromEntries(Object.keys(OPERATING.fields).filter((k) => !["turn", "site", "corporation", "sectorType", "region", "source"].includes(k)).map((k) => [k, out[k] ?? null])),
    source: SOURCE_LABEL[out.source] || null,
  })).sort((a, b) => a.turn - b.turn || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0));
  if (dropped) gaps.push({ code: "rows_dropped", message: `${dropped} row(s) without a valid turn or site were not shown`, turns: [] });
  if (dup) gaps.push({ code: "duplicate_site_turn_rows", message: `${dup} repeated row(s) for the same site and turn were not shown`, turns: [] });
  if (malformed) gaps.push({ code: "malformed_values", message: `${malformed} value(s) were not numbers and are shown as not recorded`, turns: [] });
  // Recorded per-turn totals, closed shape only.
  let byTurn = null, withoutHistory = 0;
  if (isObj(raw.summary)) {
    if (Array.isArray(raw.summary.byTurn)) byTurn = raw.summary.byTurn.filter((t) => isObj(t) && isTurn(t.turn)).slice(0, 60)
      .map((t) => ({ turn: t.turn, sites: isInt(t.sites) ? t.sites : null, revenue: num(t.revenue), operatingProfit: num(t.operatingProfit) })).sort((a, b) => a.turn - b.turn);
    if (Array.isArray(raw.summary.sitesWithoutHistory)) withoutHistory = raw.summary.sitesWithoutHistory.length;
  }
  const scope = {};
  if (typeof raw.scope.basis === "string") scope.basis = clean(raw.scope.basis, 160);
  if (Array.isArray(raw.scope.companies)) scope.companies = raw.scope.companies.filter(isObj).map((c) => clean(c.name, 60)).filter(Boolean).slice(0, 6).join(", ");
  if (!scope.companies) delete scope.companies;
  const env = { tool: "reporter_operating_results", schemaVersion: SCHEMA_VERSION, metric: "site_operating_results", unit: unitMap(OPERATING.fields, { gdp: "", unit: "" }), unitLabel: "anchor currency per turn", scope,
    world: worldOf(raw.world).id, worldDetail: worldOf(raw.world).detail, _asOf: raw.asOfTurn === null ? null : raw.asOfTurn, rows,
    summary: { byTurn, sitesWithoutHistory: withoutHistory, siteCount: bySite.size }, truncated: raw.rows.length > MAX_ROWS,
    sources: sourcesOf(raw.sources), gaps: gaps.map(gapText), gapItems: gaps, visibility: "reporter", trackable: true, kind: "series" };
  return finish(env);
}

// reporter_action_points
function adaptActionPoints(raw) {
  const bad = baseEnvelope("reporter_action_points", raw, "action_point_reconciliation");
  if (bad) return bad;
  if (!ACTION.expectUnit(raw.unit)) return fail(`unit ${JSON.stringify(raw.unit)} is not the contract unit for action points`);
  const gaps = gapsOf(raw.gaps);
  const rows = [];
  let dropped = 0, malformed = 0, mismatch = 0;
  for (const r of raw.rows.slice(0, MAX_ROWS)) {
    if (!isObj(r) || !isTurn(r.turn)) { dropped++; continue; }
    const { out, malformed: m } = mapRow(r, ACTION.map, ACTION.fields);
    malformed += m;
    out.incompleteReason = out.incompleteReason ? (INCOMPLETE[out.incompleteReason] || "Other, see gaps") : null;
    const parts = [out.opening, out.grantsNet, out.recordedSpending, out.closing, out.unexplainedDelta];
    if (parts.every((p) => p !== null) && Math.abs(out.opening + out.grantsNet - out.recordedSpending - out.closing - out.unexplainedDelta) > 1e-6) mismatch++;
    rows.push(out);
  }
  rows.sort((a, b) => a.turn - b.turn);
  if (dropped) gaps.push({ code: "rows_dropped", message: `${dropped} row(s) without a valid turn were not shown`, turns: [] });
  if (malformed) gaps.push({ code: "malformed_values", message: `${malformed} value(s) were not numbers and are shown as not recorded`, turns: [] });
  if (mismatch) gaps.push({ code: "unexplained_delta_mismatch", message: `${mismatch} period(s) whose reported unexplained change does not follow from the other columns`, turns: [] });
  const s = isObj(raw.summary) ? raw.summary : {};
  const summary = Object.fromEntries(Object.keys(ACTION.summaryFields).map((k) => [k, num(s[k])]));
  const env = { tool: "reporter_action_points", schemaVersion: SCHEMA_VERSION, metric: "action_point_reconciliation", unit: unitMap(ACTION.fields, { gdp: "", unit: "" }), unitLabel: POINTS, scope: {},
    world: worldOf(raw.world).id, worldDetail: worldOf(raw.world).detail, _asOf: raw.asOfTurn === null ? null : raw.asOfTurn, rows, summary, truncated: raw.rows.length > MAX_ROWS,
    sources: sourcesOf(raw.sources), gaps: gaps.map(gapText), gapItems: gaps, visibility: "reporter", trackable: true, kind: "series" };
  return finish(env);
}

// commodity_market: one settled turn, many commodities, no envelope, no world id.
const CM_FIELDS = {
  name: col("Commodity", "label"), unit: col("Unit", "text"), kind: col("Kind", "text"),
  supply: col("Supply (offered)", "measure", "@row"), demand: col("Demand (first-choice orders)", "measure", "@row"), filled: col("Filled", "measure", "@row"),
  funded: col("Funded orders", "measure", "@row"), substitutionOrders: col("Substitution orders", "measure", "@row"), imports: col("Imports", "measure", "@row"),
  exports: col("Exports", "measure", "@row"), gap: col("Gap (demand minus supply)", "measure", "@row"),
  balancePct: col("Shortage (+) or surplus (-)", "measure", "percent"), balance: col("Balance", "text"),
  uncappedBalancePct: col("Same, before the demand cap", "measure", "percent"), demandCapped: col("Demand capped", "flag"),
  price: col("Price", "measure", "anchor currency per unit"), previousPrice: col("Previous price", "measure", "anchor currency per unit"), priceChangePct: col("Price change", "measure", "percent"),
};
const CM_CAVEAT = "Commodity-market evidence for one settled turn: what the market recorded per commodity. It does not show any company's profitability or prove how much room a sector has to grow.";
function adaptCommodityMarket(raw, at) {
  if (!isObj(raw) || !Array.isArray(raw.commodities)) return fail("commodity_market result has no commodities");
  if (!isTurn(raw.marketTurn) || !isTurn(raw.currentTurn) || raw.marketTurn > raw.currentTurn) return fail("commodity_market has no valid settled market turn");
  if (raw.scope !== "country" && raw.scope !== "world") return fail("commodity_market scope is not country or world");
  if (raw.scope === "country" && !(typeof raw.country === "string" && /^[A-Za-z]{2,4}$/.test(raw.country))) return fail("commodity_market country scope has no country");
  const rows = [];
  const keys = new Set();
  let malformed = 0, dropped = 0;
  for (const c of raw.commodities.slice(0, MAX_ROWS)) {
    if (!isObj(c) || typeof c.commodity !== "string" || !/^[a-z][a-z0-9_]{0,59}$/.test(c.commodity) || typeof c.unit !== "string" || !c.unit || keys.has(c.commodity)) { dropped++; continue; }
    keys.add(c.commodity);
    const row = { commodity: c.commodity };
    for (const [k, f] of Object.entries(CM_FIELDS)) {
      if (k === "demandCapped") { row[k] = typeof c.capped === "boolean" ? c.capped : null; continue; }
      const v = c[k];
      if (f.kind === "measure") { const n = num(v); if (n === null && v != null) malformed++; row[k] = n; }
      else row[k] = typeof v === "string" ? clean(v, 60) : null;
    }
    row.name = row.name || human(c.commodity);
    rows.push(row);
  }
  const gaps = [];
  if (dropped) gaps.push({ code: "rows_dropped", message: `${dropped} commodity row(s) were unusable and not shown`, turns: [] });
  if (malformed) gaps.push({ code: "malformed_values", message: `${malformed} value(s) were not numbers and are shown as not recorded`, turns: [] });
  if (isObj(raw.summary) && isInt(raw.summary.traded) && raw.summary.traded !== rows.length) gaps.push({ code: "coverage_mismatch", message: `the market reports ${raw.summary.traded} traded commodities but ${rows.length} rows are shown`, turns: [] });
  if (raw.marketTurn !== raw.currentTurn) gaps.push({ code: "market_turn_behind", message: `market data is for turn ${raw.marketTurn}, the game is on turn ${raw.currentTurn}`, turns: [raw.marketTurn] });
  rows.sort((a, b) => (b.balancePct ?? -Infinity) - (a.balancePct ?? -Infinity) || (a.commodity < b.commodity ? -1 : 1));
  const capped = rows.filter((r) => r.demandCapped === true).length;
  const scope = { kind: raw.scope === "country" ? "country" : "world", ...(raw.scope === "country" ? { country: raw.country.toUpperCase() } : {}) };
  if (typeof raw.demandSource === "string" && /^[a-z_]{1,40}$/.test(raw.demandSource)) scope.demandSource = raw.demandSource;
  const env = { tool: "commodity_market", schemaVersion: null, metric: "commodity_market", unit: { balancePct: "percent", uncappedBalancePct: "percent", priceChangePct: "percent" }, unitLabel: "per-commodity units (see the Unit column)", scope,
    world: null, worldDetail: null, // the read carries no world id; none is invented
    _asOf: undefined, rows, summary: { traded: rows.length, cappedCommodities: capped, marketTurn: raw.marketTurn, currentTurn: raw.currentTurn }, truncated: raw.commodities.length > MAX_ROWS,
    sources: [clean(`commodity_market, ${scope.kind}${scope.country ? ` ${scope.country}` : ""}, settled turn ${raw.marketTurn}${scope.demandSource ? `, demand source ${scope.demandSource}` : ""}`, 240)],
    gaps: gaps.map(gapText), gapItems: gaps, visibility: "public", trackable: false, kind: "snapshot", caveat: CM_CAVEAT,
    capturedAt: typeof at === "number" && Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : null };
  const out = { ...env, asOfTurn: raw.marketTurn };
  delete out._asOf;
  return { ok: true, envelope: out };
}

// Entry point. `result` is the raw tool result (MCP wrapper or plain object).
// Returns { ok: true, envelope } or { ok: false, reason }. Never throws.
function adapt(tool, result, { at = null } = {}) {
  try {
    if (!TOOLS[tool]) return fail(`${tool} is not a presentable read`);
    const raw = parseResult(result);
    if (!raw) return fail("the read returned no usable body");
    if (tool === "commodity_market") return adaptCommodityMarket(raw, at);
    if (!Array.isArray(raw.rows)) return fail("the read has no rows");
    if (tool === "market_history") return adaptMarketHistory(raw);
    if (tool === "reporter_operating_results") return adaptOperating(raw);
    return adaptActionPoints(raw);
  } catch (e) {
    return fail(`could not read the result: ${short(e.message, 120)}`);
  }
}

// --- projection ----------------------------------------------------------------------

const metricSpec = (env) => (env.tool === "market_history" ? METRICS[env.metric] : env.tool === "reporter_operating_results" ? OPERATING : env.tool === "reporter_action_points" ? ACTION : null);
function fieldsFor(env) {
  if (env.tool === "commodity_market") return { commodity: col("Commodity key", "text"), ...CM_FIELDS };
  return metricSpec(env).fields;
}
function scopeText(env) {
  const s = env.scope || {};
  if (env.tool === "market_history") {
    if (env.metric.startsWith("gdp_")) return s.region ? `${s.country}, ${s.region} (state or region)` : `${s.country} (national)`;
    return [s.commodity && human(s.commodity), s.country || "world market"].filter(Boolean).join(", ");
  }
  if (s.companies) return s.companies;
  return "";
}
const hasNullIn = (rows, keys) => rows.some((r) => keys.some((k) => r[k] === null));

function confidenceOf(env, chartKeys, chartRows, extra = []) {
  const reasons = [...extra];
  const real = env.gapItems.filter((g) => !INFO_GAPS.has(g.code));
  if (real.length) reasons.push(`${real.length} gap(s) reported: ${[...new Set(real.map((g) => g.code))].join(", ")}`);
  if (env.truncated) reasons.push("rows were cut at the display limit");
  const measures = Object.entries(fieldsFor(env)).filter(([, f]) => f.kind === "measure").map(([k]) => k);
  const cells = env.rows.reduce((n, r) => n + measures.filter((k) => k in r).length, 0);
  const nulls = env.rows.reduce((n, r) => n + measures.filter((k) => k in r && r[k] === null).length, 0);
  if (env.rows.length && cells && nulls === cells) reasons.push("no value was recorded in any row");
  else if (nulls) reasons.push(`${nulls} of ${cells} values were not recorded`);
  if (env.tool === "reporter_operating_results" && env.rows.some((r) => r.source && r.source !== SOURCE_LABEL.market_receipt)) reasons.push("some figures are not from a settled market receipt");
  if (env.tool === "reporter_action_points" && env.rows.some((r) => r.complete === false)) reasons.push("the newest grant period is still open");
  let level = "high";
  if (reasons.length) level = "medium";
  const allNull = env.rows.length && cells && nulls === cells;
  if (!env.rows.length || allNull || (cells && nulls / cells > 0.5) || reasons.some((r) => /not from a settled|cut at/.test(r))) level = "low";
  return { level, reasons };
}

// Table sections for the page. The first is the main table (same shape the page
// store already writes: { columns, rows }), later ones are totals and facts.
function tableOf(id, title, fields, rows, keys) {
  const cols = keys.filter((k) => k in fields);
  return { id, title, columns: cols, columnMeta: Object.fromEntries(cols.map((k) => [k, { label: fields[k].label, unit: fields[k].unit, kind: fields[k].kind }])), rows: rows.map((r) => Object.fromEntries(cols.map((k) => [k, r[k] === undefined ? null : r[k]]))) };
}
function withUnits(table, env) {
  const ctx = unitCtx(env);
  for (const k of table.columns) table.columnMeta[k].unit = resolveUnit(table.columnMeta[k].unit, ctx);
  return table;
}

function chartSpec(env, { title, subtitle, yLabel, data }) {
  const source = short(`A House Divided game data, ${env.tool === "market_history" ? "public series" : "your own results"}${env.asOfTurn != null ? `, as of turn ${env.asOfTurn}` : ""}`, 180);
  return { type: "line", title: short(title, 100), subtitle: short(subtitle, 100), source, x: "turn", y: "value", series: "series", xLabel: "Turn", yLabel: short(yLabel, 100), xType: "quantitative", data };
}
function windowText(turns) { return `Turns ${turns[0]} to ${turns.at(-1)}`; }

// project(env): { chart|null, why, table, tables, dense, turns, series, confidence, label, facts, caveats, trackable }
function project(env) {
  if (!env || typeof env !== "object" || !Array.isArray(env.rows) || !TOOLS[env.tool]) {
    return { chart: null, why: "not a clean evidence envelope", table: { columns: [], rows: [] }, tables: [], dense: true, confidence: { level: "low", reasons: ["not a clean evidence envelope"] }, trackable: false, facts: [], caveats: [] };
  }
  if (env.tool === "commodity_market") return projectMarket(env);
  const fields = fieldsFor(env), spec = metricSpec(env);
  const out = { facts: [], caveats: [], trackable: env.trackable === true && TRACKABLE[env.tool] === true };
  if (spec.note) out.caveats.push(spec.note);
  let tables, chart = null, why = null, series = null, extraReasons = [];
  const rows = env.rows;
  const turns = [...new Set(rows.map((r) => r.turn).filter(isTurn))].sort((a, b) => a - b);
  const label = (() => {
    if (env.tool === "market_history") return `${spec.title}${scopeText(env) ? `: ${scopeText(env)}` : ""}`;
    if (env.tool === "reporter_operating_results") return `Operating results${scopeText(env) ? `: ${scopeText(env)}` : ""}`;
    return "Action points";
  })();

  if (env.tool === "market_history") {
    const main = tableOf("rows", label, fields, rows, Object.keys(fields));
    tables = [withUnits(main, env)];
    if (env.summary && spec.summaryFields) {
      tables.push(withUnits(tableOf("summary", "Whole window", spec.summaryFields, [env.summary], Object.keys(spec.summaryFields)), env));
    }
    const ck = spec.chart.keys.filter((k) => rows.some((r) => typeof r[k] === "number"));
    if (turns.length < 2) why = "fewer than two turns";
    else if (!ck.length) why = "no value was recorded in any row";
    else {
      const data = rows.flatMap((r) => ck.map((k) => ({ turn: r.turn, value: r[k] ?? null, series: spec.chart.names[k] })));
      const yl = resolveUnit(spec.chart.yLabel, unitCtx(env));
      const nullCells = rows.reduce((n, r) => n + ck.filter((k) => r[k] === null).length, 0);
      chart = chartSpec(env, { title: label, subtitle: [windowText(turns), nullCells ? "gaps are turns with no recorded value" : null].filter(Boolean).join(" · "), yLabel: yl, data, measures: ck });
      series = { by: "measure", measures: ck, unit: resolveUnit(spec.chart.unit, unitCtx(env)) };
    }
  } else if (env.tool === "reporter_operating_results") {
    const keys = ["turn", "site", "corporation", "sectorType", "region", "revenue", "operatingProfit", "offeredUnits", "soldUnits", "feesTotal", "feesOperatingServices", "feesMinorInputPremium", "costsInputs", "costsLabour", "costsInventoryWriteOff", "costsUnpaidArrears", "source"];
    tables = [tableOf("rows", label, fields, rows, keys)];
    const sites = [...new Set(rows.map((r) => r.site))];
    const totals = env.summary?.byTurn || null;
    if (totals && totals.length) tables.push(tableOf("totals", "Recorded totals per turn", OPERATING.totalFields, totals, Object.keys(OPERATING.totalFields)));
    const without = env.summary?.sitesWithoutHistory || 0;
    const receiptGap = env.gapItems.some((g) => g.code === "receipt_unavailable");
    let data = null, names;
    if (turns.length < 2) why = "fewer than two turns";
    else if (without > 0) why = `${without} site(s) have no history, so no complete total exists`;
    else if (sites.length === 1) {
      data = rows.flatMap((r) => [{ turn: r.turn, value: r.revenue, series: "Revenue" }, { turn: r.turn, value: r.operatingProfit, series: "Operating profit" }]);
      names = ["revenue", "operatingProfit"];
    } else if (sites.length > 1) {
      // Several sites: only the recorded per-turn totals, and only when every
      // turn has a total and it agrees with the rows underneath it.
      const complete = totals && totals.length >= 2 && turns.every((t) => totals.some((x) => x.turn === t))
        && totals.every((x) => x.revenue !== null && x.operatingProfit !== null);
      if (!totals || !totals.length) why = "no recorded per-turn totals for several sites";
      else if (!complete) why = "per-turn totals are incomplete (a site has no recorded value on some turn)";
      else {
        const agrees = totals.every((x) => {
          const rs = rows.filter((r) => r.turn === x.turn);
          if (x.sites !== null && x.sites !== rs.length) return false;
          const sum = (k) => rs.reduce((a, r) => a + r[k], 0);
          return rs.every((r) => r.revenue !== null && r.operatingProfit !== null) && Math.abs(sum("revenue") - x.revenue) <= 0.01 + Math.abs(x.revenue) * 1e-9 && Math.abs(sum("operatingProfit") - x.operatingProfit) <= 0.01 + Math.abs(x.operatingProfit) * 1e-9;
        });
        if (!agrees) { why = "recorded totals do not match the site rows"; extraReasons.push("recorded totals do not match the site rows"); }
        else { data = totals.flatMap((x) => [{ turn: x.turn, value: x.revenue, series: "Revenue, all sites" }, { turn: x.turn, value: x.operatingProfit, series: "Operating profit, all sites" }]); names = ["revenue", "operatingProfit"]; }
      }
    }
    if (data && data.some((d) => typeof d.value === "number")) {
      chart = chartSpec(env, { title: label, subtitle: [windowText(turns), sites.length > 1 ? `${sites.length} sites, recorded totals` : null].filter(Boolean).join(" · "), yLabel: "Anchor currency per turn", data, measures: names });
      series = { by: "measure", measures: names, unit: "anchor currency per turn", sites: sites.length };
    } else if (!why) why = "no value was recorded in any row";
    if (sites.length > 1) out.caveats.push("Several sites: the table keeps one row per site and turn; the chart, when there is one, shows recorded totals only.");
    out.caveats.push("Operating results are settled receipts per turn. One-off fees such as permits and construction are not included.");
  } else {
    const keys = ["turn", "nextGrantTurn", "turnsCovered", "complete", "opening", "grantsPersonal", "grantsParty", "grantsHoardPenalty", "grantsLostToCap", "grantsNet", "recordedSpending", "recordedActions", "closing", "unexplainedDelta", "incompleteReason"];
    tables = [tableOf("rows", label, fields, rows, keys)];
    const f = ACTION.summaryFields, sm = env.summary || {};
    tables.push(tableOf("summary", "Open period and totals", f, [sm], Object.keys(f)));
    if (sm.currentBalance !== null && sm.currentBalance !== undefined) out.facts.push({ label: f.currentBalance.label, value: sm.currentBalance, unit: POINTS });
    const ck = ACTION.chart.keys.filter((k) => rows.some((r) => typeof r[k] === "number"));
    if (turns.length < 2) why = "fewer than two grant periods";
    else if (!ck.length) why = "no value was recorded in any row";
    else {
      const data = rows.flatMap((r) => ck.map((k) => ({ turn: r.turn, value: r[k] ?? null, series: ACTION.chart.names[k] })));
      const open = rows.some((r) => r.complete === false);
      chart = chartSpec(env, { title: label, subtitle: [windowText(turns), open ? "the open period has no closing balance yet" : null].filter(Boolean).join(" · "), yLabel: ACTION.chart.yLabel, data, measures: ck });
      series = { by: "measure", measures: ck, unit: POINTS };
    }
    if (rows.some((r) => r.complete === false)) out.caveats.push("The newest period is still open. Its balance before the next grant is not recorded yet; the current balance is shown separately and is not a closing balance.");
  }
  if (chart && !chart.data.some((d) => typeof d.value === "number")) { chart = null; why = why || "no value was recorded in any row"; }
  const confidence = confidenceOf(env, series?.measures || [], rows, extraReasons);
  const nullCells = rows.reduce((n, r) => n + Object.keys(fields).filter((k) => fields[k].kind === "measure" && k in r && r[k] === null).length, 0);
  const multiSite = env.tool === "reporter_operating_results" && new Set(rows.map((r) => r.site)).size > 1;
  const realGaps = env.gapItems.filter((g) => !INFO_GAPS.has(g.code)).length;
  const dense = rows.length > DENSE_ROWS || tables[0].columns.length > 6 || realGaps > 0 || nullCells > 0 || env.truncated || multiSite || !chart;
  return { ...out, chart, why: chart ? null : why || "nothing to chart", table: tables[0], tables, dense, turns, series, confidence, label };
}

function projectMarket(env) {
  const fields = fieldsFor(env);
  const turn = env.asOfTurn;
  const keys = ["name", "unit", "kind", "supply", "demand", "filled", "funded", "substitutionOrders", "imports", "exports", "gap", "balancePct", "uncappedBalancePct", "demandCapped", "balance", "price", "previousPrice", "priceChangePct"];
  const scopeLabel = env.scope.kind === "country" ? env.scope.country : "world";
  const title = `Commodity market, ${scopeLabel}, settled turn ${turn}${env.capturedAt ? ` (read ${env.capturedAt})` : ""}`;
  const table = tableOf("rows", title, fields, env.rows, keys);
  // Each row's quantity columns are in that row's own unit; the Unit column says which.
  for (const k of table.columns) if (table.columnMeta[k].unit === "@row") table.columnMeta[k].unit = "per row, see Unit column";
  const caveats = [CM_CAVEAT, "Units differ by commodity, so values are only comparable within a row.",
    "Demand is first-choice funded orders; substitution orders are separate. A capped commodity's balance is set by the demand cap: read the 'before the demand cap' column instead."];
  const reasons = [];
  if (env.gapItems.length) reasons.push(`${env.gapItems.length} gap(s) reported`);
  if (env.truncated) reasons.push("rows were cut at the display limit");
  const nulls = env.rows.reduce((n, r) => n + Object.keys(fields).filter((k) => fields[k].kind === "measure" && r[k] === null).length, 0);
  if (nulls) reasons.push(`${nulls} values were not recorded`);
  // One settled turn: never a trend, never tracked, never a comparative chart across units.
  return { chart: null, why: "one settled turn across commodities with different units; shown as a dated table, not a chart", table, tables: [table], dense: true, turns: [turn],
    series: null, confidence: { level: !env.rows.length || env.truncated ? "low" : reasons.length ? "medium" : "high", reasons }, label: title, facts: [], caveats, trackable: false };
}

module.exports = { SCHEMA_VERSION, TOOLS, TRACKABLE, METRICS, adapt, project, parseResult };
