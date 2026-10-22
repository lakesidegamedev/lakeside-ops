"use strict";

/**
 * Read-only MCP access for codebase Q&A.
 *
 * Ask could only ever read source files, which is why its answers were thinner
 * than the code agent's on the questions people actually bring it: "why did this
 * number move", "has this broken before", "what did we decide here". None of
 * that is in the source. It is in the ops-knowledge brain, the live game state,
 * and the error history — all already hosted as MCP servers that the code agent
 * consults and Ask did not.
 *
 * This exposes those servers to Ask as ordinary tool calls, with two rules:
 *
 *   1. **Read-only, enforced at the token, not here.** Write tools live behind a
 *      write-scoped bearer; a read-scoped token is never even shown them
 *      (`mcp/server.js` builds its tool list per-token). Ask holds a read-scoped
 *      token, so "no edits" is a property of the credential rather than of this
 *      file remembering to filter. The `*` suffix filter below is belt-and-braces
 *      for catalog entries, not the boundary.
 *   2. **Schemas are discovered, never transcribed.** Tool signatures come from
 *      each server's own `tools/list`, so a server adding or changing a tool does
 *      not require an edit here to stay correct.
 *
 * The fleet speaks Streamable HTTP in stateless mode (`sessionIdGenerator:
 * undefined`), so a single self-contained JSON-RPC POST per call is the whole
 * protocol — no session handshake to maintain.
 */

const { MCP_DEFS, mcpUrl } = require("./mcp-catalog");

const MCP_TOKEN = process.env.ASK_MCP_TOKEN || process.env.OPS_KNOWLEDGE_MCP_TOKEN || "";

/**
 * Which servers Ask may consult, and how a citation from each should read.
 *
 * `knowledge` is written-down human judgement; `state` is a live reading of the
 * running system. The distinction matters to someone weighing an answer: a
 * runbook can be out of date in a way a database query cannot.
 */
// The player-and-world facing half of the fleet. Deliberately excludes the
// developer-oriented servers (security/Semgrep, seed-audit, worldsim,
// reports): Ask answers questions about the game, the players and what has been
// written down, not about builds and deploys.
const ASK_SERVERS = {
  "ops-knowledge": { kind: "knowledge", label: "ops-knowledge" },
  community: { kind: "knowledge", label: "community" },
  discord: { kind: "knowledge", label: "discord" },
  gamestate: { kind: "state", label: "gamestate" },
  engine: { kind: "state", label: "engine" },
  turndiag: { kind: "state", label: "turndiag" },
  support: { kind: "state", label: "support" },
};

// The unauthenticated Ask endpoint publishes its answer into a public Discord
// channel. Read-only is not the same as public: support tickets, Discord
// history, ops notes, turn diagnostics, character traces, and corporation
// traces can all contain information a player must not receive. Public Ask gets
// an explicit data allowlist; the authenticated staff Ask keeps the broader
// read-only fleet above.
const PUBLIC_ASK_SERVERS = {
  gamestate: ASK_SERVERS.gamestate,
  engine: ASK_SERVERS.engine,
};
const PUBLIC_ASK_TOOL_ALLOWLIST = {
  gamestate: new Set([
    "game_overview", "countries", "map_snapshot", "fx_quote", "entity_search",
    "elections", "analytics_catalog", "analytics_query",
    "geo_aggregate", "parties", "top_players", "corporation_rankings",
    "country_fiscal", "legislation_catalog", "wars", "macro_history",
    "trace_election", "trace_race", "trace_approval",
  ]),
  engine: new Set(["economy_pulse"]),
};

// A hard ceiling on how much of the model's context the fleet may occupy. Tool
// definitions are sent on every round, so an unbounded fleet would quietly tax
// every question — including the many that need no MCP at all. Sized to admit
// most of the fleet: the seven servers above list ~47 read-only tools between
// them, and admission is round-robin (see below) so the ceiling costs the tail
// of the deepest list rather than whole servers.
const MAX_TOOLS = 40;
const LIST_TIMEOUT_MS = 4000;
const CALL_TIMEOUT_MS = 15000;
const MAX_RESULT_CHARS = 24000;

const PRIORITY_TOOLS = [
  ["gamestate", "game_overview"],
  ["gamestate", "countries"],
  ["gamestate", "map_snapshot"],
  ["gamestate", "fx_quote"],
  ["gamestate", "entity_search"],
  ["gamestate", "trace_corp"],
  ["gamestate", "trace_sector"],
  ["gamestate", "extraction_market"],
  ["gamestate", "elections"],
  ["engine", "economy_pulse"],
];

const SEPARATOR = "__";

