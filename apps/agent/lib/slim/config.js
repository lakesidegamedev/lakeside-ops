"use strict";
// Slim Keir (2026-11-25 design): one continuing agent session per ticket.
//
// Off by default. KEIR_SLIM_MODE selects what the host may do:
//   off     nothing runs (default; also any unknown value)
//   replay  offline: real reads, every write captured to a transcript,
//           nothing reaches players, Discord, GitHub or the owner
//   live    posts and approvals go out (stage 4, only on the owner's go)
// The shared kill switch (KEIR_KILL_SWITCH_FILE, the same file old Keir uses)
// stops every outside effect in every mode.

const path = require("node:path");

const MODES = new Set(["off", "replay", "live"]);
const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

function slimConfig(env = process.env) {
  const mode = MODES.has(String(env.KEIR_SLIM_MODE || "").trim()) ? String(env.KEIR_SLIM_MODE).trim() : "off";
  const stateDir = env.KEIR_SLIM_STATE_DIR || "/var/lib/keir-slim";
  return {
    mode,
    stateDir,
    killSwitchFile: env.KEIR_KILL_SWITCH_FILE || "/var/lib/keir-operator/kill-switch",
    // Keep the model Keir uses today (codex Sol, low) unless told otherwise.
    model: env.KEIR_SLIM_MODEL || "gpt-6.2-sol",
    effort: env.KEIR_SLIM_EFFORT || "low",
    codexBin: env.KEIR_SLIM_CODEX_BIN || "",
    autoCompactTokens: Number(env.KEIR_SLIM_COMPACT_TOKENS) || 160000,
    wakeTimeoutMs: Math.min(3600000, Number(env.KEIR_SLIM_WAKE_TIMEOUT_MS) || 20 * 60000),
    // A hard ceiling per ticket: past it the ticket pauses and the coordinator is told.
    budget: {
      wakesPerDay: Number(env.KEIR_SLIM_WAKES_PER_DAY) || 40,
      minutesPerTicket: Number(env.KEIR_SLIM_MINUTES_PER_TICKET) || 300,
    },
    gameRepo: env.KEIR_SLIM_GAME_REPO || "",
    gameRepoSlug: env.KEIR_SLIM_GAME_REPO_SLUG || "lakesidegamedev/AHDGame",
    // The game's auto-promoter: development -> staging -> main on green.
    // The deployer's record of production deploys (one JSON line per deploy).
    deployReleasesFile: env.KEIR_SLIM_DEPLOY_RELEASES || "/var/lib/autodeploy/ahd-us-releases.jsonl",
    autoPromoteTimer: env.KEIR_SLIM_AUTO_PROMOTE_TIMER || "ahd-auto-promote.timer",
    autoPromoteOffFile: env.KEIR_SLIM_AUTO_PROMOTE_OFF_FILE || "/etc/lakeside-platform/ahd-auto-promote.off",
    worktreeRoot: env.KEIR_SLIM_WORKTREE_ROOT || path.join(stateDir, "worktrees"),
    ownerIds: list(env.KEIR_OWNER_ID),
    // Discord handles of the owner, used only when a message has no author id.
    ownerHandles: list(env.KEIR_SLIM_OWNER_HANDLES),
    // The owner's direct-message channel with Keir's bot: approval cards go here.
    ownerDmChannel: env.KEIR_SLIM_OWNER_DM_CHANNEL || "",
    pollMs: Math.max(5000, Number(env.KEIR_SLIM_POLL_MS) || 20000),
    // Fast pickup: how often to ask Discord whether a person wrote in an open ticket.
    fastPollMs: Math.max(2000, Number(env.KEIR_SLIM_FAST_POLL_MS) || 4000),
    maxConcurrentWakes: Math.max(1, Number(env.KEIR_SLIM_MAX_WAKES) || 3),
    // Names that refer to the owner in player copy. The owner's own name never goes in a post.
    ownerNames: list(env.KEIR_SLIM_OWNER_NAMES || "the owner"),
    ownerPrivateNames: list(env.KEIR_SLIM_OWNER_PRIVATE_NAMES),
    staffIds: list([env.KEIR_SUPPORT_DELEGATES, env.TICKET_HISTORY_STAFF_IDS].filter(Boolean).join(",")),
    mcpConfig: env.KEIR_MCP_CONFIG || path.join(process.env.HOME || "/root", ".claude.json"),
    agentEnvFile: env.KEIR_AGENT_ENV_FILE || "/etc/keir-agent.env",
  };
}

/** Whether anything may leave this box: live mode and the kill switch clear. */
function mayAct(cfg, killSwitch) {
  return cfg.mode === "live" && !killSwitch.state().engaged;
}

module.exports = { slimConfig, mayAct, MODES };
