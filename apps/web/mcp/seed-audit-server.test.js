// Unit tests for seed-audit-server.js — mock Db only, never touches MONGODB_URI.
// Run: node --test mcp/seed-audit-server.test.js
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The audit's lists come from the game repo, not from a hand-typed copy, so
// the tests point the server at a fixture artifact.
const FIXTURE = {
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  source: { repo: "AHDGame", commit: "fixture", branch: "fixture" },
  corporationTypes: ["financial", "media", "manufacturing", "energy", "extraction"],
  forexActiveCountries: ["US", "UK", "DE", "AT"],
  presets: {
    "1953-default": {
      player: ["US", "UK", "RU"],
      econ: ["DE", "AT", "FR"],
      npp: ["ES"],
      latent: ["UKR"],
    },
  },
};

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-audit-ref-"));
const fixturePath = path.join(fixtureDir, "seed-audit-reference.json");
fs.writeFileSync(fixturePath, JSON.stringify(FIXTURE), "utf8");
process.env.SEED_AUDIT_REFERENCE_PATH = fixturePath;

const { seedTruth, resetSeedTruth } = require("./seed-audit-reference");
const {
  resolveGameDbName,
  auditState,
  auditCountry,
  auditEra,
  checkDuplicates,
} = require("./seed-audit-server");

const { corporationTypes: CORPORATION_TYPES, presetCountries: PRESET_COUNTRIES } = seedTruth();

before(() => resetSeedTruth());
after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

function makeCursor(docs) {
  return {
    toArray: async () => docs,
    project() { return this; },
    sort() { return this; },
    limit() { return this; },
  };
}

/** Minimal mock Db: collection(name) → methods backed by in-memory maps. */
function createMockDb(data) {
  return {
    collection(name) {
      const rows = data[name] || [];
      return {
        async findOne(filter, _opts) {
          return rows.find((d) => match(d, filter)) || null;
        },
        find(filter) {
          const matched = rows.filter((d) => match(d, filter));
          return makeCursor(matched);
        },
        async countDocuments(filter) {
          return rows.filter((d) => match(d, filter)).length;
        },
      };
    },
  };
}

function match(doc, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or") {
      if (!v.some((clause) => match(doc, clause))) return false;
      continue;
    }
    if (v && typeof v === "object" && v.$in) {
      if (!v.$in.includes(doc[k])) return false;
      continue;
    }
    if (v && typeof v === "object" && v.$not instanceof RegExp) {
      if (v.$not.test(String(doc[k]))) return false;
      continue;
    }
    if (doc[k] !== v) return false;
  }
  return true;
}

describe("resolveGameDbName", () => {
  it("appends -sandbox for sandbox", () => {
    assert.equal(
      resolveGameDbName("sandbox", "mongodb://h/a-house-divided?x=1"),
      "a-house-divided-sandbox"
    );
  });
  it("keeps base for main", () => {
    assert.equal(
      resolveGameDbName("main", "mongodb://h/a-house-divided?x=1"),
      "a-house-divided"
    );
  });
});

