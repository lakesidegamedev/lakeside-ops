#!/usr/bin/env node
"use strict";
// Keir desk: a separate process that reads Keir's state, so it still answers when the agent loop is hung.
//   keir-desk.js <doctor|status|waiting|why|...> [ticket] [--as dev|junior|mod] [--fixture state.json] [--share]
//   keir-desk.js --http    (loopback HTTP for the game bot's /keir command; needs ASK_API_SECRET, port KEIR_DESK_PORT)
const fs = require("node:fs");
const path = require("node:path");
const { handle } = require("../lib/desk/router");
const { roleTable, settings, REQUIRED } = require("../lib/desk/config");

const SUBS = [
  ["doctor", "Why a ticket (or Keir) is stuck, and what to do", true],
  ["status", "Keir on or off, model, and ticket counts", false],
  ["waiting", "Tickets waiting on a person", false],
  ["why", "What Keir did on a ticket", true],
  ["nudge", "Make Keir look at a ticket again", true],
  ["release", "Release a ticket Keir is holding", true],
  ["pause", "Pause Keir", false],
  ["resume", "Resume Keir", false],
  ["model", "Show or set Keir's model", false],
  ["on", "Turn Keir on", false],
  ["off", "Turn Keir off", false],
];

// The bot registers /keir itself; this shape is kept for reference only.
function commandBody() {
  return {
    name: "keir", description: "Keir staff desk", dm_permission: false,
    options: SUBS.map(([name, description, ticket]) => ({
      type: 1, name, description,
      options: [
        ...(ticket ? [{ type: 4, name: "ticket", description: "Ticket number", required: name !== "doctor" }] : []),
        ...(name === "model" ? [{ type: 3, name: "name", description: "Model to use" }] : []),
        { type: 5, name: "share", description: "Show the reply to everyone in the channel" },
      ],
    })),
  };
}

const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };

async function cli(args) {
  const as = flag(args, "--as") || "mod", fixture = flag(args, "--fixture");
  const share = args.includes("--share"); if (share) args.splice(args.indexOf("--share"), 1);
  const [sub, ticket] = args;
  if (!(sub in REQUIRED)) { console.error(`usage: keir-desk.js <${Object.keys(REQUIRED).join("|")}> [ticket] [--as dev|junior|mod] [--fixture file] [--share]`); process.exit(2); }
  const table = roleTable(), role = table[as]?.[0];
  if (!role) { console.error("unknown --as"); process.exit(2); }
  const deps = fixture ? { loadState: () => { const s = JSON.parse(fs.readFileSync(path.resolve(fixture), "utf8")); s.now = s.now || Date.now(); return s; } } : {};
  const out = await handle({ command: "keir", sub, options: { ticket: ticket ? Number(ticket) : undefined, share }, member: { roles: [role] } }, deps);
  console.log(out.content);
}

// HTTP mode (owner decision 2026-11-13: /keir lives in the existing game bot, which POSTs here through Caddy).
// Loopback only. The caller proves itself with the ops dashboard's ASK_API_SECRET in X-Ask-Secret, compared in
// constant time. The body is passed straight to the router; member.id is the actor for any audit row.
function serveHttp() {
  const http = require("node:http"), crypto = require("node:crypto");
  const secret = process.env.ASK_API_SECRET || "";
  if (!secret) { console.error("ASK_API_SECRET is not set; refusing to start."); process.exit(1); }
  const expected = crypto.createHash("sha256").update(secret).digest();
  const port = Number(process.env.KEIR_DESK_PORT || 9791);
  const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
    if (req.method !== "POST" || req.url.split("?")[0] !== "/api/keir/desk/command") return send(res, 404, { error: "not found" });
    const given = crypto.createHash("sha256").update(String(req.headers["x-ask-secret"] || "")).digest();
    if (!crypto.timingSafeEqual(given, expected)) return send(res, 401, { error: "unauthorized" });
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 8192) { send(res, 413, { error: "too large" }); req.destroy(); } });
    req.on("end", async () => {
      let body; try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "invalid json" }); }
      const m = body.member || {};
      const member = { id: /^\d{15,22}$/.test(String(m.id || "")) ? String(m.id) : undefined, roles: Array.isArray(m.roles) ? m.roles.map(String).slice(0, 100) : [] };
      const o = body.options || {}, options = {};
      if (o.ticket != null && Number.isFinite(Number(o.ticket))) options.ticket = Number(o.ticket);
      if (typeof o.name === "string") options.name = o.name.slice(0, 120);
      if (o.share === true) options.share = true;
      let out;
      try { out = await handle({ command: String(body.command || "keir"), sub: String(body.sub || ""), options, member }); }
      catch { out = { content: "The desk hit an error.", ephemeral: true }; }
      send(res, 200, { content: String(out.content || "").slice(0, 1900), ephemeral: out.ephemeral !== false });
    });
  });
  server.listen(port, "127.0.0.1", () => console.log(`keir-desk listening on 127.0.0.1:${port}`));
  return server;
}

const args = process.argv.slice(2);
if (args.includes("--http")) serveHttp(); else cli(args).catch((e) => { console.error(e.message); process.exit(1); });
