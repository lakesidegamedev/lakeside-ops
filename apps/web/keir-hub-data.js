"use strict";

// Keir hub data (/api/keir/hub). One snapshot of what Keir is doing, read on
// this box: the operator ledger (jobs, decisions, status cards), the
// per-activation usage log, the Rust harness attempts and shadow report, Keir's
// pull requests on GitHub, canonical ticket status from the support MCP, and
// matching kanban items. Local files are read on every request (they are
// small and change by the second); GitHub, support and kanban are cached for
// a minute so a page left open costs nothing upstream.

const fs = require("node:fs");
const { buildWatchState } = require("./keir-watch-data");
const { buildThroughput } = require("./keir-throughput-data");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const PATHS = {
  ledger: process.env.KEIR_LEDGER || "/var/lib/keir-operator/ledger.json",
  usage: process.env.KEIR_USAGE || "/var/lib/keir-operator/usage.jsonl",
  harness: process.env.KEIR_HARNESS_DB || "/var/lib/keir-operator/harness/harness.db",
  shadow: process.env.KEIR_SHADOW || "/var/lib/keir-operator/shadow-rs/latest.json",
  release: process.env.KEIR_RELEASE || "/opt/keir/current/RELEASE",
  env: process.env.KEIR_OPERATOR_ENV || "/etc/keir-operator.env",
  mcp: process.env.KEIR_MCP_CONFIG || "/root/.claude.json",
};
const REPO = "lakesidegamedev/AHDGame";
const TERMINAL = new Set(["done", "dismissed", "cancelled"]);
const RUNNERS = ["claude", "codex", "muse", "agy"];

const ticketOf = (j) => j.ticket || Number(/^ticket-.*-(\d+)$/.exec(j.source?.channelName || "")?.[1] || 0) || null;
const runnerOfLabel = (p = "") => (/^claude/.test(p) ? "claude" : /^codex/.test(p) ? "codex" : /^muse/.test(p) ? "muse" : /^antigravity|^agy/.test(p) ? "agy" : "other");
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

function readUsage(file, sinceMs) {
  let text = "";
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - 4 * 1024 * 1024);
    const fd = fs.openSync(file, "r");
    try { const buf = Buffer.alloc(st.size - start); fs.readSync(fd, buf, 0, buf.length, start); text = buf.toString("utf8"); } finally { fs.closeSync(fd); }
  } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try { const r = JSON.parse(line); const at = Date.parse(r.at); if (r.event === "activation" && at >= sinceMs) out.push({ ...r, atMs: at }); } catch {}
  }
  return out;
}

// Rust harness attempts (lakeside activation and run), read-only.
function readAttempts(file, sinceMs) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare("SELECT a.id, a.task_id, a.provider, a.model, a.started_at, a.ended_at, a.exit_code, a.timed_out, a.quota_hold, a.tool_calls, a.duration_ms, t.kind AS task_kind, t.role, t.project FROM h_attempts a LEFT JOIN h_tasks t ON t.id = a.task_id WHERE a.started_at >= ? ORDER BY a.started_at DESC LIMIT 400").all(sinceMs).map((r) => ({ ...r, label: attemptLabel(r) }));
    } finally { db.close(); }
  } catch { return []; }
}

// A readable name for a harness task: "Ticket 1514", "Coder, a-house-divided".
function attemptLabel(r) {
  const id = String(r.task_id || "");
  let m;
  if ((m = /^ticket:(\d+)/.exec(id))) return `Ticket ${m[1]}`;
  if (/^request:/.test(id)) return r.role === "quick" ? "Quick request" : "Request";
  if ((m = /^vision-bench:(?:\d+-)?(.+)/.exec(id))) return `Vision bench, ${m[1].replace(/-/g, " ")}`;
  if (r.role) return `${r.role[0].toUpperCase()}${r.role.slice(1)}${r.project ? `, ${r.project}` : ""}`;
  return id.slice(0, 40);
}

// The tool a trace event called, across the three CLI shapes: Claude and
// Codex name it on the event, Muse inside the run record's correlation facts.
function toolOf(p) {
  const raw = p.tool || p.payload?.payload?.correlation_facts?.tool_name || null;
  if (!raw) return null;
  const name = String(raw).replace(/^mcp__harness__/, "");
  if (/^(read|write)_tool$/.test(name) && p.text) {
    try { const a = JSON.parse(p.text); if (a.server && a.tool) return `${a.server} ${a.tool}`; } catch {}
  }
  return name;
}

