"use strict";
const fs = require("node:fs");
const readline = require("node:readline");
const { ticketOf, rootJob } = require("./workrecord");
const { keyFor, stamp } = require("./ticketoutcomes");
const { estimate } = require("./usage");
const count = n => Number.isFinite(n) && n >= 0;

function distribution(values) {
  const sorted = values.filter(count).sort((a, b) => a - b);
  const n = sorted.length;
  const p = q => n ? sorted[Math.max(0, Math.ceil(q * n) - 1)] : null;
  return { n, mean: n ? sorted.reduce((a, b) => a + b, 0) / n : null,
    median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    p90: p(0.9), p95: p(0.95), min: n ? sorted[0] : null, max: n ? sorted[n - 1] : null };
}

function usageTotals(rows) {
  const sum = field => rows.reduce((total, row) => total + (count(row[field]) ? row[field] : 0), 0);
  const priced = rows.map(estimate).filter(e => count(e.usd));
  const complete = field => rows.length > 0 && rows.every(row => count(row[field]));
  const tokens = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => [key,
    rows.length && rows.every(r => count(r.tokens?.[key])) ? rows.reduce((n, r) => n + r.tokens[key], 0) : null]));
  return { activations: rows.length,
    tokens,
    turns: complete("turns") ? sum("turns") : null, knownTurns: sum("turns"), missingTurns: rows.filter(r => !count(r.turns)).length,
    durationMs: complete("durationMs") ? sum("durationMs") : null,
    apiEquivalentUsd: rows.length && priced.length === rows.length ? priced.reduce((n, e) => n + e.usd, 0) : null,
    knownApiEquivalentUsd: priced.length ? priced.reduce((n, e) => n + e.usd, 0) : null,
    unpricedActivations: rows.length - priced.length,
    // Subscription charges cannot be allocated from tokens. Only explicit
    // billed-USD evidence may populate this field, including genuine zeroes.
    actualBilledUsd: complete("actualBilledUsd") ? sum("actualBilledUsd") : null,
    notionalUsd: complete("notionalUsd") ? sum("notionalUsd") : null,
  };
}