describe("auditState", () => {
  it("returns NOT_FOUND when states doc missing", async () => {
    const db = createMockDb({ states: [] });
    const r = await auditState(db, "ZZZ");
    assert.equal(r.status, "NOT_FOUND");
    assert.equal(r.complete, false);
  });

  it("reports missing sector types and resource capacity", async () => {
    const db = createMockDb({
      states: [{
        _id: "BEL", countryId: "RU", name: "Byelorussia",
        sectorSpecializations: { primary: "manufacturing", secondary: "energy" },
      }],
      macroMetrics: [{ _id: "BEL" }],
      politicalMetrics: [{ _id: "BEL" }],
      stateBaselines: [{ _id: "BEL" }],
      stateDemographics: [{ _id: "BEL" }],
      stateBudgets: [{ _id: "BEL", stateId: "BEL" }],
      stateResourceCapacity: [],
      unownedSectors: CORPORATION_TYPES.slice(0, 2).map((sectorType) => ({
        stateId: "BEL", sectorType,
      })),
    });
    const r = await auditState(db, "BEL");
    assert.equal(r.complete, false);
    assert.ok(r.gaps.includes("stateResourceCapacity"));
    assert.ok(r.gaps.includes("unownedSectors"));
    assert.ok(!r.gaps.includes("sectorSpecializations"));
    assert.equal(r.collections.unownedSectors.missingSectorTypes.length, CORPORATION_TYPES.length - 2);
  });

  it("passes when every per-state collection is present", async () => {
    const db = createMockDb({
      states: [{
        _id: "UKR", countryId: "RU", name: "Ukraine",
        sectorSpecializations: { primary: "financial", secondary: "media" },
      }],
      macroMetrics: [{ _id: "UKR" }],
      politicalMetrics: [{ _id: "UKR" }],
      stateBaselines: [{ _id: "UKR" }],
      stateDemographics: [{ _id: "UKR" }],
      stateBudgets: [{ _id: "UKR", stateId: "UKR" }],
      stateResourceCapacity: [{ stateId: "UKR" }],
      unownedSectors: CORPORATION_TYPES.map((sectorType) => ({ stateId: "UKR", sectorType })),
    });
    const r = await auditState(db, "UKR");
    assert.equal(r.complete, true);
    assert.equal(r.status, "OK");
    assert.deepEqual(r.gaps, []);
  });

  it("flags sectorSpecializations as a gap when the embedded field is absent (regression: incident 2026-07-22)", async () => {
    // sectorSpecializations is NOT a separate collection — seedStateSectorSpecializations
    // writes it onto the states doc itself. A prior version of this audit checked a
    // nonexistent "stateSectorSpecializations" collection and false-flagged every
    // single state in the game as missing it (154/154 in the real sandbox audit).
    const db = createMockDb({
      states: [{ _id: "HU_HUN", countryId: "HU", name: "Hungary" }], // no sectorSpecializations field
      macroMetrics: [{ _id: "HU_HUN" }],
      politicalMetrics: [{ _id: "HU_HUN" }],
      stateBaselines: [{ _id: "HU_HUN" }],
      stateDemographics: [{ _id: "HU_HUN" }],
      stateBudgets: [{ _id: "HU_HUN", stateId: "HU_HUN" }],
      stateResourceCapacity: [{ stateId: "HU_HUN" }],
      unownedSectors: CORPORATION_TYPES.map((sectorType) => ({ stateId: "HU_HUN", sectorType })),
    });
    const r = await auditState(db, "HU_HUN");
    assert.equal(r.complete, false);
    assert.ok(r.gaps.includes("sectorSpecializations"));
    assert.equal(r.collections.sectorSpecializations.present, false);
  });
});

