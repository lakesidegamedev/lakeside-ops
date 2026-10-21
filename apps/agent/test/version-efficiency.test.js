"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { releaseIdentity, readRelease, readReleaseHistory, readReleaseEvents, attributeReleases } = require("../lib/operator/releaseidentity");
const { milestoneFor, tokenActivity, activationStats, versionEfficiency, readVersionEfficiency } = require("../lib/operator/versionefficiency");
const { observeTicket } = require("../lib/operator/ticketoutcomes");
const A = { version: "5.8.21", sha: "a".repeat(40) }, B = { version: "5.9.5", sha: "b".repeat(40) };
function row(fields = {}) {
  return { event: "activation", job: "support", ticket: 12, kind: "ticket", at: new Date(11000).toISOString(),
    release: B, model: "claude-opus-5-5", provider: "claude-cli-subscription", durationMs: 2000, turns: 4,
    outcome: "ok", tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 }, ...fields };
}
function fixture() {
  const job = { id: "support", ticket: 12, channelId: "ch", kind: "ticket", at: 1000, state: "done" };
  const data = { jobs: { support: job } };
  observeTicket(data, job, { number: 12, status: "resolved", createdAt: 1000,
    conversation: { channelId: "ch" }, resolution: { receiptId: "receipt", resolvedAt: 10000 },
    resolutionAttribution: { agent: "keir", jobId: "support" } }, 12000);
  return data;
}

test("explicit process identity wins; deployment timestamps never guess a version", () => {
  const rows = attributeReleases([row(), row({ release: null })], [{ ...A, at: 1 }]);
  assert.deepEqual(rows[0].release, B); assert.equal(rows[0].releaseSource, "usage-record");
  assert.equal(rows[1].release, null); assert.equal(rows[1].releaseSource, "unknown");
  assert.equal(releaseIdentity({ version: "5.9.5", sha: "current" }), null);
});

test("historical joins require the same job, compatible attempt and nearby event with one SHA", () => {
  const usage = row({ release: null, attempt: "run-b" });
  const events = [{ at: 11001, job: "support", sha: B.sha, attempt: "run-b" },
    { at: 11000, job: "support", sha: A.sha, attempt: "run-a" }];
  assert.deepEqual(attributeReleases([usage], [A, B], events)[0].release, B);
  assert.equal(attributeReleases([usage], [A, B], [{ ...events[0], job: "other" }])[0].release, null);
  assert.equal(attributeReleases([usage], [A, B], [{ ...events[0], at: 14000 }])[0].release, null);
  assert.equal(attributeReleases([usage], [A, B], events.map(e => ({ ...e, attempt: null })))[0].release, null);
});

test("numeric version comparison and significant patch milestones", () => {
  assert.equal(milestoneFor("5.8.9"), "5.8.0");
  assert.equal(milestoneFor("5.8.14"), "5.8.14");
  assert.equal(milestoneFor("5.8.20"), "5.8.15");
  assert.equal(milestoneFor("5.8.29"), "5.8.21");
  assert.equal(milestoneFor("5.9.4"), "5.9.0");
  assert.equal(milestoneFor("5.10.2"), "5.10.0");
  assert.equal(milestoneFor(undefined), "unknown");
});

