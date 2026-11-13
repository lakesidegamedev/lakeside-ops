"use strict";
// The proven-model registry for the Discord desk (developers only).
// An entry counts as proven only if its recorded run passed the bar AND a live probe of that provider and model
// passed within the last 10 minutes. A selection is queued in the operator and applies to new tickets only.
// view(config) and select({ provider, model, effort, override, actor, config }) -> { content }
// config: { env, fetchImpl, probeImpl, now, cache, killSwitch... } (all optional, injectable for tests).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { call } = require("./actions");

const DEFAULT_REGISTRY = "/var/lib/keir-operator/model-registry.json";
const PROBE_TTL_MS = 10 * 60 * 1000;
const probeCache = new Map();

function loadRegistry(config) {
  const file = (config?.env || process.env).KEIR_MODEL_REGISTRY || DEFAULT_REGISTRY;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { entries: [], bar: null, error: "The model registry could not be read." }; }
  const entries = (Array.isArray(raw.entries) ? raw.entries : []).filter((e) => e && typeof e.provider === "string" && typeof e.model === "string");
  return { entries, bar: raw.bar || null };
}

const keyOf = (e) => `${e.provider}|${e.model}|${e.effort || ""}`;

// The default probe: one tiny one-line request through the existing provider runner.
async function defaultProbe(entry) {
  const { invokeCli } = require("../operator/cli-runner");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-probe-"));
  try {
    const r = await invokeCli({ runner: entry.provider, model: entry.model, effort: entry.effort || "low", brief: "Reply with the single word ok.", prompt: "ok?",
      tools: [], maxTurns: 1, timeoutMs: 60000, stateDir, job: { id: "desk-probe" }, lane: "probe", signal: AbortSignal.timeout(70000) });
    return !r.is_error && r.subtype === "success" && String(r.result || "").trim().length > 0;
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
}

// Returns true/false. Cached with its time; at most one probe per entry per 10 minutes, failures included.
async function probe(entry, config) {
  const now = (config?.now || Date.now)(), cache = config?.cache || probeCache, k = keyOf(entry), hit = cache.get(k);
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.ok;
  let ok = false;
  try { ok = (await (config?.probeImpl || defaultProbe)(entry)) === true; } catch { ok = false; }
  cache.set(k, { ok, at: now });
  return ok;
}

// Only an entry that passed the bar is probed; the rest are not proven without spending a probe.
async function isProven(entry, config) { return entry.passedBar === true && await probe(entry, config); }

const label = (e) => `${e.provider}:${e.model}${e.effort ? `@${e.effort}` : ""}`;

async function view(config) {
  const env = config?.env || process.env, reg = loadRegistry(config);
  if (reg.error) return { content: reg.error };
  const lines = [`Current: ${env.KEIR_WORKER_PROVIDER || "claude"} (conversations: ${env.KEIR_QUICK_PROVIDER || "claude"}). Fallback order: ${env.KEIR_FALLBACK_PROVIDER || "none"}.`];
  let proven = 0;
  for (const e of reg.entries) {
    const ok = await isProven(e, config); if (ok) proven++;
    lines.push(`- ${label(e)}: ${e.date || "no date"}, ${e.cases ?? "?"} cases, ${e.right ?? "?"} right, ${e.falseClaims ?? "?"} false claims, ${ok ? "proven" : "not proven"}`);
  }
  if (reg.bar) lines.push(`Bar: ${reg.bar}.`);
  if (!proven) lines.push("No model is proven yet, so none can be switched to without an override.");
  return { content: lines.join("\n") };
}

async function select({ provider, model, effort, override, actor, config } = {}) {
  const role = String(actor?.role || "");
  if (role !== "dev" && role !== "owner") return { content: "Only developers can change the model." };
  const reg = loadRegistry(config);
  if (reg.error) return { content: reg.error };
  const matches = reg.entries.filter((e) => e.provider === provider && e.model === model && (!effort || e.effort === effort));
  if (!matches.length) return { content: "That model and setting is not in the registry, so it cannot be selected." };
  let entry = null;
  for (const e of matches) if (await isProven(e, config)) { entry = e; break; }
  const proven = !!entry;
  if (!proven) {
    if (override !== true) return { content: `${label(matches[0])} is not proven (it has not passed the bar, or its live check failed just now). A developer can pass override to use it anyway; that is logged and posted to staff.` };
    entry = matches[0];
  }
  try {
    const out = await call(config, { action: "route", provider: entry.provider, model: entry.model, effort: entry.effort, override: !proven, actor: { id: actor?.id, role } });
    return { content: out.ok ? `${out.message}${proven ? "" : " This was an override of a not-proven model and has been logged and posted to staff."}` : (out.message || "That did not go through.") };
  } catch { return { content: "Keir is off right now, so the model cannot be changed. Switch Keir on first." }; }
}

module.exports = { view, select, loadRegistry, isProven, probe, PROBE_TTL_MS };