// Hourly activations by runner for the last 24 hours, oldest first.
function activityByHour(usage, now) {
  const hour = 3600000, start = Math.floor(now / hour) * hour - 23 * hour;
  const buckets = Array.from({ length: 24 }, (_, i) => ({ at: start + i * hour, claude: 0, codex: 0, muse: 0, agy: 0, other: 0, failed: 0, ms: 0 }));
  for (const u of usage) {
    const i = Math.floor((u.atMs - start) / hour);
    if (i < 0 || i > 23) continue;
    const b = buckets[i]; b[runnerOfLabel(u.provider)]++; b.ms += u.durationMs || 0;
    if (u.outcome && u.outcome !== "ok") b.failed++;
  }
  return buckets;
}

function summarizeJob(j, d, now) {
  const p = j.provider || {};
  const history = (j.history || []).slice(-6).map((h) => ({ at: Date.parse(h.at) || h.at || null, kind: h.kind, state: h.state || null, summary: String(h.summary || "").slice(0, 500) }));
  return {
    id: j.id, kind: j.kind, role: j.role, state: j.state, ticket: ticketOf(j), coder: Boolean(j.codingParent), parent: j.codingParent || null,
    runner: p.runner || null, model: p.model || null, via: p.via || "node", attempt: p.attempt || null, effort: j.effort?.effort || p.effort || null,
    rounds: j.rounds || 0, startedAt: j.startedAt || null, updatedAt: j.updatedAt || j.at || null, wakeAt: j.state === "waiting" ? j.wakeAt || null : null,
    summary: String(j.summary || "").slice(0, 400), tags: j.tags ? { kind: j.tags.kind, mood: j.tags.mood, urgency: j.tags.urgency, complexity: j.tags.complexity, needsVision: j.tags.needsVision, injection: j.tags.injection } : null,
    pullRequests: j.pullRequests || [], history,
    decisions: Object.values(d.decisions || {}).filter((x) => x.jobId === j.id && x.state === "pending").map((x) => ({ id: x.id, at: x.at, tldr: x.tldr || String(x.question || "").slice(0, 240) })),
  };
}

// Keir's audit trail told as plain sentences, for the live feed and the
// timeline marks. Bookkeeping (checkpoints, housekeeping, classifier reads,
// tool sessions, approval digests) stays out; activations come from the
// usage log so each one carries its runner and duration.
function narrate(a, d) {
  const jobs = d.jobs || {};
  const jobId = a.job || d.decisions?.[a.decision]?.jobId || null;
  const j = jobId ? jobs[jobId] : null;
  if (j?.internalProbe) return null;
  const ticket = a.ticket || (j ? ticketOf(j) : null);
  const on = ticket ? ` on ticket ${ticket}` : "";
  const e = (cat, text, extra = {}) => ({ id: `${a.at}:${a.kind}:${jobId || ""}:${a.key || a.decision || ""}`, at: a.at, cat, text, ticket, job: jobId, runner: j?.provider?.runner || null, ...extra });
  switch (a.kind) {
    case "created":
      if (!j || /^quick-probe/.test(a.source || "") || ["coding", "probe"].includes(j.kind)) return null;
      return e("intake", j.kind === "ticket" ? `Picked up ticket ${ticket}` : j.kind === "command" ? `Took a staff request${on}` : j.kind === "conversation" ? "Started a conversation" : `Took a ${j.kind} job`);
    case "intake_tagged": {
      const t = a.tags || {};
      return e("intake", `Read ticket ${ticket} as ${[String(t.kind || "a request").replace(/_/g, " "), t.mood && t.mood !== "calm" ? t.mood : null, t.urgency === "high" ? "urgent" : null].filter(Boolean).join(", ")}`);
    }
    case "handoff_received": return e("intake", `Took a handoff from ${a.from || "a teammate"}${a.tickets?.length ? ` for ticket ${a.tickets.join(", ")}` : ""}`, { ticket: a.tickets?.[0] || ticket });
    case "ticket_owner": return e("intake", `Support owner for ticket ${ticket} is now ${a.owner}`);
    case "ticket_model_assigned": return e("intake", `Ticket ${ticket} assigned to ${a.model || a.runner}`, { runner: a.runner || null });
    case "coding_delegated": return e("code", `Handed code work${on} to a coding subworker`);
    case "coding_result_ready": return e("code", `Coding subworker came back with a patch${on}`);
    case "coding_patch_applied": return e("code", `Applied the patch${on}`);
    case "ci_watch_done": return e("ship", `Checks finished on PR #${a.number}`, { pr: a.number || null });
    case "ci_wait_update": return e("talk", `Told the player${on} the checks are still running`);
    case "promotion_held_awake_window": return e("guard", `Held a promote to ${a.to}${on} for your waking hours`);
    case "economy_consent": return e("ship", `Economy change to ${a.to}${on} went out on your approval`);
    case "decision_opened": case "owner_request_approval": return e("ask", `Asked you to decide${on}`);
    case "decision_escalated": return e("ask", "Sent a waiting decision to the delegate");
    case "decision_answered": return e(a.verdict === "approve" ? "yes" : "no", a.verdict === "approve" ? `You approved${on}` : `You declined${on}`);
    case "turn_watch_done": return e("run", `Turn ${a.turn} ran, so Keir checked back${on}`);
    case "kb_learned": return e("learn", `Saved notes: ${String(a.doc || "").replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-/g, " ").slice(0, 90)}`);
    case "second_look_refused": return e("guard", `Second look stopped an unconfirmed claim${on}`);
    case "post_screened": return a.refused ? e("guard", `Screen refused a post${on}`) : null;
    case "merged_into_incident": return e("incident", `Merged ticket ${ticket} into incident ${a.target}`);
    case "owner_pause": return e("guard", "Operator paused");
    case "effect": {
      const [k, x, y] = String(a.key || "").split(":");
      if (k === "merge") return e("ship", `Merged PR #${x}`, { pr: Number(x) || null });
      if (k === "promote-pr") return e("ship", `Opened a promote from ${x} to ${y}`);
      if (k === "close-pr") return e("ship", `Closed PR #${x}`, { pr: Number(x) || null });
      if (k === "ticket-update") return e("talk", `Posted an update${on}`);
      if (k === "status-card") return e("talk", `Updated the progress card on ticket ${x}`, { ticket: Number(x) || ticket });
      if (k === "delivery") return e("talk", `Replied${on}`);
      return null;
    }
    default: return null;
  }
}

