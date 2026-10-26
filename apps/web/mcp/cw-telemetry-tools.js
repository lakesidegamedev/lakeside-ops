"use strict";

// Corporate Warfare market-balance tools for the ops-knowledge MCP. Reads the snapshots the
// game uploads every five weeks (../cw-telemetry-store.js). Read-only; any valid token.

const { z } = require("zod");
const { sharedTelemetry } = require("../cw-telemetry-store");

function registerCwTelemetryTools(server, { jsonResult, errorResult, store = sharedTelemetry }) {
  server.tool(
    "cw_market_balance",
    "Corporate Warfare market balance from anonymous player snapshots: per good the median made, sold, imported, exported and held lots and asking price against reference; installs and snapshots counted; how many player companies lost money over their last 13 weeks. Filter by days, scenario (guided, founder) and engine version.",
    {
      days: z.number().int().min(1).max(90).optional().default(7),
      scenario: z.string().optional(),
      engine_version: z.string().optional(),
    },
    async ({ days, scenario, engine_version }) => {
      try {
        return jsonResult(store().balance({ days, scenario: scenario || null, engineVersion: engine_version || null }));
      } catch (error) {
        console.error("[cw-telemetry-mcp]", error);
        return errorResult(`cw telemetry error: ${error.message}`);
      }
    },
  );

  server.tool(
    "cw_snapshots",
    "Raw Corporate Warfare market-balance snapshots, newest first (install id, app and engine version, scenario, seed, week, payload).",
    {
      days: z.number().int().min(1).max(90).optional().default(7),
      limit: z.number().int().min(1).max(200).optional().default(20),
    },
    async ({ days, limit }) => {
      try {
        return jsonResult(store().recent({ days, limit }));
      } catch (error) {
        return errorResult(`cw telemetry error: ${error.message}`);
      }
    },
  );
}

module.exports = { registerCwTelemetryTools };
