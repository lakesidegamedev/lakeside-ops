"use strict";
// Model executor for the private owner supervisor: headless Claude Code with
// every built-in tool switched off. Its only tools are the supervisor's
// per-job loopback MCP endpoint, which runs file and command work inside the
// bubblewrap sandbox. The model process gets a throwaway HOME (credentials
// symlinked read-only, no host memories, plugins or settings) and an
// environment of HOME, PATH and LANG only, so no server secret reaches it.
// Same launch profile as the operator's proven activation runner
// (apps/cli/headless/claude.js), restated because apps/web ships alone.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SECRET = [/gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /sk-[A-Za-z0-9_-]{20,}/g, /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g, /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, /(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/g];
function redact(text) {
  let out = String(text || "");
  for (const re of SECRET) out = out.replace(re, (m, scheme) => typeof scheme === "string" && scheme.startsWith("mongodb") ? `${scheme}[redacted]@` : "[redacted]");
  return out;
}

const executable = (file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };

function findClaude(env = process.env) {
  if (env.KEIR_SUPERVISOR_CLAUDE_BIN) return env.KEIR_SUPERVISOR_CLAUDE_BIN;
  const home = env.HOME || os.homedir();
  const dirs = [path.join(home, ".local/bin"), path.join(home, ".hermes/node/bin"), ...String(env.PATH || "").split(path.delimiter), "/usr/local/bin", "/usr/bin"];
  for (const dir of dirs) if (dir && executable(path.join(dir, "claude"))) return path.join(dir, "claude");
  return null;
}

function createClaudeExecutor({ env = process.env, model = env.KEIR_SUPERVISOR_MODEL || "claude-opus-5-5", effort = env.KEIR_SUPERVISOR_EFFORT || "high", stateDir, spawnImpl = spawn } = {}) {
  const home = env.HOME || os.homedir();
  const credentials = path.join(home, ".claude/.credentials.json");

  function available() {
    const bin = findClaude(env);
    if (!bin || !executable(bin)) return { available: false, reason: "Claude Code CLI not installed for the web service account", runner: "claude", model };
    if (!fs.existsSync(credentials)) return { available: false, reason: "Claude subscription is not signed in for the web service account", runner: "claude", model };
    return { available: true, reason: null, runner: "claude", model };
  }

  async function run({ brief, prompt, toolUrl, toolNames, signal, timeoutMs = 30 * 60000, maxTurns = 120 }) {
    const state = available();
    if (!state.available) throw Object.assign(new Error(state.reason), { unavailable: true });
    const scratchRoot = path.join(stateDir, "model-homes");
    fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
    const scratch = fs.mkdtempSync(path.join(scratchRoot, "home-"));
    fs.mkdirSync(path.join(scratch, ".claude"), { mode: 0o700 });
    fs.symlinkSync(credentials, path.join(scratch, ".claude/.credentials.json"));
    const cwd = path.join(scratch, "cwd"); fs.mkdirSync(cwd, { mode: 0o700 });
    const args = ["-p", "--system-prompt", brief, "--model", model, "--effort", effort, "--setting-sources", "", "--tools", "",
      "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { supervisor: { type: "http", url: toolUrl } } }),
      "--allowedTools", toolNames.map((n) => `mcp__supervisor__${n}`).join(","),
      "--max-turns", String(maxTurns), "--no-session-persistence", "--output-format", "json"];
    const childEnv = { HOME: scratch, PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    try {
      return await new Promise((resolve, reject) => {
        const child = spawnImpl(findClaude(env), args, { cwd, env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
        let out = "", err = "", timedOut = false;
        const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
        const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
        signal?.addEventListener?.("abort", kill, { once: true });
        child.stdout.on("data", (c) => { out += c; if (out.length > 4e6) kill(); });
        child.stderr.on("data", (c) => { err = (err + c).slice(-4000); });
        child.stdin.on("error", () => {});
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", (code, sig) => {
          clearTimeout(timer); signal?.removeEventListener?.("abort", kill);
          if (signal?.aborted) return resolve({ cancelled: true });
          if (timedOut) return resolve({ timedOut: true });
          if (code === null) return resolve({ interrupted: true, reason: `model process stopped by ${sig}` });
          let parsed; try { parsed = JSON.parse(out.trim().split("\n").at(-1)); } catch { /* below */ }
          if (!parsed || typeof parsed !== "object") return resolve({ interrupted: true, reason: `model exited ${code}: ${redact(err).slice(-400) || "no result"}` });
          if (parsed.is_error) return resolve({ interrupted: true, reason: `model ended with ${parsed.subtype || "an error"}`, text: typeof parsed.result === "string" ? parsed.result : "" });
          resolve({ text: String(parsed.result || ""), usage: parsed.usage || null, turns: parsed.num_turns || null });
        });
        child.stdin.end(prompt);
      });
    } finally {
      // rmSync does not follow the credentials symlink.
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  return { available, run, name: "claude", model };
}

module.exports = { createClaudeExecutor, redact, findClaude };
