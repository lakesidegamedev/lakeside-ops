"use strict";

const fs = require("node:fs");

// Names are reviewed individually because several servers mix reads with
// production actions. Aliases use the same tools through their own registration.
// Owner, 2026-11-21: the owner's supervisor reads every read-only tool the fleet offers, at least everything the
// ticket desk can read, and without the desk's reporter-only scoping. Still closed: anything that writes, sends,
// deploys, heals, runs a simulation or scan, or reads player contact lists (comm_audience, comm_preview).
const allowed = {
  support: "support_get support_list support_search support_stats support_with_images",
  engine: "engine_health recent_turns economy_pulse",
  worldsim: "sim_list sim_run_status sim_election_status sim_balance_report sim_compare_runs sim_experiment_report sim_experiment_telemetry sim_election_report sim_economy_whatif sim_compare",
  gamestate: "game_overview countries analytics_catalog analytics_query map_snapshot geo_aggregate fx_quote entity_search parties top_players player_wealth_statistics corporation_rankings country_fiscal country_fiscal_history character_balance_sheet character_holdings character_wealth_history legislation_catalog macro_history elections extraction_market commodity_market market_history reporter_operating_results reporter_action_points " +
    "trace_character trace_account trace_corp trace_election trace_sector trace_ledger trace_bonds trace_actions trace_approval trace_race wars military_roster nomination_records alt_ring_audit alt_rank audit_query election_sim_results invariant_check",
  discord: "discord_channels discord_read",
  "ops-knowledge": "worktree_fleet_status knowledge_query knowledge_get knowledge_list knowledge_history knowledge_related knowledge_review_queue box_projects code_search code_exact code_read kanban_brief kanban_list kanban_get mcp_fleet_status mcp_capability_requests support_evidence_lookup cw_market_balance cw_snapshots",
  security: "security_audit_latest",
  community: "community_search community_ask",
  turndiag: "turn_phase_timings phase_history phase_regressions turn_anomalies lock_status turn_failure_detail",
  metroforge: "mf_status mf_cities mf_leaderboard",
  "report-publish": "list_published_reports",
  "grand-century": "gc_status",
  "seed-audit": "audit_state audit_country audit_era check_duplicates",
  tracker: "track_list track_get track_summary",
  "company-knowledge": "company_context company_search company_get company_list company_history",
  paseo: "list_workspaces get_agent_status get_agent_activity list_agents list_schedules inspect_schedule schedule_logs list_providers inspect_provider list_models list_profiles list_pending_permissions list_workspace_scripts list_terminals",
  "lean-lab": "lean_overview lean_state lean_whatif",
  "heal-ops": "heal_list heal_status heal_history heal_detect heal_verify heal_query heal_count heal_collections",
  masscomm: "comm_status",
  lore: "lore_overview lore_countries lore_country lore_world_entities lore_world_entity lore_organizations lore_historical_events lore_wiki_search lore_wiki_page lore_glossary lore_parties",
  sentry: "sentry_issues sentry_issue sentry_event_lookup sentry_player_errors sentry_new_since",
};
// Raw database reads (heal_query, heal_count) keep the ticket desk's guard: account, sign-in, contact and audit
// collections stay closed, and credential or contact fields are refused in filters and stripped from results.
const RAW_TOOLS = new Set(["heal_query", "heal_count"]);
const RAW_COLLECTION_CLOSED = /^(users?|accounts?|sessions?|auth.*|.*tokens?|.*secrets?|.*keys?|.*credentials?|.*emails?|.*passwords?|payments?|purchases?|subscriptions?|access.*log.*|request.*log.*|ip.*|devices?|admin.*)$/i;
const RAW_FIELD_CLOSED = /(email|password|passhash|hash$|token|secret|apikey|api_key|^ip$|ip_?addr|^lastip|session|phone|^address$|street|postal|mailing)/i;
function rawKeys(value, out = [], depth = 0) {
  if (depth > 12 || !value || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value)) { out.push(k); rawKeys(v, out, depth + 1); }
  return out;
}
function redact(value, hidden, depth = 0) {
  if (depth > 12 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((x) => redact(x, hidden, depth + 1));
  return Object.fromEntries(Object.entries(value).filter(([k]) => !(RAW_FIELD_CLOSED.test(k) && hidden.add(k)))
    .map(([k, x]) => [k, redact(x, hidden, depth + 1)]));
}
function rawGuard(tool, args) {
  if (!RAW_TOOLS.has(tool)) return;
  if (RAW_COLLECTION_CLOSED.test(String(args.collection || ""))) throw new Error("This collection holds account, sign-in, contact or payment data and stays closed to the private supervisor.");
  const closed = rawKeys([args.filter, args.projection, args.sort]).find((k) => RAW_FIELD_CLOSED.test(k.replace(/^.*\./, "")));
  if (closed) throw new Error(`The field ${closed} holds credentials or contact details and stays closed to the private supervisor.`);
}
function rawResult(payload) {
  const hidden = new Set();
  const parse = (item) => { try { return redact(JSON.parse(item), hidden); } catch { return item; } };
  const out = Array.isArray(payload) ? payload.map(parse) : redact(payload, hidden);
  return hidden.size ? { result: out, withheldFields: [...hidden].slice(0, 20), withheldNote: "These fields exist but are withheld as private data." } : out;
}
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
    rawGuard(tool, args);
    const entry = registrations(configPath).get(server);
    if (!entry) return { server, tool, state: "unavailable" };
    try {
      return await connect(entry, async (client, options) => {
        const result = await client.callTool({ name: tool, arguments: args }, undefined, options);
        if (result.isError) return { server, tool, state: "unavailable", note: "The MCP rejected the read. Check the tool argument schema." };
        const payload = result.structuredContent ?? result.content.filter((item) => item.type === "text").map((item) => item.text);
        const text = JSON.stringify(RAW_TOOLS.has(tool) ? rawResult(payload) : payload);
        return { server, tool, state: "read", data: text.slice(0, 16000), truncated: text.length > 16000 };
      }, signal);
    } catch { return { server, tool, state: "unavailable", note: "The MCP did not complete the read." }; }
  }

  return { catalogue, tools, read };
}

module.exports = { createStudioMcp };
