"use strict";
// Keir 10 (W3): registry for the native tools added in this release.
//
//   ask              Ask health, the reporter's recent Ask turns, a desk query
//   player_trail     the reporter's recent activity (PostHog)
//   resolve_reporter the reporter's account and characters when the ticket has no link
//   turn_status      turn, lock and schedule in plain fields (also a plain function)
//   request_log      the reporter's recent API requests with status
//
// Each tool lives in its own module; this file wires them to the broker with
// one hook (call) and one visibility check for the agent's tool list. Every
// tool degrades to a plain "not configured" note when its credential is missing.
//
// Environment the lead must wire (all optional, tools degrade without them):
//   KEIR_ASK_URL, KEIR_ASK_SECRET   already read by operator.js (fast lane)
//   POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID, POSTHOG_HOST   player_trail

const { createAskTool } = require("./asktool");
const { createPlayerTrail } = require("./playertrail");
const { createResolver } = require("./resolvereporter");
const { createRequestLog } = require("./requestlog");
const { turnStatus, lockResetPlan } = require("./turnstatus");
const advice = require("./advicerouting");

function schema(properties, required = []) { return { type: "object", properties, required, additionalProperties: false }; }
const str = { type: "string" };

const TOOL_DEFS = [
  ["ask", "Ask (the game's question service) from the support desk. action health: is Ask answering, and what share of its last day of answers were refusals; call it before telling a player to use Ask, and do not redirect when it says failing or down. action history: what Ask told this ticket's reporter recently and whether it answered or refused (reporter only). action query: put a question to Ask as the desk and read its answer (never posted anywhere) to check it before redirecting.", schema({ action: { type: "string", enum: ["health", "history", "query"] }, question: str, hours: { type: "integer", minimum: 1, maximum: 168 }, days: { type: "integer", minimum: 1, maximum: 30 }, limit: { type: "integer", minimum: 1, maximum: 20 }, userKeys: { type: "array", items: str, description: "staff only: Ask user keys such as discord:123" } }, ["action"])],
  ["player_trail", "The ticket reporter's recent activity in the game around a time: page views, clicks, rage clicks, errors and failed requests, from the analytics service, with replay links for developers. Reporter only. Use it to see what the player actually did before they wrote. Players may have declined analytics, so no events is not proof of inactivity. Never put replay links or event lists in a player reply.", schema({ around: { type: "string", description: "ISO time to centre on, default now" }, minutes: { type: "integer", minimum: 5, maximum: 360, description: "half-width of the window, default 30" } })],
  ["resolve_reporter", "Find the game account behind this ticket's reporter when the ticket carries no character link: current and retired characters (name, id, country, office), and how the match was made (character link, game username, linked Discord account, repeated page visits). No emails, sessions or Discord ids. Use it instead of asking the player who they are, and instead of reading users or sessions.", schema({})],
  ["turn_status", "The turn engine in plain fields: state (idle, processing, late, paused, stuck), current turn, last turn finished at, expected next turn, minutes overdue, who holds the lock and its heartbeat age, and the last failure phase. Call it first for any 'turn is stuck or late' report. For a stuck lock use request_action kind turn_lock_reset.", schema({})],
  ["request_log", "The ticket reporter's recent API requests (last 24 hours at most): method, path, status, grouped, with failures first. Reporter only. Shows rate limits and failed calls; it has no durations and misses page loads, so an empty result proves nothing.", schema({ hours: { type: "integer", minimum: 1, maximum: 24 } })],
];
const NAMES = new Set(TOOL_DEFS.map((t) => t[0]));
const TICKET_ONLY = new Set(["player_trail", "resolve_reporter", "request_log"]);

function createW3Tools({ config = {}, mcp, env = process.env, fetcher = fetch, staff = () => false, now = () => Date.now(), log = () => {} }) {
  const resolver = createResolver({ mcp, now });
  const resolveIdentity = (job, signal) => resolver.resolve(job, signal);
  const ask = createAskTool({ config, fetcher, resolveIdentity, staff, now });
  const trail = createPlayerTrail({ env, fetcher, resolveIdentity, now });
  const requestLog = createRequestLog({ mcp, resolveIdentity, now });
  const status = () => turnStatus((server, tool, args) => mcp.call(server, tool, args || {}, false), { now });

  // Fire and forget: keep advicerouting's view of Ask fresh without blocking any activation.
  let healthAt = 0;
  function refreshAskHealth() {
    if (now() - healthAt < 5 * 60000 || !config.askUrl) return;
    healthAt = now();
    ask.health({}, {}).then((h) => advice.noteAskHealth(h, now())).catch((e) => log(`ask health: ${e.message}`));
  }

  // Visible in the agent's tool list: never to players, ticket-bound tools only with a ticket.
  function visible(job, name) {
    if (!NAMES.has(name)) return true;
    if (job.role === "player") return false;
    if (TICKET_ONLY.has(name)) return Boolean(job.ticket);
    return true;
  }

  async function call(job, name, input = {}, signal) {
    if (!visible(job, name)) throw new Error(`${name} is not available to this task`);
    if (name === "ask") { const out = await ask.call(job, input, signal); if (input.action === "health") advice.noteAskHealth(out, now()); return out; }
    if (name === "player_trail") return trail.call(job, input, signal);
    if (name === "resolve_reporter") return resolver.present(await resolveIdentity(job, signal));
    if (name === "turn_status") return status();
    if (name === "request_log") return requestLog.call(job, input, signal);
    throw new Error(`unknown tool ${name}`);
  }

  // request_action kind turn_lock_reset. Dry run by default: returns the plan and
  // changes nothing. With dryRun false it files an ordinary owner-approved heal.
  async function turnLockReset(job, input, signal, requestHeal) {
    if (job.role === "player") throw new Error("players cannot request a turn lock reset");
    const args = input.args || {};
    const s = await status();
    const state = await mcp.call("heal-ops", "heal_query", { env: "prod", collection: "gameState", filter: { _id: "current" }, projection: { isProcessing: 1, processingTargetTurn: 1, processingPhase: 1, processingHoldReason: 1 }, limit: 1 }, false, signal).then((r) => r?.docs?.[0] || {}).catch(() => ({}));
    const plan = lockResetPlan(s, state);
    if (!plan.eligible) return { filed: false, eligible: false, reason: plan.reason, turn: s };
    if (args.dryRun !== false) return { filed: false, eligible: true, dryRun: true, plan: plan.dryRun, spec: plan.spec, turn: s, instruction: "This is the plan only; nothing changed. To file it for the owner, call request_action again with args {dryRun:false}. Only the owner can approve it, and the game's own turn lock guard may still refuse it; if so, say the admin reset-lock route is the path." };
    const filed = await requestHeal({ ...plan.spec, reason: String(input.reason || plan.spec.description).slice(0, 400) });
    return { filed: true, ...filed };
  }

  return { call, visible, has: (name) => NAMES.has(name), refreshAskHealth, resolveIdentity, turnStatus: status, turnLockReset, TOOL_DEFS };
}

module.exports = { createW3Tools, TOOL_DEFS, NAMES, TICKET_ONLY };

// Used by the agent's tool filter without constructing the tools.
function createVisible(job, name) {
  if (!NAMES.has(name)) return true;
  if (job.role === "player") return false;
  if (TICKET_ONLY.has(name)) return Boolean(job.ticket);
  return true;
}
module.exports.createVisible = createVisible;
