"use strict";
// HTTP surface of the private owner supervisor on the existing ops web server:
// /api/keir/supervisor/*. Owner only: a valid admin session whose identity is
// the same owner identity the Keir operator accepts for /api/keir/app/*.
// Another admin is refused. Writes need JSON and a same-origin (or absent,
// native) Origin. Nothing here proxies to the support operator.
const path = require("node:path");

function ownerIdentity(env = process.env) {
  return String(env.KEIR_SUPERVISOR_OWNER_IDENTITY || `discord_${env.KEIR_OWNER_ID || "333052320252297216"}@discord.local`).toLowerCase();
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    const host = String(req.headers.host || "");
    let ok = false;
    try {
      const target = new URL(`https://${host}`);
      const local = ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
      ok = origin === target.origin || (local && origin === new URL(`http://${host}`).origin);
    } catch { ok = false; }
    if (!ok) return false;
  }
  const site = req.headers["sec-fetch-site"];
  return !site || site === "same-origin" || site === "none";
}

async function readJson(req, limit = 32000) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > limit) throw Object.assign(new Error("request body too large"), { status: 413 }); }
  try { return JSON.parse(body || "{}"); } catch { throw Object.assign(new Error("invalid json"), { status: 400 }); }
}

async function handleKeirSupervisorRoute(req, res, pathname, { resolveSession, getSupervisor, env = process.env }) {
  if (!pathname.startsWith("/api/keir/supervisor/")) return false;
  const reply = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(value));
    return true;
  };
  try {
    const session = await resolveSession(req);
    if (req.opsAuthUnavailable) return reply(503, { error: "Sign-in verification is temporarily unavailable" });
    if (!session) return reply(401, { error: "unauthorized" });
    if (session.role !== "admin" || String(session.email || "").toLowerCase() !== ownerIdentity(env)) return reply(403, { error: "The private supervisor is for the owner only." });

    const sup = getSupervisor();
    if (!sup.configured) return reply(503, { error: "The private supervisor is not set up on this server.", configured: false, missing: sup.missing });
    await sup.ready;
    const s = sup.instance;
    const route = pathname.slice("/api/keir/supervisor".length);
    if (route === "/status" && req.method === "GET") return reply(200, await sup.status());
    if (!s.owner) return reply(503, { error: "The supervisor runner is owned by another web process on this server.", configured: true });
    const url = new URL(req.url, "http://request.local");

    if (req.method === "POST") {
      if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") return reply(415, { error: "JSON required" });
      if (!sameOrigin(req)) return reply(403, { error: "Unexpected origin" });
      const body = await readJson(req);
      if (route === "/messages") { const r = s.post(body.text, body.clientId); return reply(r.duplicate ? 200 : 202, r); }
      const cancel = /^\/jobs\/(j_[a-f0-9]{16})\/cancel$/.exec(route);
      if (cancel) return reply(200, s.cancel(cancel[1]));
      const decision = /^\/proposals\/(p_[a-f0-9]{16})$/.exec(route);
      if (decision) return reply(200, await s.decide(decision[1], body.verdict, body.digest));
      return reply(404, { error: "not found" });
    }
    if (req.method !== "GET") return reply(405, { error: "method not allowed" });
    if (route === "/thread") {
      const afterRaw = url.searchParams.get("after");
      const after = afterRaw === null || afterRaw === "" ? null : Math.max(0, Math.floor(Number(afterRaw)) || 0);
      const limit = url.searchParams.get("limit");
      const wait = Math.min(25, Math.max(0, Number(url.searchParams.get("wait")) || 0)) * 1000;
      const since = url.searchParams.get("since");
      let view = s.thread({ after, limit });
      if (after !== null && wait) {
        const ac = new AbortController(); res.once("close", () => ac.abort());
        const end = Date.now() + wait;
        while (!view.messages.length && (!since || view.version === since) && Date.now() < end && !ac.signal.aborted) {
          await s.waitForChange(Number(view.version), end - Date.now(), ac.signal);
          view = s.thread({ after, limit });
        }
        if (ac.signal.aborted) return true;
      }
      return reply(200, view);
    }
    if (route === "/proposals") return reply(200, { proposals: s.proposals() });
    return reply(404, { error: "not found" });
  } catch (error) {
    if (error.status) return reply(error.status, { error: error.message, ...(error.proposal ? { proposal: error.proposal } : {}) });
    console.error("[keir-supervisor]", error.message);
    return reply(500, { error: "server error" });
  }
}

