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
//
// `connect` says how an agent reaches the server:
//   "http"   public route on the MCP host, reachable from anywhere with a token
//   "local"  on this box only (127.0.0.1), for the internal fleet
//   "stdio"  a local process launched by the agent
//
// Every MCP server this box hosts is listed here, public or internal. The
// catalogue is what the drift check compares the live fleet against, so a
// server that is missing from it is a server nobody is watching.
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
  { key: "tracker", icon: "🧭", name: "Tracker", transport: "HTTP · public", health: 9741, connect: "http",
    path: "/tracker/mcp", desc: "The long-running tracker: projects, goals, tasks, checks and notes, keyed so work outlives the session that started it.",
    tools: ["track_upsert", "track_list", "track_get", "track_note", "track_summary"] },
  { key: "lean-lab", icon: "📐", name: "Lean Lab", transport: "HTTP · public", health: 9746, connect: "http",
    path: "/lean-lab/mcp", desc: "Per-state electoral-lean dashboard for a country and era: electorate measurement, seed tuning and the run record.",
    tools: ["lean_overview", "lean_state", "lean_whatif", "lean_solve", "lean_patch"] },

  // ── Internal fleet: this box only. Not reachable from the public host. ─────
  { key: "heal-ops", icon: "🩹", name: "Heal Ops", transport: "HTTP · on-box", health: 9747, connect: "local",
    desc: "Paired remediation: the code fix and the data heal for a defect in the remediation ledger, with the environments each one touches.",
    tools: ["heal_list", "heal_status", "heal_detect", "heal_plan", "heal_apply", "heal_verify", "heal_history", "heal_rollback", "heal_query", "heal_count", "heal_collections", "heal_adhoc_plan", "heal_adhoc_apply", "heal_compensate_plan", "heal_compensate_apply", "heal_scaffold", "heal_indexes"] },
  { key: "masscomm", icon: "📣", name: "Mass Communications", transport: "HTTP · on-box", health: 9748, connect: "local",
    desc: "Player announcements: resolve the audience from prod users, dry run it, and send.",
    tools: ["comm_audience", "comm_preview", "comm_send", "comm_status"] },
  { key: "company-knowledge", icon: "🏢", name: "Company Knowledge", transport: "HTTP · on-box", health: 9761, connect: "local",
    desc: "The Lakeside company knowledge scope: what the company knows about itself and where that knowledge lives.",
    tools: ["company_context", "company_search", "company_get", "company_list", "company_save", "company_history", "company_archive"] },
  { key: "lakeside-hub", icon: "🗄️", name: "Lakeside Hub", transport: "HTTP · on-box", health: 9745, connect: "local",
    desc: "The company and product hub: the brief, the next move, owner decisions, blockers, and the product kanban it keeps.",
    tools: ["hub_brief", "hub_work_report", "hub_summary", "hub_kanban_list", "hub_kanban_add", "hub_kanban_update", "hub_github_sync", "hub_execution_report"] },
  { key: "metroforge", icon: "🛠️", name: "MetroForge", transport: "HTTP · on-box", health: 9737, connect: "local",
    desc: "MetroForge repo and live deploy health: the current SHA, branch, dirty state and the deploy history.",
    tools: ["mf_status", "mf_cities", "mf_leaderboard", "mf_smoke", "mf_sim_run"] },
  { key: "grand-century", icon: "🏛️", name: "Grand Century", transport: "HTTP · on-box", health: 9740, connect: "local",
    desc: "Grand Century repo and live deploy health: the current SHA, branch, dirty state and the deploy history.",
    tools: ["gc_status", "gc_worldsim"] },
  { key: "paseo", icon: "🚶", name: "Paseo Agents", transport: "HTTP · on-box", health: 6767, connect: "local",
    localPath: "/mcp/agents",
    desc: "The Paseo agent registry: the coding agents on this box, their workspaces, and the sessions they are running.",
    tools: ["create_workspace", "list_workspaces", "archive_workspace", "create_agent", "send_agent_prompt", "get_agent_status", "list_agents", "cancel_agent", "archive_agent", "kill_agent", "update_agent", "rename_workspace", "list_workspace_scripts", "start_workspace_script", "stop_workspace_script", "list_terminals", "create_terminal", "kill_terminal", "capture_terminal", "send_terminal_keys", "create_schedule", "create_heartbeat", "delete_heartbeat", "list_schedules", "inspect_schedule", "pause_schedule", "resume_schedule", "delete_schedule", "update_schedule", "schedule_logs", "run_schedule_once", "list_providers", "list_models", "list_profiles", "inspect_provider", "get_agent_activity", "set_agent_mode", "list_pending_permissions", "respond_to_permission"] },
  { key: "glitchtip", icon: "🐛", name: "Glitchtip", transport: "stdio", health: null, connect: "stdio",
    url: "@karsten684/glitchtip-mcp-server",
    desc: "A House Divided error tracking: the issues players hit, with the stack traces.",
    tools: [] },
];

/** The on-box URL of a server the fleet check and the agents page reach. */
function localMcpUrl(d) {
  if (!d || !d.health) return null;
  return `http://127.0.0.1:${d.health}${d.localPath || "/mcp"}`;
}

function getMcpCatalog() {
  return MCP_DEFS.map((d) => ({
    ...d,
    // A stdio server is launched by a command, not reached at a URL, so its
    // own url is kept as it is.
    url: d.path ? mcpUrl(d.path) : d.url,
    localUrl: d.connect === "local" ? localMcpUrl(d) : null,
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
  localMcpUrl,
};
