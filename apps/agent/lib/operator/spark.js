"use strict";
const { spawn } = require("node:child_process");
const { makeSpark: adapter, parseObject, MODEL } = require("./cli-runtime")("spark");
const { invokeCli } = require("./cli-runner");
function makeSpark(options = {}) {
  if (options.spawnImpl && options.spawnImpl !== spawn) return adapter(options);
  return async (brief, prompt) => {
    try {
      const result = await invokeCli({ version: 1, kind: "text", runner: "codex", model: options.model || MODEL, effort: options.effort || "low", brief, prompt,
        stateDir: options.stateDir || process.env.KEIR_OPERATOR_STATE_DIR || "/var/lib/keir-operator",
        maxTurns: 1, timeoutMs: options.timeoutMs || 30000, url: "http://127.0.0.1:1", tools: [],
        codexBin: options.codexBin, job: { id: "text-helper" }, lane: "helper", signal: new AbortController().signal });
      return result.is_error ? "" : result.result;
    } catch { return ""; }
  };
}
module.exports = { makeSpark, parseObject, MODEL };
