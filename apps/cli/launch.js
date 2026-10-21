"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");
const { withVpsCredential } = require("./vps-profile.mjs");
const { locations } = require("./config.mjs");
const { resolveProject } = require("./workspace/projects.mjs");
const { engineConnections } = require("./integrations/mcp.mjs");
const { skillRoot, skillCommands } = require("./skills");
const { providerRoute } = require("./provider-routes");

const supportedVersion = "1.19.0";

function engineBinary(env = process.env) {
  if (env.LAKESIDE_OPENCODE_BIN) return env.LAKESIDE_OPENCODE_BIN;
  try {
    const file = require.resolve("opencode-ai/package.json");
    return path.join(path.dirname(file), require(file).bin.opencode);
  } catch { return "opencode"; }
}

function launchSettings(input, env = process.env) {
  const args = [], options = {};
  for (let i = 0; i < input.length; i++) {
    const word = input[i];
    if (word === "--preview") options.preview = true;
    else if (["--backend", "--provider", "--resume-run", "--carry"].includes(word)) {
      if (!input[i + 1] || input[i + 1].startsWith("--")) throw new Error(`${word} needs a value`);
      options[word.slice(2)] = input[++i];
    }
    else if (word === "--name") {
      if (!input[i + 1] || input[i + 1].startsWith("--")) throw new Error("--name needs a display name");
      options.name = input[++i];
    } else args.push(word);
  }
  const name = options.name || env.LAKESIDE_CODE_NAME || "Lakeside Code";
  if (!name.trim() || name.length > 32 || /[\x00-\x1f\x7f-\x9f]/.test(name)) throw new Error("Display name must be 1 to 32 printable characters");
  if (options.preview && args.length) throw new Error("--preview runs by itself; use it without engine commands, projects or prompt flags");
  let backend = options.backend || env.LAKESIDE_CODE_BACKEND || "api";
  if (options.provider) {
    if (options.backend) throw new Error("Choose --provider or --backend, not both");
    const index = args.indexOf("--model");
    const route = providerRoute(options.provider, index < 0 ? undefined : args[index + 1]);
    backend = route.backend;
    // Native providers use their own model ids. Ollama's interactive engine
    // uses its named provider; the headless adapter normalizes the same route.
    args[index + 1] = route.model;
  }
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(backend)) throw new Error("Backend must be a lowercase id");
  if (options.preview && backend !== "api") throw new Error("--preview uses the API terminal's sample route; omit --backend");
  if (options["resume-run"] && backend === "api") throw new Error("--resume-run is for native backends; API sessions use --session");
  let nativeModel;
  if (backend !== "api") {
    const index = args.indexOf("--model");
    if (index >= 0) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error("--model needs a native model id");
      nativeModel = args[index + 1]; args.splice(index, 2);
    }
  }
  return { backend, ...(options.provider ? { provider: options.provider } : {}), ...(nativeModel ? { nativeModel } : {}), ...(options["resume-run"] ? { nativeRun: options["resume-run"] } : {}), ...(options.carry ? { carry: options.carry } : {}), args: resolveProject(args, env), name, preview: Boolean(options.preview), binary: engineBinary(env) };
}

