"use strict";
// Alternative model runners for Keir activations. Each one gets the same
// per-activation loopback MCP url as the Claude runner, has its own built-in
// tools switched off, and returns a Claude-shaped result so agent.js does not
// care which model ran. Both bill to subscriptions: Antigravity (Google OAuth)
// and Muse (Meta OAuth). Never an API key.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { redactSecrets } = require("./text");
const host = require("./host");

const PATH = host.searchPath();

function spawnBounded(spawnImpl, cmd, args, opts, timeoutMs, signal, input = "") {
  return new Promise((resolve, reject) => {
    const {onStdout,...spawnOptions}=opts;
    const child = spawnImpl(cmd, args, { ...spawnOptions, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    let termination;
    const kill = () => { termination ||= require("./process-tree").terminateTree(child.pid); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    if (signal.aborted) kill();
    child.stdout.on("data", (c) => { out += c; onStdout?.(c); if (out.length > 4e6) kill(); });
    child.stderr.on("data", (c) => { err = (err + c).slice(-4000); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", async (code) => {
      await termination;
      clearTimeout(timer); signal.removeEventListener("abort", kill);
      if (signal.aborted) return reject(new Error("activation aborted"));
      resolve({ out, err, code, timedOut });
    });
    child.stdin.on?.("error", () => {});
    child.stdin.end(input);
  });
}

// One scratch directory per activation: the prompt file and nothing else.
function scratch(stateDir, name) {
  const dir = path.join(stateDir, name, crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const failed = (code, err, label) => { throw new Error(`model request failed: ${label} exited ${code} ${redactSecrets(err).slice(-600)}`); };

/** Gemini through the Antigravity CLI. Per-activation HOME pins its MCP config
 *  to this activation's tool server and allows only Keir's tools. */
async function invokeAgy({ spawnImpl, stateDir, model, effort, brief, prompt, tools, url, timeoutMs, signal }) {
  const { dir, cleanup } = scratch(stateDir, "agy-runs");
  try {
    const home = path.join(dir, "home"), ws = path.join(dir, "ws");
    fs.mkdirSync(path.join(home, ".gemini/config"), { recursive: true });
    fs.mkdirSync(path.join(home, ".gemini/antigravity-cli"), { recursive: true });
    fs.mkdirSync(ws, { recursive: true });
    // Symlink, not copy: a refresh must update the one real token.
    fs.symlinkSync(host.credential(".gemini/antigravity-cli/antigravity-oauth-token"), path.join(home, ".gemini/antigravity-cli/antigravity-oauth-token"));
    const task = path.join(ws, "task.md");
    fs.writeFileSync(task, `${brief}\n\n## This activation (JSON)\n\n${prompt}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(home, ".gemini/config/mcp_config.json"), JSON.stringify({ mcpServers: { keir: { serverUrl: url } } }));
    fs.writeFileSync(path.join(home, ".gemini/antigravity-cli/settings.json"), JSON.stringify({
      trustedWorkspaces: [ws],
      permissions: { allow: [`read_file(${task})`, ...tools.map((t) => `mcp(keir/${t.name})`)], deny: ["command(*)", "write_file(/)"] },
    }));
    const args = ["--model", model, "--effort", effort, "--input-format", "stream-json", "--output-format", "stream-json", "-p", ""];
    const input = JSON.stringify({ event: "user", message: { role: "user", content: [{ type: "text", text: `${brief}\n\n## This activation (JSON)\n\n${prompt}\nUse only the granted keir tools. ${tools.some(t=>t.name==="submit_result")?"Complete with submit_result and its required result; use finish only for waiting or a blocker.":"End with one accepted finish call."}` }] } }) + "\n";
    const r = await spawnBounded(spawnImpl, "agy", args, { cwd: ws, env: { HOME: home, PATH, LANG: "C.UTF-8" } }, timeoutMs, signal, input);
    if (r.timedOut) return { subtype: "error_max_turns", is_error: true, timedOut: true };
    if (r.code === null) return { subtype: "error_max_turns", is_error: true, interrupted: true };
    let j;
    try {
      const frames = r.out.trim().split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      j = frames.findLast(frame => frame.event === "result")?.result || frames.findLast(frame => frame.status);
      if (!j) j = JSON.parse(r.out.slice(r.out.indexOf("{")));
    } catch { failed(r.code, r.err || r.out, "agy"); }
    const u = j.usage || {};
    return { result: j.response || "", num_turns: j.num_turns, is_error: j.status !== "SUCCESS", subtype: j.status === "SUCCESS" ? "success" : String(j.error || j.status),
      usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_tokens } };
  } finally { cleanup(); }
}

/** Cursor Agent CLI. Each activation gets a private HOME containing only its
 *  auth link and the scoped Keir broker MCP. The model stays on Cursor Auto;
 *  Cursor selects the model for each request under the account's usage mode. */
async function invokeCursor({ spawnImpl, stateDir, model = "auto", brief, prompt, tools, url, timeoutMs, signal, authFile }) {
  if (model !== "auto") throw new Error("Keir Cursor activations must use Cursor Auto");
  const { dir, cleanup } = scratch(stateDir, "cursor-runs");
  try {
    const home = path.join(dir, "home"), ws = path.join(dir, "ws");
    const cursorConfig = path.join(home, ".cursor"), authDir = path.join(home, ".config", "cursor");
    fs.mkdirSync(cursorConfig, { recursive: true, mode: 0o700 });
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true, mode: 0o700 });
    const auth = authFile || host.credential(".config/cursor/auth.json");
    if (!fs.existsSync(auth)) throw new Error("Cursor CLI is not logged in; run cursor-agent login as the Keir service owner");
    fs.symlinkSync(auth, path.join(authDir, "auth.json"));
    fs.writeFileSync(path.join(cursorConfig, "mcp.json"), JSON.stringify({ mcpServers: { keir: { url } } }), { mode: 0o600 });
    fs.writeFileSync(path.join(ws, ".cursor", "cli.json"), JSON.stringify({ permissions: {
      allow: tools.map(t => `Mcp(keir:${t.name})`),
      deny: ["Shell(*)", "Read(*)", "Write(*)", "WebFetch(*)", "Computer(*)"],
    } }), { mode: 0o600 });
    const args = ["-p", "--model", "auto", "--approve-mcps", "--trust", "--output-format", "text", "--workspace", ws];
    const task = `${brief}\n\n## This activation (JSON)\n\n${prompt}\nUse only the granted keir tools. ${tools.some(t => t.name === "submit_result") ? "Complete with submit_result and its required result; use finish only for waiting or a blocker." : "End with one accepted finish call."}`;
    const r = await spawnBounded(spawnImpl, host.bin("cursor-agent"), args, { cwd: ws, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PATH, LANG: "C.UTF-8" } }, timeoutMs, signal, task);
    if (r.timedOut) return { subtype: "error_max_turns", is_error: true, timedOut: true };
    if (r.code === null) return { subtype: "error_max_turns", is_error: true, interrupted: true };
    if (r.code !== 0) failed(r.code, r.err || r.out, "cursor");
    return { result: r.out.trim(), num_turns: null, is_error: false, subtype: "success", usage: {},
      provenance: { billing: "subscription", accounting: "cursor-cli-usage-not-exported" } };
  } finally { cleanup(); }
}

/** Muse (Meta) headless. Shell, writes and web are off; Keir's tools come over MCP. */
async function invokeMuse({ spawnImpl, stateDir, model, effort, brief, prompt, url, maxTurns, timeoutMs, signal }) {
  const { dir, cleanup } = scratch(stateDir, "muse-runs");
  try {
    const ws = path.join(dir, "ws"), tmp = path.join(dir, "tmp");
    fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(tmp, { recursive: true });
    const promptFile = path.join(dir, "prompt.md");
    fs.writeFileSync(promptFile, `${brief}\n\n## This activation (JSON)\n\n${prompt}\n`, { mode: 0o600 });
    const args = ["exec", "--workspace", ws, "--model", model, "--effort", effort, "--no-session-log", "--no-foreign-personal-context",
      "--disable-shell", "--disable-write", "--disable-web-tools", "--disable-reminders", "--approval-mode", "never",
      "--max-model-steps", String(maxTurns), "-c", `mcp_servers.keir=${JSON.stringify({ url, transport: "streamable_http" })}`, "--prompt-file", promptFile];
    const r = await spawnBounded(spawnImpl, "muse", args, { cwd: ws, env: { HOME: host.home(), PATH, LANG: "C.UTF-8", TMPDIR: tmp } }, timeoutMs, signal);
    if (r.timedOut) return { subtype: "error_max_turns", is_error: true, timedOut: true };
    if (r.code === null) return { subtype: "error_max_turns", is_error: true, interrupted: true };
    if (/max(imum)?[ -]model[ -]steps|step (cap|limit)|did not reach a terminal state within \d+ step/i.test(r.err)) return { subtype: "error_max_turns", is_error: true, result: r.out.trim() };
    if (r.code !== 0) failed(r.code, r.err, "muse");
    return { result: r.out.trim(), num_turns: null, is_error: false, subtype: "success", usage: {} };
  } finally { cleanup(); }
}

/** OpenAI Codex (ChatGPT subscription login). Isolated CODEX_HOME: the user
 *  config lists every ops MCP with write tokens, so each run gets a config with
 *  only Keir's server, its own shell, browser, apps and plugins off, and the
 *  auth file symlinked so a token refresh updates the real one. */
const CODEX_OFF = ["shell_tool", "apps", "plugins", "browser_use", "browser_use_external", "computer_use", "multi_agent", "image_generation", "hooks", "goals",
  "in_app_browser", "memories", "remote_plugin", "skill_search", "sleep_tool"];
async function invokeCodex(options) {
  if (!options.completionUrl) return invokeCodexProcess(options);
  let partial="",usage;
  const usageFile=path.join(options.stateDir,"codex-usage-"+crypto.randomUUID()+".jsonl");
  const meter=await require("./codex-usage").createCodexUsage(usageFile);
  try {
  const transcript=path.join(options.stateDir,"codex-stream-"+crypto.randomUUID()+".jsonl");
  const ended=await require("./completion").untilAcceptedFinish(signal=>invokeCodexProcess({...options,otelEndpoint:meter.endpoint,signal,onStdout:chunk=>{
    fs.appendFileSync(transcript,chunk,{mode:0o600});partial+=chunk;let end;
    while((end=partial.indexOf("\n"))!==-1){const line=partial.slice(0,end);partial=partial.slice(end+1);try{const frame=JSON.parse(line);if(frame.type==="turn.completed"&&frame.usage)usage=frame.usage;}catch{}}
  }}),{...options,settleCompletion:meter.settle});
  await meter.settle();
  if(!ended.completion){const r=ended.process;return {...r,...(!usage&&meter.totals()?{usage:meter.totals()}:{}),provenance:{...r.provenance,usageTranscript:usageFile,accounting:r.timedOut||r.interrupted?"partial-response-events":usage?"completed-turn":"otel-response-completions",responseUsageEvents:meter.count()}};}
  return{subtype:"success",is_error:false,result:ended.completion.summary,num_turns:null,
    usage:usage?{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens,cache_read_input_tokens:usage.cached_input_tokens}:meter.totals()||{},
    provenance:{completion:"broker-receipt",transcript,accounting:usage?"completed-turn":meter.totals()?(meter.rejected()?"partial-response-events":"otel-response-completions"):"unavailable-before-turn-end",usageTranscript:usageFile,responseUsageEvents:meter.count(),invalidUsageEvents:meter.rejected()}};
  } finally { meter.close(); }
}
async function invokeCodexProcess({ spawnImpl, stateDir, model, effort, brief, prompt, url, timeoutMs, signal, codexBin, onStdout, otelEndpoint }) {
  const { dir, cleanup } = scratch(stateDir, "codex-runs");
  try {
    const home = path.join(dir, "home"), ws = path.join(dir, "ws"), last = path.join(dir, "last.txt");
    fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(ws, { recursive: true });
    fs.symlinkSync(host.credential(".codex/auth.json"), path.join(home, "auth.json"));
    fs.writeFileSync(path.join(home, "config.toml"), [`model = ${JSON.stringify(model)}`, `model_reasoning_effort = ${JSON.stringify(effort)}`, `web_search = "disabled"`, "project_doc_max_bytes = 0", "mcp_optional_startup_grace_ms = 0", "",
      "[features]", ...CODEX_OFF.map((f) => `${f} = false`), "", "[mcp_servers.keir]", `url = ${JSON.stringify(url)}`, `default_tools_approval_mode = "approve"`, "required = true", "", ...(otelEndpoint?["[otel]","log_user_prompt = false",`exporter = { otlp-http = { endpoint = ${JSON.stringify(otelEndpoint)}, protocol = "json" } }`,""]:[])].join("\n"));
    const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-C", ws, "-o", last, "-"];
    const r = await spawnBounded(spawnImpl, codexBin || "codex", args, { onStdout, cwd: ws, env: { HOME: host.home(), CODEX_HOME: home, PATH, LANG: "C.UTF-8", OTEL_BLRP_SCHEDULE_DELAY:"1" } }, timeoutMs, signal,
      `${brief}\n\n## This activation (JSON)\n\n${prompt}\n`);
    if (r.timedOut) return { subtype: "error_max_turns", is_error: true, timedOut: true };
    if (r.code === null) return { subtype: "error_max_turns", is_error: true, interrupted: true };
    if (r.code !== 0) failed(r.code, r.err || r.out, "codex");
    let result = ""; try { result = fs.readFileSync(last, "utf8").trim(); } catch {}
    const completed = r.out.split("\n").flatMap(line => { try { const e = JSON.parse(line); return e.type === "turn.completed" ? [e] : []; } catch { return []; } }).at(-1);
    const u = completed?.usage || {};
    return { result, num_turns: null, is_error: false, subtype: "success", usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cached_input_tokens } };
  } finally { cleanup(); }
}

/** Keir 4.0 phase 4: the Rust runner executes the activation (model loop,
 *  trace, admission) against this operator's own tool session, and answers in
 *  the Claude-shaped result the agent already consumes. Job and ticket state
 *  stay here; provenance comes back as `provenance`. */
async function invokeRust({ spawnImpl, stateDir, runner, model, effort, brief, prompt, url, maxTurns, timeoutMs, signal, job, lane, bin }) {
  const { dir, cleanup } = scratch(stateDir, "rust-runs");
  try {
    const briefFile = path.join(dir, "brief.md"), promptFile = path.join(dir, "prompt.json");
    fs.writeFileSync(briefFile, brief, { mode: 0o600 }); fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    const task = job.ticket ? `ticket:${job.ticket}` : `request:${job.id}`;
    const args = ["activation", "--job", job.id, "--task", task, "--lane", lane, "--tools-url", url, "--route", `${runner}:${model}@${effort}`,
      "--brief-file", briefFile, "--prompt-file", promptFile, "--max-turns", String(maxTurns), "--timeout-ms", String(timeoutMs)];
    const r = await spawnBounded(spawnImpl, bin || host.bin("lakeside-agent"), args, { cwd: dir, env: { HOME: host.home(), PATH, LANG: "C.UTF-8" } }, timeoutMs + 60000, signal);
    if (r.timedOut) return { subtype: "error_max_turns", is_error: true, timedOut: true };
    if (r.code === null) return { subtype: "error_max_turns", is_error: true, interrupted: true };
    let j; try { j = JSON.parse(r.out.trim().split("\n").at(-1)); } catch { failed(r.code, r.err || r.out, "lakeside"); }
    if (!j || typeof j !== "object" || !j.subtype) failed(r.code, r.err || r.out, "lakeside");
    return j;
  } finally { cleanup(); }
}

// Ollama credentials are resolved at execution time, never serialized into task requests.
function ollamaKey() {
  if (process.env.OLLAMA_API_KEY) return process.env.OLLAMA_API_KEY;
  try { return JSON.parse(fs.readFileSync(host.credential(".config/lakeside/ollama-cloud.json"), "utf8")).api_key; } catch { return null; }
}
// DeepSeek platform API credentials, resolved the same way (api.deepseek.com
// bills per token, so the key never rides in an activation request).
function deepseekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try { return JSON.parse(fs.readFileSync(host.credential(".config/lakeside/deepseek.json"), "utf8")).api_key; } catch { return null; }
}
module.exports = { spawnBounded, invokeAgy, invokeCursor, invokeMuse, invokeCodex, invokeRust, ollamaKey, deepseekKey };
