// Seed Audit MCP — read-only completeness + duplicate-value checks against the
// game world's reference seed data. Catches gaps like missing states docs for
// newly-added regions (incident 2026-07-22: BEL/BLT) and copy-paste twin rows.
// Streamable HTTP + scoped bearer-token auth.
//   node mcp/seed-audit-server.js   (default :9739)
require("dotenv").config({ quiet: true, path: require("path").join(__dirname, "..", ".env") });
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { createServer } = require("../packages/mcp-server");
const store = require("../knowledge-store");
const tokens = require("../agent-tokens");

const PORT = parseInt(process.env.SEED_AUDIT_MCP_PORT || "9739", 10);

// ─── The game's seed truth, generated from the game repo ─────────────────────
// Source: AHDGame/scripts/exportSeedAuditReference.ts, which reads
// CORPORATION_TYPES, FOREX_ACTIVE_COUNTRIES and the era roster from the game
// itself. This used to be a hand-typed copy "mirrored 2026-07-22", and it had
// drifted: the game dropped two corporation types (so every state read as
// incomplete) and gained six forex-active countries (so their central banks
// were never checked). A check that cries wolf gets ignored, so the lists
// come from the game now, and a missing artifact stops the audit instead of
// silently falling back to a stale mirror.
const { seedTruth, referencePath } = require("./seed-audit-reference");

// Reference collections the audit checks. This is a SELECTION from the game's
// seed manifest, not a mirror of it: the manifest holds every collection the
// game seeds, and the audit only answers "is this world's reference data
// complete?" for the ones below.
const REFERENCE_COLLECTIONS = [
  { name: "states", category: "reference", seededBy: "runCoreSeed" },
  { name: "macroMetrics", category: "reference", seededBy: "seedRegionMetrics" },
  { name: "politicalMetrics", category: "reference", seededBy: "seedPoliticalMetrics" },
  { name: "stateBaselines", category: "reference", seededBy: "runCoreSeed" },
  { name: "stateDemographics", category: "reference", seededBy: "runCoreSeed" },
  { name: "stateResourceCapacity", category: "reference", seededBy: "seedStateResourceCapacity" },
  // Not a real collection - seedStateSectorSpecializations writes
  // states.sectorSpecializations.{primary,secondary} as an embedded field.
  // seedManifest.ts's entry name is misleading; audited via hasSectorSpecialization()
  // against the states doc, not a collection query. Confirmed 2026-07-22 after this
  // exact confusion produced a false "154/154 states missing" audit finding.
  { name: "states.sectorSpecializations (embedded field)", category: "reference", seededBy: "seedStateSectorSpecializations" },
  { name: "unownedSectors", category: "reference", seededBy: "seedUnownedSectors" },
  { name: "federalBudget", category: "reference", seededBy: "seedBudgets" },
  { name: "centralBanks", category: "reference", seededBy: "seedForex" },
  { name: "politicalParties", category: "reference", seededBy: "seedParties" },
  // runtime but bootstrap-seeded - audited for player-enabled countries:
  { name: "countryState", category: "runtime", seededBy: "seedAllCountryStates" },
  { name: "countryGameStates", category: "runtime", seededBy: "seedCountryGameStates" },
  { name: "electedOfficials", category: "runtime", notes: "bootstrap-seeded then election-driven" },
  { name: "enactedLaws", category: "runtime", notes: "bootstrap-seeded default laws" },
];

const PER_STATE_BY_ID = [
  "macroMetrics",
  "politicalMetrics",
  "stateBaselines",
  "stateDemographics",
  "stateBudgets",
];

// sectorSpecializations is NOT a separate collection — seedStateSectorSpecializations.ts
// writes it as an embedded field on the states document itself
// ($set: "sectorSpecializations.primary"/".secondary"). Checking a
// "stateSectorSpecializations" collection (as the seedManifest.ts entry name implies)
// always returns empty and false-flags every state. Verified against real data
// 2026-07-22 after this exact bug produced a false "154/154 states missing" finding.
function hasSectorSpecialization(state) {
  return !!(state.sectorSpecializations && state.sectorSpecializations.primary);
}