describe("auditCountry", () => {
  it("econ-only does not require parties/officials/laws", async () => {
    const db = createMockDb({
      federalBudget: [{ _id: "DE", countryId: "DE" }],
      centralBanks: [{ _id: "DE" }],
      countryState: [{ _id: "DE" }],
      countryGameStates: [{ _id: "DE" }],
      politicalParties: [],
      electedOfficials: [],
      enactedLaws: [],
      states: [],
    });
    const r = await auditCountry(db, "DE", "econ-only");
    assert.ok(!r.countryGaps.includes("politicalParties"));
    assert.ok(!r.countryGaps.includes("electedOfficials"));
    assert.ok(r.countryGaps.some((g) => g.startsWith("states")));
  });

  it("finds centralBanks via countryId when not keyed by _id (regression: DE/ECB, incident 2026-07-22)", async () => {
    // Germany's central bank doc is a shared currency-union entity keyed
    // _id: "ECB", countryId: "DE" — not _id: "DE". A prior version of this
    // audit only checked _id === countryId and false-flagged DE as missing
    // its central bank in both a fresh prod world and the long-running sandbox.
    const db = createMockDb({
      federalBudget: [{ _id: "DE", countryId: "DE" }],
      centralBanks: [{ _id: "ECB", countryId: "DE" }],
      countryState: [{ _id: "DE" }],
      countryGameStates: [{ _id: "DE" }],
      politicalParties: [],
      electedOfficials: [],
      enactedLaws: [],
      states: [],
    });
    const r = await auditCountry(db, "DE", "econ-only");
    assert.ok(!r.countryGaps.includes("centralBanks"));
    assert.equal(r.collections.centralBanks.present, true);
  });

  it("player-enabled requires parties/officials/laws", async () => {
    const db = createMockDb({
      federalBudget: [{ _id: "RU", countryId: "RU" }],
      centralBanks: [{ _id: "RU" }],
      countryState: [{ _id: "RU" }],
      countryGameStates: [{ _id: "RU" }],
      politicalParties: [],
      electedOfficials: [],
      enactedLaws: [],
      states: [{
        _id: "UKR", countryId: "RU",
        sectorSpecializations: { primary: "financial", secondary: "media" },
      }],
      macroMetrics: [{ _id: "UKR" }],
      politicalMetrics: [{ _id: "UKR" }],
      stateBaselines: [{ _id: "UKR" }],
      stateDemographics: [{ _id: "UKR" }],
      stateBudgets: [{ _id: "UKR" }],
      stateResourceCapacity: [{ stateId: "UKR" }],
      unownedSectors: CORPORATION_TYPES.map((t) => ({ stateId: "UKR", sectorType: t })),
    });
    const r = await auditCountry(db, "RU", "player-enabled");
    assert.equal(r.complete, false);
    assert.ok(r.countryGaps.includes("politicalParties"));
    assert.ok(r.countryGaps.includes("electedOfficials"));
    assert.ok(r.countryGaps.includes("enactedLaws"));
  });

  it("does not require seated officials during pre-iteration founding", async () => {
    const db = createMockDb({
      gameState: [{ _id: "current", preIteration: { active: true, startedTurn: 1 } }],
      federalBudget: [{ _id: "RU", countryId: "RU" }],
      centralBanks: [{ _id: "RU" }],
      countryState: [{ _id: "RU" }],
      countryGameStates: [{ _id: "RU" }],
      politicalParties: [{ countryId: "RU" }],
      electedOfficials: [],
      enactedLaws: [{ countryId: "RU" }],
      states: [{
        _id: "CEN", countryId: "RU",
        sectorSpecializations: { primary: "manufacturing", secondary: "energy" },
      }],
      macroMetrics: [{ _id: "CEN" }],
      politicalMetrics: [{ _id: "CEN" }],
      stateBaselines: [{ _id: "CEN" }],
      stateDemographics: [{ _id: "CEN" }],
      stateBudgets: [{ _id: "CEN" }],
      stateResourceCapacity: [{ stateId: "CEN" }],
      unownedSectors: CORPORATION_TYPES.map((sectorType) => ({
        stateId: "CEN", sectorType,
      })),
    });

    const r = await auditCountry(db, "RU", "player-enabled");
    assert.equal(r.complete, true);
    assert.ok(!r.countryGaps.includes("electedOfficials"));
    assert.equal(r.collections.electedOfficials.required, false);
  });

  it("US does not require countryGameStates; federalBudget via countryId", async () => {
    const db = createMockDb({
      federalBudget: [{ _id: "federal", countryId: "US" }],
      centralBanks: [{ _id: "US" }],
      countryState: [{ _id: "US" }],
      countryGameStates: [],
      politicalParties: [{ countryId: "US" }],
      electedOfficials: [{ countryId: "US" }],
      enactedLaws: [{ countryId: "US" }],
      states: [],
    });
    const r = await auditCountry(db, "US", "player-enabled");
    assert.equal(r.collections.countryGameStates.expected, false);
    assert.ok(!r.countryGaps.includes("countryGameStates"));
    assert.ok(!r.countryGaps.includes("federalBudget"));
  });
});

