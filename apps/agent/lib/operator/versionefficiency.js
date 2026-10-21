"use strict";
const { distribution, ticketPerformance } = require("./ticketperformance");
const { estimate } = require("./usage");
const { ticketOf, rootJob } = require("./workrecord");
const { attributeReleases, releaseIdentity } = require("./releaseidentity");

// Minor versions are significant by default. These patch releases introduced
// distinct provider/context/workflow changes and deserve their own cohorts.
const MILESTONES = [
  { version: "5.8.0", label: "Unified CLI" },
  { version: "5.8.14", label: "DeepSeek API route" },
  { version: "5.8.15", label: "Cursor Auto" },
  { version: "5.8.21", label: "Lean context" },
  { version: "5.8.30", label: "Playbooks and proactive work" },
  { version: "5.9.0", label: "Private investigations" },
  { version: "5.9.5", label: "Ticket reliability fixes" },
];
const numeric = n => Number.isFinite(n) && n >= 0;
function tokenActivity(row) {
  const t = row.tokens || {};
  if ([t.input, t.output, t.cacheRead, t.cacheWrite].some(n => numeric(n) && n > 0)) return "nonzero";
  if ([t.input, t.output, t.cacheRead].every(numeric) && (numeric(t.cacheWrite) || row.inputIncludesCache === true)) return "zero";
  return "unknown";
}
const versionParts = version => version.split(/[.-]/).slice(0, 3).map(Number);
function compareVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
function milestoneFor(version, milestones = MILESTONES) {
  if (!releaseIdentity({ version, sha: "a".repeat(40) })) return "unknown";
  const [major, minor] = versionParts(version);
  const base = `${major}.${minor}.0`;
  return milestones.filter(m => compareVersions(m.version, base) >= 0 && compareVersions(m.version, version) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version)).at(-1)?.version || base;
}

function activationStats(rows) {
  const priced = rows.map(estimate).filter(e => numeric(e.usd));
  const nonzero = rows.filter(row => tokenActivity(row) === "nonzero");
  const nonzeroPriced = nonzero.map(estimate).filter(e => numeric(e.usd));
  const unsuccessful = rows.filter(r => !["ok", "success"].includes(r.outcome)).length;
  return { activations: rows.length, pricedActivations: priced.length,
    ticketsWorkedOn: new Set(rows.map(r => r.workTicket).filter(Boolean)).size,
    pricingCoverage: rows.length ? priced.length / rows.length : null,
    knownApiEquivalentUsd: priced.length ? priced.reduce((n, e) => n + e.usd, 0) : null,
    costPerPricedActivationUsd: distribution(priced.map(e => e.usd)),
    turnsPerActivation: distribution(rows.map(r => r.turns)),
    durationMs: distribution(rows.map(r => r.durationMs)),
    zeroTokenActivations: rows.filter(row => tokenActivity(row) === "zero").length,
    measuredEmptyActivations: rows.filter(row => typeof row.emptyActivation === "boolean").length,
    verifiedEmptyActivations: rows.filter(row => row.emptyActivation === true).length,
    unknownTokenActivity: rows.filter(row => tokenActivity(row) === "unknown").length,
    nonzeroUsage: { activations: nonzero.length, pricedActivations: nonzeroPriced.length,
      costPerPricedActivationUsd: distribution(nonzeroPriced.map(e => e.usd)),
      durationMs: distribution(nonzero.map(row => row.durationMs)), turns: distribution(nonzero.map(row => row.turns)) },
    unsuccessfulActivations: unsuccessful, unsuccessfulRate: rows.length ? unsuccessful / rows.length : null,
    // An activation returning normally is not evidence of ticket resolution.
    byKind: Object.fromEntries([...new Set(rows.map(r => r.kind || "unknown"))].sort().map(kind => {
      const group = rows.filter(r => (r.kind || "unknown") === kind);
      return [kind, { activations: group.length, durationMs: distribution(group.map(r => r.durationMs)),
        turns: distribution(group.map(r => r.turns)), priced: group.map(estimate).filter(e => numeric(e.usd)).length,
        cost: distribution(group.map(estimate).map(e => e.usd)) }];
    })),
  };
}
function ticketStats(tickets) {
  return { resolvedTickets: tickets.length,
    resolutionMs: distribution(tickets.map(t => t.resolutionMs)),
    turns: distribution(tickets.map(t => t.turns)), activations: distribution(tickets.map(t => t.activations)),
    apiEquivalentUsd: distribution(tickets.map(t => t.apiEquivalentUsd)) };
}