// Some older MCPs register write-shaped tools for read tokens and reject only
// at call time. Never offer those names to a player-facing model, even if the
// configured credential is accidentally broader than intended.
const MUTATING_TOOL_NAMES = new Set([
  "discord_send",
  "knowledge_feedback",
  "support_notify_ops_findings",
  "support_set_status",
  "support_resolve",
  "support_update",
  "support_tracker_sync",
  "support_tracker_note",
]);

function isReadOnlyName(name) {
  return typeof name === "string" && !name.endsWith("*") && !MUTATING_TOOL_NAMES.has(name);
}

/** `gamestate` + `country_snapshot` → `gamestate__country_snapshot`. */
function toolId(serverKey, toolName) {
  return `${serverKey}${SEPARATOR}${toolName}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Parse a Streamable HTTP reply. The transport answers with either plain JSON or
 * an SSE frame depending on what it negotiates, so both shapes are handled
 * rather than assuming the one seen in testing.
 */
function parseRpcBody(text, contentType) {
  const body = String(text || "");
  if ((contentType || "").includes("text/event-stream")) {
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        return JSON.parse(trimmed.slice(5).trim());
      } catch { /* keep scanning — a frame may span several data lines */ }
    }
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function rpc(serverPath, method, params, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(mcpUrl(serverPath), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(MCP_TOKEN ? { Authorization: `Bearer ${MCP_TOKEN}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const text = await res.text();
    const parsed = parseRpcBody(text, res.headers?.get?.("content-type"));
    if (!res.ok) throw new Error(parsed?.error?.message || `HTTP ${res.status}`);
    if (parsed?.error) throw new Error(parsed.error.message || "MCP error");
    return parsed?.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/** Flatten an MCP tool result into text a chat model can consume. */
function resultToText(result) {
  if (!result) return "";
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .map((part) => (part && part.type === "text" ? String(part.text || "") : ""))
    .filter(Boolean)
    .join("\n");
  const out = text || JSON.stringify(result);
  return out.length > MAX_RESULT_CHARS ? `${out.slice(0, MAX_RESULT_CHARS)}\n…(truncated)` : out;
}

/**
 * Ask every reachable server what it can do, and turn that into OpenAI-style
 * function definitions.
 *
 * A server that is down, slow, or rejects the token is skipped rather than
 * failing the build: Ask has always worked without MCP, and a knowledge server
 * being unreachable should cost a bit of depth, never the answer.
 */
async function discoverAskTools({ fetchImpl = fetch, servers = ASK_SERVERS, allowlist = null } = {}) {
  if (!MCP_TOKEN) return { tools: [], index: new Map(), skipped: ["no ASK_MCP_TOKEN configured"] };

  const defs = MCP_DEFS.filter((def) => servers[def.key]);
  const skipped = [];
  const tools = [];
  const index = new Map();

  const listed = await Promise.all(defs.map(async (def) => {
    try {
      const result = await rpc(def.path, "tools/list", {}, LIST_TIMEOUT_MS, fetchImpl);
      return { def, tools: Array.isArray(result?.tools) ? result.tools : [] };
    } catch (e) {
      skipped.push(`${def.key}: ${e.message}`);
      return { def, tools: [] };
    }
  }));

  // Admission is round-robin across servers, not first-come. Spending a single
  // global cap in declaration order let one deep server exhaust the whole budget
  // and leave every server after it with nothing — and silently, because nothing
  // had errored, so `skipped` stayed empty and discovery looked healthy. Taking
  // one tool per server per pass keeps every server reachable and spends the cut
  // on the tail of the longest lists, which is where the most specialised (and
  // least often needed) tools sit.
  const queues = listed.map(({ def, tools: serverTools }) => {
    const allowed = allowlist?.[def.key] || null;
    const queue = (Array.isArray(serverTools) ? serverTools : []).filter((tool) =>
      isReadOnlyName(tool?.name) && (!allowlist || allowed?.has(tool.name))
    );
    return { def, queue, total: queue.length, admitted: 0 };
  });

  const admit = (entry, tool) => {
    const id = toolId(entry.def.key, tool.name);
    index.set(id, {
      serverKey: entry.def.key,
      path: entry.def.path,
      toolName: tool.name,
      meta: servers[entry.def.key],
    });
    tools.push({
      type: "function",
      function: {
        name: id,
        description: `[${entry.def.name}] ${tool.description || tool.name}`.slice(0, 1024),
        parameters: tool.inputSchema && typeof tool.inputSchema === "object"
          ? tool.inputSchema
          : { type: "object", properties: {} },
      },
    });
    entry.admitted += 1;
  };

  for (const [serverKey, toolName] of PRIORITY_TOOLS) {
    if (tools.length >= MAX_TOOLS) break;
    const entry = queues.find((queue) => queue.def.key === serverKey);
    const position = entry?.queue.findIndex((tool) => tool.name === toolName) ?? -1;
    if (!entry || position < 0) continue;
    const [tool] = entry.queue.splice(position, 1);
    admit(entry, tool);
  }

  for (let depth = 0; tools.length < MAX_TOOLS; depth += 1) {
    let placedThisPass = 0;
    for (const entry of queues) {
      if (tools.length >= MAX_TOOLS) break;
      const tool = entry.queue[depth];
      if (!tool) continue;
      placedThisPass += 1;
      admit(entry, tool);
    }
    if (!placedThisPass) break; // every queue exhausted before the cap
  }

  // Truncation is reported for the same reason an unreachable server is: from
  // the outside a capped fleet and a complete one look identical.
  const truncated = queues.filter((entry) => entry.admitted < entry.total);
  if (truncated.length) {
    const detail = truncated.map((e) => `${e.def.key}:${e.total - e.admitted}`).join(", ");
    skipped.push(`tool cap ${MAX_TOOLS} reached — tools not offered: ${detail}`);
  }

  return { tools, index, skipped };
}

async function discoverPublicAskTools({ fetchImpl = fetch } = {}) {
  return discoverAskTools({
    fetchImpl,
    servers: PUBLIC_ASK_SERVERS,
    allowlist: PUBLIC_ASK_TOOL_ALLOWLIST,
  });
}

/**
 * Run one discovered tool. Returns the text for the model plus the citation the
 * answer should carry, so a reader can see the knowledge doc or state query an
 * answer leaned on rather than just the files it opened.
 */
async function callAskTool(index, id, args, { fetchImpl = fetch, resultValidator = null } = {}) {
  const entry = index.get(id);
  if (!entry) return { text: `Error: unknown tool "${id}".`, source: null };
  try {
    const result = await rpc(
      entry.path, "tools/call",
      { name: entry.toolName, arguments: args && typeof args === "object" ? args : {} },
      CALL_TIMEOUT_MS, fetchImpl
    );
    if (resultValidator && !resultValidator(result)) {
      return { text: "Error: public tool returned data outside the public disclosure contract.", source: null };
    }
    const text = resultToText(result);
    return {
      text,
      source: {
        kind: entry.meta.kind,
        label: `${entry.meta.label}: ${entry.toolName}${summarizeArgs(args)}`,
        detail: text,
      },
    };
  } catch (e) {
    // A failed lookup is reported to the model so it can try another route,
    // and is not cited — an answer must never claim evidence it did not get.
    return { text: `Error calling ${id}: ${e.message}`, source: null };
  }
}

const FORBIDDEN_PUBLIC_RESULT_KEYS = new Set([
  "accountid", "balancesheet", "deployments", "discordid", "email", "equipment",
  "fingerprint", "forcecomposition", "forcestrength", "holdings", "insolventcorps",
  "ip", "ipaddress", "liquidcapital", "militaryroster", "militarystrength",
  "militaryunits", "personnel", "readiness", "roster", "userid",
]);

function containsForbiddenPublicToolData(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
    try { return containsForbiddenPublicToolData(JSON.parse(trimmed), depth + 1); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenPublicToolData(entry, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    return FORBIDDEN_PUBLIC_RESULT_KEYS.has(normalized)
      || containsForbiddenPublicToolData(entry, depth + 1);
  });
}

async function callPublicAskTool(index, id, args, { fetchImpl = fetch } = {}) {
  return callAskTool(index, id, args, {
    fetchImpl,
    resultValidator: (result) => !containsForbiddenPublicToolData(result),
  });
}

/** A short, readable rendering of the call's arguments for the citation label. */
function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  const parts = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .slice(0, 3)
    .map(([key, value]) => {
      const rendered = typeof value === "object" ? JSON.stringify(value) : String(value);
      return `${key}=${rendered.length > 40 ? `${rendered.slice(0, 40)}…` : rendered}`;
    });
  return parts.length ? ` (${parts.join(", ")})` : "";
}

module.exports = {
  ASK_SERVERS,
  PUBLIC_ASK_SERVERS,
  PUBLIC_ASK_TOOL_ALLOWLIST,
  MAX_TOOLS,
  callAskTool,
  callPublicAskTool,
  containsForbiddenPublicToolData,
  discoverAskTools,
  discoverPublicAskTools,
  isReadOnlyName,
  parseRpcBody,
  resultToText,
  summarizeArgs,
  toolId,
};
