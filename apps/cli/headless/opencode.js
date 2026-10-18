"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { spawnBounded } = require("./providers");
const host = require("./host");

function engineConfig({ model, briefPath, tools, url, maxTurns, providerConfig, toolsMode, effort }) {
  // Hybrid keeps OpenCode's own workspace tools (confined by the caller) and adds the Keir MCP for effects.
  const permissions = toolsMode === "native" || toolsMode === "hybrid"
    ? [{ action: "*", resource: "*", effect: "allow" }, ...["subagent", "webfetch", "websearch", "question"].map(action => ({ action, resource: "*", effect: "deny" }))]
    : [{ action: "*", resource: "*", effect: "deny" }, ...tools.map(t => ({ action: `keir_${t.name}`, resource: "*", effect: "allow" }))];
  const providers = {};
  for (const [id, entry] of Object.entries(providerConfig || {})) {
    providers[id] = { name: entry.name, package: entry.package || entry.npm?.replace("@ai-sdk/", "@opencode/ai/providers/"), settings: entry.settings || entry.options, models: {} };
    for (const [name, spec] of Object.entries(entry.models || {})) {
      const { tool_call, ...rest } = spec;
      providers[id].models[name] = { ...rest, ...(tool_call === undefined ? {} : { capabilities: { ...rest.capabilities, tools: tool_call } }) };
    }
  }
  if (effort && effort !== "default") {
    const slash = model.indexOf("/"), provider = model.slice(0, slash), name = model.slice(slash + 1).split("#")[0];
    const entry = providers[provider] ||= { models: {} };
    const spec = entry.models[name] ||= {};
    spec.settings = { ...spec.settings, reasoningEffort: effort };
  }
  return {
    model, default_agent: "keir", update: "disable", snapshots: false,
    permissions, ...(briefPath ? { instructions: [briefPath] } : {}),
    ...(Object.keys(providers).length ? { providers } : {}),
    mcp: { servers: toolsMode !== "native" && tools.length ? { keir: { type: "remote", url, codemode: false, oauth: false } } : {} },
    agents: {
      keir: { description: "Keir scoped headless worker", mode: "primary", model,
        steps: maxTurns, permissions },
      title: { disabled: true }, summary: { disabled: true },
    },
  };
}

// With the studio launcher, it owns admission and protected Git metadata.
// Standalone installs run the engine directly in the disposable worktree.
function launchCommand({ runner, binary, control, worktree, promptFile, model, log, session }) {
  return runner ? [runner, ["opencode", control, worktree, promptFile, model, log]]
    : [binary, ["run", "--standalone", "-m", model, "--session", session, fs.readFileSync(promptFile, "utf8")]];
}

