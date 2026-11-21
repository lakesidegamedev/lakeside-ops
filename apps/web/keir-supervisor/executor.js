"use strict";
// Model executor for the private owner supervisor: a full Claude Code agent on
// this box, the same reach as the owner's own interactive root session. All
// built-in tools, permissions skipped, real network, the host's own settings,
// CLAUDE.md files, memory and every MCP server registered for the account in
// ~/.claude.json. The only additions are the supervisor's per-job loopback MCP
// endpoint (progress lines, conversation recall, the owner attention list) and
// the brief appended to Claude Code's own system prompt.
//
// Limits that are not restrictions: each run lives in its own transient systemd
// scope with a memory cap (so a runaway job cannot take the web service or the
// box down), a hard runtime cap, and a stop that kills the whole process tree.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");

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

// Names (never headers or tokens) of the MCP servers Claude Code will load for
// this account: user scope plus the project scope of the run directory.
function hostMcpServers(home, cwd) {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    return [...new Set([...Object.keys(conf.mcpServers || {}), ...Object.keys(conf.projects?.[cwd]?.mcpServers || {})])].sort();
  } catch { return []; }
}

// Claude Code keeps a session transcript at ~/.claude/projects/<cwd with
// every non-alphanumeric character as "-">/<id>.jsonl. A resume needs it.
function sessionFile(home, cwd, sessionId) {
  return path.join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

// What a tool call looks like on the phone while it runs: short, no secrets.
function describeTool(name, input = {}) {
  const short = (s, n = 90) => redact(String(s || "")).replace(/\s+/g, " ").trim().slice(0, n);
  if (name === "Bash") return `Running: ${short(input.description || input.command)}`;
  if (["Read", "Edit", "Write", "NotebookEdit"].includes(name)) return `${name === "Read" ? "Reading" : "Editing"} ${short(path.basename(String(input.file_path || input.notebook_path || "")), 60)}`;
  if (name === "Grep" || name === "Glob") return `Searching for ${short(input.pattern, 60)}`;
  if (name === "WebFetch" || name === "WebSearch") return `Looking up ${short(input.url || input.query, 70)}`;
  if (name === "Agent" || name === "Task") return `Delegating: ${short(input.description, 70)}`;
  const mcp = /^mcp__([^_]+(?:[-_][^_]+)*?)__(.+)$/.exec(name);
  if (mcp) return `Using ${mcp[1]} ${mcp[2].replace(/_/g, " ")}`;
  return `Using ${short(name, 60)}`;
}

function createClaudeExecutor({ env = process.env, model = env.KEIR_SUPERVISOR_MODEL || "claude-opus-5-5", effort = env.KEIR_SUPERVISOR_EFFORT || "high",
  stateDir, spawnImpl = spawn, execFileImpl = execFile, cwd = env.KEIR_SUPERVISOR_CWD || env.HOME || os.homedir(),
  memoryMax = env.KEIR_SUPERVISOR_MEMORY_MAX || "16G", systemdRun = env.KEIR_SUPERVISOR_SYSTEMD_RUN ?? "/usr/bin/systemd-run",
  systemctl = env.KEIR_SUPERVISOR_SYSTEMCTL || "/usr/bin/systemctl" } = {}) {
  const home = env.HOME || os.homedir();
  const credentials = path.join(home, ".claude/.credentials.json");
  const scoped = Boolean(systemdRun) && executable(systemdRun);

  function available() {
    const bin = findClaude(env);
    const base = { runner: "claude", model, effort, cwd, memoryMax: scoped ? memoryMax : null, scope: scoped ? "systemd" : "process-group", mcpServers: hostMcpServers(home, cwd) };
    if (!bin || !executable(bin)) return { available: false, reason: "Claude Code CLI not installed for the web service account", ...base };
    if (!fs.existsSync(credentials)) return { available: false, reason: "Claude subscription is not signed in for the web service account", ...base };
    return { available: true, reason: null, ...base };
  }

  // The environment of a root login, not the web service's: the service's own
  // secrets (session keys, bot tokens) are not passed through. Tools that need
  // credentials find them the way an interactive session does (gh, git, files).
  function childEnv(jobId) {
    const extra = [path.join(home, ".local/bin"), path.join(home, "bin"), path.join(home, ".hermes/node/bin")];
    const PATH = [...new Set([...extra, ...String(env.PATH || "/usr/local/bin:/usr/bin:/bin").split(path.delimiter)])].filter(Boolean).join(path.delimiter);
    return { HOME: home, USER: env.USER || "root", LOGNAME: env.USER || "root", SHELL: "/bin/bash", PATH, LANG: "C.UTF-8", TERM: "dumb",
      TZ: "America/New_York", IS_SANDBOX: "1", DISABLE_AUTOUPDATER: "1", KEIR_SUPERVISOR_JOB: jobId,
      PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH || path.join(home, ".cache/ms-playwright") };
  }

  // Stop a scope left behind by a previous web process (a scope is its own
  // cgroup, so it outlives the service that started it).
  function reap(unit) {
    if (!unit || !scoped || !/^keir-supervisor-[A-Za-z0-9_-]{1,80}\.scope$/.test(unit)) return Promise.resolve(false);
    return new Promise((resolve) => execFileImpl(systemctl, ["kill", "--kill-whom=all", "--signal=SIGKILL", unit], { timeout: 15000 }, () =>
      execFileImpl(systemctl, ["stop", unit], { timeout: 15000 }, (e) => resolve(!e))));
  }

  // `model` and `effort` are the owner's choice for this job (validated by the
  // caller against models.js); without one the service default applies.
  async function run({ jobId, attempt = 1, brief, prompt, toolUrl, signal, timeoutMs = 60 * 60000, sessionId = null, resume = false, onStart = () => {}, onActivity = () => {},
    model: jobModel = null, effort: jobEffort = null }) {
    const state = available();
    if (!state.available) throw Object.assign(new Error(state.reason), { unavailable: true });
    const runs = path.join(stateDir, "runs");
    fs.mkdirSync(runs, { recursive: true, mode: 0o700 });
    const canResume = resume && sessionId && fs.existsSync(sessionFile(home, cwd, sessionId));
    const session = canResume ? sessionId : crypto.randomUUID();
    // Only the supervisor's own endpoint is added; host servers come from the
    // account's normal configuration, exactly as in an interactive session.
    const mcpFile = path.join(runs, `${jobId}-${attempt}-mcp.json`);
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { supervisor: { type: "http", url: toolUrl } } }), { mode: 0o600 });
    const runModel = jobModel || model, runEffort = jobEffort || effort;
    const claudeArgs = ["-p", "--model", runModel, "--effort", runEffort, "--dangerously-skip-permissions", "--append-system-prompt", brief,
      "--mcp-config", mcpFile, "--output-format", "stream-json", "--verbose", ...(canResume ? ["--resume", session] : ["--session-id", session])];
    const unit = `keir-supervisor-${String(jobId).replace(/[^A-Za-z0-9_-]/g, "")}-a${attempt}.scope`;
    const bin = findClaude(env);
    const [cmd, args] = scoped
      ? [systemdRun, ["--scope", "--quiet", "--collect", `--unit=${unit}`, "-p", `MemoryMax=${memoryMax}`, "-p", "MemorySwapMax=0", "--", bin, ...claudeArgs]]
      : [bin, claudeArgs];
    try {
      return await new Promise((resolve, reject) => {
        const child = spawnImpl(cmd, args, { cwd, env: childEnv(jobId), detached: true, stdio: ["pipe", "pipe", "pipe"] });
        let buf = "", err = "", timedOut = false, result = null, init = null, lastText = "", killed = false;
        const kill = () => {
          if (killed) return; killed = true;
          try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
          // Anything that left the process group (setsid, double fork) is still in the scope.
          if (scoped) execFileImpl(systemctl, ["kill", "--kill-whom=all", "--signal=SIGKILL", unit], { timeout: 15000 }, () => {});
        };
        const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
        signal?.addEventListener?.("abort", kill, { once: true });
        if (signal?.aborted) kill();
        onStart({ unit: scoped ? unit : null, pid: child.pid, sessionId: session, resumed: Boolean(canResume), model: runModel, effort: runEffort });
        const line = (raw) => {
          let ev; try { ev = JSON.parse(raw); } catch { return; }
          if (ev.type === "system" && ev.subtype === "init") {
            init = { tools: (ev.tools || []).length, mcpServers: (ev.mcp_servers || []).map((s) => ({ name: String(s.name || ""), status: String(s.status || "") })) };
            onActivity({ init });
          } else if (ev.type === "assistant") {
            for (const part of ev.message?.content || []) {
              if (part.type === "tool_use") onActivity({ line: describeTool(part.name, part.input) });
              if (part.type === "text" && part.text) lastText = part.text;
            }
          } else if (ev.type === "result") result = ev;
        };
        child.stdout.on("data", (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) line(l); }
          if (buf.length > 8e6) buf = "";
        });
        child.stderr.on("data", (c) => { err = (err + c).slice(-4000); });
        child.stdin.on("error", () => {});
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", (code, sig) => {
          clearTimeout(timer); signal?.removeEventListener?.("abort", kill);
          if (buf.trim()) line(buf);
          const meta = { sessionId: session, unit: scoped ? unit : null, init };
          if (signal?.aborted) return resolve({ cancelled: true, ...meta });
          if (timedOut) return resolve({ timedOut: true, ...meta });
          if (!result) {
            const why = code === null ? `model process stopped by ${sig}` : `model exited ${code}: ${redact(err).slice(-400) || "no result"}`;
            return resolve({ interrupted: true, reason: why, text: lastText, ...meta });
          }
          if (result.is_error) return resolve({ interrupted: true, reason: `model ended with ${result.subtype || "an error"}`, text: typeof result.result === "string" ? result.result : lastText, ...meta });
          resolve({ text: String(result.result || ""), usage: result.usage || null, turns: result.num_turns || null, costUsd: result.total_cost_usd ?? null, ...meta });
        });
        child.stdin.end(prompt);
      });
    } finally {
      fs.rmSync(mcpFile, { force: true });
    }
  }

  return { available, run, reap, name: "claude", model };
}

module.exports = { createClaudeExecutor, redact, findClaude, describeTool, hostMcpServers, sessionFile };
