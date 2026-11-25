"use strict";
// Outside effects for the slim Keir tools. Live adapters reach the support
// service, GitHub and the owner. Replay adapters read real data but capture
// every write, and hide anything that happened after the replay point.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

function run(cmd, args, { cwd, timeoutMs = 60000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8e6, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} ${args[0]} failed: ${String(stderr || err.message).slice(-600)}`));
      resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const REQUIRED_CHECKS = ["verify", "dependency-review", "custom-rules"];

function shared({ mcp }) {
  return {
    mcpList: (server) => mcp.list(server),
    mcpCall: (server, tool, args) => mcp.call(server, tool, args, false),
    historySearch: (args) => mcp.call("support", "support_history_search", args, false),
    historyRead: (args) => mcp.call("support", "support_history_get", args, false),
  };
}

/** Live: real posts, real PRs, real approval requests. Used only in live mode. */
function createLiveAdapters({ mcp, cfg, ticketCheckout, notifyOwner, gh = (args, o) => run("gh", args, o), git = (args, o) => run("git", args, o) }) {
  return {
    ...shared({ mcp }),
    async readTicket(n) {
      const t = await mcp.call("support", "support_get", { kind: "ticket", number: Number(n) }, false);
      delete t._images;
      return t;
    },
    async githubGet(apiPath) {
      if (!/^repos\/[A-Za-z0-9._/?=&,-]+$/.test(apiPath)) throw new Error("GET paths under repos/ only");
      return JSON.parse(await gh(["api", "-X", "GET", apiPath], { timeoutMs: 30000 }));
    },
    async post({ ticket, text }) {
      const r = await mcp.call("support", "support_public_update", { kind: "ticket", number: Number(ticket), message: text, deliver: true, update_kind: "progress", delivery_mode: "reply" }, true);
      return { delivered: r?.delivery?.status !== "failed", status: r?.delivery?.status || null };
    },
    async resolve({ ticket, message, actions, followUp }) {
      const r = await mcp.call("support", "support_resolve", { number: Number(ticket), message, actions, ...(followUp ? { followUp } : {}), source: "agent", attribution: { agent: "keir", evidence: "slim Keir session" } }, true);
      return { delivered: r?.notification?.status !== "failed", status: r?.ticket_status || null };
    },
    async approval({ ticket, kind, id, payload }) {
      // Durable first, then the owner is told. The owner's answer comes back as an event.
      const dir = path.join(cfg.stateDir, "approvals");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ ticket, kind, id, payload, at: new Date().toISOString(), status: "pending" }, null, 2), { mode: 0o600 });
      const sent = notifyOwner ? await notifyOwner({ ticket, kind, id, payload }) : { sent: false, reason: "no owner channel configured" };
      return { recorded: true, ...sent };
    },
    async openPr({ ticket, title, body, tests }) {
      const cwd = ticketCheckout(ticket);
      const branch = `keir/ticket-${Number(ticket)}`;
      await git(["-C", cwd, "checkout", "-B", branch]);
      await git(["-C", cwd, "add", "-A"]);
      await git(["-C", cwd, "commit", "-m", `${title}\n\n${body}\n\nTests: ${tests}`]);
      await git(["-C", cwd, "push", "-u", "origin", branch, "--force-with-lease"]);
      const url = (await gh(["pr", "create", "-R", cfg.gameRepoSlug, "--base", "development", "--head", branch, "--title", title, "--body", `${body}\n\nTests: ${tests}`], { cwd })).trim().split("\n").pop();
      return { opened: true, url };
    },
    async mergeToDevelopment({ pr }) {
      const n = Number(String(pr).match(/\/pull\/(\d+)/)?.[1]);
      if (!n) throw new Error("Not a pull request url");
      const info = JSON.parse(await gh(["api", `repos/${cfg.gameRepoSlug}/pulls/${n}`]));
      if (info.base?.ref !== "development") throw new Error("Only pull requests into development can be merged here.");
      const runs = JSON.parse(await gh(["api", `repos/${cfg.gameRepoSlug}/commits/${info.head.sha}/check-runs?per_page=100`])).check_runs || [];
      const missing = REQUIRED_CHECKS.filter((c) => !runs.some((r) => r.name === c && r.status === "completed" && r.conclusion === "success"));
      if (missing.length) return { merged: false, waiting: missing, note: "Required checks are not green yet. Set a reminder and come back." };
      await gh(["api", "-X", "PUT", `repos/${cfg.gameRepoSlug}/pulls/${n}/merge`, "-f", "merge_method=squash", "-f", `sha=${info.head.sha}`]);
      return { merged: true };
    },
  };
}

/**
 * Replay: the ticket as it was at `cursor` (an ISO time). Reads of this
 * ticket and of other tickets stop at the cursor; reads that only exist with
 * hindsight (the work board, notes, GitHub, the code index, which follow
 * today's code) are closed. Game data is today's, which the report says.
 * Every write is captured and answered as if it worked.
 */
function createReplayAdapters({ mcp, ticket, getCursor, history }) {
  const before = (at) => Date.parse(at) <= Date.parse(getCursor());
  const closed = (what) => async () => { throw new Error(`${what} is not available right now.`); };
  return {
    ...shared({ mcp }),
    async readTicket(n) {
      if (Number(n) !== Number(ticket)) throw new Error("Only this ticket");
      const events = (history.events || []).filter((e) => before(e.at));
      const talk = events.filter((e) => /_message$/.test(e.kind) && e.kind !== "system_message").map((e) => ({ at: e.at, who: e.who, text: e.text }));
      return { number: ticket, title: history.title, category: history.category, reporter: history.reporter, character: history.character, opened: history.opened, status: "open", conversation: talk };
    },
    async historySearch(args) {
      const cursorDay = String(getCursor()).slice(0, 10);
      const r = await mcp.call("support", "support_history_search", { ...args, until: args.until && args.until < cursorDay ? args.until : cursorDay, exclude: ticket }, false);
      // A ticket opened before the cursor may have closed after it: show what was known then.
      if (Array.isArray(r?.results)) for (const x of r.results) if (x.closed && !before(x.closed)) { x.closed = null; x.status = "open"; x.snippet = "(still open at this time)"; }
      return r;
    },
    async historyRead(args) {
      const r = await mcp.call("support", "support_history_get", args, false);
      if (r?.opened && !before(r.opened)) throw new Error(`ticket #${args.number} has no history`);
      if (Array.isArray(r?.events)) r.events = r.events.filter((e) => before(e.at));
      if (r?.closed && !before(r.closed)) { r.closed = null; r.status = "open"; }
      return r;
    },
    githubGet: closed("GitHub"),
    mcpCall: async (server, tool, args) => {
      if (server === "ops-knowledge") throw new Error("That index is not available right now; read the code in your checkout with the shell instead.");
      return mcp.call(server, tool, args, false);
    },
    post: async () => ({ delivered: true, status: "captured" }),
    resolve: async () => ({ delivered: true, status: "captured" }),
    approval: async () => ({ recorded: true, sent: false, captured: true }),
    openPr: async ({ ticket: n }) => ({ opened: true, url: `https://example.invalid/replay/ticket-${n}/pull`, captured: true }),
    mergeToDevelopment: async () => ({ merged: false, captured: true, note: "Recorded. The checks run on their own; set a reminder to come back." }),
  };
}

module.exports = { createLiveAdapters, createReplayAdapters, REQUIRED_CHECKS, run };
