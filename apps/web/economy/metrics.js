"use strict";

// Units and aggregation belong to the metric, so a range selector cannot add
// stock values together or turn missing observations into zero.
const METRICS = {};
function add(scope, rows) {
  for (const [key, label, unit = "", aggregation = "mean"] of rows) {
    METRICS[`${scope}.${key}`] = { scope, key, label, unit, aggregation };
  }
}
add("macro", [["infl","Inflation","%"],["growth","GDP growth","%"],["unemp","Unemployment","%"],
  ["prime","Prime interest rate","%"],["realRate","Real interest rate","%"],["gap","Output gap"],
  ["fill","Goods demand filled","%"],["intent","Trade orders filled","%"],["sdMedian","Median reported supply / demand","x"],
  ["realMedian","Median real price / base","x"],["deepShort","Commodities in deep shortage"],["glut","Commodities in glut"],
  ["outliers","Price outliers"],["nominalIndex","Nominal price index","x"]]);
add("corp", [["nActive","Active companies"],["nListed","Listed companies"],["rev","Corporate revenue","anchor","sum"],
  ["costs","Corporate costs","anchor","sum"],["net","Corporate net income","anchor","sum"],["cash","Corporate cash","anchor"],
  ["mcap","Listed market capitalisation","anchor"],["tax","Corporate taxes","anchor","sum"],["div","Corporate dividends","anchor","sum"],
  ["medMargin","Median profit margin","%"],["margin","Aggregate profit margin","%"],["lossShare","Loss-making companies","%"],
  ["distressShare","Distressed companies","%"],["dormantShare","Dormant companies","%"],["negCashShare","Companies with negative cash","%"],
  ["top1","Largest company market share","%"],["top5","Top five market share","%"],["hhi","Market concentration (HHI)"],
  ["effN","Effective competing companies"],["pe","Aggregate price / earnings","x"],["gini","Company market-cap Gini"],
  ["foundedPer12","Companies founded in trailing 12 turns"],["exitsPer12","Company exits in trailing 12 turns"],
  ["plRevShare","Player share of corporate revenue","%"],["plMcapShare","Player share of market cap","%"],
  ["runway","Cash runway","turns"],["cashTrend","Cash change over 12 turns","%"]]);
add("wealth", [["n","Players with recorded wealth"],["median","Median player wealth","anchor"],
  ["total","Total player wealth","anchor"],["gini","Player wealth Gini"],["top1","Richest player's wealth share","%"],
  ["top10pct","Top tenth's wealth share","%"]]);
add("trades", [["n","Share trades","trades","sum"],["notional","Share trading value","anchor","sum"],["corps","Companies traded"]]);
add("index", [["idx","Market index"],["cap","Exchange market capitalisation","anchor"]]);
add("commodity", [["price","Published price","price"],["real","Real price / base","x"],["sd","Reported supply / demand","x"]]);
add("country", [["gdpA","GDP","anchor"],["growth","GDP growth","%"],["infl","Inflation","%"],["unemp","Unemployment","%"],
  ["prime","Prime interest rate","%"],["gap","Output gap"],["bal","Budget balance / GDP","%"]]);
for (const scope of ["family", "industry", "owner", "company_country"]) add(scope, [["n","Companies"],["rev","Revenue","anchor","sum"],
  ["net","Net income","anchor","sum"],["mcap","Market capitalisation","anchor"],["cash","Cash","anchor"],
  ["lossShare","Loss-making companies","%"],["medMargin","Median profit margin","%"],["margin","Aggregate margin","%"]]);
add("flow", [["in","Recorded inflow","anchor","sum"],["out","Recorded outflow","anchor","sum"],["net","Recorded net flow","anchor","sum"]]);
add("score", [["health","Economic health score","%"],["gameplay","Gameplay score","%"],["commodities","Commodity score","%"]]);
const VIEWS = [
  { id:"overview", label:"Overview", scope:"score", metric:"health", description:"The current position and the changes that need attention." },
  { id:"macro", label:"Macro", scope:"macro", metric:"growth", description:"World prices, activity, rates and demand. Choose one measure to investigate." },
  { id:"markets", label:"Markets", scope:"commodity", metric:"sd", description:"Follow one commodity through shortages, pricing and resets." },
  { id:"companies", label:"Companies", scope:"corp", metric:"net", description:"Corporate viability, competition and capital. Drill into a family, industry or ownership group." },
  { id:"players", label:"Players", scope:"wealth", metric:"median", description:"Aggregate player wealth and participation without individual player records." },
  { id:"countries", label:"Countries", scope:"country", metric:"growth", description:"Country-specific history with consistent units and explicit coverage." },
  { id:"flows", label:"Cash flows", scope:"flow", metric:"net", description:"Recorded corporate flows by transaction type. Coverage follows the collector; this is not a whole-economy money reconciliation." },
  { id:"history", label:"History", scope:"macro", metric:"growth", description:"Browse retained iterations, reset boundaries and collection coverage." },
  { id:"fixes", label:"Changes", scope:"macro", metric:"growth", description:"Tracked changes and deployment markers. Timing alone does not establish an effect." },
];
const human = value => String(value).replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase());
module.exports = { METRICS, VIEWS, human };