const databaseParam = z.enum(["main", "sandbox"]).optional().default("main")
  .describe('target DB: "main" (default) or "sandbox" (<dbname>-sandbox on same cluster)');

function baseDbName(uri) {
  try {
    const u = new URL(String(uri || "").replace(/^mongodb(\+srv)?:\/\//, "http://"));
    const name = decodeURIComponent((u.pathname || "").replace(/^\//, "").split("?")[0] || "");
    return name || "a-house-divided";
  } catch {
    return "a-house-divided";
  }
}

function resolveGameDbName(which, uri) {
  const base = baseDbName(uri);
  if (which === "sandbox") {
    return base.endsWith("-sandbox") ? base : `${base}-sandbox`;
  }
  return base.endsWith("-sandbox") ? base.slice(0, -"-sandbox".length) : base;
}

async function getGameDb(opsDb, which) {
  const name = resolveGameDbName(which || "main", process.env.MONGODB_URI);
  return opsDb.client.db(name);
}

async function existsById(db, collection, id) {
  const doc = await db.collection(collection).findOne({ _id: id }, { projection: { _id: 1 } });
  return !!doc;
}

/** Build one state's result from prefetched id-sets / sector maps. */
function scoreState(state, idSets, resourceIds, sectorsByState, truth) {
  const stateId = state._id;
  const collections = { states: { present: true } };
  const gaps = [];

  for (const col of PER_STATE_BY_ID) {
    const present = idSets[col].has(stateId);
    collections[col] = { present, key: "_id" };
    if (!present) gaps.push(col);
  }

  const resourcePresent = resourceIds.has(stateId);
  collections.stateResourceCapacity = { present: resourcePresent, key: "stateId" };
  if (!resourcePresent) gaps.push("stateResourceCapacity");

  const sectorSpecPresent = hasSectorSpecialization(state);
  collections.sectorSpecializations = { present: sectorSpecPresent, key: "embedded field on states doc" };
  if (!sectorSpecPresent) gaps.push("sectorSpecializations");

  const presentTypes = sectorsByState.get(stateId) || new Set();
  const missingSectorTypes = truth.corporationTypes.filter((t) => !presentTypes.has(t));
  collections.unownedSectors = {
    present: missingSectorTypes.length === 0,
    key: "{stateId, sectorType}",
    expected: truth.corporationTypes.length,
    found: presentTypes.size,
    missingSectorTypes,
  };
  if (missingSectorTypes.length) gaps.push("unownedSectors");

  return {
    stateId,
    countryId: state.countryId || null,
    name: state.name || null,
    status: gaps.length ? "GAPS" : "OK",
    complete: gaps.length === 0,
    gaps,
    collections,
  };
}

/** Prefetch per-state coverage for a list of state ids (few queries, not N×collections). */
async function prefetchStateCoverage(db, stateIds) {
  const idSets = {};
  for (const col of PER_STATE_BY_ID) {
    const rows = await db.collection(col)
      .find({ _id: { $in: stateIds } }, { projection: { _id: 1 } }).toArray();
    idSets[col] = new Set(rows.map((r) => r._id));
  }
  const resourceRows = await db.collection("stateResourceCapacity")
    .find({ stateId: { $in: stateIds } }, { projection: { stateId: 1 } }).toArray();
  const resourceIds = new Set(resourceRows.map((r) => r.stateId));
  const sectorRows = await db.collection("unownedSectors")
    .find({ stateId: { $in: stateIds } }, { projection: { stateId: 1, sectorType: 1 } }).toArray();
  const sectorsByState = new Map();
  for (const r of sectorRows) {
    if (!sectorsByState.has(r.stateId)) sectorsByState.set(r.stateId, new Set());
    sectorsByState.get(r.stateId).add(r.sectorType);
  }
  return { idSets, resourceIds, sectorsByState };
}

/** Per-state reference completeness. Read-only. */
async function auditState(db, stateId, countryId) {
  const truth = seedTruth();
  if (truth.error) return { error: truth.error, referencePath: referencePath() };
  const stateFilter = countryId ? { _id: stateId, countryId } : { _id: stateId };
  const state = await db.collection("states").findOne(stateFilter, {
    projection: { _id: 1, countryId: 1, name: 1, sectorSpecializations: 1 },
  });
  if (!state) {
    return {
      stateId,
      countryId: countryId || null,
      status: "NOT_FOUND",
      complete: false,
      collections: { states: { present: false } },
    };
  }
  const pref = await prefetchStateCoverage(db, [stateId]);
  return scoreState(state, pref.idSets, pref.resourceIds, pref.sectorsByState, truth);
}

/** Per-country reference completeness for a given profile. Read-only. */
async function auditCountry(db, countryId, profile) {
  const truth = seedTruth();
  if (truth.error) return { error: truth.error, referencePath: referencePath() };
  const countryGaps = [];
  const collections = {};

  // federalBudget: US uses _id "federal"; others use _id === countryId. Prefer countryId field.
  const fb = await db.collection("federalBudget").findOne(
    { $or: [{ countryId }, { _id: countryId }, ...(countryId === "US" ? [{ _id: "federal" }] : [])] },
    { projection: { _id: 1, countryId: 1 } }
  );
  collections.federalBudget = { present: !!fb, key: "countryId|_id" };
  if (!fb) countryGaps.push("federalBudget");

  if (truth.forexActiveCountries.has(countryId)) {
    // Not always keyed by _id === countryId — a shared currency-union bank
    // (e.g. Germany's is _id: "ECB") is keyed by the countryId field instead.
    // Verified against real data 2026-07-22: every FOREX_ACTIVE_COUNTRIES entry
    // matches _id === countryId except DE (ECB).
    const cb = await db.collection("centralBanks").findOne(
      { $or: [{ _id: countryId }, { countryId }] },
      { projection: { _id: 1 } }
    );
    collections.centralBanks = { present: !!cb, key: "_id|countryId", expected: true };
    if (!cb) countryGaps.push("centralBanks");
  } else {
    collections.centralBanks = { present: null, key: "_id", expected: false, note: "not forex-active" };
  }

  const cs = await existsById(db, "countryState", countryId);
  collections.countryState = { present: cs, key: "_id" };
  if (!cs) countryGaps.push("countryState");

  // US has no countryGameStates row (seedCountryGameStates omits it — global GameState).
  if (countryId === "US") {
    collections.countryGameStates = {
      present: null, key: "_id", expected: false, note: "US uses global gameState",
    };
  } else {
    const cgs = await existsById(db, "countryGameStates", countryId);
    collections.countryGameStates = { present: cgs, key: "_id" };
    if (!cgs) countryGaps.push("countryGameStates");
  }

  if (profile === "player-enabled") {
    const partyCount = await db.collection("politicalParties").countDocuments({ countryId });
    collections.politicalParties = { present: partyCount >= 1, count: partyCount };
    if (partyCount < 1) countryGaps.push("politicalParties");

    const gameState = await db.collection("gameState").findOne(
      { _id: "current" },
      { projection: { preIteration: 1 } }
    );
    const foundingActive = gameState?.preIteration?.active === true;
    const officialCount = await db.collection("electedOfficials").countDocuments({ countryId });
    collections.electedOfficials = {
      present: officialCount >= 1,
      count: officialCount,
      required: !foundingActive,
      ...(foundingActive ? { note: "expected vacant during pre-iteration founding" } : {}),
    };
    if (officialCount < 1 && !foundingActive) countryGaps.push("electedOfficials");

    const lawCount = await db.collection("enactedLaws").countDocuments({ countryId });
    collections.enactedLaws = { present: lawCount >= 1, count: lawCount };
    if (lawCount < 1) countryGaps.push("enactedLaws");
  } else {
    // econ-only: do NOT flag absence of parties / officials / elections.
    const partyCount = await db.collection("politicalParties").countDocuments({ countryId });
    const officialCount = await db.collection("electedOfficials").countDocuments({ countryId });
    const lawCount = await db.collection("enactedLaws").countDocuments({ countryId });
    collections.politicalParties = { present: partyCount >= 1, count: partyCount, required: false };
    collections.electedOfficials = { present: officialCount >= 1, count: officialCount, required: false };
    collections.enactedLaws = { present: lawCount >= 1, count: lawCount, required: false };
  }

  const states = await db.collection("states")
    .find({ countryId, _id: { $not: /^NATIONAL_/ } }, { projection: { _id: 1, countryId: 1, name: 1, sectorSpecializations: 1 } })
    .toArray();
  const pref = states.length
    ? await prefetchStateCoverage(db, states.map((s) => s._id))
    : { idSets: Object.fromEntries(PER_STATE_BY_ID.map((c) => [c, new Set()])), resourceIds: new Set(), sectorsByState: new Map() };
  const stateResults = [];
  const incompleteStates = [];
  for (const s of states) {
    const r = scoreState(s, pref.idSets, pref.resourceIds, pref.sectorsByState, truth);
    stateResults.push({
      stateId: r.stateId, complete: r.complete, status: r.status, gaps: r.gaps || [],
    });
    if (!r.complete) incompleteStates.push({ stateId: r.stateId, gaps: r.gaps || [], status: r.status });
  }

  const statesComplete = states.length === 0
    ? false
    : incompleteStates.length === 0;
  if (states.length === 0) countryGaps.push("states (none found for countryId)");

  const complete = countryGaps.length === 0 && statesComplete;
  return {
    countryId,
    profile,
    complete,
    countryGaps,
    collections,
    states: {
      total: states.length,
      complete: stateResults.filter((s) => s.complete).length,
      summary: `${stateResults.filter((s) => s.complete).length}/${states.length} states complete`,
      incomplete: incompleteStates,
    },
  };
}

/** Era/preset rollup over PRESET_COUNTRIES. Read-only. */
async function auditEra(db, preset, profiles) {
  const truth = seedTruth();
  if (truth.error) return { error: truth.error, referencePath: referencePath() };
  const roster = truth.presetCountries[preset];
  if (!roster) {
    return {
      error: `unknown preset '${preset}'`,
      knownPresets: Object.keys(truth.presetCountries),
    };
  }
  const defaults = truth.presetProfiles[preset] || {};
  const countries = [];
  for (const countryId of roster) {
    const profile = (profiles && profiles[countryId])
      || defaults[countryId]
      || "player-enabled";
    const r = await auditCountry(db, countryId, profile);
    countries.push({
      countryId,
      profile,
      complete: r.complete,
      countryGaps: r.countryGaps,
      statesSummary: r.states.summary,
      incompleteStates: r.states.incomplete,
    });
  }
  const completeCountries = countries.filter((c) => c.complete).map((c) => c.countryId);
  const incompleteCountries = countries.filter((c) => !c.complete);
  return {
    preset,
    complete: incompleteCountries.length === 0 && roster.length > 0,
    rosterSize: roster.length,
    completeCountries,
    incompleteCountries: incompleteCountries.map((c) => ({
      countryId: c.countryId,
      profile: c.profile,
      countryGaps: c.countryGaps,
      statesSummary: c.statesSummary,
      incompleteStateCount: c.incompleteStates.length,
      incompleteStates: c.incompleteStates.slice(0, 25),
    })),
  };
}

/** Pairwise identical-field scan within groupBy buckets. Read-only. */
async function checkDuplicates(db, collection, fields, groupBy) {
  const groupField = groupBy || "countryId";
  const projection = { _id: 1, [groupField]: 1 };
  for (const f of fields) projection[f] = 1;

  const docs = await db.collection(collection).find({}, { projection }).toArray();
  const groups = new Map();
  for (const d of docs) {
    const g = d[groupField] == null ? "__null__" : String(d[groupField]);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(d);
  }

  const duplicates = [];
  for (const [group, members] of groups) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i], b = members[j];
        const shared = {};
        let allMatch = true;
        for (const f of fields) {
          if (a[f] !== b[f]) { allMatch = false; break; }
          shared[f] = a[f];
        }
        if (allMatch) {
          duplicates.push({
            groupBy: groupField,
            group,
            a: String(a._id),
            b: String(b._id),
            sharedValues: shared,
          });
        }
      }
    }
  }

  return {
    collection,
    fields,
    groupBy: groupField,
    documentsScanned: docs.length,
    groupCount: groups.size,
    duplicatePairCount: duplicates.length,
    duplicates: duplicates.slice(0, 200),
    truncated: duplicates.length > 200,
  };
}

