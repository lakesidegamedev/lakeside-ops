"use strict";
// Typed facts from a verified, properly scoped public game read. The plain number check compares a
// draft figure with the raw numbers a read contained. That misses two honest ways of saying the same
// thing: a GDP level read in millions of currency ("32,833,360.36 million" is 3.28e13 against a stored
// 32833360.36), and a decrease read as -1.091 and written as "fell 1.091%". A fact exists only when the
// read parsed through the evidence adapter (so failed, empty or malformed reads add nothing) and names
// a country. Reporter-private reads never produce one.
const series = require("./evidence-series");

const MILLION = 1e6;

/** Facts from one read_tool result. input is the read_tool input; result the raw result. */
function fromRead(input, result) {
  if (!input || input.server !== "gamestate" || input.tool !== "market_history") return [];
  const out = series.adapt("market_history", result);
  if (!out?.ok) return [];
  const env = out.envelope;
  if (env.visibility !== "public" || !env.scope?.country) return [];
  if (env.metric !== "gdp_level" && env.metric !== "gdp_change") return [];
  const facts = [], seen = new Set();
  const add = (f) => { const k = `${f.kind}:${f.value}`; if (!seen.has(k)) { seen.add(k); facts.push(f); } };
  const level = (v) => { if (Number.isFinite(v)) add({ kind: "amount", value: v * MILLION, scope: env.scope.country }); };
  const rows = Array.isArray(env.rows) ? env.rows : [];
  for (const r of rows) {
    level(r.value);
    if (env.metric === "gdp_change") { level(r.previousValue); if (Number.isFinite(r.changePct)) add({ kind: "percent", value: r.changePct, scope: env.scope.country }); }
  }
  if (env.metric === "gdp_change" && env.summary) {
    level(env.summary.fromValue); level(env.summary.toValue);
    if (Number.isFinite(env.summary.changePct)) add({ kind: "percent", value: env.summary.changePct, scope: env.scope.country });
  }
  return facts;
}

module.exports = { fromRead };
