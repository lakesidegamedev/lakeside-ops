#!/usr/bin/env node
"use strict";
// One-shot cleanup for the answer feedback row. The row belongs on the newest bot message
// of a ticket channel only; before keir 10.2.3 support-service replies kept theirs forever.
// This removes the row from every message except the newest holder in each open ticket
// channel. Dry run by default; --apply performs the edits.
//
//   keir-feedback-strip.js --mcp-config <file>              dry run over every open ticket
//   keir-feedback-strip.js --mcp-config <file> --apply      remove the stale rows
//   keir-feedback-strip.js --channels 123,456 [--apply]     explicit channel ids, no MCP needed
//
// Needs DISCORD_BOT_TOKEN in the environment (the game bot owns the rows, only it can edit
// them). --mcp-config is a JSON file with mcpServers.support { url, headers }, the same file
// keir-conversation-audit.js takes (or set KEIR_MCP_CONFIG). Flags: --pages N (100 messages
// per page, default 5), --limit N (open tickets, max 60, default 60).
const fs = require("node:fs");
const { staleHolders, holdsRow } = require("../lib/operator/feedback");

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const apply = args.includes("--apply");
const API = "https://discord.com/api/v10";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function discord(method, route, body, attempt = 0) {
  const r = await fetch(API + route, { method, headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json", "User-Agent": "KeirFeedbackStrip/1.0" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  if (r.status === 429 && attempt < 5) { const j = await r.json().catch(() => ({})); await sleep(Math.ceil((j.retry_after || 1) * 1000) + 100); return discord(method, route, body, attempt + 1); }
  if (!r.ok) throw new Error(`discord ${r.status} ${method} ${route}`);
  return r.json();
}

async function mcp(config, name, input) {
  const c = config.mcpServers?.support; if (!c) throw new Error("no support server in the MCP config");
  const url = new URL(c.url);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("MCP must be local");
  const r = await fetch(url, { method: "POST", headers: { ...c.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: input } }), signal: AbortSignal.timeout(20000) });
  let text = await r.text(); if (text.startsWith("event:")) text = text.split("\n").find((l) => l.startsWith("data: ")).slice(6);
  const res = JSON.parse(text); if (res.error || res.result?.isError) throw new Error(`MCP ${name} refused`);
  return JSON.parse(res.result.content.find((x) => x.type === "text").text);
}

async function recent(channelId, pages) {
  const out = []; let before = null;
  for (let p = 0; p < pages; p++) {
    const list = await discord("GET", `/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`);
    if (!Array.isArray(list) || !list.length) break;
    out.push(...list); before = list[list.length - 1].id;
    if (list.length < 100) break;
  }
  return out;
}

async function main() {
  if (!process.env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN must be set");
  const pages = Math.min(20, Math.max(1, Number(option("--pages", 5))));
  let targets = (option("--channels", "") || "").split(",").map((s) => s.trim()).filter(Boolean).map((channelId) => ({ channelId, ticket: null }));
  if (!targets.length) {
    const file = option("--mcp-config", process.env.KEIR_MCP_CONFIG);
    if (!file) throw new Error("give --mcp-config <file> (or --channels a,b)");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = await mcp(config, "support_list", { kind: "ticket", openOnly: true, limit: Math.min(60, Number(option("--limit", 60))) });
    for (const t of list.items || []) {
      try { const full = await mcp(config, "support_get", { kind: "ticket", number: t.number }); const c = full.conversation?.channelId || full.discordChannelId; if (/^\d{15,22}$/.test(String(c || ""))) targets.push({ channelId: c, ticket: t.number }); else console.log(`#${t.number}: no channel, skipped`); }
      catch (e) { console.log(`#${t.number}: ${e.message}`); }
    }
  }
  let rows = 0, stale = 0, done = 0, failed = 0;
  for (const { channelId, ticket } of targets) {
    try {
      const messages = await recent(channelId, pages);
      const held = messages.filter((m) => holdsRow(m));
      const ids = staleHolders(messages);
      rows += held.length; stale += ids.length;
      console.log(`${ticket ? `#${ticket} ` : ""}${channelId}: ${held.length} rows, ${ids.length} to strip${held[0] ? `, keeping ${held.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))[0].id}` : ""}`);
      if (!apply) continue;
      for (const id of ids) { try { await discord("PATCH", `/channels/${channelId}/messages/${id}`, { components: [] }); done++; } catch (e) { failed++; console.log(`  ${id}: ${e.message}`); } await sleep(300); }
    } catch (e) { failed++; console.log(`${channelId}: ${e.message}`); }
  }
  console.log(`${apply ? "APPLIED" : "DRY RUN"}: ${targets.length} channels, ${rows} rows found, ${stale} stale${apply ? `, ${done} stripped, ${failed} failed` : " (re-run with --apply to strip)"}`);
  if (failed) process.exitCode = 1;
}
main().catch((e) => { console.error(e.message); process.exit(1); });
