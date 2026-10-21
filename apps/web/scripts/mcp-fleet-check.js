#!/usr/bin/env node
"use strict";

// Check the hosted MCP catalogue against the fleet that is actually running.
//
// The catalogue (mcp-catalog.js) is hand-written, so it drifts. On 2026-10-21
// it named 14 of the gamestate server's 36 tools and left eight hosted
// servers out of it entirely, and nothing noticed. This script asks every
// catalogued server what it exposes and reports the difference.
//
//   node scripts/mcp-fleet-check.js           report drift, exit 1 if any
//   node scripts/mcp-fleet-check.js --json    report as JSON
//
// It is read-only: it calls tools/list on each server and nothing else.

const path = require("path");
const { MCP_DEFS, localMcpUrl } = require(path.join(__dirname, "..", "mcp-catalog.js"));
const { describeServer, tokenFor } = require(path.join(__dirname, "..", "mcp", "fleet-tools.js"));

/**
 * The catalogue marks write-scoped tools with a trailing star, because a
 * read-scoped token does not see them. The live tool list has no such marker,
 * so the comparison ignores it. A star-marked tool missing from the live list
 * is expected, not drift; an unstarred one missing is drift.
 */
function catalogueTools(def) {
  return def.tools.map((raw) => {
    const name = raw.replace(/\*/g, "").split(" ")[0];
    return { name, writeScoped: raw.trim().endsWith("*") };
  }).filter((t) => t.name);
}

async function main() {
  const asJson = process.argv.includes("--json");
  const token = process.env.OPS_KNOWLEDGE_MCP_TOKEN || process.env.MCP_FLEET_TOKEN;
  if (!token) {
    console.error("no fleet token: set OPS_KNOWLEDGE_MCP_TOKEN (a read-scoped agent token)");
    process.exit(2);
  }

  const described = await Promise.all(
    MCP_DEFS.filter((d) => d.connect !== "stdio" && d.health).map((d) => describeServer(d, tokenFor(d) || token))
  );
  const stdio = MCP_DEFS.filter((d) => d.connect === "stdio" || !d.health).map((d) => d.key);
  const drift = [];
  const scopes = [];
  for (const d of described) {
    const def = MCP_DEFS.find((x) => x.key === d.key);
    if (!d.reachable) {
      drift.push({ kind: "unreachable", server: d.key, detail: d.error });
      continue;
    }
    const live = new Set(d.tools || []);
    const listed = catalogueTools(def);
    const missing = [...live].filter((t) => !listed.some((c) => c.name === t));
    const stale = listed.filter((c) => !c.writeScoped && !live.has(c.name)).map((c) => c.name);
    if (missing.length || stale.length) {
      drift.push({ kind: "tools", server: d.key, missingFromCatalogue: missing, notOnServer: stale });
    }
    // Scope inventory: the catalogue's write-scoped tools per server. The
    // servers list every tool in tools/list and refuse the write ones at call
    // time, so "listed" is not "callable"; this is an inventory, not a finding.
    const writeScoped = listed.filter((c) => c.writeScoped).map((c) => c.name);
    if (writeScoped.length) scopes.push({ server: d.key, writeScopedTools: writeScoped });
  }

  const report = {
    checkedAt: new Date().toISOString(),
    cataloguedServers: MCP_DEFS.length,
    stdioServers: stdio,
    reachable: described.filter((d) => d.reachable).length,
    liveTools: described.reduce((n, d) => n + (d.toolCount || 0), 0),
    drift,
    scopeExposure: scopes,
  };
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`checked ${report.cataloguedServers} catalogued servers, ${report.reachable} reachable, ${report.liveTools} tools live`);
    if (!drift.length) console.log("no drift: every catalogued server is reachable and its catalogue tool list matches what it exposes");
    for (const d of drift) {
      if (d.kind === "unreachable") console.log(`UNREACHABLE ${d.server}: ${d.detail}`);
      else {
        if (d.missingFromCatalogue.length) console.log(`DRIFT ${d.server}: ${d.missingFromCatalogue.length} tool(s) on the server but not in the catalogue: ${d.missingFromCatalogue.join(", ")}`);
        if (d.notOnServer.length) console.log(`DRIFT ${d.server}: ${d.notOnServer.length} catalogue tool(s) the server does not expose: ${d.notOnServer.join(", ")}`);
      }
    }
    for (const s of scopes) {
      console.log(`SCOPE ${s.server}: ${s.writeScopedTools.length} write-scoped tool(s), refused at call time without a write token: ${s.writeScopedTools.join(", ")}`);
    }
  }
  process.exit(drift.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
