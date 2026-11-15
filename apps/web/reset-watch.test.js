"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const rw = require("./reset-watch");
const { makeResetWatchBody } = require("./reset-watch-page");

test("quantile and median handle gaps and infinity", () => {
  assert.equal(rw.median([3, 1, 2]), 2);
  assert.equal(rw.median([1, null, 3]), 2);
  assert.equal(rw.median([]), null);
  assert.equal(rw.median([1, Infinity, Infinity]), Infinity);
});

test("laneOf splits vehicles and entertainment like the engine", () => {
  assert.equal(rw.laneOf({ sectorType: "manufacturing", industryModel: "vehicles" }), "manufacturing_vehicles");
  assert.equal(rw.laneOf({ sectorType: "media", mediaDiscriminator: "entertainment" }), "media_entertainment");
  assert.equal(rw.laneOf({ sectorType: "retail" }), "retail");
});

function corpMap(list) {
  return new Map(list.map((c) => [String(c._id), c]));
}

test("site return converts daily local profit to per-turn anchor and uses paid build cost", () => {
  const corps = corpMap([{ _id: "c1", ceoType: "npp" }, { _id: "nat", isPrimaryNationalCorporation: true }]);
  const sectors = [
    // 24,000 local a day = 1,000 local a turn = 500 anchor a turn at rate 2.
    // 100 units, unit price 2,000 anchor: return = 500/100*48/2000 = 12% a year.
    { corporationId: "c1", countryId: "UK", sectorType: "retail", plantsPnl: { revenue: 240000, profit: 24000, turn: 5 }, capacityBookAnchor: 200000, capitalStock: 100, plantCount: 10, soldFraction: 1 },
    { corporationId: "nat", countryId: "UK", sectorType: "retail", plantsPnl: { revenue: 1, profit: 1, turn: 5 }, capacityBookAnchor: 1, capitalStock: 1 },
  ];
  const rows = rw.siteRows({ sectors, corpById: corps, fxByCountry: new Map([["UK", 2]]), primeByCountry: new Map([["UK", 3]]), turn: 5 });
  assert.equal(rows.length, 1, "national state corporations are excluded");
  const r = rows[0];
  assert.ok(Math.abs(r.returnPct - 12) < 1e-9);
  assert.ok(Math.abs(r.paybackTurns - 400) < 1e-9);
  assert.ok(Math.abs(r.excessPp - 9) < 1e-9);
  assert.equal(r.margin, 10);
  assert.equal(r.plantCost, 20000);
});

test("a built site with no sales this turn is idle and counts as not profitable", () => {
  const rows = rw.siteRows({
    sectors: [
      { corporationId: "c1", countryId: "US", sectorType: "extraction", plantsPnl: { revenue: 10, profit: 5, turn: 1 }, capacityBookAnchor: 10, capitalStock: 1 },
      { corporationId: "c1", countryId: "US", sectorType: "extraction", plantsPnl: { revenue: 0, profit: 0, turn: 9 }, capacityBookAnchor: 10, capitalStock: 1 },
      { corporationId: "c1", countryId: "US", sectorType: "extraction", capitalStock: 0, constructionInProgressAnchor: 500 },
    ],
    corpById: corpMap([{ _id: "c1", ceoType: "npp" }]), fxByCountry: new Map(), turn: 9,
  });
  assert.deepEqual(rows.map((r) => [r.operating, r.idle, r.building, r.profitable]), [[true, true, false, false], [true, true, false, false], [false, false, true, null]]);
  assert.equal(rows[0].returnPct, 0, "stale result reads as zero profit, not as this turn's profit");
  const lane = rw.sectorMetrics(rows).lanes.find((l) => l.lane === "extraction");
  assert.equal(lane.idle, 2);
  assert.equal(lane.building, 1);
  assert.equal(lane.profitableShare, 0);
});

test("NPPs not running excludes NPPs already standing", () => {
  const [us] = rw.candidateFields({
    elections: [{ _id: "e1", countryId: "US", status: "active" }, { _id: "e2", countryId: "US", status: "active" }],
    candidates: [{ electionId: "e1", party: "independent", nppId: "n1", status: "active" }],
    npps: [{ _id: "n1", countryId: "US" }, { _id: "n2", countryId: "US" }, { _id: "n3", countryId: "US", retiredAt: new Date() }],
    parties: [], turn: 1,
  });
  assert.equal(us.npps, 2);
  assert.equal(us.nppsFree, 1);
  assert.equal(us.nppsFreePerEmptyRace, 1);
});

test("sector verdict: profitable but below the prime rate is red", () => {
  assert.equal(rw.sectorVerdict({ sites: 6, profitableShare: 1, excessPp: -0.5, returnPct: 1.5 }).level, "bad");
  assert.equal(rw.sectorVerdict({ sites: 6, profitableShare: 1, excessPp: 1, returnPct: 3 }).level, "warn");
  assert.equal(rw.sectorVerdict({ sites: 6, profitableShare: 1, excessPp: 4, returnPct: 6 }).level, "ok");
  assert.equal(rw.sectorVerdict({ sites: 6, profitableShare: 0.2, excessPp: 4, returnPct: 6 }).level, "bad");
  assert.equal(rw.sectorVerdict({ sites: 1, profitableShare: 1, excessPp: 4 }).level, "none");
});

