"use strict";
// Loopback MCP endpoint for one wake of one ticket's session. The path holds
// an unguessable token; it serves only that wake's tools, and its /completion
// route answers once finish is accepted so the runner can end the process.

const http = require("node:http");
const crypto = require("node:crypto");
const { redactSecrets } = require("../text");

const RESULT_CAP = 22000;
function cap(text) {
  if (text.length <= RESULT_CAP) return text;
  const note = `\n[Cut off: showing ${RESULT_CAP} of ${text.length} characters. Ask for a narrower range before relying on what is missing.]`;
  return text.slice(0, RESULT_CAP - note.length) + note;
}

function createSlimToolServer({ port = 0, log = () => {} } = {}) {
  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
    const route = /^\/mcp\/([a-f0-9]{48})(\/completion)?$/.exec(req.url || "");
    const session = route && sessions.get(route[1]);
    if (!session) return send(404, { error: "unknown session" });
    if (route[2]) {
      if (session.completion) return send(200, session.completion);
      session.waiters.add(res);
      res.once("close", () => session.waiters.delete(res));
      return;
    }
    if (req.method !== "POST") return send(405, { error: "POST only" });
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 2e6) return send(413, { error: "too large" }); }
    let msg; try { msg = JSON.parse(raw); } catch { return send(400, { error: "invalid json" }); }
    if (msg.id === undefined) return send(202);
    const ok = (result) => send(200, { jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") return ok({ protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "keir", version: "slim-1" } });
    if (msg.method === "ping") return ok({});
    if (msg.method === "tools/list") return ok({ tools: session.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    if (msg.method !== "tools/call") return send(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    const { name, arguments: input = {} } = msg.params || {};
    const t = session.tools.find((x) => x.name === name);
    if (!t) return ok({ isError: true, content: [{ type: "text", text: `tool ${name} is not available` }] });
    if (session.completion) return ok({ isError: true, content: [{ type: "text", text: "This wake is finished. Issue no more tools." }] });
    const started = Date.now();
    try {
      const result = await t.handler(input || {});
      session.calls.push({ name, ms: Date.now() - started, ok: true });
      session.onCall?.({ name, input, result, ok: true });
      if (name === "finish" && session.ctx.finished) {
        session.completion = { version: 1, state: session.ctx.finished.state, summary: String(session.ctx.finished.summary).slice(0, 4000), acceptedAt: Date.now(), toolCalls: session.calls.length };
        for (const w of session.waiters) { w.writeHead(200, { "Content-Type": "application/json" }); w.end(JSON.stringify(session.completion)); }
        session.waiters.clear();
      }
      return ok({ content: [{ type: "text", text: cap(redactSecrets(JSON.stringify(result ?? null))) }] });
    } catch (e) {
      session.calls.push({ name, ms: Date.now() - started, ok: false });
      session.onCall?.({ name, input, error: e.message, ok: false });
      return ok({ isError: true, content: [{ type: "text", text: redactSecrets(String(e.message || e)).slice(0, 4000) }] });
    }
  });
  const ready = new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
  server.unref();
  async function open({ tools, ctx, onCall }) {
    const token = crypto.randomBytes(24).toString("hex");
    const session = { tools, ctx, onCall, calls: [], waiters: new Set(), completion: null };
    sessions.set(token, session);
    const url = `http://127.0.0.1:${await ready}/mcp/${token}`;
    return {
      url, completionUrl: `${url}/completion`, session,
      close() { sessions.delete(token); for (const w of session.waiters) { w.writeHead(410); w.end(); } session.waiters.clear(); },
    };
  }
  return { open, close: () => server.close() };
}

module.exports = { createSlimToolServer };
