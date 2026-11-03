"use strict";

// Dashboard authorization is separate from game privileges. Only this exact
// opsRole value grants Junior Developer access; account role stays unchanged.
function opsStaffRole(user) {
  if (!user || user.isBanned === true) return null;
  if (user.isAdmin === true) return "admin";
  if (user.opsRole === "junior_dev") return "junior_dev";
  if (user.isModerator === true) return "moderator";
  return null;
}

const JUNIOR_NAV = [{ label: "Development", items: [
  { href: "/", label: "Junior Developer", icon: "home" },
  { href: "/kanban", label: "Work board", icon: "check-square" },
  { href: "/project-guide", label: "Project guide", icon: "book-open" },
  { href: "https://docs.lakesidegames.net", label: "Technical docs", icon: "book-open", ext: true },
  { href: "/economy", label: "Economy", icon: "trending-up" },
  { href: "/reports", label: "Economy reports", icon: "newspaper" },
  { href: "/engine", label: "Engine diagnostics", icon: "activity" },
] }];

const JUNIOR_READ_PATHS = new Set([
  "/", "/apps", "/kanban", "/api/kanban", "/api/kanban/brief",
  "/project-guide", "/api/project-guide", "/reports", "/economy", "/commodity-report",
  "/reports/extraction-capacity", "/api/extraction-audit", "/engine",
  "/api/me", "/api/health", "/api/auth/check", "/api/auth/admin-check",
  "/auth/game", "/auth/handoff", "/auth/callback",
  "/ahd-logo.png", "/lakeside-mark.svg", "/logo.svg", "/ops-mark.svg",
  "/favicon.ico", "/favicon-32.png", "/apple-touch-icon.png", "/status",
]);

function juniorDeveloperRequestAllowed(method, pathname) {
  if (method === "POST") return pathname === "/api/logout";
  if (method !== "GET" && method !== "HEAD") return false;
  return JUNIOR_READ_PATHS.has(pathname) || /^\/api\/kanban\/items\/\d+$/.test(pathname);
}

function canReadDeveloperView(session, pathname) {
  return session?.role === "admin" ||
    (session?.role === "junior_dev" && juniorDeveloperRequestAllowed("GET", pathname));
}

// Runs before all HTTP dispatch, including handlers before the general API
// gate. Unknown paths and methods are denied for this role by default.
async function guardJuniorDeveloperRequest(req, res, pathname, { resolveSession, json }) {
  const session = await resolveSession(req);
  if (session?.role !== "junior_dev" || juniorDeveloperRequestAllowed(req.method, pathname)) return false;
  json(res, 403, { error: "Junior Developer access is limited to development views" });
  return true;
}

function juniorDeveloperHome() {
  return `<section style="max-width:900px;margin:32px auto;padding:24px"><h1>Junior Developer</h1>
<p>Your development workspace includes the work board, project documentation, economy reports and read-only engine diagnostics.</p>
<ul>${JUNIOR_NAV[0].items.slice(1).map(item => `<li><a href="${item.href}">${item.label}</a></li>`).join("")}</ul>
<p>The work board is read-only. Coordinate changes through the linked GitHub issues.</p></section>`;
}

function juniorEconomyReports() {
  return `<section style="max-width:900px;margin:32px auto;padding:24px"><h1>Economy reports</h1><ul>
<li><a href="/economy">Live economy tracker</a></li>
<li><a href="/commodity-report">Commodity economy analysis</a></li>
<li><a href="/reports/extraction-capacity">Extraction capacity and bottlenecks</a></li>
<li><a href="/engine">Current economy and turn diagnostics</a></li></ul></section>`;
}

module.exports = { opsStaffRole, JUNIOR_NAV, juniorDeveloperRequestAllowed, canReadDeveloperView,
  guardJuniorDeveloperRequest, juniorDeveloperHome, juniorEconomyReports };