test("zero-token and unknown usage cannot make nonzero work look cheaper", () => {
  const zero = row({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.equal(tokenActivity(zero), "zero");
  assert.equal(tokenActivity(row({ tokens: {} })), "unknown");
  assert.equal(tokenActivity(row({ tokens: { output: 2 } })), "nonzero");
  const stats = activationStats([row(), zero]);
  assert.equal(stats.zeroTokenActivations, 1); assert.equal(stats.nonzeroUsage.activations, 1);
  assert.equal(stats.nonzeroUsage.costPerPricedActivationUsd.mean, stats.costPerPricedActivationUsd.mean * 2);
  assert.equal(stats.measuredEmptyActivations, 0);
  assert.equal(activationStats([row({ emptyActivation: true })]).verifiedEmptyActivations, 1);
});

test("exact version ticket volume deduplicates attempts and includes inherited coding work", () => {
  const data = fixture(); data.jobs.child = { id: "child", codingParent: "support", kind: "coding", at: 2000 };
  const report = versionEfficiency(data, [row(), row({ job: "child", ticket: null, kind: "coding", turns: 2 })], { until: 12000 });
  assert.equal(report.versions[0].ticketsWorkedOn, 1);
  assert.equal(report.versions[0].activations, 2);
  assert.equal(report.versions[0].completionCohort.resolvedTickets, 1);
  assert.equal(report.cohorts[0].singleMilestoneTickets.resolvedTickets, 1);
  assert.equal(report.cohorts[0].singleMilestoneTickets.turns.mean, 6);
});

test("resolution belongs to the spanning activation; lifetime costs span earlier versions", () => {
  const rows = [row({ release: A, at: new Date(3000).toISOString(), durationMs: 1000 }), row()];
  const report = versionEfficiency(fixture(), rows, { since: 9000, until: 12000 });
  assert.equal(report.tickets[0].completionVersion, B.version);
  assert.equal(report.tickets[0].turns, 8); assert.equal(report.tickets[0].activations, 2);
  assert.deepEqual(report.tickets[0].milestones, [A.version, B.version]);
  assert.equal(report.cohorts.find(c => c.milestone === B.version).singleMilestoneTickets.resolvedTickets, 0);
  assert.equal(report.versions.some(v => v.version === A.version), false, "activation window does not include earlier work; ticket lifetime does");
});

test("unknown historical release and incomplete pricing stay out of clean ticket comparisons", () => {
  const report = versionEfficiency(fixture(), [row({ release: null }), row({ model: "unpriced" })], { until: 12000 });
  assert.equal(report.tickets[0].singleMilestone, false);
  assert.equal(report.tickets[0].apiEquivalentUsd, null);
  assert.equal(report.releaseAttribution.unknownRows, 1);
  assert.equal(report.cohorts.find(c => c.milestone === B.version).singleMilestoneTickets.resolvedTickets, 0);
});

test("changing workload mix is exposed through matched kind/model cells", () => {
  const report = versionEfficiency({}, [row({ release: A }), row({ kind: "coding" }), row({ model: "claude-sonnet-5-5" })], { until: 12000 });
  assert.equal(report.matchedWork.length, 3);
  assert.equal(report.matchedWork.find(c => c.milestone === B.version && c.kind === "coding").activations, 1);
  assert.equal(report.cohorts.find(c => c.milestone === B.version).byKind.ticket.activations, 1);
});

test("canonical reopen excludes the previous ticket success from version counts", () => {
  const data = fixture(), job = data.jobs.support;
  observeTicket(data, job, { number: 12, status: "in_progress", conversation: { channelId: "fresh" } }, 12000);
  const report = versionEfficiency(data, [row()], { until: 12000 });
  assert.equal(report.resolvedTickets, 0); assert.equal(report.versions[0].completionCohort.resolvedTickets, 0);
  assert.equal(report.versions[0].ticketsWorkedOn, 1);
});

test("unobserved canonical receipts are reported as missing coverage, not measured zero success", () => {
  const data = fixture(); delete data.ticketOutcomes;
  const report = versionEfficiency(data, [row()], { until: 12000 });
  assert.equal(report.resolvedTickets, 0); assert.equal(report.versions[0].ticketsWorkedOn, 1);
  assert.equal(report.outcomeCoverage.unobservedTickets, 1); assert.equal(report.outcomeCoverage.observedTickets, 0);
});

test("immutable release files, history and SQLite attribution are read-only", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-efficiency-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const releaseDir = path.join(dir, "releases"), build = path.join(releaseDir, "build"); fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, "RELEASE"), `${B.sha} ${B.version}\n`);
  assert.deepEqual(readRelease(path.join(build, "RELEASE")), B);
  assert.equal(readRelease(path.join(dir, "absent")), null);
  const historyFile = path.join(dir, "history.jsonl"); fs.writeFileSync(historyFile, JSON.stringify(A) + '\n{"torn":');
  const history = readReleaseHistory(historyFile, releaseDir); assert.deepEqual(history.map(r => r.version), [A.version, B.version]);
  const { DatabaseSync } = require("node:sqlite"), file = path.join(dir, "events.db"), db = new DatabaseSync(file);
  db.exec("CREATE TABLE events (at INTEGER, kind TEXT, attempt_id TEXT, release TEXT, payload TEXT)");
  db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)").run(11000, "audit:cli_activation", "support", B.sha, JSON.stringify({ attempt: "run", privateText: "never-return-this" })); db.close();
  const events = readReleaseEvents(file); assert.equal(events.length, 1); assert.doesNotMatch(JSON.stringify(events), /never-return/);
  const usage = path.join(dir, "usage.jsonl"); fs.writeFileSync(usage, JSON.stringify(row({ release: null, attempt: "run" })) + '\n{"torn":');
  const report = await readVersionEfficiency(fixture(), usage, { historyFile, releasesDirectory: releaseDir, eventsFile: file, until: 12000 });
  assert.equal(report.releaseAttribution.eventMatchedRows, 1); assert.equal(report.versions[0].version, B.version);
  assert.equal((await readVersionEfficiency({}, path.join(dir, "missing"), { until: 12000 })).usageLogMissing, true);
});
