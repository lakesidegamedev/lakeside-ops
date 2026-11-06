"use strict";
// Keir 8.4 hard caps. Pure counting over timestamps kept on the ledger (d.trust), so a cap
// survives restarts. Limits are read at runtime (file beats env beats default).
//
//   /var/lib/keir-operator/limits.json  {"deploysPerDay":3,"healsPerDay":5}
//   env KEIR_LIMIT_DEPLOYS_DAY, KEIR_LIMIT_HEALS_DAY
//
// The window is a rolling 24 hours, not a calendar day, so a cap cannot be spent twice around midnight.
// Deploys count promotions to main (production). Heals count production heals. Both are idempotent per
// key: re-reading the same promotion or executing the same approved heal again never double counts.
const fs = require("node:fs");

const DAY = 86400000;
const DEFAULT_FILE = "/var/lib/keir-operator/limits.json";
const DEFAULTS = Object.freeze({ deploysPerDay: 3, healsPerDay: 5 });
const ENV = { deploysPerDay: "KEIR_LIMIT_DEPLOYS_DAY", healsPerDay: "KEIR_LIMIT_HEALS_DAY" };

const valid = (n) => Number.isInteger(n) && n >= 0 && n <= 1000;
function resolveLimits({ env = {}, fileText = null } = {}) {
  let file = {};
  if (fileText) { try { const j = JSON.parse(fileText); if (j && typeof j === "object") file = j; } catch {} }
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const fromFile = Number(file[key]), fromEnv = env[ENV[key]] === undefined || env[ENV[key]] === "" ? NaN : Number(env[ENV[key]]);
    out[key] = valid(fromFile) ? fromFile : valid(fromEnv) ? fromEnv : DEFAULTS[key];
  }
  return out;
}
function createLimits({ file = process.env.KEIR_LIMITS_FILE || DEFAULT_FILE, env = process.env, now = () => Date.now(), readFile = (f) => fs.readFileSync(f, "utf8"), ttlMs = 5000 } = {}) {
  let cached = null, at = -Infinity;
  return { get() {
    if (cached && now() - at < ttlMs) return cached;
    let text = null; try { text = readFile(file); } catch {}
    cached = resolveLimits({ env, fileText: text }); at = now();
    return cached;
  } };
}

function state(d) {
  const t = (d.trust ||= {});
  t.counters ||= {};
  return t;
}
const within = (list, now, windowMs = DAY) => list.filter((x) => now - (typeof x === "number" ? x : x.at) < windowMs);

const COUNTER_LIMIT = { deploy: "deploysPerDay", heal: "healsPerDay" };
function countCounter(d, kind, now) { return within(state(d).counters[kind] || [], now).length; }
function checkCounter(d, kind, key, now, limits) {
  const entries = within(state(d).counters[kind] || [], now);
  const limit = limits[COUNTER_LIMIT[kind]];
  if (entries.some((e) => e.key === key)) return { ok: true, count: entries.length, limit, repeat: true };
  return entries.length < limit ? { ok: true, count: entries.length, limit } : { ok: false, count: entries.length, limit, reason: `Refused: ${entries.length} production ${kind === "deploy" ? "promotions" : "heals"} already happened in the last 24 hours (the limit is ${limit}). It waits for the owner; finish waiting and tell them.` };
}
function recordCounter(d, kind, key, at) {
  const t = state(d), entries = within(t.counters[kind] || [], at, 2 * DAY);
  if (!entries.some((e) => e.key === key)) entries.push({ key, at });
  t.counters[kind] = entries.slice(-100);
}

module.exports = { DEFAULTS, DAY, resolveLimits, createLimits, countCounter, checkCounter, recordCounter };
