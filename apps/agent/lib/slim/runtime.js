"use strict";
// Assemble a slim Keir host. Nothing here starts on its own: a caller (the
// replay runner now, the live intake in stage 4) builds a runtime and delivers
// events to it. Live effects need KEIR_SLIM_MODE=live and a clear kill switch.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { slimConfig } = require("./config");
const S = require("./state");
const { createHost } = require("./host");
const { createSlimToolServer } = require("./toolserver");
const { createCodexSessions } = require("./codex-session");
const { createLiveAdapters, createReplayAdapters } = require("./adapters");
const { createKillSwitch } = require("../operator/killswitch");

function createMcpClient(cfg) {
  const { createSlimMcp } = require("./mcp");
  const { readAgentToken } = require("../operator/token");
  const killSwitch = createKillSwitch({ file: cfg.killSwitchFile });
  return createSlimMcp({ configFile: cfg.mcpConfig, readToken: readAgentToken(cfg.agentEnvFile), gate: (what) => { if (cfg.mode !== "live") throw new Error(`${what} is refused outside live mode`); killSwitch.assertClear(what); } });
}

/** One game checkout per ticket, on development. Code is written only here. */
function liveCheckout(cfg) {
  return (ticket) => {
    const dir = path.join(cfg.worktreeRoot, `keir-slim-ticket-${Number(ticket)}`);
    if (!fs.existsSync(path.join(dir, ".git"))) {
      if (!cfg.gameRepo) throw new Error("KEIR_SLIM_GAME_REPO is not set");
      fs.mkdirSync(cfg.worktreeRoot, { recursive: true });
      execFileSync("git", ["-C", cfg.gameRepo, "fetch", "-q", "origin", "development"]);
      execFileSync("git", ["-C", cfg.gameRepo, "worktree", "add", "-B", `keir/ticket-${Number(ticket)}`, dir, "origin/development"], { stdio: "ignore" });
      // The sandbox has no network: share the main checkout's installed dependencies.
      const modules = path.join(cfg.gameRepo, "node_modules");
      if (fs.existsSync(modules) && !fs.existsSync(path.join(dir, "node_modules"))) fs.symlinkSync(modules, path.join(dir, "node_modules"));
    }
    return dir;
  };
}

/**
 * mode "live": real adapters. mode "replay": opts.replay = { ticket, history,
 * getCursor, checkout } and every write is captured.
 */
function createRuntime({ env = process.env, mode, replay, onWake, onEffect, log = console.error, mcp, sessions: injectedSessions, notifyOwner: injectedNotify } = {}) {
  const cfg = { ...slimConfig(env), ...(mode ? { mode } : {}) };
  if (cfg.mode === "off") throw new Error("KEIR_SLIM_MODE is off");
  if (cfg.mode === "replay" && !replay) throw new Error("replay mode needs the replay inputs");
  const client = mcp || createMcpClient(cfg);
  const killSwitch = createKillSwitch({ file: cfg.killSwitchFile });
  const store = S.createFileStore(path.join(cfg.stateDir, "tickets"));
  const sessions = injectedSessions || createCodexSessions({ stateDir: cfg.stateDir, model: cfg.model, effort: cfg.effort, compactTokens: cfg.autoCompactTokens, codexBin: cfg.codexBin || undefined });
  const toolServer = createSlimToolServer();
  const checkout = cfg.mode === "replay" ? () => replay.checkout : liveCheckout(cfg);
  // Approval cards go through the injected notifier (the owner's direct messages, bin/keir-slim-serve.js).
  const notifyOwner = injectedNotify || (async () => ({ sent: false, reason: "no owner notifier configured" }));

  const adaptersFor = (ticket) => cfg.mode === "replay"
    ? createReplayAdapters({ mcp: client, ticket, getCursor: replay.getCursor, history: replay.history })
    : createLiveAdapters({ mcp: client, cfg, ticketCheckout: checkout, notifyOwner });
  const host = createHost({
    cfg, store, sessions, toolServer, adaptersFor, killSwitch, checkoutFor: checkout,
    sandboxFor: () => (cfg.mode === "live" ? "workspace-write" : "read-only"),
    now: replay?.now || (() => Date.now()),
    log, onWake, onEffect,
    alert: async ({ ticket, reason }) => log(`[keir-slim] ticket ${ticket} paused: ${reason}`),
  });
  return { cfg, host, store, killSwitch, toolServer, sessions, adaptersFor, close: () => toolServer.close() };
}

module.exports = { createRuntime, liveCheckout };
