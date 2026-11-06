"use strict";
// Keir 8.4 kill switch. One switch that stops everything Keir does to the outside world:
// replies to players, GitHub and MCP writes, heals, promotions, new activations.
// It is a file read at runtime (no redeploy, no restart), so the owner, the guardian
// or a script can flip it even when the operator is hung.
//
//   engage:   node bin/keir-killswitch.js on "reason"      (or: echo reason > /var/lib/keir-operator/kill-switch)
//   release:  node bin/keir-killswitch.js off              (or: rm /var/lib/keir-operator/kill-switch)
//   env:      KEIR_KILL_SWITCH=1 also engages it (needs a restart; the file does not).
//
// File content: empty or free text = engaged (first line is the reason); JSON
// {"reason","by","until"} = engaged until the ISO time in `until`; "off"/"0" = released.
// Missing file = released. An unreadable file fails CLOSED (engaged).
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_FILE = "/var/lib/keir-operator/kill-switch";
const OFF = /^(?:off|0|false|no|disabled|clear|released)$/i;
const TRUE = /^(?:1|true|on|yes)$/i;

function parseKillSwitch(text, at = Date.now()) {
  if (text === null || text === undefined) return { engaged: false };
  const raw = String(text).trim();
  if (OFF.test(raw)) return { engaged: false };
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw);
      const until = j.until ? Date.parse(j.until) : null;
      if (until !== null && Number.isFinite(until) && until <= at) return { engaged: false, expired: true };
      return { engaged: true, reason: String(j.reason || "no reason recorded").slice(0, 300), by: j.by ? String(j.by).slice(0, 80) : null, since: j.since || null, until: until && Number.isFinite(until) ? new Date(until).toISOString() : null };
    } catch { return { engaged: true, reason: "kill switch file is not valid JSON; treated as engaged" }; }
  }
  return { engaged: true, reason: (raw.split("\n")[0] || "no reason recorded").slice(0, 300) };
}

function createKillSwitch({ file = process.env.KEIR_KILL_SWITCH_FILE || DEFAULT_FILE, env = process.env, now = () => Date.now(), readFile = (f) => fs.readFileSync(f, "utf8"), ttlMs = 1000 } = {}) {
  let cached = null, cachedAt = -Infinity;
  function state() {
    const at = now();
    if (cached && at - cachedAt < ttlMs) return cached;
    let result;
    if (TRUE.test(String(env.KEIR_KILL_SWITCH || ""))) result = { engaged: true, reason: "KEIR_KILL_SWITCH is set in the environment", source: "env" };
    else {
      try { result = { ...parseKillSwitch(readFile(file), at), source: "file" }; }
      catch (e) { result = e.code === "ENOENT" ? { engaged: false } : { engaged: true, reason: `kill switch file unreadable (${e.code || e.message}); treated as engaged`, source: "file" }; }
    }
    cached = result; cachedAt = at;
    return result;
  }
  function assertClear(what = "this action") {
    const s = state();
    if (!s.engaged) return;
    throw Object.assign(new Error(`The kill switch is engaged (${s.reason}). ${what} is refused. Nothing may be posted, merged, healed or promoted until the owner releases it. Finish waiting; do not retry.`), { code: "KILL_SWITCH" });
  }
  function engage({ reason = "engaged by the owner", by = "owner", until = null } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ reason: String(reason).slice(0, 300), by, since: new Date(now()).toISOString(), ...(until ? { until: new Date(until).toISOString() } : {}) }) + "\n", { mode: 0o600 });
    cached = null;
    return state();
  }
  function release() { try { fs.unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; } cached = null; return state(); }
  return { state, assertClear, engage, release, file };
}

module.exports = { createKillSwitch, parseKillSwitch, DEFAULT_FILE };