// The live feed and the timeline lanes for the last twelve hours. A lane is a
// job that ran, acted or is still live in that window; its spans are
// activations (end time and duration from the usage log, plus the one running
// now), its marks are narrated audit events.
function buildStream(d, usage, now, { windowMs = 12 * 3600000, laneCap = 14 } = {}) {
  const since = now - windowMs;
  const jobs = d.jobs || {};
  const events = [];
  for (const a of d.audit || []) {
    if (!(a.at >= since)) continue;
    const ev = narrate(a, d);
    if (ev) events.push(ev);
  }
  for (const u of usage) {
    if (u.atMs < since) continue;
    const j = jobs[u.job];
    if (j?.internalProbe) continue;
    const ticket = u.ticket || (j ? ticketOf(j) : null);
    const runner = runnerOfLabel(u.provider);
    events.push({ id: `${u.atMs}:activation:${u.job || ""}`, at: u.atMs, cat: u.outcome && u.outcome !== "ok" ? "fail" : "run", runner, ticket, job: u.job || null, ms: u.durationMs || 0,
      text: `${u.outcome && u.outcome !== "ok" ? "Activation did not finish" : "Worked"}${ticket ? ` on ticket ${ticket}` : u.kind ? ` on a ${u.kind}` : ""} for ${Math.max(1, Math.round((u.durationMs || 0) / 1000))}s${u.turns ? `, ${u.turns} turns` : ""}`, model: u.model || null });
  }
  events.sort((a, b) => b.at - a.at);

  const lanes = new Map();
  const lane = (id) => {
    const j = jobs[id];
    if (!j || j.internalProbe) return null;
    if (!lanes.has(id)) lanes.set(id, { id, ticket: ticketOf(j), kind: j.kind, coder: Boolean(j.codingParent), state: j.state, runner: j.provider?.runner || null,
      startedAt: j.state === "running" ? j.startedAt || null : null, wakeAt: j.state === "waiting" ? j.wakeAt || null : null, firstAt: Date.parse(j.at) || j.at || null, spans: [], marks: [], last: 0 });
    return lanes.get(id);
  };
  for (const u of usage) {
    if (u.atMs < since || !u.job) continue;
    const l = lane(u.job); if (!l) continue;
    l.spans.push({ from: u.atMs - (u.durationMs || 0), to: u.atMs, runner: runnerOfLabel(u.provider), ok: !u.outcome || u.outcome === "ok", model: u.model || null });
    l.last = Math.max(l.last, u.atMs);
  }
  for (const ev of events) {
    if (!ev.job || ev.cat === "run" || ev.cat === "fail") continue;
    const l = lane(ev.job); if (!l) continue;
    l.marks.push({ id: ev.id, at: ev.at, cat: ev.cat, text: ev.text });
    l.last = Math.max(l.last, ev.at);
  }
  for (const j of Object.values(jobs)) {
    if (TERMINAL.has(j.state) || j.internalProbe) continue;
    const fresh = now - (j.updatedAt || 0) < windowMs;
    if (j.state === "running" || j.state === "queued" || (j.state === "waiting" && fresh) || (j.state === "blocked" && fresh)) {
      const l = lane(j.id); if (l) l.last = Math.max(l.last, j.state === "running" ? now : j.updatedAt || 0);
    }
  }
  const rank = { running: 0, queued: 1, waiting: 2, blocked: 3 };
  const list = [...lanes.values()].sort((a, b) => (rank[a.state] ?? 4) - (rank[b.state] ?? 4) || b.last - a.last);
  return { feed: events.slice(0, 120), lanes: list.slice(0, laneCap), hiddenLanes: Math.max(0, list.length - laneCap), windowMs };
}

