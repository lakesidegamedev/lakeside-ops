// Sims MCP: every simulation tool on one server (MCP fleet consolidation,
// 2026-10-22). It replaces three servers and answers as each of them, with the
// old server name and only its tools, at /mcp/<old-name>:
//
//   /mcp/worldsim       ops-worldsim   A House Divided world and election sims
//   /mcp/metroforge     metroforge     MetroForge health, leaderboard, sidecar runs
//   /mcp/grand-century  grand-century  Grand Century status and season worldsims
//
// The worldsim tools keep their databases exactly as before: the game database
// for the live economy and sim_scenarios, the sim control-plane for simJobs.
// Clone-from-live runs only queue a job; the sim worker reads its own snapshot.
//
// Streamable HTTP + scoped bearer-token auth.
//   node mcp/sims-server.js   (default :9752)
require("dotenv").config({ quiet: true, path: require("path").join(__dirname, "..", ".env") });
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { createServer } = require("../packages/mcp-server");
const tokens = require("../agent-tokens");
const { connectWorldsim, registerWorldsimTools, buildWorldsimServer } = require("./worldsim-server");
const { registerMetroforgeTools } = require("./metroforge-tools");
const { registerGrandCenturyTools } = require("./grand-century-tools");

const PORT = parseInt(process.env.SIMS_MCP_PORT || "9752", 10);

function buildSimsServer(deps) {
  const server = new McpServer({ name: "ops-sims", version: "1.0.0" });
  registerWorldsimTools(server, deps);
  registerMetroforgeTools(server);
  registerGrandCenturyTools(server);
  return server;
}

const aliases = (deps) => ({
  worldsim: () => buildWorldsimServer(deps),
  metroforge: () => registerMetroforgeTools(new McpServer({ name: "metroforge", version: "1.0.0" })),
  "grand-century": () => registerGrandCenturyTools(new McpServer({ name: "grand-century", version: "1.0.0" })),
});

async function main() {
  const deps = await connectWorldsim();
  createServer({
    name: "sims-mcp", version: "1.0.0", port: PORT, bind: process.env.MCP_BIND || "127.0.0.1",
    authorize: (req) => tokens.validate(deps.db, req.headers.authorization),
    buildServer: () => buildSimsServer(deps),
    aliases: aliases(deps),
  });
}

if (require.main === module) {
  main().catch((e) => { console.error("[sims-mcp] fatal:", e); process.exit(1); });
}

module.exports = { buildSimsServer, aliases };
