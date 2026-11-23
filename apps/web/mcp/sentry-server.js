// Sentry MCP — read-only view of A House Divided's client and server errors in
// Sentry.io (org lakeside-games). Replaces the retired GlitchTip MCP.
// Streamable HTTP + the shared agent bearer token, loopback only.
//   node mcp/sentry-server.js   (default 127.0.0.1:9740)
// SENTRY_AUTH_TOKEN comes from the unit's EnvironmentFile, never from a tool argument.
require("dotenv").config({ quiet: true, path: require("path").join(__dirname, "..", ".env") });
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { createServer } = require("../packages/mcp-server");
const store = require("../knowledge-store");
const tokens = require("../agent-tokens");
const sentry = require("./sentry-client");

const PORT = parseInt(process.env.SENTRY_MCP_PORT || "9740", 10);
const ORG = process.env.SENTRY_ORG_SLUG || "lakeside-games";

function jsonResult(o) { return { content: [{ type: "text", text: JSON.stringify(o, null, 2) }] }; }
function errorResult(e) {
  const msg = e instanceof sentry.SentryError ? e.message : `Unexpected error: ${e.message}`;
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: msg, status: e.status || null }) }] };
}
const run = fn => async args => { try { return jsonResult(await fn(args)); } catch (e) { return errorResult(e); } };

function buildServerFor(client) {
  const server = new McpServer({ name: "ops-sentry", version: "1.0.0" });
  const project = z.string().optional().describe("project slug, e.g. a-house-divided; omit for all projects");
  server.tool("sentry_issues",
    "Unresolved Sentry issues for A House Divided (client and server). Filter by project, Sentry search query, and period. Returns id, shortId, title, culprit, count, userCount, firstSeen, lastSeen, permalink.",
    { project, query: z.string().optional().describe("Sentry search syntax, e.g. 'error_code:CLIENT_ERROR' or 'release:1.2.3'; is:unresolved is implied"),
      statsPeriod: z.string().optional().default("24h").describe("e.g. 1h, 24h, 7d, 14d"),
      sort: z.enum(["date", "new", "freq", "user", "trends", "inbox"]).optional().default("date"),
      limit: z.number().int().min(1).max(100).optional().default(25) },
    run(args => sentry.listIssues(client, args).then(issues => ({ count: issues.length, issues }))));
  server.tool("sentry_issue",
    "One Sentry issue plus its latest event: exception type and value, top in-app frames, tags (route, error_code, release, browser), breadcrumb tail, request url, and the user id (id only).",
    { id: z.string().describe("issue id or short id such as AHD-1A") },
    run(({ id }) => sentry.getIssue(client, id)));
  server.tool("sentry_event_lookup",
    "Find an event by full id or by the 8 character ref players see on error pages ('Ref: 584ffe8b'). Scans recent events and matches the prefix client-side.",
    { ref: z.string().describe("event id or 8 character prefix, with or without 'Ref:'"), project,
      statsPeriod: z.string().optional().default("14d") },
    run(args => sentry.lookupEvent(client, args.ref, args)));
  server.tool("sentry_player_errors",
    "Errors one player hit, for support tickets: pass the reporter's account id (userId) or character id, optionally the page path they mention (e.g. /actions) and the time they describe (around, ISO) with a window. Returns matching events newest first, and for the latest few the exception, top frames and a readable step trail (requests with status codes and page navigation just before the error).",
    { userId: z.string().optional().describe("the player's account id (from the support ticket reporter)"),
      characterId: z.string().optional(),
      page: z.string().optional().describe("page path or fragment, e.g. /actions or stockmarket"),
      around: z.string().optional().describe("ISO time the player says it happened; omit to use statsPeriod"),
      windowMinutes: z.number().int().min(5).max(1440).optional().default(60),
      statsPeriod: z.string().optional().default("7d"),
      // Agents often send detail: true; read it as the default depth instead of rejecting the call.
      detail: z.preprocess(v => (v === true ? 3 : v === false ? 0 : v), z.number().int().min(0).max(5).optional().default(3))
        .describe("how many recent events to show in full, 0 to 5 (true means 3)"), project },
    run(args => sentry.playerErrors(client, args)));
  server.tool("sentry_new_since",
    "Unresolved issues first seen after a timestamp. For watchers: pass the last check time.",
    { since: z.string().describe("ISO timestamp"), project, limit: z.number().int().min(1).max(100).optional().default(50) },
    run(args => sentry.newSince(client, args).then(issues => ({ since: args.since, count: issues.length, issues }))));
  return server;
}

async function main() {
  if (!process.env.SENTRY_AUTH_TOKEN) { console.error("[sentry-mcp] SENTRY_AUTH_TOKEN is not set"); process.exit(1); }
  const db = await store.getDb(process.env.MONGODB_URI);
  await tokens.ensureIndexes(db);
  const client = sentry.createClient({ token: process.env.SENTRY_AUTH_TOKEN, org: ORG });
  createServer({
    name: "sentry-mcp", version: "1.0.0", port: PORT, bind: "127.0.0.1",
    authorize: req => tokens.validate(db, req.headers.authorization), buildServer: () => buildServerFor(client),
  });
}
if (require.main === module) main().catch(e => { console.error("[sentry-mcp] fatal:", e.message); process.exit(1); });
module.exports = { buildServerFor };
