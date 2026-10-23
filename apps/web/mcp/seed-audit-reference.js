"use strict";

// The seed audit's reference data, as the game defines it.
//
// Until 2026-10-21 the audit kept this list as a hand-typed copy of the
// game's constants, marked "mirrored 2026-07-22, refresh manually if the
// game list changes". It had drifted, in both directions:
//
//   - the game dropped two corporation types, so the audit expected a company
//     that no longer exists and reported EVERY state as incomplete;
//   - the game added six forex-active countries, so the audit never checked
//     their central banks at all.
//
// A mirror of a moving list is worse than no check, because a check that
// cries wolf gets ignored. The lists now come from the game repo itself
// (AHDGame scripts/exportSeedAuditReference.ts), and this module turns that
// artifact into the shape the audit works with.
//
// If the artifact is missing or unreadable the audit refuses to run rather
// than falling back to a stale list.

const fs = require("fs");

/**
 * Where the artifact lives.
 *
 * The path is configuration, not a constant: the repo's own semgrep rules
 * forbid a hardcoded machine path, and the artifact is written by the daily
 * reference refresh.
 */
function referencePath() {
  return process.env.SEED_AUDIT_REFERENCE_PATH || "";
}

/**
 * Read the artifact.
 * @returns {{reference: object|null, error: string|null}}
 */
function loadReference(path = referencePath()) {
  if (!path) {
    return {
      reference: null,
      error:
        "the seed audit reference path is not configured: set SEED_AUDIT_REFERENCE_PATH " +
        "to the artifact the game repo generates (scripts/exportSeedAuditReference.ts --out <path>)",
    };
  }
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e) {
    return {
      reference: null,
      error:
        `the seed audit reference is not readable at ${path} (${e.message}). ` +
        "Regenerate it with: npx tsx scripts/exportSeedAuditReference.ts --out " + path,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { reference: null, error: `the seed audit reference at ${path} could not be parsed: ${e.message}` };
  }
  const need = ["corporationTypes", "forexActiveCountries", "presets"];
  for (const key of need) {
    if (!parsed || !parsed[key]) return { reference: null, error: `the seed audit reference has no "${key}"` };
  }
  return { reference: parsed, error: null };
}

/**
 * Turn the artifact into what the audit asks for.
 *
 * The game says which countries are player, economy-only, self-governing and
 * latent in each era. The audit asks two questions about a country: is it in
 * this preset, and does it owe the player-facing collections?
 */
function derive(reference) {
  const presetCountries = {};
  const presetProfiles = {};
  for (const [preset, roster] of Object.entries(reference.presets || {})) {
    const countries = [...(roster.player || []), ...(roster.econ || []), ...(roster.npp || [])];
    presetCountries[preset] = countries;
    const profiles = {};
    for (const country of countries) profiles[country] = "econ-only";
    for (const country of roster.player || []) profiles[country] = "player-enabled";
    presetProfiles[preset] = profiles;
  }
  return {
    corporationTypes: [...(reference.corporationTypes || [])],
    forexActiveCountries: new Set(reference.forexActiveCountries || []),
    presetCountries,
    presetProfiles,
    source: reference.source || null,
    generatedAt: reference.generatedAt || null,
  };
}

/**
 * The seed truth, loaded once. `error` is set when the artifact is missing or
 * unreadable, in which case every list below is empty and the audit refuses
 * to answer rather than checking against a stale mirror.
 */
const cache = new Map();
function seedTruth(path = referencePath()) {
  if (cache.has(path)) return cache.get(path);
  const { reference, error } = loadReference(path);
  const truth = error
    ? { error, corporationTypes: [], forexActiveCountries: new Set(), presetCountries: {}, presetProfiles: {}, source: null, generatedAt: null }
    : derive(reference);
  cache.set(path, truth);
  return truth;
}

/** Forget the cached artifact. Used by tests that point at a new file. */
function resetSeedTruth() {
  cache.clear();
}

module.exports = { referencePath, loadReference, derive, seedTruth, resetSeedTruth };