test("country edge is sector-adjusted", () => {
  // Country A only hosts a high-return sector, B only a low-return one, both
  // exactly at their sector's median: neither should show an edge.
  const mk = (country, lane, returnPct) => ({ country, lane, operating: true, returnPct, margin: 10, profitable: true, player: false });
  const rows = [mk("A", "financial", 9), mk("A", "financial", 9), mk("A", "financial", 9), mk("B", "retail", 2), mk("B", "retail", 2), mk("B", "retail", 2)];
  const lanes = rw.sectorMetrics(rows);
  const countries = rw.countryBalance(rows, lanes);
  for (const c of countries) assert.equal(c.edgePp, 0, c.country);
});

test("candidate fields count independents as separate sides", () => {
  const elections = [
    { _id: "e1", countryId: "US", status: "active", primaryEndTurn: 25, endTurn: 49 },
    { _id: "e2", countryId: "US", status: "active", primaryEndTurn: 25, endTurn: 49 },
    { _id: "e3", countryId: "US", status: "active", primaryEndTurn: 25, endTurn: 49 },
  ];
  const candidates = [
    { electionId: "e1", party: "independent", nppId: "n1", status: "active" },
    { electionId: "e1", party: "independent", nppId: "n2", status: "active" },
    { electionId: "e2", party: "3", nppId: "n3", status: "active" },
    { electionId: "e2", party: "3", nppId: "n4", status: "active" },
    { electionId: "e3", party: "3", nppId: "n5", status: "withdrawn" },
  ];
  const [us] = rw.candidateFields({ elections, candidates, npps: [], parties: [], turn: 20 });
  assert.equal(us.contested, 1);
  assert.equal(us.uncontested, 1);
  assert.equal(us.empty, 1);
  assert.equal(us.turnsToDeadline, 5);
  assert.equal(us.resultsTurn, 49);
  assert.equal(us.level, "bad", "empty races 5 turns before the deadline");
});

test("race margins compare top two sides by party", () => {
  const electionById = new Map([["e1", { countryId: "UK", electionType: "commons" }]]);
  const tallies = [{ electionId: "e1", finalized: true, totalVotes: { a: 40, b: 15, c: 45 }, candidateParties: { a: "1", b: "1", c: "2" } }];
  const [m] = rw.raceMargins({ tallies, electionById });
  assert.equal(Math.round(m.marginPp), 10); // party 1 = 55, party 2 = 45
});

test("effective number of parties", () => {
  assert.equal(rw.effectiveParties([50, 50]), 2);
  assert.equal(rw.effectiveParties([100]), 1);
  assert.equal(rw.effectiveParties([]), null);
});

test("dominance flags a supermajority but not a constitutional one-party state", () => {
  const officials = [
    ...Array.from({ length: 70 }, () => ({ countryId: "UK", officeType: "commons", party: "1" })),
    ...Array.from({ length: 30 }, () => ({ countryId: "UK", officeType: "commons", party: "2" })),
    { countryId: "CN", officeType: "npcDelegate", party: "1", seatsHeld: 100 },
  ];
  const parties = [{ countryId: "CN", sequentialId: 1, regimeStatus: "ruling", name: "Ruling" }];
  const rows = rw.dominance({ officials, formations: [], partyByKey: new Map(), parties, turn: 60, history: [] });
  const uk = rows.find((r) => r.country === "UK");
  const cn = rows.find((r) => r.country === "CN");
  assert.equal(uk.level, "bad");
  assert.equal(cn.level, "ok");
  assert.equal(cn.byDesign, true);
});

test("dominance counts handovers and tenure from history", () => {
  const history = [
    { turn: 50, politics: { exec: { US: "1" } } },
    { turn: 60, politics: { exec: { US: "2" } } },
    { turn: 70, politics: { exec: { US: "2" } } },
  ];
  const officials = [{ countryId: "US", officeType: "president", party: "2" }];
  const us = rw.dominance({ officials, formations: [], partyByKey: new Map(), parties: [], turn: 80, history }).find((r) => r.country === "US");
  assert.equal(us.handovers, 1);
  assert.equal(us.tenureTurns, 20);
});

test("release retries collapse into one release", () => {
  const rows = [
    ...Array.from({ length: 5 }, () => ({ row: "ahd-us-web", kind: "web", sha: "abc", result: "rolled-back" })),
    { row: "ahd-us-web", kind: "web", sha: "abc", result: "deployed", lead_s: 600, finished_at: "2026-11-15T00:00:00Z" },
    { row: "ahd-us-worker", kind: "worker", sha: "def", result: "build-failed", finished_at: "2026-11-15T01:00:00Z" },
  ];
  const g = rw.groupReleases(rows);
  assert.equal(g.length, 2);
  const web = g.find((r) => r.kind === "web");
  assert.equal(web.ok, true);
  assert.equal(web.retries, 5);
  assert.equal(g.find((r) => r.kind === "worker").ok, false);
});

