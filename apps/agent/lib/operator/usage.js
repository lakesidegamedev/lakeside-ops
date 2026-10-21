"use strict";
// API-equivalent text-token scenarios, never subscription invoices. Rates are
// exact model matches verified 2026-10-16. Unknown models stay unpriced.
const fs = require("node:fs");
const readline = require("node:readline");
const VERIFIED = "2026-10-16";
const claudeSource = "https://platform.claude.com/docs/en/about-claude/pricing";
const geminiSource = "https://ai.google.dev/gemini-api/docs/pricing";
const RATES = {
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, longContext: true, source: "https://developers.openai.com/api/docs/models/gpt-6.1-sol" },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, longContext: true, source: "https://developers.openai.com/api/docs/models/gpt-6-luna" },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8, source: claudeSource },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4, source: claudeSource },
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75, source: geminiSource },
  // DeepSeek bills peak and off-peak rates (off-peak is half). Peak is used as
  // the standard scenario, so an estimate never understates a peak-hour call.
  // No cache-write charge: a cache miss is already priced at the miss rate.
  "deepseek-flash": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0, verified: "2026-10-18", source: "https://api-docs.deepseek.com/quick_start/pricing" },
};
const count = n => Number.isFinite(n) && n >= 0;
function ratesFor(model, at) {
  const r = RATES[model];
  if (!r) return null;
  if (model === "gemini-3.8-flash" && Date.parse(at) >= Date.parse("2027-01-01T00:00:00Z"))
    return { ...r, input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.5 };
  return r;
}
function estimate(row) {
  const r = ratesFor(row.model, row.at), t = row.tokens || {};
  if (!r) return { status: "unknown-model", usd: null };
  if (!count(t.input) || !count(t.output)) return { status: "missing-usage", usd: null };
  const inclusive = row.inputIncludesCache ?? /^(codex-|antigravity-)/.test(row.provider || "");
  // A missing cache split cannot be priced as a cache miss. Old Rust Claude
  // rows omitted cache creation entirely; their input total is incomplete.
  if (!count(t.cacheRead) || (!inclusive && !count(t.cacheWrite)))
    return { status: "missing-cache-usage", usd: null };
  const read = t.cacheRead, write = t.cacheWrite ?? 0;
  const input = inclusive ? t.input - read - write : t.input;
  if (input < 0) return { status: "invalid-usage", usd: null };
  const split = count(t.cacheWrite1h) && count(t.cacheWrite5m) && t.cacheWrite1h + t.cacheWrite5m === write;
  const writeCost = split && r.cacheWrite1h !== undefined ? t.cacheWrite1h * r.cacheWrite1h + t.cacheWrite5m * r.cacheWrite : write * r.cacheWrite;
  const inputCost = input * r.input + read * r.cacheRead + writeCost;
  const usd = (inputCost + t.output * r.output) / 1e6;
  // Activation totals do not reveal individual prompt lengths. Give the
  // standard short-context scenario and the all-long-context scenario.
  const maxWriteCost = !split && r.cacheWrite1h ? write * r.cacheWrite1h : writeCost;
  const upperUsd = r.longContext ? (inputCost * 2 + t.output * r.output * 1.5) / 1e6
    : (input * r.input + read * r.cacheRead + maxWriteCost + t.output * r.output) / 1e6;
  return { status: "estimated", usd, upperUsd, source: r.source, verifiedAt: r.verified || VERIFIED };
}
function empty() {
  return { activations: 0, measuredActivations: 0, pricedActivations: 0, durationMs: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    missing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    apiEquivalentUsd: null, apiEquivalentUpperUsd: null, outcomes: {}, unpriced: {} };
}
function add(group, row) {
  group.activations++;
  if (count(row.durationMs)) group.durationMs += row.durationMs;
  const t = row.tokens || {};
  if (count(t.input) && count(t.output)) group.measuredActivations++;
  for (const key of Object.keys(group.tokens)) {
    if (count(t[key])) group.tokens[key] += t[key]; else group.missing[key]++;
  }
  group.outcomes[row.outcome || "unknown"] = (group.outcomes[row.outcome || "unknown"] || 0) + 1;
  const e = estimate(row);
  if (e.usd !== null) {
    group.pricedActivations++;
    group.apiEquivalentUsd = (group.apiEquivalentUsd ?? 0) + e.usd;
    group.apiEquivalentUpperUsd = (group.apiEquivalentUpperUsd ?? 0) + e.upperUsd;
  } else group.unpriced[e.status] = (group.unpriced[e.status] || 0) + 1;
}
function usageReport(rows, { since = Date.now() - 86400000, until = Date.now() } = {}) {
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) throw new Error("Invalid usage window");
  const total = empty(), models = {}, tasks = {}, finished = new Map();
  for (const row of rows) {
    const at = Date.parse(row.at);
    // Request logs from the old API transport are a different population.
    // Counting both request and activation events would double count tokens.
    if (row.event !== "activation" || !Number.isFinite(at) || at < since || at > until) continue;
    add(total, row);
    if (row.taskState === "done") finished.set(row.job, Boolean(row.parent));
    const modelKey = `${row.provider || "unknown"}:${row.model || "unknown"}`;
    add(models[modelKey] ||= { provider: row.provider, model: row.model, ...empty() }, row);
    add(tasks[row.job || "unknown"] ||= { task: row.job || null, parent: row.parent || null, ticket: row.ticket || null, ...empty() }, row);
  }
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString(),
    pricing: { verifiedAt: VERIFIED, currency: "USD", basis: "Standard text-token API-equivalent scenario, not subscription charges", actualBilledUsd: null,
      assumptions: ["Input totals include cached input for Codex and Gemini; Claude and DeepSeek input excludes cache reads and writes. Do not add cacheRead to inclusive input.",
        "USD covers only priced activations. Missing usage and unknown models are excluded, never treated as free.",
        "Lower scenario uses standard short-context rates and 5m cache writes. Upper scenario uses all-long-context OpenAI rates or 1h Claude writes where TTL is missing.",
        "Tier, regional premiums, tools, audio and cache storage are excluded. Activations ending in the window are counted in full; in-flight usage is not yet available."], rates: RATES },
    throughput: { windowHours: (until - since) / 3600000, finishedRootTasks: [...finished.values()].filter(child => !child).length,
      finishedChildTasks: [...finished.values()].filter(Boolean).length,
      note: "Finished counts require usageVersion 2 taskState receipts. They measure task finishes, not deployed features or closed support tickets. Pre-upgrade finishes are unavailable." },
    total, models: Object.values(models), tasks: Object.values(tasks) };
}
async function readUsage(file, options) {
  const rows = [], stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  stream.on("error", error => lines.close());
  try {
    for await (const line of lines) {
      try { const r = JSON.parse(line); const at = Date.parse(r.at); if (r.event === "activation" && at >= options.since && at <= options.until) rows.push(r); } catch { /* torn lines are not usage */ }
    }
    if (stream.errored) throw stream.errored;
    return usageReport(rows, options);
  } finally { lines.close(); stream.destroy(); }
}
module.exports = { RATES, estimate, usageReport, readUsage };