describe("auditEra", () => {
  it("rejects unknown preset", async () => {
    const r = await auditEra(createMockDb({}), "nope-default");
    assert.ok(r.error);
    assert.ok(r.knownPresets.includes("1953-default"));
  });

  it("1953-default roster includes RU and US", () => {
    assert.ok(PRESET_COUNTRIES["1953-default"].includes("RU"));
    assert.ok(PRESET_COUNTRIES["1953-default"].includes("US"));
  });

  it("the roster comes from the game artifact, not a hand-typed copy", () => {
    // AT is economy-only in the fixture; the game added AT to the 1953 roster
    // after the old hand-typed mirror was taken.
    assert.ok(PRESET_COUNTRIES["1953-default"].includes("AT"));
    assert.ok(!PRESET_COUNTRIES["1953-default"].includes("UKR"), "latent countries are not in the audited roster");
  });

  it("a missing reference artifact stops the audit instead of passing it", async () => {
    const missing = path.join(fixtureDir, "not-here.json");
    const previous = process.env.SEED_AUDIT_REFERENCE_PATH;
    process.env.SEED_AUDIT_REFERENCE_PATH = missing;
    resetSeedTruth();
    try {
      const r = await auditState(createMockDb({}), "BEL");
      assert.ok(r.error, "the audit must refuse rather than report nothing missing");
      assert.match(r.error, /not readable/);
      const era = await auditEra(createMockDb({}), "1953-default");
      assert.ok(era.error);
    } finally {
      process.env.SEED_AUDIT_REFERENCE_PATH = previous;
      resetSeedTruth();
    }
  });

  it("a country the game added to its forex list has its central bank checked", async () => {
    // The old mirror listed 13 forex-active countries and the game has 18, so
    // AT's central bank was never checked at all.
    const db = createMockDb({
      federalBudget: [{ _id: "AT", countryId: "AT" }],
      centralBanks: [],
      countryState: [{ _id: "AT" }],
      countryGameStates: [{ _id: "AT" }],
      politicalParties: [],
      electedOfficials: [],
      enactedLaws: [],
      states: [],
    });
    const r = await auditCountry(db, "AT", "econ-only");
    assert.ok(r.countryGaps.includes("centralBanks"), "AT is forex-active in the game, so its central bank is expected");
  });

  it("an unconfigured reference path stops the audit too", async () => {
    const previous = process.env.SEED_AUDIT_REFERENCE_PATH;
    delete process.env.SEED_AUDIT_REFERENCE_PATH;
    resetSeedTruth();
    try {
      const r = await auditState(createMockDb({}), "BEL");
      assert.ok(r.error);
      assert.match(r.error, /not configured/);
    } finally {
      process.env.SEED_AUDIT_REFERENCE_PATH = previous;
      resetSeedTruth();
    }
  });
});

describe("checkDuplicates", () => {
  it("flags identical field pairs within a group", async () => {
    const db = createMockDb({
      states: [
        { _id: "A", countryId: "X", population: 100, gdp: 5 },
        { _id: "B", countryId: "X", population: 100, gdp: 5 },
        { _id: "C", countryId: "X", population: 100, gdp: 9 },
        { _id: "D", countryId: "Y", population: 100, gdp: 5 },
      ],
    });
    const r = await checkDuplicates(db, "states", ["population", "gdp"], "countryId");
    assert.equal(r.duplicatePairCount, 1);
    assert.equal(r.duplicates[0].a, "A");
    assert.equal(r.duplicates[0].b, "B");
    assert.deepEqual(r.duplicates[0].sharedValues, { population: 100, gdp: 5 });
  });
});
