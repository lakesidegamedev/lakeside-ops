"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { passwordMatches, sessions } = require("./auth");

function publicOrigin(value) {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("LAKESIDE_PUBLIC_URL must be an HTTPS origin (loopback HTTP is allowed for development)");
  return url;
}
async function body(req) {
  let data = "";
  for await (const chunk of req) { data += chunk; if (data.length > 32000) throw Object.assign(new Error("Request too large"), { status: 413 }); }
  if (req.headers["content-type"]?.startsWith("application/json")) return JSON.parse(data || "{}");
  if (req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(data));
  throw Object.assign(new Error("Unsupported content type"), { status: 415 });
}
function createPortal({ origin, passwordHash, stateDir, runtime, email = "owner@localhost", now = Date.now }) {
  const base = publicOrigin(origin);
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/.test(passwordHash || "")) throw new Error("Run lakeside init to configure portal authentication");
  const store = sessions(path.join(stateDir, "sessions.json"), now);
  let attempts = 0, windowStart = 0;
  const tokenOf = req => {
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || "");
    if (bearer) return bearer[1];
    const values = String(req.headers.cookie || "").split(";").map(x => x.trim()).filter(x => x.startsWith("ops_session="));
    return values.length === 1 ? values[0].slice(12) : null;
  };
  const cookie = (token, age = 604800) => `ops_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${base.protocol === "https:" ? "; Secure" : ""}`;
  return http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    try {
      if (req.headers.host !== base.host) return json(421, { error: "Unexpected host" });
      const url = new URL(req.url, base);
      if (!["GET", "HEAD"].includes(req.method)) {
        if (req.headers.origin && req.headers.origin !== base.origin) return json(403, { error: "Unexpected origin" });
        // Non-browser clients send JSON. HTML form submissions require Origin.
        if (!req.headers.origin && !req.headers["content-type"]?.startsWith("application/json")) return json(403, { error: "Origin required" });
      }
      if (url.pathname === "/api/portal/config" && req.method === "GET") return json(200, { mode: "standalone", auth: "password" });
      if (url.pathname === "/api/health" && req.method === "GET") return json(200, { ok: true, mode: "standalone" });
      if (url.pathname === "/api/login" && req.method === "POST") {
        if (now() - windowStart > 60000) { attempts = 0; windowStart = now(); }
        if (++attempts > 10) return json(429, { error: "Too many sign-in attempts. Try again in a minute." });
        const input = await body(req);
        if (!await passwordMatches(input.password, passwordHash)) return json(401, { error: "Invalid credentials" });
        const token = store.create(); res.setHeader("Set-Cookie", cookie(token));
        return json(200, { ok: true, email, role: "admin", mode: "standalone" });
      }
      const token = tokenOf(req);
      const authenticated = store.has(token);
      if (req.method === "GET" && ["/", "/keir/app", "/portal.js", "/portal.css", "/keir/keir-mark.svg", "/keir/keir-apple-touch-icon.png"].includes(url.pathname)) {
        const name = ["/", "/keir/app"].includes(url.pathname) ? "index.html" : url.pathname.split("/").pop();
        res.setHeader("Content-Type", name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".js") ? "text/javascript" : name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".png") ? "image/png" : "text/css");
        return res.end(fs.readFileSync(path.join(__dirname, "public", name)));
      }
      if (!authenticated) return json(401, { error: "Sign in required" });
      if (url.pathname === "/api/logout" && req.method === "POST") { store.remove(token); res.setHeader("Set-Cookie", cookie("", 0)); return json(200, { ok: true }); }
      if (url.pathname === "/api/me" && req.method === "GET") return json(200, { email, role: "admin", mode: "standalone", capabilities: ["keir"] });
      if (url.pathname.startsWith("/api/keir/app/")) return runtime.server.emit("request", req, res);
      return json(404, { error: "Not available in standalone mode" });
    } catch (error) { return json(error.status || 400, { error: error.status ? error.message : "Invalid request" }); }
  });
}

function start(env = process.env) {
  if (!env.LAKESIDE_CONFIG || !env.LAKESIDE_PUBLIC_URL) throw new Error("LAKESIDE_CONFIG and LAKESIDE_PUBLIC_URL are required");
  const configFile = path.resolve(env.LAKESIDE_CONFIG);
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const { createDiscordChannel, discordSettings } = require("../../agent/lib/standalone/discord");
  const discordConfig = discordSettings(env);
  const { createRuntime } = require("../../agent/lib/standalone/runtime");
  const runtime = createRuntime({ configFile, binary: env.LAKESIDE_AGENT_BIN || "lakeside-agent", grant: env.LAKESIDE_PORTAL_GRANT || "read", worktree: env.LAKESIDE_PORTAL_WORKTREE || null });
  const server = createPortal({ origin: env.LAKESIDE_PUBLIC_URL, passwordHash: env.LAKESIDE_PASSWORD_HASH, stateDir: path.join(config.state_dir, "portal"), runtime, email: env.LAKESIDE_OWNER_EMAIL });
  const discord = discordConfig ? createDiscordChannel({ runtime, ...discordConfig }) : null;
  discord?.start();
  server.listen(Number(env.PORT || 9724), env.HOST || "127.0.0.1", () => console.log("Keir portal ready"));
  const stop = () => { discord?.stop(); runtime.stop(); server.close(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return { server, runtime };
}
if (require.main === module) start();
module.exports = { createPortal, publicOrigin, start };