function versionEfficiency(data, inputRows, { history = [], events = [], milestones = MILESTONES, since = 0, until = Date.now() } = {}) {
  if (!numeric(since) || !numeric(until) || since > until) throw new Error("Invalid efficiency window");
  // Retain all historical work for tickets resolved in the selected cohort.
  const jobs = data.jobs || {};
  const rows = attributeReleases(inputRows.filter(r => r?.event === "activation" && Date.parse(r.at) <= until), history, events).map(row => {
    const job = jobs[row.job] || jobs[row.parent];
    return { ...row, workTicket: job ? ticketOf(job) || ticketOf(rootJob(job, jobs)) : Number(row.ticket) || null };
  });
  const selected = rows.filter(r => Date.parse(r.at) >= since);
  const groups = new Map();
  for (const row of selected) {
    const key = milestoneFor(row.release?.version, milestones);
    (groups.get(key) || groups.set(key, []).get(key)).push(row);
  }
  const ticketRows = new Map();
  for (const row of rows) {
    const job = jobs[row.job] || jobs[row.parent], root = job ? rootJob(job, jobs) : null;
    const number = job ? ticketOf(job) || ticketOf(root) : Number(row.ticket);
    if (number) (ticketRows.get(number) || ticketRows.set(number, []).get(number)).push(row);
  }
  const performance = ticketPerformance(data, rows, { since, until });
  const tickets = performance.tickets.filter(t => t.credit === "keir").map(ticket => {
    const work = (ticketRows.get(ticket.ticket) || []).filter(row => Date.parse(row.at) - (numeric(row.durationMs) ? row.durationMs : 0) <= ticket.resolvedAt);
    // Prefer the activation that contains the resolution event, not merely
    // the last version to touch the ticket earlier in its lifetime.
    const resolver = work.filter(row => row.job === ticket.resolverJob && Date.parse(row.at) >= ticket.resolvedAt)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    const versions = [...new Set(work.map(row => row.release?.version || "unknown"))];
    const cohorts = [...new Set(versions.map(version => milestoneFor(version, milestones)))];
    const completionMilestone = milestoneFor(resolver?.release?.version, milestones);
    return { ticket: ticket.ticket, resolvedAt: ticket.resolvedAt, resolutionMs: ticket.resolutionMs,
      turns: ticket.turns, activations: ticket.activations, apiEquivalentUsd: ticket.apiEquivalentUsd,
      versions, milestones: cohorts, completionVersion: resolver?.release?.version || null, completionMilestone,
      singleMilestone: cohorts.length === 1 && cohorts[0] !== "unknown", resolverVersionKnown: Boolean(resolver?.release) };
  });
  const cohortKeys = [...new Set([...groups.keys(), ...tickets.map(t => t.completionMilestone)])];
  const cohorts = cohortKeys.sort((a, b) => a === "unknown" ? 1 : b === "unknown" ? -1 : compareVersions(a, b)).map(key => {
    const group = groups.get(key) || [], completed = tickets.filter(t => t.completionMilestone === key);
    const stable = tickets.filter(t => t.singleMilestone && t.milestones[0] === key);
    return { milestone: key, label: milestones.find(m => m.version === key)?.label || (key === "unknown" ? "Release unknown" : `Keir ${key.split('.').slice(0,2).join('.')}`),
      firstAt: group.length ? Math.min(...group.map(r => Date.parse(r.at))) : null,
      lastAt: group.length ? Math.max(...group.map(r => Date.parse(r.at))) : null,
      versions: [...new Set(group.map(r => r.release?.version).filter(Boolean))].sort(compareVersions),
      ...activationStats(group), completionCohort: ticketStats(completed), singleMilestoneTickets: ticketStats(stable) };
  });
  // Matched kind/provider/model cells reduce workload and model-mix effects.
  // They remain observational, with measurement coverage shown per cell.
  const cells = new Map();
  for (const row of selected.filter(r => r.release)) {
    const key = JSON.stringify([milestoneFor(row.release.version, milestones), row.kind || "unknown", row.provider || "unknown", row.model || "unknown"]);
    (cells.get(key) || cells.set(key, []).get(key)).push(row);
  }
  const matchedWork = [...cells].map(([key, rs]) => {
    const [milestone, kind, provider, model] = JSON.parse(key);
    return { milestone, kind, provider, model, ...activationStats(rs) };
  });
  const exactVersions = [...new Set(selected.map(row => row.release?.version).filter(Boolean))].sort(compareVersions).map(version => {
    const work = selected.filter(row => row.release?.version === version);
    return { version, shas: [...new Set(work.map(row => row.release.sha))],
      firstAt: Math.min(...work.map(row => Date.parse(row.at))), lastAt: Math.max(...work.map(row => Date.parse(row.at))),
      ...activationStats(work), completionCohort: ticketStats(tickets.filter(t => t.completionVersion === version)) };
  });
  return { since, until, releaseAttribution: { exactUsageRows: selected.filter(r => r.releaseSource === "usage-record").length,
    eventMatchedRows: selected.filter(r => r.releaseSource === "event-sink").length,
    unknownRows: selected.filter(r => !r.release).length },
    cautions: ["Known USD is an API-equivalent subtotal, not actual subscription charges. Compare coverage as well as cost.",
      "Normal activation returns are not ticket successes. Completion cohorts include lifetime work performed under earlier releases.",
      "Single-milestone tickets exclude work spanning milestone boundaries or unknown releases. Sample sizes and ticket difficulty can still differ.",
      "Matched cells hold task kind, provider and model fixed, not ticket difficulty. Release association does not establish causation.",
      "Zero-token rows are separated from nonzero-usage comparisons. They can be empty provider runs or accounting gaps; neither proves productive work.",
      "Older thrown/interrupted runs often lack a matching event-sink release. Versioned activation failure rates can therefore be selection-biased.",
      "Pre-usage retention and unlogged external work cannot be reconstructed. Current reopened tickets are excluded from resolution success."],
    trackedTickets: performance.trackedTickets, resolvedTickets: tickets.length,
    unknownCompletionVersionTickets: tickets.filter(t => !t.resolverVersionKnown).length,
    cohorts, versions: exactVersions, matchedWork, tickets };
}

async function readVersionEfficiency(data, file, { historyFile, releasesDirectory, eventsFile, ...options } = {}) {
  const { rows, usageLogMissing } = await require("./ticketperformance").readActivationRows(file);
  const { readReleaseHistory, readReleaseEvents } = require("./releaseidentity");
  return { ...versionEfficiency(data, rows, { ...options,
    history: readReleaseHistory(historyFile, releasesDirectory), events: readReleaseEvents(eventsFile) }), usageLogMissing };
}

module.exports = { MILESTONES, milestoneFor, compareVersions, tokenActivity, activationStats, versionEfficiency, readVersionEfficiency };