function ticketPerformance(data, usage = [], { since = 0, until = Date.now() } = {}) {
  if (!count(since) || !count(until) || since > until) throw new Error("Invalid performance window");
  const jobs = data.jobs || {};
  const latest = new Map();
  for (const job of Object.values(jobs)) {
    if (job.kind !== "ticket" || !job.ticket) continue;
    if (!latest.has(job.ticket) || (job.at || 0) > (latest.get(job.ticket).at || 0)) latest.set(job.ticket, job);
  }
  const starts = new Map();
  for (const job of Object.values(jobs)) {
    const root = rootJob(job, jobs), number = ticketOf(job) || ticketOf(root), current = latest.get(number);
    if (current && count(job.at))
      starts.set(number, Math.min(starts.get(number) ?? Infinity, job.at));
  }
  const rowsByTicket = new Map();
  for (const row of usage) {
    if (row?.event !== "activation") continue;
    const job = jobs[row.job] || jobs[row.parent], root = job ? rootJob(job, jobs) : null;
    const number = job ? ticketOf(job) || ticketOf(root) : Number(row.ticket);
    const current = latest.get(number);
    const at = stamp(row.at);
    if (!current || !Number.isFinite(at) || at > until) continue;
    if (at < (starts.get(number) || 0)) continue;
    (rowsByTicket.get(number) || rowsByTicket.set(number, []).get(number)).push(row);
  }
  const tickets = [];
  let pending = 0, unverifiedClosures = 0, reopenedTickets = 0, mergedTickets = 0, observedTickets = 0;
  for (const [number, job] of latest) {
    const outcome = data.ticketOutcomes?.[keyFor(job)];
    if (outcome) observedTickets++;
    if (outcome?.reopened || job.reopenedFromJob) reopenedTickets++;
    if (outcome?.superseded) { pending++; continue; }
    if ((["closed", "resolved"].includes(outcome?.status) && !outcome.receiptId) || job.mergedInto || outcome?.mergedInto) {
      if (job.mergedInto || outcome?.mergedInto) mergedTickets++; else unverifiedClosures++;
    }
    if (!outcome?.resolvedAt || !outcome.receiptId) { if (outcome && !["resolved", "closed"].includes(outcome.status) && !job.mergedInto) pending++; continue; }
    if (outcome.resolvedAt < since || outcome.resolvedAt > until) continue;
    // An activation that records the resolution logs its usage at completion.
    // Include it when its measured execution interval spans the receipt time.
    const rows = (rowsByTicket.get(number) || []).filter(r => stamp(r.at) - (count(r.durationMs) ? r.durationMs : 0) <= outcome.resolvedAt);
    const models = new Map();
    for (const row of rows) {
      const key = JSON.stringify([row.provider || "unknown", row.model || "unknown"]);
      (models.get(key) || models.set(key, []).get(key)).push(row);
    }
    const resolverRows = rows.filter(r => r.job === outcome.resolverJob).sort((a, b) => stamp(b.at) - stamp(a.at));
    tickets.push({ ...outcome,
      resolutionMs: count(outcome.createdAt) && outcome.createdAt <= outcome.resolvedAt ? outcome.resolvedAt - outcome.createdAt : null,
      pickupToResolutionMs: count(starts.get(number)) && outcome.resolvedAt >= starts.get(number) ? outcome.resolvedAt - starts.get(number) : null,
      ...usageTotals(rows),
      resolvingModel: resolverRows[0] ? { provider: resolverRows[0].provider, model: resolverRows[0].model } : null,
      models: [...models.values()].map(rs => ({ provider: rs[0].provider || "unknown", model: rs[0].model || "unknown", ...usageTotals(rs) })),
    });
  }
  tickets.sort((a, b) => b.resolvedAt - a.resolvedAt || a.ticket - b.ticket);
  const summarize = group => ({ tickets: group.length,
    resolutionMs: distribution(group.map(t => t.resolutionMs)),
    pickupToResolutionMs: distribution(group.map(t => t.pickupToResolutionMs)),
    turns: distribution(group.map(t => t.turns)), activations: distribution(group.map(t => t.activations)),
    apiEquivalentUsd: distribution(group.map(t => t.apiEquivalentUsd)), actualBilledUsd: distribution(group.map(t => t.actualBilledUsd)),
    missingUsageTickets: group.filter(t => !t.activations).length,
  });
  const resolved = tickets.filter(t => t.credit === "keir");
  const days = new Map();
  for (const ticket of resolved) {
    const day = new Date(ticket.resolvedAt).toISOString().slice(0, 10);
    (days.get(day) || days.set(day, []).get(day)).push(ticket);
  }
  const modelGroups = new Map();
  for (const ticket of resolved) for (const model of ticket.models) {
    const key = JSON.stringify([model.provider, model.model]);
    const group = modelGroups.get(key) || { provider: model.provider, model: model.model, tickets: [] };
    group.tickets.push({ ...ticket, ...model }); modelGroups.set(key, group);
  }
  return { since, until, basis: "Current outcome per ticket; cohort by canonical resolution time; lifetime work through resolution, including earlier conversations when reopened. Turns are model turns, not game turns or player messages.",
    attribution: "Keir credit requires an explicit resolver attribution or Keir resolution submission. Other canonical closures with Keir work are assisted, not credited resolutions. Model groups show contributing work, not sole authorship.",
    costs: "API-equivalent USD uses the usage report rate table, not subscription charges. Incomplete totals are null; known subtotals and missing counts remain visible. Usage logged after until is not yet included.",
    trackedTickets: latest.size, observedTickets, unobservedTickets: latest.size - observedTickets,
    pending, unverifiedClosures, mergedTickets, reopenedTickets,
    resolved: summarize(resolved), assisted: summarize(tickets.filter(t => t.credit === "assisted")),
    byDay: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, group]) => ({ day, ...summarize(group) })),
    byModel: [...modelGroups.values()].map(g => ({ provider: g.provider, model: g.model, ...summarize(g.tickets) })), tickets };
}

async function readActivationRows(file) {
  const rows = [], stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  stream.on("error", () => lines.close());
  try {
    try {
      for await (const line of lines) {
        try { const row = JSON.parse(line); if (row?.event === "activation") rows.push(row); } catch { /* torn line */ }
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stream.errored && stream.errored.code !== "ENOENT") throw stream.errored;
    return { rows, usageLogMissing: stream.errored?.code === "ENOENT" };
  } finally { lines.close(); stream.destroy(); }
}
async function readTicketPerformance(data, file, options) {
  const { rows, usageLogMissing } = await readActivationRows(file);
  return { ...ticketPerformance(data, rows, options), usageLogMissing };
}

module.exports = { distribution, usageTotals, ticketPerformance, readTicketPerformance, readActivationRows };
