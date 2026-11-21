"use strict";
// HTTP surface of the private owner supervisor on the existing ops web server:
// /api/keir/supervisor/*. Owner only: a valid admin session whose identity is
// the same owner identity the Keir operator accepts for /api/keir/app/*.
// Another admin is refused. Writes need JSON and a same-origin (or absent,
// native) Origin. Creating a private side chat and ticket commands use the
// operator's authenticated app routes with the owner's own session.
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

// The owner's link to Keir's operator for one job: the owner's own sign-in cookie from the request that created the
// job, sent only to the operator's app server on loopback, which checks it against the ops dashboard itself. It lives
// in memory only (never in the state file), so after a restart a job has no link and sends nothing.
function ownerLink(req, env) {
  const session = /(?:^|;\s*)ops_session=([^;]+)/.exec(String(req.headers.cookie || ""))?.[1];
  if (!session) return undefined;
  let upstream;
  try { upstream = new URL(env.KEIR_APP_BASE_URL || "http://127.0.0.1:9768"); } catch { return undefined; }
  if (upstream.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname) || upstream.username || upstream.password) return undefined;
  return { createSideChat: sideChatCreator(session, upstream), ticketCommand: ticketCommandSender(session, upstream, env), retryTicket: ticketRetrier(session, upstream) };
}

