"use strict";
// Independent, deterministic observer. It never opens the operator ledger.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const MINUTE = 60000;
const TERMINAL = new Set(["done", "dismissed", "cancelled", "closed", "failed"]);
const READS = { overview: ["gamestate", "game_overview", {}], anomalies: ["turndiag", "turn_anomalies", { turns: 3 }], lock: ["turndiag", "lock_status", {}] };
function compactEvidence(evidence) {
  const text = JSON.stringify(evidence);
  return text.length > 4000 ? { detailPreview: text.slice(0, 3500), truncated: true } : evidence;
}
function timestamp(value) { const n = typeof value === "number" ? value : Date.parse(value); return Number.isFinite(n) ? n : 0; }
function localUrl(value) {
  const u = new URL(value);
  if (u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.username || u.password || u.search || u.hash) throw new Error("Watchkeeper URLs must be local HTTP endpoints without credentials, query or fragment");
  return u.toString().replace(/\/$/, "");
}
function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (state.version !== 1 || !state.incidents || !Array.isArray(state.outbox)) throw new Error("invalid Watchkeeper state");
    return state;
  } catch (e) { if (e.code !== "ENOENT") throw e; return { version: 1, incidents: {}, outbox: [], sensors: {} }; }
}
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(state)}\n`); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch (e) { if (e.code !== "ENOENT") throw e; } }
}
function parseMcp(text) {
  const raw = text.trim().startsWith("{") ? text : text.split("\n").filter(x => x.startsWith("data:")).at(-1)?.slice(5);
  const envelope = JSON.parse(raw);
  if (envelope.error) throw new Error(`MCP error: ${envelope.error.message || "request failed"}`);
  const result = envelope.result;
  if (!result || result.isError) throw new Error("MCP read failed");
  if (result.structuredContent) return result.structuredContent;
  const content = result.content?.filter(x => x.type === "text").map(x => x.text).join("\n");
  if (!content) throw new Error("MCP read returned no data");
  return JSON.parse(content);
}
function createWatchkeeper({ stateFile = "/var/lib/keir-watchkeeper/state.json", operatorUrl = "http://127.0.0.1:9765", gamestateUrl = "http://127.0.0.1:9730/mcp", turndiagUrl = "http://127.0.0.1:9736/mcp", token, readToken, fetchImpl = fetch, now = Date.now, log = console.log, requestTimeoutMs = 5000, runTimeoutMs = 40000, stallMs = 30 * MINUTE, staleMs = 10 * MINUTE } = {}) {
  const operator = localUrl(operatorUrl), urls = { gamestate: localUrl(gamestateUrl), turndiag: localUrl(turndiagUrl) };
  if (!token || !readToken) throw new Error("Watchkeeper requires its scoped endpoint token and read-only MCP token");
  // Hard caps also apply when callers accidentally pass larger values.
  const timeout = Math.max(1, Math.min(requestTimeoutMs, 5000));
  const budget = Math.max(1, Math.min(runTimeoutMs, 40000));
  async function run() {
    const state = loadState(stateFile), at = now(), deadline = AbortSignal.timeout(budget);
    state.sensors ||= {};
    const persist = () => saveState(stateFile, state);
    function observe(base, kind, title, evidence, jobId) {
      title = title.slice(0, 170); evidence = compactEvidence(evidence);
      let incident = state.incidents[base];
      if (!incident?.active) {
        const episode = (incident?.episode || 0) + 1;
        incident = state.incidents[base] = { active: true, episode, firstSeen: at, kind, title, key: `${base}:${episode}`, ...(jobId ? { jobId } : {}) };
        state.outbox.push({ key: incident.key, kind, title, evidence: JSON.stringify({ status: "active", incidentKey: incident.key, ...compactEvidence(evidence) }), observedAt: new Date(at).toISOString(), ...(jobId ? { jobId } : {}) });
        log(`watchkeeper observation ${incident.key}: ${title}`);
      }
      incident.lastSeen = at;
    }
    function recover(base, evidence = {}) {
      const incident = state.incidents[base];
      if (!incident?.active) return;
      incident.active = false; incident.recoveredAt = at;
      state.outbox.push({ key: `${incident.key}:recovery:${incident.episode}`, kind: incident.kind, title: `Recovered: ${incident.title}`, evidence: JSON.stringify({ status: "recovered", incidentKey: incident.key, ...compactEvidence(evidence) }), observedAt: new Date(at).toISOString(), ...(incident.jobId ? { jobId: incident.jobId } : {}) });
      log(`watchkeeper recovery ${incident.key}`);
    }
    async function request(url, auth, body) {
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(timeout)]);
      // Explicit race also bounds injected transports that do not honor AbortSignal.
      let onAbort;
      const aborted = new Promise((_, reject) => { onAbort = () => reject(new Error("Watchkeeper request deadline exceeded")); if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); });
      try {
        return await Promise.race([aborted, (async () => {
          const response = await fetchImpl(url, { method: body ? "POST" : "GET", redirect: "error", headers: { Authorization: `Bearer ${auth}`, Accept: "application/json, text/event-stream", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          if (text.length > 2 * 1024 * 1024) throw new Error("Watchkeeper response too large");
          return text;
        })()]);
      } finally { signal.removeEventListener("abort", onAbort); }
    }
    async function readSensor(name, fn, validate) {
      try {
        const result = await fn();
        if (!validate(result)) throw new Error("invalid sensor response");
        state.sensors[name] = { succeededAt: at };
        recover(`sensor:${name}`);
        return result;
      } catch (e) {
        // One slow read that the next minute's run answers is not an outage;
        // raise only on the second failure in a row.
        const failures = (state.sensors[name]?.failures || 0) + 1;
        state.sensors[name] = { ...state.sensors[name], failedAt: at, error: e.message, failures };
        if (failures >= 2) observe(`sensor:${name}`, name === "operator" ? "operator_unavailable" : "sensor_stale", `${name} observation unavailable`, { error: e.message, failures, lastSuccessAt: state.sensors[name].succeededAt || null });
        return null;
      }
    }
    const [snapshot, overview, anomalies, lock] = await Promise.all([
      readSensor("operator", async () => JSON.parse(await request(`${operator}/v5/roles/snapshot`, token)), x => x && Array.isArray(x.jobs) && x.scan && x.heartbeat != null),
      ...Object.entries(READS).map(([name, [server, tool, args]]) => readSensor(name, async () => parseMcp(await request(urls[server], readToken, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } })), x => name === "overview" ? Number.isFinite(Number(x?.turn)) && typeof x.paused === "boolean" : name === "anomalies" ? Array.isArray(x?.anomalies) : typeof x?.isProcessing === "boolean")),
    ]);
    if (snapshot) {
      const stale = at - timestamp(snapshot.heartbeat) > staleMs || at - timestamp(snapshot.scan.lastSuccessAt) > staleMs || (snapshot.scan.consecutiveFailures ?? snapshot.scan.failures) > 0;
      if (stale) observe("operator:scan", "scan_stale", "Operator heartbeat or intake scan is stale", { heartbeat: snapshot.heartbeat, scan: snapshot.scan, paused: snapshot.paused }); else recover("operator:scan");
      const current = new Set();
      state.jobProgress ||= {};
      for (const job of snapshot.jobs) {
        const base = `job:${job.id}:stalled`; current.add(base);
        const approvals = (job.pendingApprovals || []).filter(a => !["denied", "rejected", "expired", "applied", "cancelled"].includes(a.state));
        const held = job.waitingFor || job.ownerDecisionPending || job.staffHeld || job.uncertainEffect || timestamp(job.wakeAt) > at || approvals.length || (job.developerHandoffs || []).some(h => !TERMINAL.has(h.state)) || /(?:player_reply|owner_approval|staff_hold|approval|uncertain)/.test(job.state || "");
        const active = job.kind === "ticket" && !snapshot.paused && !TERMINAL.has(job.state) && ["queued", "ready", "running", "pending", "active", "waiting", "blocked"].includes(job.state);
        let progress = 0;
        if (job.kind === "ticket") {
          // Activation timestamps are bookkeeping, not evidence of useful work.
          const fingerprint = String(job.progressFingerprint ?? (job.summary || "").trim().replace(/\s+/g, " "));
          let tracked = state.jobProgress[job.id];
          if (!tracked) {
            const baseline = Math.max(...[job.at, job.lastPublishedAt].map(timestamp));
            tracked = state.jobProgress[job.id] = { fingerprint, meaningfulAt: baseline > 0 ? Math.min(baseline, at) : at };
          } else if (tracked.fingerprint !== fingerprint) {
            tracked.fingerprint = fingerprint; tracked.meaningfulAt = at;
          }
          progress = tracked.meaningfulAt;
        }
        if (active && !held && progress && at - progress > stallMs) observe(base, "ticket_stalled", `Operator job ${job.id} stopped making progress`, { state: job.state, progressAt: progress, ticket: job.ticket }, job.id); else recover(base, { state: job.state, held: Boolean(held) });
        for (const approval of approvals) {
          const key = `approval:${approval.id}:delivery`; current.add(key);
          if (["failed", "error", "undelivered"].includes(approval.deliveryStatus)) observe(key, "approval_delivery_failed", `Approval ${approval.id} was not delivered`, { state: approval.state, deliveryStatus: approval.deliveryStatus }, job.id); else recover(key);
        }
      }
      for (const key of Object.keys(state.incidents)) if ((key.startsWith("job:") || key.startsWith("approval:")) && !current.has(key)) recover(key, { absentFromActiveSnapshot: true });
      const watch = snapshot.watch || {};
      for (const [sensor, succeededAt] of Object.entries(watch.succeeded || {})) {
        const base = `operator:sensor:${sensor}`;
        const threshold = ({ turns: 60, economy: 180, invariants: 180, heal: 540, sentry: 120, pages: 360 }[sensor] || 360) * MINUTE;
        if (at - timestamp(succeededAt) > threshold) observe(base, "sensor_stale", `Operator ${sensor} sensor is stale`, { succeededAt }); else recover(base);
      }
    }
    if (lock) {
      const stalled = !lock.paused && (lock.verdict === "stuck" || (lock.isProcessing && Number(lock.heartbeatAgeSec) > 600) || (!lock.isProcessing && Number(lock.overdueMin) > 30));
      if (stalled) observe("game:stalled", "game_turn_stalled", "Game turn processing is stalled", { lock }); else recover("game:stalled", { lock });
    }
    if (overview) state.lastGame = { at, turn: overview.turn, paused: overview.paused };
    if (anomalies) {
      for (const a of anomalies.anomalies) if (a.kind === "turn-failed" || /^phase-(?:failed|error|stuck|timed?out)/.test(a.kind)) {
        // Successful newer turns retire historical failures; do not resurrect them.
        const knownTurn = overview?.turn ?? state.lastGame?.turn;
        if (knownTurn != null && Number(a.turn) < Number(knownTurn)) continue;
        observe(`game:failure:${a.turn}:${a.phase || "turn"}`, "game_turn_failed", `Game turn ${a.turn} ${a.phase || "processing"} failed`, { anomaly: a });
      }
    }
    if (overview) for (const base of Object.keys(state.incidents)) {
      const match = /^game:failure:(\d+):/.exec(base);
      if (match && Number(overview.turn) > Number(match[1])) recover(base, { currentTurn: overview.turn });
    }
    state.lastRunAt = at;
    // Durable before delivery: a crash or endpoint failure leaves a retryable outbox.
    persist();
    let delivered = 0;
    for (const observation of [...state.outbox]) {
      if (deadline.aborted) break;
      try {
        const receipt = JSON.parse(await request(`${operator}/v5/watchkeeper/observations`, token, observation));
        if (receipt.ok === false) throw new Error("operator rejected observation");
        state.outbox = state.outbox.filter(x => x.key !== observation.key); delivered++; persist();
      } catch (e) { state.deliveryError = { at, error: e.message }; persist(); log(`watchkeeper delivery pending (${state.outbox.length}): ${e.message}`); break; }
    }
    if (!state.outbox.length) { delete state.deliveryError; persist(); }
    if (!deadline.aborted) {
      try {
        const receipt = JSON.parse(await request(`${operator}/v5/watchkeeper/heartbeat`, token, {
          at, pendingObservations: state.outbox.length,
          sensorFailures: Object.values(state.sensors).filter(s => s.succeededAt !== at).length,
          sensors: Object.fromEntries(Object.entries(state.sensors).map(([name, s]) => [name, { succeededAt: s.succeededAt || null, failedAt: s.failedAt || null }])),
        }));
        if (receipt.ok !== true) throw new Error("operator rejected heartbeat");
        state.lastHeartbeatAt = at; delete state.heartbeatError;
      } catch (e) { state.heartbeatError = { at, error: e.message }; log(`watchkeeper heartbeat pending: ${e.message}`); }
      persist();
    }
    log(`watchkeeper run: ${Object.values(state.incidents).filter(x => x.active).length} active, ${delivered} delivered, ${state.outbox.length} pending`);
    return { state, delivered, healthy: Object.values(state.sensors).every(s => s.succeededAt === at) && !state.outbox.length && !state.heartbeatError && !deadline.aborted };
  }
  return { run };
}
module.exports = { createWatchkeeper, loadState, saveState, localUrl, parseMcp };