// OpenCode owns the model/tool loop. When present, the host launcher still owns
// admission, provider provenance, protected Git metadata and the heavy-check guard.
async function invokeOpenCode(options) {
  const activationStartedAt = Date.now();
  const { stateDir, model, prompt, spawnImpl, signal, timeoutMs } = options;
  if (!model.includes("/")) throw new Error("OpenCode requires provider/model; no model substitution is allowed");
  const base = path.join(stateDir, "opencode-runtime");
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const attempt = path.join(base, crypto.randomUUID());
  const control = options.repo || path.join(attempt, "control");
  fs.mkdirSync(attempt, { mode: 0o700 });
  const git = args => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // A control repository contains no application source or credentials.
  // Linked worktrees satisfy the host launcher's mandatory registration seam.
  if (!fs.existsSync(path.join(control, ".git"))) {
    fs.mkdirSync(control, { recursive: true });
    git(["init", "-b", "main", control]);
    git(["-C", control, "-c", "user.name=Keir", "-c", "user.email=keir@localhost", "commit", "--allow-empty", "-m", "chore: initialize execution workspace"]);
  }
  const worktree = options.worktree || path.join(control, "worktrees", path.basename(attempt));
  if (!options.worktree) git(["-C", control, "worktree", "add", "--detach", worktree, "HEAD"]);
  const briefPath = path.join(attempt, "brief.md");
  fs.writeFileSync(briefPath, options.brief, { mode: 0o600 });
  const config = engineConfig({ ...options, briefPath });
  const session = "ses_" + crypto.randomBytes(16).toString("hex");
  const configDir = path.join(attempt, "config"); fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify(config), { mode: 0o600 });
  const promptFile = path.join(attempt, "prompt.md"), log = path.join(attempt, "provider.log");
  fs.writeFileSync(promptFile, workerPrompt({ ...options, prompt }), { mode: 0o600 });
  const env = { ...require("../provider-routes").credentialEnv(), ...options.providerEnv, HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8",
    XDG_CONFIG_HOME: configDir, XDG_DATA_HOME: path.join(attempt, "data"), XDG_CACHE_HOME: path.join(attempt, "cache"),
    OPENCODE_CONFIG_DIR: configDir, OPENCODE_CONFIG: path.join(configDir, "opencode.json"), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DB: process.env.OPENCODE_DB || path.join(process.env.HOME || osHome(), ".local/share/opencode/opencode.db"),
    KEIR_OPENCODE_SESSION: session,
    OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true" };
  try {
    const startedAt = Date.now();
    const binary = host.bin("opencode");
    const launch = launchCommand({ runner: host.providerRunner(), binary, control, worktree, promptFile, model, log, session });
    const ended = await require("./completion").untilAcceptedFinish(workerSignal => spawnBounded(spawnImpl, launch[0],
      launch[1], { cwd: worktree, env }, timeoutMs, workerSignal), { completionUrl: options.completionUrl, signal, timeoutMs });
    const modelEndedAt = Date.now();
    const result = ended.process || {};
    if (ended.completion) fs.writeFileSync(path.join(attempt, "completion.json"), JSON.stringify(ended.completion), { mode: 0o600 });
    const terminal = !ended.completion && (result.timedOut || result.code === null) ? { subtype: "error_max_turns", is_error: true, timedOut: result.timedOut, interrupted: !result.timedOut } : !ended.completion && result.code !== 0 ? { subtype:"error",is_error:true,result:`OpenCode launcher exited ${result.code}: ${require("./text").redactSecrets(result.err + "\n" + result.out).slice(-1200)}` } : null;
    let read, transcriptFile, accountingError;
    try {
      const exported = await spawnBounded(spawnImpl, binary, ["session", "export", "--standalone", session], { cwd: worktree, env }, 15000, signal);
      const transcript = JSON.parse(exported.out);
      transcriptFile = path.join(attempt, "transcript.json");
      fs.writeFileSync(transcriptFile, exported.out, { mode: 0o600 });
      read = readTranscript(transcript, { acceptedCompletion: ended.completion, allowIncomplete: Boolean(terminal), maxTurns: options.maxTurns });
    } catch (error) {
      if ((!ended.completion && !terminal) || signal.aborted) throw error;
      // Losing usage export cannot undo an already accepted, persisted finish.
      accountingError = require("./text").redactSecrets(error.message).slice(0, 400);
      read = { subtype: "success", is_error: false, usage: {}, num_turns: null };
    }
    return { ...read, ...terminal, ...(ended.completion ? { result: ended.completion.summary } : {}), provenance: { session, transcript: transcriptFile, accounting:terminal?"partial-exported-session":accountingError?"unavailable":"exported-session", accountingError, completion: ended.completion ? "broker-receipt" : "provider-final", timings: { setupMs: startedAt - activationStartedAt, modelLoopMs: modelEndedAt - startedAt, exportMs: Date.now() - modelEndedAt } } };
  } finally {
    // Logs/session data are retained as attempt evidence; the scratch worktree is disposable.
    try { if (!options.worktree) git(["-C", control, "worktree", "remove", "--force", worktree]); } catch { /* interrupted launcher may still own it */ }
  }
}
function workerPrompt({ prompt, toolsMode, tools }) {
  if (toolsMode === "native" || !tools.some(t => t.name === "shell")) return prompt;
  return `${prompt}\n\n## Keir execution context\nThe launcher's working directory is an empty control repository, not the task source. keir_shell runs in the task workspace, with its own working directory. Use paths relative to that tool's working directory as specified in your brief; never try to reach the launcher's host path through keir_shell. The supervising launcher owns Git checkpoints after this activation returns, so the worker must not commit. ${tools.some(t => t.name === "submit_result") ? "After verifying the task, call keir_submit_result with the required structured result. Use keir_finish only to wait or report a blocker." : tools.some(t => t.name === "finish") ? "After verifying the task, call keir_finish and obtain an accepted completion before writing your final answer." : ""}`;
}
function readTranscript(transcript, { acceptedCompletion, allowIncomplete, maxTurns } = {}) {
  const messages = (transcript.messages || []).filter(m => m.type === "assistant");
  if (!acceptedCompletion && !allowIncomplete && transcript.info?.outcome && transcript.info.outcome !== "succeeded") throw new Error(`OpenCode session ended ${transcript.info.outcome}`);
  if (!messages.length) throw new Error("OpenCode returned no assistant messages");
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 };
  for (const message of messages) {
    const tokens = message.tokens || {};
    usage.input_tokens += tokens.input || 0; usage.output_tokens += tokens.output || 0; usage.reasoning_tokens += tokens.reasoning || 0;
    usage.cache_read_input_tokens += tokens.cache?.read || 0; usage.cache_creation_input_tokens += tokens.cache?.write || 0;
  }
  const last = messages.at(-1);
  if (!acceptedCompletion && !allowIncomplete && last.finish === "length") throw new Error("OpenCode generation incomplete: output limit");
  if (!acceptedCompletion && !allowIncomplete && last.error) throw new Error(`OpenCode model request failed: ${last.error.name || "unknown"}`);
  const result = (last.content || []).filter(p => p.type === "text").map(p => p.text).join("\n");
  if (!acceptedCompletion && !allowIncomplete && !result.trim()) {
    // V2 can report succeeded after its step cap with a reasoning-only stop.
    // Preserve usage and let the operator continue through its bounded handoff.
    const exhausted = Number.isInteger(maxTurns) && messages.length >= maxTurns;
    return { subtype: exhausted ? "error_max_turns" : "error_empty_result", is_error: true,
      result: exhausted ? "OpenCode step budget ended without an answer or accepted completion." : "OpenCode returned no answer or accepted completion.",
      num_turns: messages.length, usage };
  }
  return { subtype: "success", is_error: false, result, num_turns: messages.length, usage };
}
function osHome() { return require("node:os").homedir(); }
module.exports = { invokeOpenCode, launchCommand, engineConfig, readTranscript, workerPrompt };