// Retry a stalled ticket through the operator's own app routes (the Retry button on the app's ticket page): read the
// ticket's stalled attempt, then ask for exactly that attempt to be retried. The operator applies every hold itself.
function ticketRetrier(session, upstream) {
  const call = async (method, route, body, signal) => {
    const timeout = AbortSignal.timeout(15000);
    let response;
    try {
      response = await fetch(new URL(`/api/keir/app${route}`, upstream), { method, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { cookie: `ops_session=${session}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error("Keir's operator did not answer, so nothing was retried."); }
    const out = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) throw new Error("Keir's operator could not verify your app sign-in, so nothing was retried.");
    if (!response.ok) throw new Error(`${String(out?.error || "Keir's operator refused the retry").slice(0, 300)} Nothing was retried.`);
    return out;
  };
  return async (number, signal) => {
    const n = Number(number);
    if (!Number.isSafeInteger(n) || n < 1 || n > 9999999) throw new Error("ticket must be a ticket number");
    const detail = await call("GET", `/tickets/${n}`, null, signal);
    if (!/^[a-f0-9]{12}$/.test(String(detail?.retryTaskId || ""))) return { retried: false, ticket: n, why: `ticket ${n} has no stalled attempt to retry${detail?.timing?.reason ? ` (${String(detail.timing.reason).slice(0, 200)})` : ""}` };
    const r = await call("POST", `/tickets/${n}/retry`, { taskId: detail.retryTaskId }, signal);
    return { retried: true, ticket: n, state: r?.state || "queued" };
  };
}

// One structured ticket command to the operator (apps/agent ticketcommands.ownerApp). Refusals come back as data and
// are relayed as given; transport failures say plainly whether anything could have been done.
function ticketCommandSender(session, upstream, env) {
  const endpoint = new URL("/api/keir/app/ticket-commands", upstream);
  const timeoutMs = Math.max(1000, Number(env.KEIR_SUPERVISOR_TICKET_TIMEOUT_MS) || 90000);
  return async (command, signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetch(endpoint, { method: "POST", headers: { cookie: `ops_session=${session}`, "Content-Type": "application/json" },
        body: JSON.stringify(command), redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (e) {
      const refused = e?.cause?.code === "ECONNREFUSED";
      throw new Error(refused ? "Keir's operator is not running right now, so nothing was changed." : "Keir's operator did not answer in time, so I cannot tell yet whether the change was made.");
    }
    let body = null; try { body = await response.json(); } catch { /* below */ }
    if (response.status === 401 || response.status === 403) throw new Error("Keir's operator could not verify your app sign-in, so nothing was changed. Sign in again and resend the request.");
    if (response.status === 404) throw new Error("Keir's operator on this server does not take ticket commands from this chat yet (it needs its next release). Nothing was changed.");
    if (response.status === 503) throw new Error("Keir's operator could not check your sign-in just now, so nothing was changed. Try again in a minute.");
    if (!response.ok || !body || typeof body !== "object") throw new Error(`Keir's operator refused the command${body?.error ? `: ${String(body.error).slice(0, 200)}` : ""}. Nothing was changed.`);
    return body;
  };
}

function sideChatCreator(session, upstream) {
  const endpoint = new URL("/api/keir/app/threads", upstream);
  return async (title, creationKey, signal) => {
    const timeout = AbortSignal.timeout(10000);
    const response = await fetch(endpoint, { method: "POST", headers: {
      cookie: `ops_session=${session}`, "Content-Type": "application/json",
    }, body: JSON.stringify({ title, creationKey }), redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? "The owner’s app session could not be verified. Ask them to resend the side-chat request after signing in."
      : "The conversation service could not create a side chat.");
    const row = await response.json();
    if (!/^[a-f0-9]{12}$/.test(row.id) || typeof row.title !== "string") throw new Error("The conversation service returned no side chat receipt.");
    return { id: row.id, title: row.title, archived: Boolean(row.archived) };
  };
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
      if (route === "/messages") { const r = s.post(body.text, body.clientId, ownerLink(req, env)); return reply(r.duplicate ? 200 : 202, r); }
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
    const { createAttention } = require("./attention");
    const repos = overrides.repos || resolveRepos(env);
    const sandbox = overrides.sandbox || createSandbox(path.join(dir, "workspaces"));
    const executor = overrides.executor || createClaudeExecutor({ env, stateDir: dir });
    // Optional: without an explicit directory no push alert is projected and the in-app proposal card is unaffected.
    let attention = overrides.attention || null, attentionIssue = null;
    if (!attention && env.KEIR_APPROVAL_ATTENTION_DIR) {
      try { attention = createAttention({ dir: env.KEIR_APPROVAL_ATTENTION_DIR, log }); } catch (e) { attentionIssue = e.message; log(`keir-supervisor: ${e.message}`); }
    }
    const publishEnabled = env.KEIR_SUPERVISOR_PUBLISH === "1";
    const guardianDir = env.KEIR_GUARDIAN_DIR || "/var/lib/keir-guardian";
    // Read-only ticket and game evidence through the ops web MCP client, with this host's own credentials.
    const hub = require("../keir-hub-data");
    const evidence = overrides.evidence || (() => {
      return require("./studio-evidence").createStudioEvidence({ mcpCall: hub._mcpCall, configPath: hub.PATHS.mcp, ledgerPath: hub.PATHS.ledger });
    })();
    const studioMcp = require("./studio-mcp").createStudioMcp({ configPath: hub.PATHS.mcp });
    const instance = createSupervisor({ studioMcp, stateDir: dir, repos, sandbox, executor, guardianDir, publishEnabled, evidence, attention,
      publisher: overrides.publisher || (publishEnabled ? createPublisher({ env }) : null), log, ...(overrides.supervisor || {}) });
    const ready = instance.start().catch((e) => log(`keir-supervisor: start failed: ${e.message}`));
    built = { configured: true, missing: [], instance, ready,
      async status() {
        return { configured: true, missing: [], executor: executor.available(), sandbox: await sandbox.available(),
          repos: Object.values(repos).map((r) => publicRepo(r, publishEnabled)), runner: instance.status(), guardian: instance.guardian(),
          approvalAlerts: attention ? { enabled: true } : { enabled: false, ...(attentionIssue ? { issue: attentionIssue } : {}) } };
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

module.exports = { handleKeirSupervisorRoute, createSupervisorHost, ownerIdentity, sameOrigin, supervisorProfile, ownerLink };