// Server wiring: builds the supervisor once from env and reports honestly
// what is missing instead of guessing a state location.
function createSupervisorHost({ env = process.env, log = (m) => console.log(m), overrides = {} } = {}) {
  let built = null;
  function build() {
    if (built) return built;
    const missing = [];
    const dir = env.KEIR_SUPERVISOR_DIR;
    if (!dir) missing.push("KEIR_SUPERVISOR_DIR");
    else if (!path.isAbsolute(dir)) missing.push("KEIR_SUPERVISOR_DIR (must be absolute)");
    if (missing.length) { built = { configured: false, missing }; return built; }
    const { resolveRepos, publicRepo } = require("./repos");
    const { createSandbox } = require("./sandbox");
    const { createClaudeExecutor } = require("./executor");
    const { createSupervisor, createPublisher } = require("./supervisor");
    const repos = overrides.repos || resolveRepos(env);
    const sandbox = overrides.sandbox || createSandbox(path.join(dir, "workspaces"));
    const executor = overrides.executor || createClaudeExecutor({ env, stateDir: dir });
    const publishEnabled = env.KEIR_SUPERVISOR_PUBLISH === "1";
    const guardianDir = env.KEIR_GUARDIAN_DIR || "/var/lib/keir-guardian";
    // Read-only ticket and game evidence through the ops web MCP client, with this host's own credentials.
    const evidence = overrides.evidence || (() => {
      const hub = require("../keir-hub-data");
      return require("./studio-evidence").createStudioEvidence({ mcpCall: hub._mcpCall, configPath: hub.PATHS.mcp });
    })();
    const instance = createSupervisor({ stateDir: dir, repos, sandbox, executor, guardianDir, publishEnabled, evidence,
      publisher: overrides.publisher || (publishEnabled ? createPublisher({ env }) : null), log, ...(overrides.supervisor || {}) });
    const ready = instance.start().catch((e) => log(`keir-supervisor: start failed: ${e.message}`));
    built = { configured: true, missing: [], instance, ready,
      async status() {
        return { configured: true, missing: [], executor: executor.available(), sandbox: await sandbox.available(),
          repos: Object.values(repos).map((r) => publicRepo(r, publishEnabled)), runner: instance.status(), guardian: instance.guardian() };
      } };
    return built;
  }
  return { get: build };
}

async function supervisorProfile(session, host, env = process.env) {
  if (session.role !== "admin" || String(session.email || "").toLowerCase() !== ownerIdentity(env) || !env.KEIR_SUPERVISOR_DIR) {
    return { ownerSupervisor: false };
  }
  // Keep the private destination selected even in an outage. The phone can
  // explain what failed without routing a private maintenance message elsewhere.
  let issue = "The private supervisor could not start.";
  try {
    const sup = host.get();
    if (!sup.configured) issue = "The private supervisor configuration is incomplete.";
    else {
      await sup.ready;
      const { executor, sandbox } = await sup.status();
      if (!sup.instance.owner) issue = "The private supervisor is waiting for its runner.";
      else if (!executor.available) issue = executor.reason;
      else if (!sandbox.available) issue = sandbox.reason;
      else return { ownerSupervisor: true, ownerSupervisorReady: true };
    }
  } catch { /* an unavailable supervisor must not break sign-in */ }
  return { ownerSupervisor: true, ownerSupervisorReady: false, ownerSupervisorIssue: issue };
}

module.exports = { handleKeirSupervisorRoute, createSupervisorHost, ownerIdentity, sameOrigin, supervisorProfile };
