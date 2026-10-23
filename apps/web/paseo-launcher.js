"use strict";

// Launch and steer coding agents through the Paseo daemon (127.0.0.1:6767).
//
// Why this exists
// ---------------
// Automated ticket repair used to spawn a tmux pane and type the prompt into it
// with `seedAgentPrompt`, which meant the launch could only be confirmed by
// scraping the pane. Paseo owns the agent process directly, so a launch either
// returns an agent id or throws, and a follow-up message is a command rather
// than simulated keystrokes.
//
// This module deliberately does NOT create the worktree. The existing
// `codeSessionManager.initializeWorktree` already produces a branch named to the
// repo's delivery convention and a `code_sessions` row the ops dashboard renders,
// and both would be lost if Paseo provisioned its own worktree under
// `/root/.paseo/worktrees`. Paseo is given the finished worktree as `--cwd`.
//
// Every call is async `execFile`. A synchronous spawn on this box once blocked
// Node for 50+ seconds and tripped the health checks.

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getConfig } = require("./src/core/config");
const paseoConfig = getConfig().paseo || {};

const PASEO_BIN = process.env.PASEO_BIN || paseoConfig.bin || "paseo";

// `paseo run` has no flag for provider feature toggles, and OpenCode's
// `auto_accept` defaults to FALSE. An unattended repair agent that hits a
// permission prompt does not fail — it sits there looking "running" until a
// human who is not watching approves it. (2026-08-28: #1209 spawned fine and
// stalled exactly this way.) The daemon's MCP endpoint accepts a stateless
// tools/call, so the toggle is flipped immediately after launch.
//
// Note this is a SECOND layer: ~/.config/opencode/opencode.jsonc already sets
// edit/bash/webfetch to "allow". That covers OpenCode's own prompts; this
// covers the ones Paseo surfaces on top. Containment is the throwaway worktree,
// not the prompt.
const PASEO_MCP_URL = process.env.PASEO_MCP_URL || "http://127.0.0.1:6767/mcp/agents";

async function enableAutoAccept(agentId) {
  const res = await fetch(PASEO_MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "update_agent", arguments: { agentId, settings: { features: { auto_accept: true } } } },
    }),
  });
  if (!res.ok) throw new Error(`paseo mcp update_agent: HTTP ${res.status}`);
}

// All automated repairs share one Paseo project so the UI shows a single
// "AHD Ticket Repairs" tile instead of a cs_<hash> project per worktree (the
// 2026-08-15 sprawl). The shared project id is seeded in this file; if it is
// missing or stale, launchAgent silently falls back to a plain --cwd run.
const REPAIR_PROJECT_FILE = process.env.PASEO_REPAIR_PROJECT_FILE || paseoConfig.repairProjectFile || path.join(os.homedir(), ".paseo", "repair-project.json");

// The daemon runs as root and needs the provider CLIs on PATH, same as its unit.
const PASEO_ENV = {
  ...process.env,
  PATH: [
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".hermes", "node", "bin"),
    path.join(os.homedir(), ".opencode", "bin"),
    process.env.PATH || "",
  ].join(path.delimiter),
};

function paseo(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      PASEO_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 4 << 20, env: PASEO_ENV, cwd: os.homedir() },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim().slice(0, 600);
          reject(new Error(`paseo ${args[0]} failed: ${detail}`));
          return;
        }
        resolve(String(stdout));
      }
    );
  });
}

// `paseo run` prints human tips ("Created workspace …") before the JSON body, so
// take the last balanced object rather than parsing the whole stream.
function lastJsonObject(stdout) {
  const start = stdout.lastIndexOf("\n{");
  const slice = start === -1 ? stdout.slice(stdout.indexOf("{")) : stdout.slice(start + 1);
  try {
    return JSON.parse(slice.trim());
  } catch {
    throw new Error(`paseo returned no parseable JSON: ${stdout.trim().slice(0, 300)}`);
  }
}

function lastJsonArray(stdout) {
  const start = stdout.lastIndexOf("\n[");
  const slice = start === -1 ? stdout.slice(stdout.indexOf("[")) : stdout.slice(start + 1);
  return JSON.parse(slice.trim());
}

// Preference order for "let the repair agent act unattended", by the mode id the
// daemon reports in its `Available modes: …` rejection. Providers rename these
// between versions (muse: sandboxed/trusted/yolo, codex: full-access), and an
// unrecognised mode fails the create outright, so a rejected launch retries with
// the most permissive id the daemon actually offers rather than dropping --mode
// and landing on the provider default, where the agent stalls on the first
// permission prompt with nobody watching.
const MODE_FALLBACK_ORDER = [
  "yolo",
  "full-access",
  "danger-full-access",
  "bypass",
  "trusted",
  "agent",
  "build",
  "accept-edits",
];

