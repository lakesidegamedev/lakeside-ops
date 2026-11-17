"use strict";
// keir-summon: the public edge for the Discord bot's /summon and pokes. It
// forwards message identifiers to the operator, which re-fetches every message
// from Discord and authenticates it independently. No content or identity is
// trusted from the caller, and this process holds no model or Discord access.
const http = require("node:http");

const env = process.env;
const PORT = Number(env.KEIR_PUBLIC_PORT || 9763);
const OPERATOR = env.KEIR_OPERATOR_URL || "http://127.0.0.1:9765";
const TOKEN = env.KEIR_OPERATOR_ADMIN_TOKEN;
if (!TOKEN) throw new Error("KEIR_OPERATOR_ADMIN_TOKEN is required");

const log = (msg) => console.log(`[keir-summon] ${msg}`);
const send = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const snowflake = (v) => typeof v === "string" && /^\d{17,20}$/.test(v);

// Per-IP poke budget: 30 a minute is far above the bot's real rate.
const pokes = new Map();
function pokeAllowed(ip) {
  const now = Date.now(), recent = (pokes.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now); pokes.set(ip, recent);
  if (pokes.size > 1000) for (const [k, v] of pokes) if (!v.some((t) => now - t < 60000)) pokes.delete(k);
  return recent.length <= 30;
}
async function readBody(req, limit) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > limit) throw Object.assign(new Error("body too large"), { status: 413 }); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error("invalid json"), { status: 400 }); }
}
async function forward(method, route, body) {
  const r = await fetch(`${OPERATOR}${route}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  return { status: r.status, body: await r.json().catch(() => ({ ok: false, error: "operator returned no JSON" })) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/summon/health") {
      const r = await fetch(`${OPERATOR}/health`, { signal: AbortSignal.timeout(10000) }).then((x) => x.json()).catch(() => null);
      return send(res, r?.ok ? 200 : 503, { ok: Boolean(r?.ok), ready: Boolean(r?.ok), operator: r });
    }
    if (req.method === "GET" && url.pathname === "/api/summon/channels") {
      const out = await forward("GET", "/channels"); return send(res, out.status, out.body);
    }
    const status = /^\/api\/summon\/status\/(\d{17,20})$/.exec(url.pathname);
    if (req.method === "GET" && status) {
      const out = await forward("GET", `/channel-status/${status[1]}`); return send(res, out.status, out.body);
    }
    if (req.method === "POST" && url.pathname === "/api/summon/poke") {
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      if (!pokeAllowed(ip)) return send(res, 429, { ok: false, error: "slow down" });
      const { channelId, messageId } = await readBody(req, 4096);
      if (!snowflake(channelId) || !snowflake(messageId)) return send(res, 400, { ok: false, error: "bad ids" });
      try { const out = await forward("POST", "/poke", { channelId, messageId }); return send(res, out.status, out.body); }
      catch { return send(res, 502, { ok: false, error: "operator is unavailable; task was not acknowledged" }); }
    }
    // Keir 10.2: a feedback click. Only the interaction token travels; the operator
    // reads the game bot's private reply back from Discord to learn who voted and how.
    if (req.method === "POST" && url.pathname === "/api/summon/feedback") {
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      if (!pokeAllowed(ip)) return send(res, 429, { ok: false, error: "slow down" });
      const { token } = await readBody(req, 2048);
      if (typeof token !== "string" || !/^[A-Za-z0-9_.-]{20,600}$/.test(token)) return send(res, 400, { ok: false, error: "bad token" });
      try { const out = await forward("POST", "/v5/feedback", { token }); return send(res, out.status, out.body); }
      catch { return send(res, 502, { ok: false, error: "operator is unavailable" }); }
    }
    return send(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    log(`${req.method} ${url.pathname} failed: ${err.message}`);
    return send(res, err.status || 502, { ok: false, error: err.status ? err.message : "operator is unavailable" });
  }
});

if (require.main === module) server.listen(PORT, "127.0.0.1", () => log(`forwarding :${PORT} -> ${OPERATOR}`));
module.exports = { server, pokeAllowed };
