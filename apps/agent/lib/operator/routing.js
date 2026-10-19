"use strict";
// Keir 5.1 routing lock (2026-10-15 audit). Models that measurably failed a
// lane do not get it back by an env edit alone:
//   - Ollama Cloud routes, measured on deepseek-v4.1-flash on the coding lane,
//     Keir 4.x: 39 of 42 activations ended at the turn limit with no patch.
//     The direct DeepSeek API route (deepseek:deepseek-flash) is a different
//     deployment and is not covered by that measurement.
//   - gemini-3.8-flash (Antigravity), 2026-10-12 A/B: timed out on
//     conversations and investigations.
// A blocked spec falls back to the lane's default and leaves an alert. Setting
// KEIR_ALLOW_BLOCKED_ROUTES=1 lifts the lock for a deliberate trial; the trial
// should clear the lane's bar (BAR) before the lock entry is removed here.
//
// Pure: specs in, verdicts out.

const { assertAllowedBilling } = require(require("node:path").join(require("./cli-runtime").root, "provider-routes"));

const BAR = { completion: 0.9 };
const BLOCKED = [
  { match: /^ollama(?::|@|$)|deepseek-v4\.1-flash/i, lanes: ["coding", "investigator", "worker"], why: "deepseek-v4.1-flash ended 39 of 42 coding activations at the turn limit (Keir 4.x)" },
  { match: /^agy(?::|@|$)|gemini-3\.8-flash/i, lanes: ["coding", "investigator", "worker"], why: "gemini-3.8-flash timed out in the 2026-10-12 A/B" },
];

function check(lane, spec) {
  const s = String(spec || "");
  for (const part of s.split(",")) {
    const route = part.trim().split("@")[0], colon = route.indexOf(":");
    const runner = colon < 0 ? route : route.slice(0, colon);
    const model = colon < 0 ? "" : route.slice(colon + 1);
    try { assertAllowedBilling({ runner, model }); }
    catch (error) { return { ok: false, reason: error.message }; }
  }
  const hit = BLOCKED.find((b) => b.lanes.includes(lane) && s.split(",").some((part) => b.match.test(part.trim())));
  return hit ? { ok: false, reason: hit.why } : { ok: true };
}

// config: the operator config. Mutates the lane keys that fail the lock and
// returns what changed, for the caller to log and alert.
const LANES = { coding: "codingProvider", investigator: "investigatorProvider", worker: "workerProvider" };
const FALLBACK = { coding: "codex:gpt-6.1-sol@low", investigator: "codex:gpt-6.1-sol@low", worker: "claude:claude-opus-5-5@medium" };
function enforce(config, { allowBlocked = false } = {}) {
  if (allowBlocked) return [];
  const changed = [];
  for (const [lane, key] of Object.entries(LANES)) {
    const v = check(lane, config[key]);
    if (v.ok) continue;
    changed.push({ lane, from: config[key], to: FALLBACK[lane], reason: v.reason });
    config[key] = FALLBACK[lane];
  }
  return changed;
}

module.exports = { BAR, BLOCKED, check, enforce, FALLBACK };
