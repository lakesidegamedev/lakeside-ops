#!/usr/bin/env node
"use strict";

// Rewrite the hosted MCP catalogue's tool lists from the fleet that is running.
//
// The catalogue is hand-written, so it drifts: on 2026-10-21 it named 14 of
// the gamestate server's 36 tools and left eight hosted servers out of it.
// This script asks each catalogued server what it exposes and rewrites that
// server's `tools:` array in mcp-catalog.js.
//
//   node scripts/mcp-catalog-sync.js           write the file
//   node scripts/mcp-catalog-sync.js --check   report what would change
//
// Write-scoped tools keep their trailing star. A star-marked tool the server
// does not expose is left alone and reported, because the star is also used
// for tools that are deliberately disabled (the catalogue says so in the name).

const fs = require("node:fs");
const path = require("path");
const { MCP_DEFS } = require(path.join(__dirname, "..", "mcp-catalog.js"));
const { describeServer } = require(path.join(__dirname, "..", "mcp", "fleet-tools.js"));

const CATALOG_PATH = path.join(__dirname, "..", "mcp-catalog.js");

function escapeForJs(text) {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Rewrite the tools array of one catalogue entry, in place, in the source. */
function rewriteEntry(source, def, tools) {
  const marker = `key: "${def.key}"`;
  const keyAt = source.indexOf(marker);
  if (keyAt === -1) return { source, changed: false, reason: "entry not found" };
  const toolsAt = source.indexOf("tools: [", keyAt);
  if (toolsAt === -1) return { source, changed: false, reason: "no tools array" };
  const open = source.indexOf("[", toolsAt);
  const close = source.indexOf("]", open);
  if (open === -1 || close === -1) return { source, changed: false, reason: "malformed tools array" };
  const rendered = tools.map((t) => `"${escapeForJs(t)}"`).join(", ");
  const next = `${source.slice(0, open)}[${rendered}]${source.slice(close + 1)}`;
  return { source: next, changed: next !== source };
}

async function main() {
  const check = process.argv.includes("--check");
  const token = process.env.OPS_KNOWLEDGE_MCP_TOKEN || process.env.MCP_FLEET_TOKEN;
  if (!token) {
    console.error("no fleet token: set OPS_KNOWLEDGE_MCP_TOKEN (a read-scoped agent token)");
    process.exit(2);
  }

  let source = fs.readFileSync(CATALOG_PATH, "utf8");
  const changes = [];
  for (const def of MCP_DEFS) {
    const described = await describeServer(def, token);
    if (!described.reachable) {
      changes.push({ server: def.key, error: described.error });
      continue;
    }
    const live = described.tools || [];
    const existing = def.tools.map((raw) => {
      const name = raw.replace(/\*/g, "").split(" ")[0];
      return { name, starred: raw.trim().endsWith("*"), raw };
    });
    // Keep the star on a tool that is still there, keep a catalogue-only
    // tool (it may be deliberately disabled), and add every live tool.
    const merged = [];
    const seen = new Set();
    for (const tool of existing) {
      merged.push(tool.raw);
      seen.add(tool.name);
    }
    for (const name of live) {
      if (seen.has(name)) continue;
      merged.push(name);
      seen.add(name);
    }
    const result = rewriteEntry(source, def, merged);
    source = result.source;
    if (result.changed) changes.push({ server: def.key, tools: merged.length });
    if (!result.changed && result.reason) changes.push({ server: def.key, error: result.reason });
  }

  if (check) {
    console.log(JSON.stringify({ changed: changes.length, changes }, null, 2));
    process.exit(0);
  }
  fs.writeFileSync(CATALOG_PATH, source);
  console.log(`catalogue tool lists updated: ${changes.map((c) => c.server).join(", ")}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
