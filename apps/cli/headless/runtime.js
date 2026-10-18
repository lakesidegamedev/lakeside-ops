"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const providers = require("./providers");
const { invokeClaude } = require("./claude");

const RUNNERS = ["claude", "codex", "muse", "agy", "cursor", "ollama", "deepseek", "opencode"];
function validate(request) {
  if (!request || request.version !== 1 || !RUNNERS.includes(request.runner)) throw new Error("Unsupported CLI activation route or protocol");
  for (const key of ["model", "brief", "prompt", "stateDir"]) if (typeof request[key] !== "string" || !request[key]) throw new Error(`CLI activation needs ${key}`);
  if (!path.isAbsolute(request.stateDir)) throw new Error("CLI stateDir must be absolute");
  if (request.kind === "text" && (request.runner !== "codex" || request.model !== "gpt-6-luna")) throw new Error("Text helpers require the explicit Codex Luna route");
  if (!Number.isInteger(request.maxTurns) || request.maxTurns < 1 || request.maxTurns > 1000) throw new Error("Invalid CLI turn limit");
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 3600000) throw new Error("Invalid CLI timeout");
  const endpoint = new URL(request.url);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname)) throw new Error("Activation tools must use a loopback HTTP endpoint");
  if (request.completionUrl && request.completionUrl !== request.url + "/completion") throw new Error("Completion receipt must belong to the granted tool session");
  if (!Array.isArray(request.tools) || request.tools.some(t => typeof t.name !== "string")) throw new Error("Invalid CLI tool grant");
  if (request.viaRust && ["ollama", "deepseek", "opencode"].includes(request.runner)) throw new Error("Selected route has no Rust provider adapter");
  if (request.toolsMode && !["broker", "native"].includes(request.toolsMode)) throw new Error("Invalid tool mode");
  if (request.toolsMode === "native") {
    if (!request.worktree || !request.repo || !fs.existsSync(path.join(request.worktree, ".git"))) throw new Error("Native tools need an explicit registered worktree");
    const registered = require("node:child_process").execFileSync("git", ["-C", request.repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    if (!registered.split("\n").includes(`worktree ${fs.realpathSync(request.worktree)}`)) throw new Error("Native tools worktree is not registered");
    if (request.viaRust) throw new Error("Native coding tools cannot also select broker-only Rust execution");
  }
  return request;
}

// The operator owns task retries. Every CLI call is one recorded attempt;
// an interrupted attempt is never automatically replayed here.
async function executeActivation(request, { spawnImpl = spawn, signal = new AbortController().signal, fetchImpl, openCodeImpl = require("./opencode").invokeOpenCode, ollamaCredential = providers.ollamaKey, deepseekCredential = providers.deepseekKey } = {}) {
  if (request?.provider) {
    const route = require("../provider-routes").providerRoute(request.provider, request.model);
    if (request.runner && request.runner !== route.runner) throw new Error("Provider and runner disagree");
    request = { ...request, billing: route.billing, runner: route.runner, model: ["ollama", "deepseek"].includes(route.runner) ? route.model.slice(route.runner.length + 1) : route.model };
  }
  validate(request);
  require("../provider-routes").assertAllowedBilling(request);
  if (signal.aborted) throw new Error("activation aborted");
  const id = request.attemptId || crypto.randomUUID(), startedAt = Date.now();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid CLI attempt id");
  const dir = path.join(request.stateDir, "cli-attempts"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${id}.json`);
  const record = { version: 1, id, job: request.job?.id, lane: request.lane, runner: request.runner, model: request.model, provider: request.provider || request.runner, billing: request.billing || null, startedAt, state: "running" };
  const save = fields => { Object.assign(record, fields); fs.writeFileSync(`${file}.tmp`, JSON.stringify(record) + "\n", { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file); };
  save({});
  const common = { ...request, spawnImpl, signal, ...(fetchImpl ? { fetchImpl } : {}) };
  try {
    const result = request.toolsMode === "native" && !["opencode", "ollama", "deepseek"].includes(request.runner)
      ? await require("./native-tools").invokeNativeTools(common)
      : request.kind === "text" ? await (async () => {
      const text = await require("./spark").makeSpark({ spawnImpl, codexBin: request.codexBin, timeoutMs: request.timeoutMs })(request.brief, request.prompt);
      return { subtype: text ? "success" : "error", is_error: !text, result: text, usage: {} };
    })() : request.viaRust ? await providers.invokeRust({ ...common, bin: request.rustBin })
      : request.runner === "claude" ? await invokeClaude(common)
      : request.runner === "codex" ? await providers.invokeCodex(common)
      : request.runner === "muse" ? await providers.invokeMuse(common)
      : request.runner === "agy" ? await providers.invokeAgy(common)
      : request.runner === "cursor" ? await providers.invokeCursor(common)
      : request.runner === "ollama" ? await openCodeImpl({ ...common,
        model: `keir-ollama/${request.model}`,
        providerEnv: { OLLAMA_API_KEY: ollamaCredential() || (() => { throw new Error("Ollama Cloud credential missing"); })() },
        providerConfig: { "keir-ollama": { npm: "@ai-sdk/openai-compatible", name: "Ollama Cloud",
          options: { baseURL: "https://ollama.com/v1", apiKey: "{env:OLLAMA_API_KEY}" },
          models: { [request.model]: { name: request.model, tool_call: true, ...(request.maxOutputTokens ? { limit: { context: 131072, output: request.maxOutputTokens } } : {}) } } } } })
      : request.runner === "deepseek" ? await openCodeImpl({ ...common,
        model: `keir-deepseek/${request.model}`,
        providerEnv: { DEEPSEEK_API_KEY: deepseekCredential() || (() => { throw new Error("DeepSeek API credential missing"); })() },
        providerConfig: { "keir-deepseek": { npm: "@ai-sdk/openai-compatible", name: "DeepSeek API",
          options: { baseURL: "https://api.deepseek.com/v1", apiKey: "{env:DEEPSEEK_API_KEY}" },
          models: { [request.model]: { name: request.model, tool_call: true, ...(request.maxOutputTokens ? { limit: { context: 1048576, output: request.maxOutputTokens } } : {}) } } } } })
      : await openCodeImpl(common);
    if (!result || typeof result.subtype !== "string") throw new Error("Provider returned an invalid activation result");
    result.provenance = { ...result.provenance, cliAttempt: id, engine: ["opencode", "ollama", "deepseek"].includes(request.runner) ? "opencode" : request.viaRust ? "rust-adapter" : "native-adapter", runtime: "lakeside-code", provider: request.provider || request.runner, billing: request.billing || (request.runner === "deepseek" ? "api" : request.runner === "opencode" ? /^(openai|anthropic)\//.test(request.model) ? "api" : request.model.startsWith("opencode-go/") ? "subscription" : null : "subscription") };
    save({ state: result.interrupted ? "interrupted" : result.timedOut ? "timeout" : result.is_error ? "failed" : "completed", finishedAt: Date.now(), usage: result.usage || {}, subtype: result.subtype });
    return result;
  } catch (error) {
    save({ state: signal.aborted ? "interrupted" : "failed", finishedAt: Date.now() });
    throw error;
  }
}
module.exports = { executeActivation, validate, RUNNERS };
