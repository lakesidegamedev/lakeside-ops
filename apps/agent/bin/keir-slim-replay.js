#!/usr/bin/env node
"use strict";
// Offline replay of one past ticket through the slim Keir.
//
//   keir-slim-replay.js <ticket> --out <dir> --game-repo <path> [--old-keys <file>] [--dry-run]
//
// The real messages people wrote (player, staff, owner) are delivered in
// their real order, at their real times, from the ticket history. Messages
// within 90 seconds of each other are one wake. Every write is captured;
// nothing reaches a player, Discord, GitHub or the owner. The session reads
// the game code from a checkout of main as it was when the ticket opened.
// --dry-run uses a scripted fake model (no model calls) to check the plumbing.
//
// Output: <dir>/ticket-<n>.json (inputs, every wake, the old side) and the
// session state under <dir>/state.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const ticket = Number(args[0]);
const outDir = path.resolve(opt("out", "."));
const gameRepo = opt("game-repo", process.env.KEIR_SLIM_GAME_REPO || "");
const oldKeysFile = opt("old-keys", "");
const dryRun = args.includes("--dry-run");
const BATCH_MS = 90 * 1000;

async function fullHistory(mcp, n) {
  const all = [];
  let offset = 0, head = null;
  for (let page = 0; page < 20; page++) {
    const r = await mcp.call("support", "support_history_get", { number: n, offset, limit: 300 }, false);
    head ||= r;
    all.push(...r.events);
    if (r.nextOffset == null) break;
    offset = r.nextOffset;
  }
  return { ...head, events: all };
}

function batches(events) {
  const out = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && Date.parse(e.at) - Date.parse(last[last.length - 1].at) <= BATCH_MS) last.push(e); else out.push([e]);
  }
  return out;
}

function pinnedCheckout(repo, n, openedAt, dir) {
  execFileSync("git", ["-C", repo, "fetch", "-q", "origin", "main"]);
  const sha = execFileSync("git", ["-C", repo, "rev-list", "-1", `--before=${openedAt}`, "origin/main"], { encoding: "utf8" }).trim();
  if (!fs.existsSync(path.join(dir, ".git"))) execFileSync("git", ["-C", repo, "worktree", "add", "--detach", dir, sha], { stdio: "ignore" });
  return { dir, sha };
}

