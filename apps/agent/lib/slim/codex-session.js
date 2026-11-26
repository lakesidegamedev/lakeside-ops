"use strict";
// One continuing Codex session per ticket. The first wake starts the session;
// every later wake resumes it by id, so the ticket keeps one conversation.
// Codex compacts the conversation itself when it grows past
// model_auto_compact_token_limit. The brief and style guide are standing
// developer instructions, so compaction never drops them.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const runtime = require("../operator/cli-runtime");

const FEATURES_OFF = ["apps", "plugins", "browser_use", "browser_use_external", "computer_use", "multi_agent", "image_generation", "hooks", "goals",
  "in_app_browser", "memories", "remote_plugin", "skill_search", "sleep_tool"];

const toml = (v) => JSON.stringify(String(v));

function configToml({ model, effort, sandbox, compactTokens, instructions, url }) {
  return [
    `model = ${toml(model)}`,
    `model_reasoning_effort = ${toml(effort)}`,
    `web_search = "disabled"`,
    "project_doc_max_bytes = 0",
    `sandbox_mode = ${toml(sandbox)}`,
    `approval_policy = "never"`,
    `model_auto_compact_token_limit = ${Number(compactTokens) || 160000}`,
    `developer_instructions = ${toml(instructions)}`,
    "mcp_optional_startup_grace_ms = 0",
    "",
    "[features]",
    ...FEATURES_OFF.map((f) => `${f} = false`),
    "",
    "[sandbox_workspace_write]",
    "network_access = false",
    "",
    "[mcp_servers.keir]",
    `url = ${toml(url)}`,
    `default_tools_approval_mode = "approve"`,
    "required = true",
    "",
  ].join("\n");
}

function threadIdFrom(stdout) {
  for (const line of String(stdout).split("\n")) {
    try { const f = JSON.parse(line); if (f.type === "thread.started" && f.thread_id) return f.thread_id; } catch { /* not a frame */ }
  }
  return null;
}

function usageFrom(stdout) {
  let usage = null;
  for (const line of String(stdout).split("\n")) {
    try { const f = JSON.parse(line); if (f.type === "turn.completed" && f.usage) usage = f.usage; } catch { /* not a frame */ }
  }
  return usage;
}

function createCodexSessions({ stateDir, model, effort, compactTokens, codexBin, spawnImpl = spawn, credentialFile } = {}) {
  const host = runtime("host");
  const { spawnBounded } = runtime("providers");
  const { untilAcceptedFinish } = runtime("completion");

  function homeFor(ticket) {
    const home = path.join(stateDir, "sessions", `ticket-${Number(ticket)}`, "codex-home");
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const auth = path.join(home, "auth.json");
    if (!fs.existsSync(auth)) fs.symlinkSync(credentialFile || host.credential(".codex/auth.json"), auth);
    return home;
  }

  /**
   * Run one wake. sessionId null starts the session; otherwise it resumes.
   * Returns { sessionId, completion, result, usage, timedOut, transcript }.
   */
  async function wake({ ticket, sessionId, cwd, sandbox = "read-only", instructions, prompt, url, completionUrl, timeoutMs, images = [], signal = new AbortController().signal }) {
    const home = homeFor(ticket);
    fs.writeFileSync(path.join(home, "config.toml"), configToml({ model, effort, sandbox, compactTokens, instructions, url }), { mode: 0o600 });
    const runDir = path.join(stateDir, "sessions", `ticket-${Number(ticket)}`, "wakes");
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const transcript = path.join(runDir, `${stamp}.jsonl`);
    const last = path.join(runDir, `${stamp}.last.txt`);
    const run = (resumeId) => (sig) => {
      // --image=<file> per image: the option takes several values, so a bare -i would swallow the "-" stdin marker.
      const attach = images.map((f) => `--image=${f}`);
      const args = resumeId
        ? ["exec", "resume", resumeId, "--json", "--skip-git-repo-check", ...attach, "-o", last, "-"]
        : ["exec", "--json", "--skip-git-repo-check", "-C", cwd, ...attach, "-o", last, "-"];
      return spawnBounded(spawnImpl, codexBin || host.bin("codex"), args, {
        cwd,
        env: { HOME: host.home(), CODEX_HOME: home, PATH: host.searchPath(), LANG: "C.UTF-8" },
        onStdout: (chunk) => fs.appendFileSync(transcript, chunk, { mode: 0o600 }),
      }, timeoutMs, sig, prompt);
    };
    let ended = await untilAcceptedFinish(run(sessionId), { completionUrl, signal, timeoutMs });
    let started = sessionId;
    // A session that cannot be resumed (lost home, corrupt rollout) starts over;
    // the caller's prompt then carries the ticket state as the recap.
    if (!ended.completion && sessionId && ended.process && ended.process.code !== 0 && !ended.process.timedOut) {
      started = null;
      ended = await untilAcceptedFinish(run(null), { completionUrl, signal, timeoutMs });
    }
    const out = fs.existsSync(transcript) ? fs.readFileSync(transcript, "utf8") : "";
    const id = threadIdFrom(out) || started;
    let result = ""; try { result = fs.readFileSync(last, "utf8").trim(); } catch { /* no final message */ }
    return {
      sessionId: id,
      restarted: Boolean(sessionId && started === null),
      completion: ended.completion || null,
      result,
      usage: usageFrom(out),
      timedOut: Boolean(ended.process?.timedOut),
      exitCode: ended.process ? ended.process.code : 0,
      transcript,
    };
  }

  return { wake, homeFor };
}

module.exports = { createCodexSessions, configToml, threadIdFrom, usageFrom };
