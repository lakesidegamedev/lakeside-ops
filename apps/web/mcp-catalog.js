// mcp-catalog.js — the single source of truth for the platform's hosted MCP
// fleet and the master "getting started" onboarding prompt.
//
// Shared by:
//   • agents-page.js   — renders the MCP directory + the Getting Started tab
//   • mcp/server.js    — exposes the same prompt via the knowledge_bootstrap
//                        tool, so off-dashboard agents (Kimi, Hermes) can
//                        self-onboard without a human pasting anything.
//
// Keep this the ONLY place the catalog is defined so the onboarding prompt can
// never drift from what's actually hosted.
//
// Public base URL comes from MCP_PUBLIC_BASE / config.mcp.publicBase
// (see src/core/paths.js). Paths below are relative to that base.

"use strict";

const { mcpPublicBase, primaryRepoDir } = require("./src/core/paths");
const { getPrimaryProject, getTenant } = require("./src/services/projectRegistry");

function mcpBase() {
  const base = mcpPublicBase();
  return base || "http://127.0.0.1:9725";
}

function mcpUrl(suffix) {
  const base = mcpBase().replace(/\/+$/, "");
  if (!suffix || suffix === "/") return `${base}/mcp`;
  return `${base}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

// Relative path after the public MCP host. Hosted fleet layout:
//   /mcp                  knowledge
//   /community/mcp        community
//   /gamestate/mcp        …
const MCP_DEFS = [
  { key: "ops-knowledge", icon: "📚", name: "Ops Knowledge", transport: "HTTP · public", health: 9725, connect: "http",
    path: "/mcp", desc: "Docs, skills & memory — semantic search + save. Scoped, token-gated.",
    tools: ["worktree_fleet_status", "knowledge_query", "knowledge_get", "knowledge_list", "knowledge_related", "knowledge_history", "knowledge_review_queue", "knowledge_bootstrap", "knowledge_feedback", "knowledge_save*", "knowledge_delete*", "code_search", "code_exact", "code_read", "box_projects", "kanban_brief", "kanban_list", "kanban_get", "kanban_add", "kanban_update", "work_report", "kanban_github_sync", "mcp_fleet_status", "mcp_capability_requests"] },
  { key: "community", icon: "🧠", name: "Community Brain", transport: "HTTP · public", health: 9729, connect: "http",
    path: "/community/mcp", desc: "Semantic search + RAG over Discord message corpus.", tools: ["community_search", "community_ask"] },
  { key: "gamestate", icon: "🗺️", name: "Game State", transport: "HTTP · public", health: 9730, connect: "http",
    path: "/gamestate/mcp", desc: "Live game world — Rust-only read-only queries, fuzzy entity discovery, focused FX, and forensic time-lines.", tools: ["game_overview", "countries", "fx_quote", "entity_search", "parties", "top_players", "elections", "trace_character", "trace_account", "trace_corp", "trace_election", "trace_sector", "trace_ledger", "extraction_market", "analytics_catalog", "analytics_query", "map_snapshot", "geo_aggregate", "player_wealth_statistics", "corporation_rankings", "country_fiscal", "character_balance_sheet", "legislation_catalog", "wars", "military_roster", "macro_history", "character_wealth_history", "trace_bonds", "alt_ring_audit", "alt_rank", "audit_query", "trace_actions", "trace_approval", "trace_race", "election_sim_results", "invariant_check"] },
  { key: "engine", icon: "🛰️", name: "Engine Observatory", transport: "HTTP · public", health: 9731, connect: "http",
    path: "/engine/mcp", desc: "Simulation health: turns, elections, economy — + Discord alerts.", tools: ["engine_health", "recent_turns", "economy_pulse"] },
  { key: "turndiag", icon: "⏱️", name: "Turn Diagnostics", transport: "HTTP · public", health: 9736, connect: "http",
    path: "/turndiag/mcp", desc: "Phase-level turn triage: per-phase timings, timing regressions, anomaly sweep, live processing-lock status.",
    tools: ["turn_phase_timings", "phase_history", "phase_regressions", "turn_anomalies", "lock_status"] },
  { key: "seed-audit", icon: "🌱", name: "Seed Audit", transport: "HTTP · public", health: 9739, connect: "http",
    path: "/seed-audit/mcp", desc: "Read-only seed-completeness + duplicate-value auditing.",
    tools: ["audit_state", "audit_country", "audit_era", "check_duplicates"] },
  { key: "worldsim", icon: "🌐", name: "World Simulator", transport: "HTTP · public", health: 9732, connect: "http",
    path: "/worldsim/mcp", desc: "What-if economy projections and headless turn-engine sim runs.",
    tools: ["sim_economy_whatif", "sim_snapshot", "sim_list", "sim_compare", "sim_run_world", "sim_run_status", "sim_balance_report", "sim_compare_runs", "sim_experiment_report", "sim_run_election", "sim_election_status", "sim_election_report", "sim_experiment_telemetry"] },
  { key: "security", icon: "🛡️", name: "Security (Semgrep)", transport: "HTTP · public", health: 9733, connect: "http",
    path: "/security/mcp", desc: "On-demand Semgrep security scans of the primary project codebase (path or diff).", tools: ["security_scan", "security_scan_changes", "security_audit_latest"] },
  { key: "railway", icon: "🚂", name: "Railway", transport: "HTTP · public", health: 9734, connect: "http",
    path: "/railway/mcp", desc: "Railway deploy status / history / logs.", tools: ["railway_status", "railway_deployments", "railway_logs"] },
  { key: "support", icon: "🎫", name: "Support", transport: "HTTP · public", health: 9735, connect: "http",
    path: "/support/mcp", desc: "Tickets & suggestions with screenshots + AI triage — for agents.", tools: ["support_list", "support_get", "support_search", "support_with_images", "support_stats", "support_set_status*", "support_resolve*", "support_update*", "support_tracker_sync*", "support_tracker_note*", "support_notify_ops_findings*", "support_notify_ops_heal*", "support_public_update", "support_audit_accounts", "support_create_investigation", "support_create_suggestion", "support_create_ticket", "support_reopen", "support_merge"] },
  { key: "discord", icon: "💬", name: "Discord", transport: "HTTP · public", health: 9727, connect: "http",
    path: "/discord/mcp", desc: "Read / list Discord channels (send disabled — use support_notify_ops_findings for ops).", tools: ["discord_channels", "discord_read", "discord_send* (disabled)"] },
  { key: "reports", icon: "📰", name: "Report Publish", transport: "HTTP · public", health: 9738, connect: "http",
    path: "/reports/mcp", desc: "Publish a finished report to the ops dashboard (write-scoped token).",
    tools: ["publish_report*", "list_published_reports", "unpublish_report*", "restart_dashboard*", "edit_report", "upload_report_image", "set_report_visibility"] },
  { key: "lore", icon: "📜", name: "Lore", transport: "HTTP · public", health: 9750, connect: "http",
    path: "/lore/mcp", desc: "The world's authored lore: countries and eras, the wider world registry, blocs and charters, the history of the eras, the player wiki and the glossary. Also serves MCP resources (lore://wiki/<slug>, lore://country/<id>) and the world_brief prompt.",
    tools: ["lore_overview", "lore_countries", "lore_country", "lore_world_entities", "lore_world_entity", "lore_organizations", "lore_historical_events", "lore_wiki_search", "lore_wiki_page", "lore_glossary", "lore_parties"] },
];

function getMcpCatalog() {
  return MCP_DEFS.map((d) => ({
    ...d,
    url: mcpUrl(d.path),
  }));
}

/** @deprecated prefer getMcpCatalog() — snapshot at require time */
const MCP_CATALOG = getMcpCatalog();

function buildGettingStarted(mcpUrlOverride) {
  const knowledgeUrl = mcpUrlOverride || mcpUrl("/mcp");
  const tenant = getTenant();
  const primary = getPrimaryProject();
  const projectName = primary?.name || tenant?.name || "the primary project";
  const repoHint = primaryRepoDir() || "(set PRIMARY_REPO_DIR / projects[].repoDir)";

  return `You are a senior engineer on the ${projectName} team.
Use the Ops Knowledge MCP (${knowledgeUrl}) as your shared brain — query before
exploring, and save runbooks/decisions after multi-step work.

Primary repo on this box: ${repoHint}

When diagnosing production issues, prefer the hosted MCP tools (gamestate,
engine, turndiag, support, railway, security) over shelling into infra.`;
}

module.exports = {
  MCP_CATALOG,
  MCP_DEFS,
  getMcpCatalog,
  buildGettingStarted,
  mcpUrl,
  mcpBase,
};