function modeFromInvalidModeError(message) {
  const m = /available modes:\s*([^.\n"]+)/i.exec(String(message || ""));
  if (!m) return null;
  const offered = m[1].split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return MODE_FALLBACK_ORDER.find((pref) => offered.includes(pref)) || null;
}

/** Workspace ids currently registered against `cwd`; empty on any failure. */
async function workspaceIdsFor(cwd) {
  try {
    const list = lastJsonArray(await paseo(["workspace", "ls", "--json"], { timeoutMs: 30000 }));
    return new Set(list.filter((w) => w && w.cwd === cwd).map((w) => w.workspaceId));
  } catch {
    return new Set();
  }
}

function readRepairProject() {
  try {
    return JSON.parse(fs.readFileSync(REPAIR_PROJECT_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Re-register the repo as the shared repair project and persist the new id.
 * The daemon's project store is not backed up alongside REPAIR_PROJECT_FILE, so
 * the id there goes stale whenever the project is deleted (2026-09-04: it had
 * been dead since at least 09-03 and every launch was silently falling back to a
 * per-worktree cs_<hash> project). Returns null if re-registration fails.
 */
async function recreateRepairProject(cfg) {
  const repoPath = (cfg && cfg.path) || paseoConfig.repairRepoDir || process.cwd();
  const title = (cfg && cfg.title) || paseoConfig.repairProjectTitle || "Ticket Repairs";
  const created = lastJsonObject(await paseo(["project", "create", "--json", repoPath]));
  if (!created.projectId) return null;
  try {
    await paseo(["project", "rename", created.projectId, title], { timeoutMs: 30000 });
  } catch {
    // cosmetic only: the tile keeps the repo name
  }
  try {
    fs.writeFileSync(
      REPAIR_PROJECT_FILE,
      JSON.stringify({ ...(cfg || {}), projectId: created.projectId, title, path: repoPath }, null, 2)
    );
  } catch {
    // the id still works for this launch; the next one re-creates again
  }
  return created.projectId;
}

/**
 * Register `cwd` (an existing worktree) as a workspace under the shared repair
 * project and return its workspaceId, so `run --workspace` groups the agent
 * under one project tile instead of minting a cs_<hash> project. Returns null
 * (caller falls back to a plain --cwd run) when the shared project is not
 * configured or the create fails, so grouping is best-effort and never blocks a
 * repair.
 */
async function repairWorkspaceId(cwd, title) {
  const cfg = readRepairProject();
  if (!cfg || !cfg.projectId) return null;
  const create = async (projectId) => {
    const args = ["workspace", "create", "--json", "--project", projectId, "--isolation", "local", "--path", cwd];
    if (title) args.push("--title", title.slice(0, 120));
    const parsed = lastJsonObject(await paseo(args));
    return parsed.workspaceId || null;
  };
  try {
    return await create(cfg.projectId);
  } catch (e) {
    if (!/unknown project/i.test(String((e && e.message) || e))) return null;
    try {
      const projectId = await recreateRepairProject(cfg);
      return projectId ? await create(projectId) : null;
    } catch {
      return null;
    }
  }
}

/**
 * Start an agent in an already-provisioned directory.
 * Returns { agentId, workspaceId, status }.
 */
async function launchAgent({ cwd, prompt, provider, model, title, mode, images }) {
  if (!cwd) throw new Error("paseo launchAgent requires a cwd");
  if (!prompt) throw new Error("paseo launchAgent requires a prompt");

  // Everything this launch registers against `cwd`, so a create that fails
  // validation after the daemon has already minted its project + workspace can
  // be swept below instead of leaving a ghost row in the UI.
  const workspacesBefore = await workspaceIdsFor(cwd);

  // Group under the shared repair project when available; a plain --cwd run
  // (its own project) still works if this returns null.
  const workspaceId = await repairWorkspaceId(cwd, title);

  const args = ["run", "--background", "--json", "--provider", provider];
  // --workspace already carries the directory; passing --cwd as well invites the
  // daemon to resolve the path into a second workspace for the same worktree.
  if (workspaceId) args.push("--workspace", workspaceId);
  else args.push("--cwd", cwd);
  if (model) args.push("--model", model);
  if (title) args.push("--title", title.slice(0, 120));
  if (mode) args.push("--mode", mode);
  // Attach ticket screenshots as native image blocks on the initial prompt so
  // the agent never has to WebFetch expiring Discord CDN URLs (which stalls
  // cursor). Each --image is a local file path the caller already downloaded.
  for (const imgPath of Array.isArray(images) ? images : []) {
    if (imgPath) args.push("--image", imgPath);
  }
  // `--` so a prompt that happens to begin with a dash is not read as an option.
  args.push("--", prompt);

  let parsed;
  try {
    parsed = lastJsonObject(await paseo(args));
  } catch (e) {
    // Modes are provider-specific and renamed between daemon versions; an
    // invalid mode fails the whole launch, so retry on the most permissive mode
    // the daemon says it does accept, and only drop --mode if it named none.
    // (2026-09-04: a stale PASEO_REPAIR_MODE=build against the muse provider hit
    // this on every ticket, and the old bare retry then ran the repair on muse's
    // default mode.)
    if (mode && /invalid mode/i.test(String((e && e.message) || e))) {
      const without = args.filter((a, i, all) => a !== "--mode" && all[i - 1] !== "--mode");
      const offered = modeFromInvalidModeError((e && e.message) || e);
      const retryArgs = offered ? [...without.slice(0, -2), "--mode", offered, ...without.slice(-2)] : without;
      console.warn(`[paseo] invalid mode '${mode}' for ${provider}; retrying with ${offered || "provider default"}`);
      parsed = lastJsonObject(await paseo(retryArgs));
    } else {
      throw e;
    }
  }
  if (parsed.error) throw new Error(`paseo run: ${parsed.error.message || parsed.error.code}`);
  if (!parsed.agentId) throw new Error(`paseo run returned no agentId: ${JSON.stringify(parsed).slice(0, 300)}`);

  // Fail-soft: a launched agent that may prompt still beats no agent at all, and
  // providers without an `auto_accept` feature are expected to reject this.
  try {
    await enableAutoAccept(parsed.agentId);
  } catch (e) {
    console.warn(`[paseo] auto_accept not set on ${parsed.agentId}: ${e.message}`);
  }

  // Archive whatever this launch minted beyond the workspace the agent landed
  // in. A rejected create-agent keeps its workspace, so before this sweep one
  // repair showed up in the UI as two identical rows ("double spawn").
  // `paseo run --json` does not report the workspace it used, so fall back to the
  // one we registered above (the daemon reuses it; --workspace is authoritative).
  const landed = parsed.workspaceId || workspaceId || null;
  if (landed) {
    for (const wid of await workspaceIdsFor(cwd)) {
      if (wid === landed || workspacesBefore.has(wid)) continue;
      try {
        await paseo(["workspace", "archive", wid], { timeoutMs: 30000 });
        console.warn(`[paseo] archived orphan workspace ${wid} for ${cwd}`);
      } catch {
        // cosmetic; the agent is already running
      }
    }
  }

  return { agentId: parsed.agentId, workspaceId: landed, status: parsed.status || null };
}

/** Queue a follow-up message for a running or idle agent. */
async function sendPrompt(agentId, text) {
  if (!agentId) throw new Error("paseo sendPrompt requires an agentId");
  // `--prompt` rather than the positional form: the message can begin with a dash
  // or a slash, and `--no-wait` so a long repair turn does not hold this call open.
  await paseo(["send", "--no-wait", agentId, "--prompt", text]);
}

/** Best-effort teardown; used on the launch failure path, so it must not throw. */
async function killAgent(agentId) {
  if (!agentId) return false;
  try {
    await paseo(["delete", agentId], { timeoutMs: 30000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalized status, or null if the agent is gone. `paseo inspect --json` answers
 * PascalCase keys; callers should not have to know that.
 * Returns { status, mode, cwd, provider, model, pendingPermissions, archived }.
 */
async function agentStatus(agentId) {
  if (!agentId) return null;
  let raw;
  try {
    raw = lastJsonObject(await paseo(["inspect", agentId, "--json"], { timeoutMs: 30000 }));
  } catch {
    return null;
  }
  return {
    status: raw.Status || null,
    mode: raw.Mode || null,
    cwd: raw.Cwd || null,
    provider: raw.Provider || null,
    model: raw.Model || null,
    // Non-empty means the agent is stopped waiting on a human, not working.
    pendingPermissions: Array.isArray(raw.PendingPermissions) ? raw.PendingPermissions : [],
    archived: Boolean(raw.Archived),
    raw,
  };
}

/** Is the daemon up? Used to fall back to the tmux launcher rather than fail a ticket. */
async function daemonReady() {
  try {
    const parsed = lastJsonObject(await paseo(["daemon", "status", "--json"], { timeoutMs: 15000 }));
    const running = parsed.localDaemon || parsed["Local Daemon"] || parsed.status;
    return String(running).toLowerCase().includes("running");
  } catch {
    return false;
  }
}

// `paseo daemon status` costs ~3s per spawn, so the Agents page reads a cached
// answer. Control paths (ticket repair fallback) keep calling the fresh
// daemonReady() above.
let daemonStatusCache = { at: 0, value: null };
let daemonStatusInFlight = null;
async function daemonReadyCached({ maxAgeMs = 5 * 60_000 } = {}) {
  if (daemonStatusCache.value !== null && Date.now() - daemonStatusCache.at < maxAgeMs) {
    return daemonStatusCache.value;
  }
  if (daemonStatusInFlight) return daemonStatusInFlight;
  daemonStatusInFlight = daemonReady().then((value) => {
    daemonStatusCache = { at: Date.now(), value };
    return value;
  }).finally(() => { daemonStatusInFlight = null; });
  return daemonStatusInFlight;
}

module.exports = { launchAgent, sendPrompt, killAgent, agentStatus, daemonReady, daemonReadyCached, paseo, modeFromInvalidModeError };