// What a running Rust attempt is doing right now: its newest tool calls and
// words, read from the trace as it streams in.
function liveTails(file, now) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const open = db.prepare("SELECT a.id, a.task_id, a.provider, a.model, a.started_at, t.kind AS task_kind, t.role, t.project FROM h_attempts a LEFT JOIN h_tasks t ON t.id = a.task_id WHERE a.ended_at IS NULL AND a.started_at >= ? ORDER BY a.started_at DESC LIMIT 6").all(now - 2 * 3600000);
      return open.map((a) => {
        const rows = db.prepare("SELECT at, kind, payload FROM attempt_events WHERE attempt_id = ? AND kind IN ('tool_use', 'assistant_text', 'error') ORDER BY seq DESC LIMIT 8").all(a.id);
        const steps = rows.reverse().map((e) => {
          let p = {}; try { p = JSON.parse(e.payload); } catch {}
          return { at: e.at, kind: e.kind, tool: e.kind === "tool_use" ? toolOf(p) : null, text: e.kind !== "tool_use" && typeof p.text === "string" ? p.text.slice(0, 220) : null };
        });
        const calls = db.prepare("SELECT count(*) AS n FROM attempt_events WHERE attempt_id = ? AND kind = 'tool_use'").get(a.id).n;
        return { id: a.id, label: attemptLabel(a), ticket: Number(/^ticket:(\d+)/.exec(a.task_id || "")?.[1] || 0) || null, provider: a.provider, model: a.model, startedAt: a.started_at, calls, steps };
      });
    } finally { db.close(); }
  } catch { return []; }
}

// External sources, cached per process.
const cache = new Map();
async function cached(key, ttlMs, fn, options = {}) {
  const hit = cache.get(key), hasValue = hit && Object.hasOwn(hit, "value");
  if (hasValue && Date.now() - Math.max(hit.at || 0, hit.attemptedAt || 0) < ttlMs) return hit.value;
  if (hit?.pending) return hasValue ? hit.value : Object.hasOwn(options, "initial") ? options.initial : hit.pending;
  const entry = hit || {};
  cache.set(key, entry);
  entry.pending = Promise.resolve().then(fn).then((value) => {
    if (value?.error) throw new Error(typeof value.error === "string" ? value.error : value.error.message || "Upstream returned an error");
    return value;
  }).then((value) => {
    entry.value = value; entry.at = Date.now(); entry.error = null;
    return value;
  }, (e) => {
    entry.error = String(e.message || e).slice(0, 300);
    // Keep the last good snapshot visible, with its original freshness time.
    if (!Object.hasOwn(entry, "value")) { entry.value = { error: entry.error }; entry.at = null; }
    return entry.value;
  }).finally(() => { entry.attemptedAt = Date.now(); delete entry.pending; });
  return hasValue ? entry.value : Object.hasOwn(options, "initial") ? options.initial : entry.pending;
}
function sourceFreshness(key) {
  const entry = cache.get(key);
  return { at: entry?.at || null, refreshing: Boolean(entry?.pending), error: entry?.error || null };
}

async function mcpCall(server, tool, args, { fetchImpl = fetch, configPath = PATHS.mcp } = {}) {
  const cfg = readJson(configPath)?.mcpServers?.[server];
  if (!cfg?.url || !/^http:\/\/(127\.0\.0\.1|localhost):/.test(cfg.url)) throw new Error(`${server} MCP not configured locally`);
  const res = await fetchImpl(cfg.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(cfg.headers || {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }), signal: AbortSignal.timeout(15000) });
  if (res.ok === false) throw new Error(`${server} answered HTTP ${res.status}`);
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) || text;
  const j = JSON.parse(line.trim());
  if (j.error || j.result?.isError) throw new Error(j.error?.message || `${server} tool ${tool} failed`);
  const body = (j.result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const value = JSON.parse(body);
  if (value?.error) throw new Error(typeof value.error === "string" ? value.error : `${server} tool ${tool} failed`);
  return value;
}

