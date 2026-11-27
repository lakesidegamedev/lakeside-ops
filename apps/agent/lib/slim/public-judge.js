"use strict";
// One short, fresh model wake per public mention: read-only game, code and
// site tools, then answer or skip. Nothing else can be done from here.

const fs = require("node:fs");
const path = require("node:path");
const rules = require("./rules");

const READ_SERVERS = ["gamestate", "engine", "lore"];
const WRITE_LIKE = /(?:^|_)(?:patch|apply|write|set|update|delete|send|create|run|heal|post|resolve|merge|promote|reset|grant|pay)(?:_|$)/i;

function createPublicJudge({ cfg, sessions, toolServer, adapters, post, discord, log = () => {} }) {
  const instructions = fs.readFileSync(path.join(__dirname, "PUBLIC.md"), "utf8") + "\n\n" + fs.readFileSync(path.join(__dirname, "STYLE.md"), "utf8");
  return async function judge(m) {
    let context = [];
    try { context = ((await discord("GET", `/channels/${m.channelId}/messages?before=${m.messageId}&limit=6`)) || []).reverse().map((x) => `${x.author?.bot ? "bot" : x.author?.global_name || x.author?.username}: ${String(x.content || "").slice(0, 300)}`); } catch { /* context is optional */ }
    const out = { posted: false, reason: null, text: null };
    const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
    const tools = [
      { name: "game_read", description: `Call one read-only game data tool (${READ_SERVERS.join(", ")}).`, input_schema: obj({ server: { type: "string", enum: READ_SERVERS }, tool: { type: "string" }, args: { type: "object" } }, ["server", "tool"]),
        handler: async (a) => { if (WRITE_LIKE.test(a.tool)) throw new Error("not a read"); return adapters.mcpCall(a.server, a.tool, a.args || {}); } },
      { name: "game_tools", description: "List read-only game data tools on a server.", input_schema: obj({ server: { type: "string", enum: READ_SERVERS } }, ["server"]),
        handler: async ({ server }) => (await adapters.mcpList(server)).filter((t) => !WRITE_LIKE.test(t.name)).map((t) => ({ name: t.name, description: String(t.description || "").slice(0, 300) })) },
      { name: "code_search", description: "Search the game's code and docs (live branch).", input_schema: obj({ question: { type: "string" } }, ["question"]),
        handler: async ({ question }) => adapters.mcpCall("ops-knowledge", "code_search", { question, source: "prod", topK: 5, maxChars: 10000 }) },
      { name: "site_read", description: "Read a public game page as a logged-out visitor.", input_schema: obj({ path: { type: "string" } }, ["path"]),
        handler: async (a) => adapters.siteRead(a) },
      { name: "answer", description: "Post one short public reply to the message. Only for a clear game question you confirmed.", input_schema: obj({ text: { type: "string" }, basis: { type: "string", description: "what you checked" } }, ["text", "basis"]),
        handler: async ({ text, basis }) => {
          if (out.posted) throw new Error("Already answered.");
          const shaped = rules.shape(text);
          const problems = [...rules.checkPost(shaped, { kind: "resolution", state: { posts: [], receipts: { fixLive: [], paid: [] } }, names: [m.authorName].filter(Boolean), ownerNames: cfg.ownerNames, ownerPrivateNames: cfg.ownerPrivateNames }).problems];
          for (const n of [...(cfg.ownerNames || []), ...(cfg.ownerPrivateNames || [])].filter((x) => x && !/^the /i.test(x))) if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(shaped)) problems.push({ rule: "owner_name", match: n, fix: "Never name the owner in public. Say \"the team\"." });
          if (shaped.length > 700 || rules.sentences(shaped).length > 5) problems.push({ rule: "length", match: `${shaped.length} characters`, fix: "Two to four short sentences." });
          if (!String(basis || "").trim()) problems.push({ rule: "basis", match: "", fix: "Say what you checked." });
          if (problems.length) return { posted: false, problems, note: "Fix these and answer again, or skip." };
          await post(m, shaped);
          Object.assign(out, { posted: true, text: shaped, reason: `answered: ${String(basis).slice(0, 200)}` });
          ctx.finished = { state: "done", summary: "answered" };
          return { posted: true };
        } },
      { name: "skip", description: "Do not answer. Give the reason.", input_schema: obj({ reason: { type: "string" } }, ["reason"]),
        handler: async ({ reason }) => { out.reason = String(reason).slice(0, 300); ctx.finished = { state: "done", summary: "skipped" }; return { ok: true }; } },
      { name: "finish", description: "End. Use after answer or skip.", input_schema: obj({}),
        handler: async () => { ctx.finished ||= { state: "done", summary: out.posted ? "answered" : "skipped" }; return { ok: true }; } },
    ];
    const ctx = { finished: null, finishOnAny: true };
    const endpoint = await toolServer.open({ tools, ctx });
    try {
      // Each mention is its own short conversation: nothing carries between mentions.
      const r = await sessions.wake({
        ticket: 0, sessionId: null, cwd: cfg.stateDir, sandbox: "read-only", instructions,
        prompt: [`Channel #${m.channelName}. ${m.authorName || "Someone"} wrote:`, String(m.content || "").slice(0, 1500), context.length ? `\nEarlier in the channel:\n${context.join("\n")}` : "", "\nDecide: answer (after checking) or skip. Then finish."].join("\n"),
        url: endpoint.url, completionUrl: endpoint.completionUrl, timeoutMs: 180000,
      });
      if (!out.posted && !out.reason) out.reason = r?.timedOut ? "timed out without deciding" : "ended without deciding";
    } finally { endpoint.close(); }
    return out;
  };
}

module.exports = { createPublicJudge };
