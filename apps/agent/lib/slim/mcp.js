"use strict";
// A small MCP client for the slim Keir. Local servers only. Reads use Keir's
// read token; writes use the server's configured credential and pass a gate
// first (live mode and a clear kill switch). A read that cannot connect is
// retried briefly (a server restarting for a deploy); writes never are.

const fs = require("node:fs");
const { redactSecrets } = require("../text");

const RETRY_MS = [1500, 4000, 10000];

function localUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.username || u.password) return null;
    if (u.hostname === "localhost") u.hostname = "127.0.0.1";
    return u.href;
  } catch { return null; }
}

function parseRpc(text) {
  const t = String(text || "").trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const data = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
  for (let i = data.length - 1; i >= 0; i--) { try { return JSON.parse(data[i]); } catch { /* next */ } }
  throw new Error("unreadable MCP response");
}

function createSlimMcp({ configFile, readToken, gate = () => {}, fetchImpl = fetch, retryMs = RETRY_MS }) {
  const servers = JSON.parse(fs.readFileSync(configFile, "utf8")).mcpServers || {};
  const listCache = new Map();
  async function rpc(server, method, params, write = false) {
    const c = servers[server];
    const url = localUrl(c?.url);
    if (!url) throw new Error(`no local MCP server named ${server}`);
    if (write) gate(`The ${server} write ${params?.name || method}`);
    const auth = write ? c.headers?.Authorization : `Bearer ${readToken}`;
    const send = () => fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60000) });
    let res;
    try { res = await send(); }
    catch (e) {
      if (write) throw e;
      let last = e;
      for (const ms of retryMs) {
        await new Promise((r) => setTimeout(r, ms));
        try { res = await send(); break; } catch (e2) { last = e2; }
      }
      if (!res) throw new Error(`could not reach the ${server} MCP server (${last.cause?.code || last.message}); this says nothing about the data`);
    }
    const j = parseRpc(await res.text());
    if (!res.ok || j.error || j.result?.isError) throw new Error(redactSecrets(JSON.stringify(j.error || j.result || {}).slice(0, 2000)));
    return j.result;
  }
  return {
    async list(server) {
      const hit = listCache.get(server);
      if (hit && Date.now() - hit.at < 300000) return hit.tools;
      const tools = (await rpc(server, "tools/list", {})).tools || [];
      listCache.set(server, { at: Date.now(), tools });
      return tools;
    },
    async call(server, tool, args, write = false) {
      const r = await rpc(server, "tools/call", { name: tool, arguments: args || {} }, write);
      const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const images = (r.content || []).filter((c) => c.type === "image" && /^image\/(png|jpeg|webp|gif)$/.test(c.mimeType || "") && c.data && c.data.length <= 5600000).slice(0, 6).map((c) => ({ data: c.data, mimeType: c.mimeType }));
      let out; try { out = JSON.parse(text); } catch { out = { text }; }
      if (images.length && out && typeof out === "object") Object.defineProperty(out, "_images", { value: images, enumerable: false });
      return out;
    },
  };
}

module.exports = { createSlimMcp, parseRpc, localUrl };
