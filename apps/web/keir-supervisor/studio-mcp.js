"use strict";

const fs = require("node:fs");

// Names are reviewed individually because several servers mix reads with
// production actions. Aliases use the same tools through their own registration.
const allowed = {
  support: "support_list support_search support_stats support_with_images",
  engine: "engine_health recent_turns economy_pulse",
  worldsim: "sim_list sim_run_status sim_election_status sim_balance_report sim_compare_runs sim_experiment_report sim_experiment_telemetry sim_election_report",
  gamestate: "game_overview countries analytics_catalog analytics_query map_snapshot geo_aggregate fx_quote entity_search parties top_players player_wealth_statistics corporation_rankings country_fiscal country_fiscal_history character_balance_sheet legislation_catalog macro_history elections extraction_market commodity_market market_history reporter_operating_results reporter_action_points",
  discord: "discord_channels discord_read",
  "ops-knowledge": "worktree_fleet_status knowledge_query knowledge_get knowledge_list knowledge_history knowledge_related box_projects code_search code_exact code_read kanban_brief kanban_list kanban_get mcp_fleet_status support_evidence_lookup",
  security: "security_audit_latest",
  community: "community_search",
  turndiag: "turn_phase_timings phase_history phase_regressions turn_anomalies lock_status turn_failure_detail",
  metroforge: "mf_status mf_cities mf_leaderboard",
  "report-publish": "list_published_reports",
  "grand-century": "gc_status",
  "seed-audit": "audit_state audit_country audit_era check_duplicates",
  tracker: "track_list track_get track_summary",
  "company-knowledge": "company_context company_search company_get company_list company_history",
  paseo: "list_workspaces get_agent_status list_agents list_schedules inspect_schedule schedule_logs list_providers list_models list_profiles list_pending_permissions",
  "lean-lab": "lean_overview lean_state lean_whatif",
  "heal-ops": "heal_list heal_status heal_history",
  masscomm: "comm_status",
  lore: "lore_overview lore_countries lore_country lore_world_entities lore_world_entity lore_organizations lore_historical_events lore_wiki_search lore_wiki_page lore_glossary lore_parties",
  sentry: "sentry_issues sentry_issue sentry_new_since",
};
const policy = Object.fromEntries(Object.entries(allowed).map(([server, names]) => [server, new Set(names.split(" "))]));
const combine = (...servers) => new Set(servers.flatMap((server) => [...policy[server]]));
policy.game = combine("gamestate", "engine", "lore", "turndiag", "seed-audit", "lean-lab");
policy.sims = combine("worldsim", "metroforge", "grand-century");
policy.comms = combine("discord", "community", "masscomm");
policy["ops-knowledge"] = combine("ops-knowledge", "tracker", "company-knowledge", "report-publish");

function registrations(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return new Map(Object.entries(config.mcpServers || {}).filter(([, entry]) => {
      try {
        const url = new URL(entry.url);
        return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
          !url.username && !url.password;
      } catch { return false; }
    }));
  } catch { return new Map(); }
}

async function request(entry, operation, parentSignal) {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const deadline = AbortSignal.timeout(15000);
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
  const client = new Client({ name: "private-keir", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
    requestInit: { headers: entry.headers },
    fetch: (url, options) => fetch(url, { ...options, signal, redirect: "error" }),
  });
  try {
    await client.connect(transport, { signal });
    return await operation(client, { signal });
  } finally {
    if (transport.sessionId && !signal.aborted) await transport.terminateSession().catch(() => {});
    await client.close();
  }
}

function createStudioMcp({ configPath, connect = request }) {
  function catalogue() {
    return { servers: [...registrations(configPath).keys()].sort().map((server) => ({
      server, readsConfigured: Object.hasOwn(policy, server),
    })) };
  }

  async function tools(server, signal) {
    const entry = registrations(configPath).get(server);
    if (!entry) return { server, state: "unavailable" };
    const reads = Object.hasOwn(policy, server) ? policy[server] : null;
    if (!reads) return { server, state: "available", tools: [] };
    try {
      return await connect(entry, async (client, options) => {
        const found = [];
        let cursor;
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, options);
          found.push(...page.tools.filter((tool) => reads.has(tool.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
          cursor = page.nextCursor;
        } while (cursor);
        return { server, state: "available", tools: found };
      }, signal);
    } catch { return { server, state: "unavailable", note: "The MCP did not return its tool catalogue." }; }
  }

  async function read(server, tool, args = {}, signal) {
    if (!Object.hasOwn(policy, server) || !policy[server].has(tool)) throw new Error("This tool is outside the private supervisor's MCP read catalogue.");
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments must be an object");
    const entry = registrations(configPath).get(server);
    if (!entry) return { server, tool, state: "unavailable" };
    try {
      return await connect(entry, async (client, options) => {
        const result = await client.callTool({ name: tool, arguments: args }, undefined, options);
        if (result.isError) return { server, tool, state: "unavailable", note: "The MCP rejected the read. Check the tool argument schema." };
        const text = JSON.stringify(result.structuredContent ?? result.content.filter((item) => item.type === "text").map((item) => item.text));
        return { server, tool, state: "read", data: text.slice(0, 16000), truncated: text.length > 16000 };
      }, signal);
    } catch { return { server, tool, state: "unavailable", note: "The MCP did not complete the read." }; }
  }

  return { catalogue, tools, read };
}

module.exports = { createStudioMcp };
