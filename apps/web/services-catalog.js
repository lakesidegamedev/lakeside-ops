// services-catalog.js — searchable index of ops pages + configured external links.
// Powers the dashboard command palette / search.
"use strict";

const { listExternalLinks } = require("./src/services/externalLinks");
const { listGames, getPrimaryProject } = require("./src/services/projectRegistry");
const { isEnabled } = require("./src/services/featureFlags");

const BASE_PAGES = [
  { id: "dashboard", name: "Dashboard", desc: "Overview, KPIs, system health", url: "/", icon: "home", group: "Ops", keywords: ["home", "overview", "kpi", "metrics"] },
  { id: "reports", name: "Daily Reports", desc: "AI daily operations reports + actions", url: "/reports", icon: "newspaper", group: "Ops", keywords: ["report", "summary", "daily", "exec", "actions"] },
  { id: "engine", name: "Engine Observatory", desc: "Simulation health — turns, elections, economy", url: "/engine", icon: "cpu", group: "Ops", keywords: ["engine", "turns", "simulation", "elections", "economy", "health"] },
  { id: "status", name: "Uptime / Status", desc: "Service status page", url: "/status", icon: "activity", group: "Ops", feature: "statusPage", keywords: ["uptime", "status", "down", "outage", "health"] },
  { id: "db", name: "Database", desc: "Browse MongoDB collections", url: "/db", icon: "database", group: "Data", feature: "dbBrowser", keywords: ["mongo", "database", "collections", "data", "query"] },
  { id: "backups", name: "Backups", desc: "Database backups", url: "/backups", icon: "folder", group: "Data", feature: "backups", keywords: ["backup", "restore", "snapshot", "dump"] },
  { id: "wiki-export", name: "Wiki Export", desc: "Download the wiki as Markdown or JSON", url: "/wiki-export", icon: "download", group: "Data", feature: "wikiExport", keywords: ["wiki", "export", "download", "knowledge", "pages", "markdown"] },
  { id: "tickets", name: "Tickets", desc: "Support tickets + triage", url: "/tickets", icon: "life-buoy", group: "Support", feature: "tickets", keywords: ["ticket", "support", "bug", "triage", "report"] },
  { id: "suggestions", name: "Suggestions", desc: "Player suggestions review", url: "/suggestions", icon: "lightbulb", group: "Support", feature: "tickets", keywords: ["suggestion", "idea", "feature", "request"] },
  { id: "ask", name: "Ask", desc: "Ask the AI about the primary project codebase", url: "/ask", icon: "message", group: "Tools", keywords: ["ask", "ai", "codebase", "question", "how"] },
  { id: "code", name: "Code Agent", desc: "Autonomous coding sessions (PRs)", url: "/code", icon: "code", group: "Tools", feature: "codeAgent", keywords: ["code", "agent", "fix", "pr"] },
  { id: "ideas", name: "Ideas", desc: "Semantic search over community messages", url: "/ideas", icon: "lightbulb", group: "Tools", feature: "ideas", keywords: ["ideas", "discord", "community", "search", "rag"] },
  { id: "community-voice", name: "Community Voice", desc: "Markov mimicry and word clouds", url: "/community-voice", icon: "message-circle", group: "Tools", feature: "discordInsights", keywords: ["markov", "word cloud", "discord", "community", "voice"] },
  { id: "scheduler", name: "Work Scheduler", desc: "Heavy checks, builds, and world simulations", url: "/scheduler", icon: "activity", group: "Tools", keywords: ["scheduler", "queue", "test", "typecheck", "build", "worldsim"] },
  { id: "security", name: "Security", desc: "Host hardening, firewall, fail2ban and audit posture for both VPS hosts", url: "/security", icon: "shield", group: "Monitor", keywords: ["security", "hardening", "fail2ban", "firewall", "ufw", "auditd", "ssh", "posture", "vps"] },
];

function buildCatalog() {
  const pages = BASE_PAGES.filter((p) => !p.feature || isEnabled(p.feature));
  const external = listExternalLinks().map((l) => ({
    id: l.id || l.href,
    name: l.label,
    desc: l.desc || l.label,
    url: l.href,
    icon: l.icon || "external-link",
    group: l.group || "External",
    ext: true,
    keywords: l.keywords || [],
  }));
  const games = listGames().map((g) => ({
    id: `game-${g.key}`,
    name: g.name,
    desc: g.tagline || g.name,
    url: g.publicUrl,
    icon: "globe",
    group: "Games",
    ext: true,
    keywords: [g.key, "game"],
  }));
  const primary = getPrimaryProject();
  if (primary?.publicUrl && !games.some((g) => g.url === primary.publicUrl)) {
    games.unshift({
      id: "primary-site",
      name: primary.name,
      desc: "Primary project site",
      url: primary.publicUrl,
      icon: "globe",
      group: "Games",
      ext: true,
      keywords: ["game", "site", "live"],
    });
  }
  return [...pages, ...external, ...games];
}

/** @deprecated snapshot — prefer getCatalog() */
const CATALOG = buildCatalog();

function getCatalog() {
  return buildCatalog();
}

function keywordSearch(q) {
  const t = q.toLowerCase().trim();
  if (!t) return [];
  const terms = t.split(/\s+/);
  const scored = getCatalog().map((c) => {
    const hay = (c.name + " " + c.desc + " " + (c.keywords || []).join(" ")).toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (c.name.toLowerCase().includes(term)) score += 5;
      if ((c.keywords || []).some((k) => k === term)) score += 4;
      if (hay.includes(term)) score += 1;
    }
    return { ...c, score };
  }).filter((c) => c.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 20);
}

module.exports = { CATALOG, getCatalog, keywordSearch };