async function keirPullRequests(run = execFileAsync) {
  const { stdout } = await run("gh", ["pr", "list", "--repo", REPO, "--state", "all", "--limit", "40", "--search", "head:keir/", "--json", "number,title,state,url,headRefName,mergedAt,updatedAt,createdAt,isDraft,statusCheckRollup,body"],
    { env: { ...process.env, HOME: "/root" }, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function ciState(pr) {
  const r = pr.statusCheckRollup || [];
  if (!r.length) return "none";
  if (r.some((c) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(c.conclusion || c.state))) return "red";
  if (r.some((c) => !/SUCCESS|SKIPPED|NEUTRAL/.test(c.conclusion || "") && !/SUCCESS/.test(c.state || ""))) return "pending";
  return "green";
}

async function buildHubState({ now = Date.now(), kanban = null, run = execFileAsync, fetchImpl = fetch, paths = PATHS, backgroundSources = true } = {}) {
  const ledger = readJson(paths.ledger);
  const d = ledger || { jobs: {}, decisions: {}, statusCards: {}, audit: [] };
  const jobs = Object.values(d.jobs || {});
  const live = jobs.filter((j) => !TERMINAL.has(j.state) && !j.internalProbe).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const recent = jobs.filter((j) => TERMINAL.has(j.state) && !j.internalProbe && now - (j.updatedAt || 0) < 6 * 3600000).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 25);
  const usage = readUsage(paths.usage, now - 24 * 3600000);
  const usage12h = usage.filter((u) => u.atMs >= now - 12 * 3600000);
  const attempts = readAttempts(paths.harness, now - 24 * 3600000);
  const shadow = readJson(paths.shadow);
  const release = (() => { try { const [sha, version] = fs.readFileSync(paths.release, "utf8").trim().split(/\s+/); return { sha: sha.slice(0, 12), version }; } catch { return null; } })();
  let envAvailable = false;
  const envText = (() => { try { const text = fs.readFileSync(paths.env, "utf8"); envAvailable = true; return text; } catch { return ""; } })();
  const envValue = (key) => {
    const value = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, "m").exec(envText)?.[1]?.trim() || "";
    return /^["']/.test(value) ? value.slice(1, value.lastIndexOf(value[0])) : value.replace(/\s+#.*$/, "").trim();
  };
  const watchMode = envAvailable ? envValue("KEIR_WATCH") === "0" ? "off" : envValue("KEIR_WATCH") === "report" ? "report" : "active" : null;
  const lanes = (/^KEIR_RUST_RUNNER_LANES=(.*)$/m.exec(envText)?.[1] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const routing = Object.fromEntries(["KEIR_WORKER_PROVIDER", "KEIR_QUICK_PROVIDER", "KEIR_CODING_PROVIDER", "KEIR_VISION_PROVIDER"].map((k) => [k.replace(/^KEIR_|_PROVIDER$/g, "").toLowerCase(), new RegExp(`^${k}=(.*)$`, "m").exec(envText)?.[1] || null]));

  const [prsRaw, support, incidents] = await Promise.all([
    cached("prs", 60000, () => keirPullRequests(run), backgroundSources ? { initial: null } : {}),
    cached("support", 60000, () => mcpCall("support", "support_list", { kind: "ticket", limit: 60 }, { fetchImpl, configPath: paths.mcp }), backgroundSources ? { initial: null } : {}),
    cached("incidents", 60000, () => incidentList({ fetchImpl, configPath: paths.mcp }), backgroundSources ? { initial: null } : {}),
  ]);
  const prs = Array.isArray(prsRaw) ? prsRaw.map((p) => {
    const m = /^keir\/task-([a-f0-9]{12})/.exec(p.headRefName || "");
    const job = m && d.jobs?.[m[1]];
    const ticket = job ? ticketOf(job) : Number(/ticket[ #]*(1\d{3})\b/i.exec(`${p.title}\n${p.body || ""}`)?.[1] || 0) || null;
    const issues = [...new Set([...`${p.title}\n${p.body || ""}`.matchAll(/\b(?:fixes|closes|resolves|refs?)\s+#(\d{3,5})/gi)].map((x) => Number(x[1])))];
    return { number: p.number, title: p.title, state: p.state, url: p.url, draft: p.isDraft, ci: ciState(p), ticket, job: job?.id || null, issues, updatedAt: Date.parse(p.mergedAt || p.updatedAt) || null, mergedAt: Date.parse(p.mergedAt) || null };
  }) : [];
  const issueNumbers = [...new Set(prs.flatMap((p) => p.issues))].slice(0, 20);
  const issues = await cached(`issues:${issueNumbers.join(",")}`, 120000, async () => {
    const out = [];
    for (const n of issueNumbers) {
      try { const { stdout } = await run("gh", ["api", `repos/${REPO}/issues/${n}`, "--jq", "{number,title,state,html_url}"], { env: { ...process.env, HOME: "/root" }, timeout: 20000 }); out.push({ ...JSON.parse(stdout), from: prs.filter((p) => p.issues.includes(n)).map((p) => p.number) }); }
      catch { out.push({ number: n, title: null, state: "unknown", html_url: `https://github.com/${REPO}/issues/${n}`, from: prs.filter((p) => p.issues.includes(n)).map((p) => p.number) }); }
    }
    return out;
  }, backgroundSources ? { initial: null } : {});
  const tickets = Array.isArray(support?.items) ? support.items : [];
  let kanbanItems = [];
  try {
    const store = kanban || require("./kanban-store").sharedKanban();
    const all = store.list({ product: "a-house-divided", include_done: true, limit: 500 });
    const items = Array.isArray(all) ? all : all?.items || [];
    const nums = new Set(tickets.map((t) => t.number));
    kanbanItems = items.filter((k) => {
      const text = `${k.title} ${k.detail || ""} ${k.progress_summary || ""}`;
      return /\bkeir\b/i.test(text) || [...nums].some((n) => new RegExp(`\\b${n}\\b`).test(text));
    }).filter((k) => k.lane !== "done" || now - Date.parse(k.updated_at || 0) < 3 * 86400000).slice(0, 60)
      .map((k) => ({ id: k.id, title: k.title, lane: k.lane, assigned_to: k.assigned_to, impact: k.impact, progress: String(k.progress_summary || "").slice(0, 300), updated_at: k.updated_at, needs_owner: Boolean(k.needs_owner), tickets: [...nums].filter((n) => new RegExp(`\\b${n}\\b`).test(`${k.title} ${k.detail || ""}`)) }));
  } catch (e) { kanbanItems = [{ error: String(e.message).slice(0, 200) }]; }

  const ticketRows = tickets.map((t) => {
    const tj = jobs.filter((j) => ticketOf(j) === t.number);
    const active = tj.filter((j) => !TERMINAL.has(j.state)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    const card = d.statusCards?.[t.number];
    const tagJob = tj.find((j) => j.tags);
    return {
      number: t.number, title: t.title, status: t.status, category: t.category, mergedInto: t.mergedInto ?? null, hasImage: t.hasImage, createdAt: Date.parse(t.createdAt) || null,
      card: card ? { status: card.status || "", at: card.at || null, items: (card.items || []).map((i) => ({ name: i.name, stage: i.stage, blocked: Boolean(i.blocked), note: i.note || "" })) } : null,
      active: active ? { id: active.id, state: active.state, runner: active.provider?.runner || null, via: active.provider?.via || "node", wakeAt: active.wakeAt || null } : null,
      prs: prs.filter((p) => p.ticket === t.number).map((p) => p.number),
      kanban: kanbanItems.filter((k) => (k.tickets || []).includes(t.number)).map((k) => k.id),
      decisionPending: Object.values(d.decisions || {}).some((x) => x.state === "pending" && tj.some((j) => j.id === x.jobId)),
      tags: tagJob?.tags ? { kind: tagJob.tags.kind, mood: tagJob.tags.mood, urgency: tagJob.tags.urgency } : null,
      attempts: tj.length, lastKeirAt: tj.reduce((m, j) => Math.max(m, j.updatedAt || 0), 0) || null,
    };
  });

  const ok = usage.filter((u) => u.outcome === "ok").length;
  const rustAudits = (d.audit || []).filter((a) => a.kind === "rust_activation" && now - a.at < 24 * 3600000);
  // Share since the Rust runner took over, not over a 24 hours that mostly predates it.
  const rustSince = rustAudits.length ? Math.min(...rustAudits.map((a) => a.at)) : null;
  const sinceCutover = rustSince ? usage.filter((u) => u.atMs >= rustSince).length : 0;
  const durations = usage.map((u) => u.durationMs || 0).sort((a, b) => a - b);
  const pick = (q) => (durations.length ? durations[Math.round((durations.length - 1) * q)] : null);

  return {
    at: now, release, lanes, routing,
    throughput: buildThroughput(d, usage, { now, supportTickets: Array.isArray(support?.items) ? tickets : null }),
    // Sentry may come from a separate systemd EnvironmentFile. Absence in
    // this file is not evidence that the running sensor lacks credentials.
    watch: buildWatchState(d, { now, mode: watchMode, ledgerAvailable: Boolean(ledger), sentryConfigured: envValue("SENTRY_API_TOKEN") && envValue("SENTRY_ORG") ? true : null }),
    supportOwner: d.supportOwner?.owner || null, paused: Boolean(d.paused),
    kpis: {
      live: live.length, running: live.filter((j) => j.state === "running").length, waiting: live.filter((j) => j.state === "waiting").length,
      queued: live.filter((j) => j.state === "queued").length, blocked: live.filter((j) => j.state === "blocked").length,
      decisionsPending: Object.values(d.decisions || {}).filter((x) => x.state === "pending").length,
      openTickets: tickets.filter((t) => !["resolved", "closed"].includes(t.status)).length,
      prsOpen: prs.filter((p) => p.state === "OPEN").length, prsRed: prs.filter((p) => p.state === "OPEN" && p.ci === "red").length,
      activations24h: usage.length, successRate24h: usage.length ? ok / usage.length : null,
      rustActivations24h: rustAudits.length, rustShareSinceCutover: sinceCutover ? Math.min(1, rustAudits.length / sinceCutover) : null, rustSince, medianActivationMs: pick(0.5), p90ActivationMs: pick(0.9),
    },
    activity: activityByHour(usage, now),
    workers: live.map((j) => summarizeJob(j, d, now)),
    recent: recent.map((j) => summarizeJob(j, d, now)),
    decisions: Object.values(d.decisions || {}).filter((x) => x.state === "pending").map((x) => ({ id: x.id, job: x.jobId, ticket: ticketOf(d.jobs?.[x.jobId] || {}), at: x.at, escalatedAt: x.escalatedAt || null, tldr: x.tldr || String(x.question || "").slice(0, 300) })),
    tickets: ticketRows,
    prs, issues: Array.isArray(issues) ? issues : [], kanban: kanbanItems,
    attempts: attempts.slice(0, 60),
    stream: buildStream(d, usage12h, now),
    live: liveTails(paths.harness, now),
    incidents: Array.isArray(incidents) ? incidents : [],
    quality: shadow?.metrics ? { ...shadow.metrics, labels: (shadow.labels || []).reduce((m, l) => ((m[l.label] = (m[l.label] || 0) + 1), m), {}) } : null,
    jev: jevAnalytics(d.audit, now),
    shadow: shadow ? { at: shadow.at, agreement: shadow.agreement_24h || [], review: (shadow.review_queue || []).length, labels: (shadow.labels || []).reduce((m, l) => ((m[l.label] = (m[l.label] || 0) + 1), m), {}), jev: shadow.jev || null } : null,
    sourceFreshness: { prs: sourceFreshness("prs"), support: sourceFreshness("support"), incidents: sourceFreshness("incidents"), issues: sourceFreshness(`issues:${issueNumbers.join(",")}`) },
    sources: { incidents: Array.isArray(incidents) ? "ok" : cache.get("incidents")?.pending ? "loading" : incidents?.error || "unavailable", prs: Array.isArray(prsRaw) ? "ok" : cache.get("prs")?.pending ? "loading" : prsRaw?.error || "unavailable", support: tickets.length || support?.items ? "ok" : cache.get("support")?.pending ? "loading" : support?.error || "unavailable" },
  };
}

// Incidents: staff-opened catch-alls and the reports merged into them.
async function incidentList({ fetchImpl, configPath }) {
  const list = await mcpCall("support", "support_list", { kind: "ticket", category: "incident", limit: 20 }, { fetchImpl, configPath });
  const items = (list?.items || []).filter((t) => t.category === "incident");
  const out = [];
  for (const t of items.slice(0, 12)) {
    const open = !["resolved", "closed"].includes(t.status);
    const full = open ? await mcpCall("support", "support_get", { kind: "ticket", number: t.number }, { fetchImpl, configPath }).catch(() => null) : null;
    out.push({ number: t.number, title: t.title, status: t.status, open, createdAt: Date.parse(t.createdAt) || null,
      merged: (full?.mergedTickets || []).map((m) => ({ number: m.number, mergedAt: Date.parse(m.mergedAt) || null, mergedBy: m.mergedBy || null })),
      description: String(full?.description || "").slice(0, 400) });
  }
  return out;
}

// Jev request reads and post screens over the last seven days, from the ledger audit.
function jevAnalytics(audit, now) {
  const since = now - 7 * 86400000;
  const tags = { kind: {}, mood: {}, urgency: {}, complexity: {} };
  let tagged = 0, injections = 0, screened = 0, refused = 0;
  const labels = {};
  for (const a of audit || []) {
    if (a.at < since) continue;
    if (a.kind === "intake_tagged" && a.tags) {
      tagged++; if (a.tags.injection) injections++;
      for (const k of Object.keys(tags)) if (a.tags[k]) tags[k][a.tags[k]] = (tags[k][a.tags[k]] || 0) + 1;
    }
    if (a.kind === "post_screened") { screened++; if (a.refused) refused++; for (const l of a.labels || []) labels[l.label] = (labels[l.label] || 0) + 1; }
  }
  return { tagged, injections, screened, refused, tags, labels };
}

// One Rust harness attempt and its trace, read-only.
function readAttempt(file, id) {
  if (!/^[a-z]-?[a-z0-9-]{6,60}$/i.test(String(id))) return null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const a = db.prepare("SELECT a.id, a.task_id, a.provider, a.model, a.effort, a.label AS route_label, t.kind AS task_kind, t.role, t.project, a.started_at, a.ended_at, a.exit_code, a.timed_out, a.quota_hold, a.tool_calls, a.duration_ms, a.final_text FROM h_attempts a LEFT JOIN h_tasks t ON t.id = a.task_id WHERE a.id = ?").get(id);
      if (!a) return null;
      const events = db.prepare("SELECT seq, at, kind, payload FROM attempt_events WHERE attempt_id = ? ORDER BY seq LIMIT 400").all(id).map((e) => {
        let p = {}; try { p = JSON.parse(e.payload); } catch {}
        const result = p.payload?.payload?.kind === "tool_result" ? p.payload.payload.text : null;
        return { seq: e.seq, at: e.at, kind: e.kind, tool: e.kind === "tool_use" ? toolOf(p) : null, text: typeof p.text === "string" ? p.text.slice(0, 600) : typeof result === "string" ? result.slice(0, 600) : null };
      }).filter((e) => e.kind !== "other" && e.kind !== "system");
      return { ...a, label: attemptLabel(a), final_text: String(a.final_text || "").slice(0, 4000), events };
    } finally { db.close(); }
  } catch { return null; }
}

// Admin actions. Both run server-side with the box's own credentials so no
// token reaches a browser.
async function mergeTicket({ source, target, reason, by }, { fetchImpl = fetch, configPath = PATHS.mcp } = {}) {
  const out = await mcpCall("support", "support_merge", { source_number: source, target_number: target, reason: String(reason || "").slice(0, 500), merged_by: by, require_incident: true }, { fetchImpl, configPath });
  cache.delete("support"); cache.delete("incidents");
  return out;
}
async function probeKeir({ fetchImpl = fetch, envPath = PATHS.env } = {}) {
  const env = fs.readFileSync(envPath, "utf8");
  const token = /^KEIR_OPERATOR_ADMIN_TOKEN=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const port = /^KEIR_OPERATOR_PORT=(\d+)$/m.exec(env)?.[1] || "9765";
  if (!token) throw new Error("operator admin token not readable");
  const res = await fetchImpl(`http://127.0.0.1:${port}/probe/quick`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`operator answered ${res.status}`);
  return res.json();
}
async function operatorMetrics(endpoint, { days = 30, fetchImpl = fetch, envPath = PATHS.env } = {}) {
  if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Error("Invalid days");
  const env = fs.readFileSync(envPath, "utf8");
  const token = /^KEIR_OPERATOR_ADMIN_TOKEN=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const port = /^KEIR_OPERATOR_PORT=(\d+)$/m.exec(env)?.[1] || "9765";
  if (!token) throw new Error("operator admin token not readable");
  const res = await fetchImpl(`http://127.0.0.1:${port}/v5/${endpoint}?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`operator answered ${res.status}`);
  return res.json();
}
const ticketPerformance = options => operatorMetrics("performance", options);
const releaseEfficiency = options => operatorMetrics("efficiency", options);
function probeState(ledgerPath, task) {
  const d = readJson(ledgerPath); const j = d?.jobs?.[task];
  if (!j) return { state: "unknown" };
  return { state: j.state, summary: String(j.summary || "").slice(0, 400), provider: j.provider || null, rounds: j.rounds || 0, updatedAt: j.updatedAt || null };
}

module.exports = { buildHubState, buildStream, narrate, liveTails, attemptLabel, toolOf, incidentList, jevAnalytics, readAttempt, mergeTicket, probeKeir, ticketPerformance, releaseEfficiency, probeState, activityByHour, readUsage, ciState, summarizeJob, PATHS, RUNNERS, _cache: cache, _cached: cached, _mcpCall: mcpCall };