test("turn metrics count failed turns and late starts", () => {
  const base = Date.parse("2026-11-15T00:00:00Z");
  const turns = [1, 2, 3, 4].map((n) => ({ turn: n, at: new Date(base + (n === 4 ? 5 : n - 1) * 3600e3).toISOString(), ms: 60000, outcome: n === 2 ? "failed" : "clean", failedPhases: 0 }));
  const m = rw.turnMetrics({ turns, cadenceMin: 60 });
  assert.equal(m.failures, 1);
  assert.equal(m.late, 1);
  assert.equal(m.level, "bad");
});

function snapshotFixture() {
  return {
    v: 1,
    generatedAt: new Date().toISOString(),
    world: { id: "2027-default:Iteration-3", preset: "2027-default", turn: 3, year: 2027, iteration: { type: "Iteration", number: 3 } },
    thresholds: { ...rw.THRESHOLDS, enginePaybackTurns: 100, turnsPerYear: 48 },
    sectors: rw.sectorMetrics([]),
    balance: { countries: [], forms: { playerCorps: 0, foundedSinceReset: 0, forms: [] } },
    politics: { fields: [{ country: "US", races: 2, empty: 2, uncontested: 0, contested: 0, parties: 0, partiesWithoutNpps: 0, npps: 10, nppsPerRace: 5, turnsToDeadline: 22, resultsTurn: 49, level: "warn", why: "x <b>" }], competitiveness: [], dominance: [], racesWithVotes: 0 },
    infra: { turns: rw.turnMetrics({ turns: [] }), turnSeries: [], slowPhases: [], builds: { releases: [], count: 0, failed: 0, retried: 0 } },
  };
}

test("history keeps one record per turn", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-"));
  const s = snapshotFixture();
  s.verdicts = rw.verdicts(s);
  rw.appendHistory(dir, s);
  rw.appendHistory(dir, s);
  s.world.turn = 4;
  rw.appendHistory(dir, s);
  const h = rw.loadHistory(dir, s.world.id);
  assert.deepEqual(h.map((x) => x.turn), [3, 4]);
});

test("page renders every section, escapes text and handles no snapshot", () => {
  const s = snapshotFixture();
  s.verdicts = rw.verdicts(s);
  const { body } = makeResetWatchBody({ snapshot: s, history: [] });
  for (const id of ["sectors", "balance", "politics", "infra"]) assert.match(body, new RegExp(`id="${id}"`));
  assert.ok(!body.includes("x <b>"), "untrusted text is escaped");
  assert.match(body, /First results at turn 49/);
  assert.match(makeResetWatchBody({ snapshot: null }).body, /No snapshot yet/);
});

test("a re-run reset with the same label is a different world", () => {
  const a = rw.worldIdentity({ preset: "2027-default", iteration: { type: "Iteration", number: 3 }, worldEpochId: "aaa", worldEpochStartedAt: "2026-11-15T06:25:00Z" });
  const b = rw.worldIdentity({ preset: "2027-default", iteration: { type: "Iteration", number: 3 }, worldEpochId: "bbb", worldEpochStartedAt: "2026-11-15T11:45:25Z" });
  assert.notEqual(a.id, b.id);
  assert.equal(a.label, b.label);
  assert.equal(b.startedAt.toISOString(), "2026-11-15T11:45:25.000Z");
  assert.equal(rw.worldIdentity({ preset: "p", iteration: { type: "Iteration", number: 1 } }).id, "p:Iteration-1");
});

test("turn records persist past the turn log expiry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-"));
  rw.saveTurns(dir, "w", [{ turn: 1, ms: 10 }, { turn: 2, ms: 20 }]);
  rw.saveTurns(dir, "w", [{ turn: 2, ms: 25 }, { turn: 3, ms: 30 }]);
  assert.deepEqual(rw.loadTurns(dir, "w").map((r) => [r.turn, r.ms]), [[1, 10], [2, 25], [3, 30]]);
});

test("line chart renders legend, end labels, data table and escapes names", () => {
  const { lineChart } = require("./reset-watch-charts");
  const html = lineChart([
    { name: "A <x>", slot: 1, points: [[1, 1], [2, 2]] },
    { name: "B", slot: 2, points: [[1, 2], [2, 2.01]] },
  ], { title: "T", yKind: "num" });
  assert.match(html, /rwc-legend/);
  assert.match(html, /class="rwc-end"/);
  assert.match(html, /rwc-table/);
  assert.ok(!html.includes("A <x>"));
  assert.match(lineChart([{ name: "x", points: [] }], { empty: "None yet" }), /None yet/);
});
