// fleet-tools.js — the MCP fleet describing itself.
//
// The catalogue (mcp-catalog.js) lists what the platform hosts, but it was
// written by hand, so it drifts: on 2026-10-21 it named 14 of the gamestate
// server's 36 tools and omitted eight hosted servers entirely. An agent that
// onboarded from the catalogue did not know what it could actually call.
//
// This tool asks the live servers instead. It is the truth the catalogue
// should be checked against, and the fleet's first self-description endpoint.
//
// Read-only: it calls tools/list, prompts/list and resources/list on each
// server and reports what came back. It never calls a tool on another server.

"use strict";

const { z } = require("zod");
const { MCP_DEFS } = require("../mcp-catalog");

const DEFAULT_TIMEOUT_MS = 8000;

function rpc(url, method, params, token, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: controller.signal,
  })
    .then(async (res) => {
      const text = await res.text();
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const line = text.split("\n").find((l) => l.startsWith("data: "));
      let payload;
      try {
        payload = JSON.parse(line ? line.slice(6) : text);
      } catch {
        return { error: "unreadable response" };
      }
      if (payload.error) return { error: payload.error.message || "rpc error" };
      return { result: payload.result || {} };
    })
    .catch((e) => ({ error: e.name === "AbortError" ? "timeout" : e.message }))
    .finally(() => clearTimeout(timer));
}

function localUrl(def) {
  return `http://127.0.0.1:${def.health}/mcp`;
}

async function describeServer(def, token) {
  const url = localUrl(def);
  const init = await rpc(url, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fleet-status", version: "1.0.0" } }, token);
  if (init.error) {
    return { key: def.key, name: def.name, url: def.path, health: def.health, reachable: false, error: init.error };
  }
  const tools = await rpc(url, "tools/list", {}, token);
  const prompts = await rpc(url, "prompts/list", {}, token);
  const resources = await rpc(url, "resources/list", {}, token);
  const templates = await rpc(url, "resources/templates/list", {}, token);
  const toolList = (tools.result && tools.result.tools) || [];
  return {
    key: def.key,
    name: def.name,
    url: def.path,
    health: def.health,
    reachable: true,
    serverInfo: (init.result && init.result.serverInfo) || null,
    toolCount: toolList.length,
    tools: toolList.map((t) => t.name),
    promptCount: ((prompts.result && prompts.result.prompts) || []).length,
    resourceCount: ((resources.result && resources.result.resources) || []).length,
    resourceTemplateCount: ((templates.result && templates.result.resourceTemplates) || []).length,
    error: tools.error || null,
  };
}

function registerFleetTools(server, { jsonResult, errorResult }) {
  server.tool(
    "mcp_fleet_status",
    "List the MCP servers this platform hosts and what each one actually exposes right now: reachability, tool names, prompt count and resource count, read live from the servers themselves rather than from a hand-written catalogue. Use it to find the tool you need instead of guessing a server name or a tool name.",
    {
      server: z.string().optional().describe("one server key to describe in full (e.g. gamestate); omit for every hosted server"),
      include_tools: z.boolean().optional().default(true).describe("include the tool names of each server"),
    },
    async ({ server, include_tools }) => {
      const token = process.env.OPS_KNOWLEDGE_MCP_TOKEN || process.env.MCP_FLEET_TOKEN;
      if (!token) {
        return errorResult("no fleet token configured: set OPS_KNOWLEDGE_MCP_TOKEN (a read-scoped agent token) so this server can ask the other servers what they expose");
      }
      const defs = server ? MCP_DEFS.filter((d) => d.key === server) : MCP_DEFS;
      if (!defs.length) return errorResult(`no hosted server is keyed "${server}". Known: ${MCP_DEFS.map((d) => d.key).join(", ")}`);
      const described = await Promise.all(defs.map((d) => describeServer(d, token)));
      const out = described.map((d) => {
        const row = { ...d };
        if (!include_tools) delete row.tools;
        return row;
      });
      const down = out.filter((d) => !d.reachable);
      return jsonResult({
        ok: down.length === 0,
        cataloguedServers: MCP_DEFS.length,
        reachable: out.length - down.length,
        unreachable: down.map((d) => ({ key: d.key, error: d.error })),
        totalTools: out.reduce((n, d) => n + (d.toolCount || 0), 0),
        totalPrompts: out.reduce((n, d) => n + (d.promptCount || 0), 0),
        totalResources: out.reduce((n, d) => n + (d.resourceCount || 0), 0),
        servers: out,
      });
    }
  );
}

module.exports = { registerFleetTools, describeServer };