async function main() {
  if (!Number.isInteger(ticket)) throw new Error("usage: keir-slim-replay.js <ticket> --out <dir> --game-repo <path>");
  fs.mkdirSync(outDir, { recursive: true });
  const env = { ...process.env, KEIR_SLIM_MODE: "replay", KEIR_SLIM_STATE_DIR: path.join(outDir, "state") };
  const { slimConfig } = require("../lib/slim/config");
  const cfg = slimConfig(env);
  const { createSlimMcp } = require("../lib/slim/mcp");
  const { readAgentToken } = require("../lib/operator/token");
  const mcp = createSlimMcp({ configFile: cfg.mcpConfig, readToken: readAgentToken(cfg.agentEnvFile), gate: (what) => { throw new Error(`${what} is refused in a replay`); } });

  const history = await fullHistory(mcp, ticket);
  const isOwner = (e) => cfg.ownerIds.includes(String(e.authorId || "")) || cfg.ownerNames.some((n) => n.length > 2 && e.who.toLowerCase().includes(n.toLowerCase()));
  const raw = history.events;
  const humans = raw
    .filter((e) => ["player_message", "staff_message", "participant_message"].includes(e.kind))
    .map((e) => ({ role: e.kind === "player_message" ? "player" : e.kind === "participant_message" ? "participant" : isOwner(e) ? "owner" : "staff", name: e.who.replace(/^(player|staff|other person)\s*/, ""), at: new Date(e.at).toISOString(), text: e.text }));
  const groups = batches(humans);

  const oldKeys = new Set(oldKeysFile ? JSON.parse(fs.readFileSync(oldKeysFile, "utf8")) : []);
  const oldSide = raw.filter((e) => e.kind === "support_post" || e.kind === "resolution" || e.kind === "refused_post").map((e) => {
    const key = String(e.id || "").split(":post:")[1] || null;
    return { at: new Date(e.at).toISOString(), kind: e.kind, by: e.kind === "support_post" ? (key && oldKeys.has(key) ? "old Keir" : /^Hi, I'm Keir\b/.test(e.text) ? "old Keir" : "coordinator or staff") : e.who, delivered: e.meta?.delivered || null, text: e.text };
  });

  const checkoutDir = path.join(gameRepo, "worktrees", `keir-replay-${ticket}`);
  const pinned = dryRun ? { dir: outDir, sha: "dry-run" } : pinnedCheckout(gameRepo, ticket, history.opened, checkoutDir);

  let cursor = groups.length ? groups[0][0].at : history.opened;
  let realStart = Date.now();
  const now = () => Date.parse(cursor) + (Date.now() - realStart);
  const wakes = [];
  const { createRuntime } = require("../lib/slim/runtime");
  const rt = createRuntime({ env, mode: "replay", mcp, ...(dryRun ? { sessions: fakeSessions() } : {}), replay: { ticket, history, getCursor: () => new Date(now()).toISOString(), checkout: pinned.dir, now }, onWake: (r) => wakes.push(r) });
  const names = [history.reporter, history.character, ...humans.filter((h) => h.role === "player").map((h) => h.name)].filter(Boolean);
  rt.host.setPlayerNames(ticket, [...new Set(names)]);

  const result = { ticket, title: history.title, opened: history.opened, closed: history.closed, checkoutSha: pinned.sha, model: `${cfg.model}@${cfg.effort}`, dryRun, inputs: humans, groups: groups.map((g) => ({ at: g[0].at, count: g.length })), oldSide, wakes };
  const save = () => fs.writeFileSync(path.join(outDir, `ticket-${ticket}.json`), JSON.stringify(result, null, 2));
  try {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      cursor = g[g.length - 1].at; realStart = Date.now();
      await rt.host.deliver(ticket, g, i === 0 ? { intro: `Title: ${history.title}. Category: ${history.category || "unknown"}.` } : {});
      save();
      // One minutes-reminder may fire before the next message arrives.
      const state = rt.store.load(ticket);
      const nextAt = groups[i + 1] ? Date.parse(groups[i + 1][0].at) : Infinity;
      if (state.reminder?.minutes && !state.closed) {
        const due = Date.parse(cursor) + state.reminder.minutes * 60000;
        if (due < nextAt && due < Date.parse(cursor) + 24 * 3600000) {
          cursor = new Date(due).toISOString(); realStart = Date.now();
          await rt.host.deliver(ticket, [{ role: "reminder", at: cursor, text: state.reminder.reason }]);
          save();
        }
      }
    }
  } finally {
    result.finalState = rt.store.load(ticket);
    save();
    rt.close();
    if (!dryRun) try { execFileSync("git", ["-C", gameRepo, "worktree", "remove", "--force", checkoutDir], { stdio: "ignore" }); } catch { /* left for cleanup */ }
  }
  console.log(JSON.stringify({ ticket, wakes: wakes.length, posts: wakes.flatMap((w) => w.effects).filter((e) => e.kind === "post").length, ruleHits: wakes.flatMap((w) => w.ruleHits).length, errors: wakes.filter((w) => w.error).length }));
}

// Dry run: a scripted model that reads the ticket, posts once and finishes.
function fakeSessions() {
  return {
    async wake(req) {
      const rpc = async (method, params) => (await (await fetch(req.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
      await rpc("initialize", {});
      await rpc("tools/call", { name: "ticket_read", arguments: {} });
      await rpc("tools/call", { name: "post_reply", arguments: { text: "Dry run reply.", kind: "update", basis: "no facts" } });
      await rpc("tools/call", { name: "finish", arguments: { next_step: "dry run", waits_on: "player" } });
      return { sessionId: "dry-run", completion: { state: "waiting" }, result: "" };
    },
  };
}

main().catch((e) => { console.error(`replay ${ticket} failed: ${e.stack || e.message}`); process.exit(1); });
