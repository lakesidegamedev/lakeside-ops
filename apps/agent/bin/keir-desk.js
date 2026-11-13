#!/usr/bin/env node
"use strict";
// Keir desk: a separate process that reads Keir's state, so it still answers when the agent loop is hung.
//   keir-desk.js <doctor|status|waiting|why|...> [ticket] [--as dev|junior|mod] [--fixture state.json] [--share]
//   keir-desk.js --serve   (needs KEIR_DESK_DISCORD_TOKEN and KEIR_DESK_APP_ID; otherwise CLI only)
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

function interactionToCall(i) {
  const d = i.data || {}, s = d.options?.[0] || {}, options = {};
  for (const o of s.options || []) options[o.name] = o.value;
  return { command: d.name, sub: s.name, options, member: { roles: i.member?.roles || [] } };
}

async function serve() {
  const cfg = settings();
  if (!cfg.token || !cfg.appId) { console.error("KEIR_DESK_DISCORD_TOKEN and KEIR_DESK_APP_ID are not set; the desk is CLI-only."); process.exit(1); }
  const API = "https://discord.com/api/v10";
  // The desk's own application only. POST upserts the one command by name; never a bulk PUT.
  const res = await fetch(`${API}/applications/${cfg.appId}/guilds/${cfg.guildId}/commands`, { method: "POST", headers: { authorization: `Bot ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify(commandBody()) });
  if (!res.ok) console.error(`command registration failed: HTTP ${res.status}`); else console.log("command /keir registered");
  const respond = (i, out) => fetch(`${API}/interactions/${i.id}/${i.token}/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: 4, data: { content: out.content, flags: out.ephemeral ? 64 : 0, allowed_mentions: { parse: [] } } }) }).catch((e) => console.error("reply failed", e.message));
  let backoff = 1000;
  const connect = () => {
    const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
    let timer = null, seq = null;
    ws.onmessage = async (ev) => {
      const m = JSON.parse(ev.data);
      if (m.s != null) seq = m.s;
      if (m.op === 10) {
        timer = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), m.d.heartbeat_interval);
        ws.send(JSON.stringify({ op: 2, d: { token: cfg.token, intents: 0, properties: { os: "linux", browser: "keir-desk", device: "keir-desk" } } }));
      } else if (m.op === 7 || m.op === 9) ws.close();
      else if (m.op === 0 && m.t === "READY") backoff = 1000;
      else if (m.op === 0 && m.t === "INTERACTION_CREATE" && m.d.type === 2 && m.d.data?.name === "keir") {
        let out; try { out = await handle(interactionToCall(m.d)); } catch { out = { content: "The desk hit an error.", ephemeral: true }; }
        await respond(m.d, out);
      }
    };
    ws.onclose = () => { clearInterval(timer); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); };
    ws.onerror = () => {};
  };
  connect();
}

const args = process.argv.slice(2);
if (args.includes("--serve")) serve(); else cli(args).catch((e) => { console.error(e.message); process.exit(1); });