function terminalRuntime(dir) {
  // OpenCode's Solid transform skips node_modules. Stage source assets outside
  // the installed npm tree so the host compiles JSX with its own UI runtime.
  const files = ["terminal.tsx", "peers.mjs", "peer-monitor.mjs", "config.mjs", "vps-profile.mjs", "workspace/projects.mjs", "integrations/studio.mjs", "integrations/vps-client.mjs", "midnight.json", "daybreak.json", "contrast.json",
    ...fs.readdirSync(path.join(__dirname, "tui")).filter(file => /\.(tsx|mjs)$/.test(file) && !/\.test\./.test(file)).map(file => `tui/${file}`)];
  const contents = files.map(file => fs.readFileSync(path.join(__dirname, file)));
  const hash = crypto.createHash("sha256");
  contents.forEach(content => hash.update(content));
  const target = path.join(dir, "tui-runtime", hash.digest("hex").slice(0, 20));
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  files.forEach((file, index) => {
    const destination = path.join(target, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(destination)) {
      try { fs.writeFileSync(destination, contents[index], { mode: 0o600, flag: "wx" }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  });
  return path.join(target, "terminal.tsx");
}

function vpsMessagePermission(env) {
  try { const profile = require("./vps-profile.mjs").loadVps(env); return profile ? { [`${profile.id}_vps_message`]: "ask", [`${profile.id}_vps_discord_send`]: "ask" } : {}; } catch { return {}; }
}

function prepare(settings, env = process.env) {
  env = withVpsCredential(env);
  const dir = locations(env).config;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A generated launch file never replaces the user's OpenCode configuration.
  const tuiFile = path.join(dir, "terminal.generated.json");
  fs.writeFileSync(tuiFile, JSON.stringify({
    theme: "midnight",
    plugin: [[pathToFileURL(terminalRuntime(dir)).href, { name: settings.name, backend: settings.backend, version: require("./package.json").version, engine: supportedVersion }]],
    prompt: { max_width: "auto", max_height: 8 },
    diff_style: "auto",
    attention: { enabled: false },
  }, null, 2) + "\n", { mode: 0o600 });
  const inline = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
  const plugin = pathToFileURL(path.join(__dirname, "coordination-plugin.mjs")).href;
  const selectedModel = settings.args[settings.args.indexOf("--model") + 1];
  const cloud = settings.provider === "ollama" ? { ollama: {
    npm: "@ai-sdk/openai-compatible", name: "Ollama Cloud", options: { baseURL: "https://ollama.com/v1" },
    models: { [selectedModel.slice("ollama/".length)]: { name: selectedModel.slice("ollama/".length), tool_call: true } },
  } } : settings.provider === "deepseek" ? { deepseek: {
    npm: "@ai-sdk/openai-compatible", name: "DeepSeek API", options: { baseURL: "https://api.deepseek.com/v1" },
    models: { [selectedModel.slice("deepseek/".length)]: { name: selectedModel.slice("deepseek/".length), tool_call: true } },
  } } : {};
  const childEnv = {
    ...env,
    LAKESIDE_CODE_NAME: settings.name,
    LAKESIDE_CODE_BACKEND: settings.backend,
    ...(settings.carry ? { LAKESIDE_CODE_CARRY: settings.carry } : {}),
    OPENCODE_TUI_CONFIG: tuiFile,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_TERMINAL_TITLE: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...inline,
      ...(Object.keys(cloud).length ? { provider: { ...(inline.provider || {}), ...cloud } } : {}),
      mcp: { ...engineConnections(env), ...(inline.mcp || {}) },
      skills: { ...(inline.skills || {}), paths: [...(inline.skills?.paths || []), path.join(skillRoot(), "vendor"), path.join(__dirname, "design-skills")] },
      command: { ...skillCommands(), ...(inline.command || {}) },
      // Messages to VPS agents and posts to the AHD Discord act for the owner, so each one is confirmed.
      permission: typeof inline.permission === "string" ? inline.permission : { agent_handoff: "ask", agent_cancel: "ask", ...vpsMessagePermission(env), ...(inline.permission || {}) },
      plugin: [...(inline.plugin || []), plugin],
    }),
  };
  if (settings.backend !== "api") childEnv.OPENCODE_ROUTE = JSON.stringify({ type: "plugin", id: "lakeside.native" });
  if (settings.preview) childEnv.OPENCODE_ROUTE = JSON.stringify({ type: "plugin", id: "lakeside.preview" });
  return { args: settings.args, env: childEnv };
}

async function launch(input = [], env = process.env) {
  env = withVpsCredential(env);
  const settings = launchSettings(input, env);
  try { await import("@opencode-ai/plugin"); }
  catch { throw new Error("Install the coding client dependency first: npm --prefix apps/cli ci --ignore-scripts"); }
  const version = spawnSync(settings.binary, ["--version"], { encoding: "utf8", timeout: 15000, env });
  if (version.error || version.status !== 0) throw new Error(`Install OpenCode ${supportedVersion} first, or set LAKESIDE_OPENCODE_BIN to its executable`);
  if (version.stdout.trim() !== supportedVersion) throw new Error(`This terminal targets OpenCode ${supportedVersion}; found ${version.stdout.trim()}. Use a matching binary via LAKESIDE_OPENCODE_BIN.`);
  const bridge = settings.backend === "api" ? undefined : await (await import("./native/launch.mjs")).startNativeBridge(settings, env);
  try {
  const prepared = prepare(settings, bridge ? { ...env, LAKESIDE_NATIVE_BRIDGE: JSON.stringify(bridge.connection) } : env);
  return await new Promise((resolve, reject) => {
    const child = spawn(settings.binary, prepared.args, { stdio: "inherit", env: prepared.env });
    // The terminal delivers Ctrl-C to the foreground process group. Let
    // OpenCode restore terminal modes before the launcher exits.
    const interrupt = () => {};
    const terminate = () => child.kill("SIGTERM");
    const hangup = () => child.kill("SIGHUP");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    process.on("SIGHUP", hangup);
    const cleanup = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => { cleanup(); process.exitCode = code ?? (signal ? 130 : 1); resolve(); });
  });
  } finally { await bridge?.close(); }
}

module.exports = { vpsMessagePermission, launch, launchSettings, prepare, supportedVersion, engineBinary };
