"use strict";
// Loopback MCP endpoint (JSON-RPC over HTTP, plain JSON responses) exposing the
// supervisor's tools to one model run at a time. Each run gets an unguessable
// path bound to one job and its abort signal; nothing else is reachable. It
// listens on 127.0.0.1 only and forwards nothing to any other host.
const http = require("node:http");
const crypto = require("node:crypto");
const { redact } = require("./executor");

const RESULT_CAP = 22000;
function cap(text) {
  if (text.length <= RESULT_CAP) return text;
  const note = `\n[Cut off: showing ${RESULT_CAP} of ${text.length} characters. Ask for a narrower range before relying on what is missing.]`;
  return text.slice(0, RESULT_CAP - note.length) + note;
}

function createToolServer({ tools, call }) {
  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
    const m = /^\/mcp\/([a-f0-9]{48})$/.exec(req.url || "");
    const session = m && sessions.get(m[1]);
    if (!session) return send(404, { error: "unknown session" });
    if (req.method !== "POST") return send(405, { error: "POST only" });
    let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 2e6) return send(413, { error: "too large" }); }
    let msg; try { msg = JSON.parse(raw); } catch { return send(400, { error: "invalid json" }); }
    if (msg.id === undefined) return send(202);
    const ok = (result) => send(200, { jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") return ok({ protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "keir-supervisor", version: "1.0.0" } });
    if (msg.method === "ping") return ok({});
    if (msg.method === "tools/list") return ok({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    if (msg.method !== "tools/call") return send(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    const { name, arguments: input = {} } = msg.params || {};
    const tool = tools.find((t) => t.name === name);
    if (!tool) return ok({ isError: true, content: [{ type: "text", text: `tool ${name} is not available` }] });
    if (session.signal.aborted) return ok({ isError: true, content: [{ type: "text", text: "This job was cancelled." }] });
    session.calls += 1;
    if (session.calls > session.maxCalls) return ok({ isError: true, content: [{ type: "text", text: "Tool budget for this job is used up. Answer the owner with what you have." }] });
    try {
      const result = await call(session.job, name, input && typeof input === "object" ? input : {}, session.signal);
      return ok({ content: [{ type: "text", text: cap(redact(typeof result === "string" ? result : JSON.stringify(result ?? null))) }] });
    } catch (error) {
      return ok({ isError: true, content: [{ type: "text", text: cap(redact(error.message || String(error))) }] });
    }
  });
  const ready = new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
  server.unref();

  async function open(job, signal, { maxCalls = 400 } = {}) {
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, { job, signal, calls: 0, maxCalls });
    const url = `http://127.0.0.1:${await ready}/mcp/${token}`;
    return { url, close: () => sessions.delete(token) };
  }
  return { open, close: () => server.close(), ready };
}

module.exports = { createToolServer, cap };