async function main() {
  const opsDb = await store.getDb(process.env.MONGODB_URI);
  await tokens.ensureIndexes(opsDb);
  function buildServer() {
    const server = new McpServer({ name: "ops-seed-audit", version: "1.0.0" });

    server.tool("audit_state",
      "Check that a single state/region has every expected per-state reference doc (states, macroMetrics, politicalMetrics, stateBaselines, stateDemographics, stateBudgets, stateResourceCapacity, embedded sector specializations, and unowned sectors by type). Returns NOT_FOUND immediately if the states doc is missing. Read-only.",
      {
        stateId: z.string().describe("state/region code, e.g. BEL, UKR, CA"),
        countryId: z.string().optional().describe("optional countryId disambiguator"),
        database: databaseParam,
      },
      async ({ stateId, countryId, database }) => {
        const db = await getGameDb(opsDb, database);
        return auditResult(await auditState(db, stateId, countryId));
      });

    server.tool("audit_country",
      "Check per-country reference docs for a profile (player-enabled vs econ-only), then roll up audit_state for every state in that country. Read-only.",
      {
        countryId: z.string().describe("country code, e.g. RU, US, UK"),
        profile: z.enum(["player-enabled", "econ-only"])
          .describe("player-enabled expects parties + electedOfficials + enactedLaws; econ-only does not. This is the era roster's own distinction: a country the game lets a player sit in is player-enabled."),
        database: databaseParam,
      },
      async ({ countryId, profile, database }) => {
        const db = await getGameDb(opsDb, database);
        return auditResult(await auditCountry(db, countryId, profile));
      });

    server.tool("audit_era",
      "Audit every country in a preset's expected roster, taken from the game's era roster (the same one the game seeds from). A country the game calls player-enabled expects parties, elected officials and enacted laws; every other profile does not. Override with profiles map. Read-only.",
      {
        preset: z.string().describe('preset id, e.g. "1953-default"'),
        profiles: z.record(z.enum(["player-enabled", "econ-only"])).optional()
          .describe("optional per-country profile overrides"),
        database: databaseParam,
      },
      async ({ preset, profiles, database }) => {
        const db = await getGameDb(opsDb, database);
        return auditResult(await auditEra(db, preset, profiles));
      });

    server.tool("check_duplicates",
      "Flag pairs of docs in one collection whose values are IDENTICAL across every given numeric/scalar field, grouped by groupBy (default countryId). Plain pairwise — no relationship graph. Read-only.",
      {
        collection: z.string().describe('Mongo collection name, e.g. "states"'),
        fields: z.array(z.string()).min(1)
          .describe('fields that must all match, e.g. ["population","gdp"]'),
        groupBy: z.string().optional().default("countryId")
          .describe("sibling-grouping field (default countryId)"),
        database: databaseParam,
      },
      async ({ collection, fields, groupBy, database }) => {
        const db = await getGameDb(opsDb, database);
        return jsonResult(await checkDuplicates(db, collection, fields, groupBy));
      });

    return server;
  }

  createServer({
    name: "seed-audit-mcp", port: PORT, bind: process.env.MCP_BIND || "127.0.0.1", jsonLimit: "256kb",
    authorize: req => tokens.validate(opsDb, req.headers.authorization), buildServer,
    health: () => ({ port: PORT, referenceCollections: REFERENCE_COLLECTIONS.map(c => c.name) }),
  });
}

function jsonResult(o) { return { content: [{ type: "text", text: JSON.stringify(o, null, 2) }] }; }
// A missing reference artifact is a failure to answer, not an audit finding:
// it must not read as "nothing is missing".
function auditResult(result) {
  if (result && result.error && result.referencePath) return errorResult(result.error);
  return jsonResult(result);
}
function rpcErr(code, message) { return { jsonrpc: "2.0", error: { code, message }, id: null }; }

if (require.main === module) {
  main().catch((e) => { console.error("[seed-audit-mcp] fatal:", e); process.exit(1); });
}

module.exports = {
  REFERENCE_COLLECTIONS,
  resolveGameDbName,
  baseDbName,
  auditState,
  auditCountry,
  auditEra,
  checkDuplicates,
};
