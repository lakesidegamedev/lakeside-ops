"use strict";
// Owner app boundary. Legacy Support policy is separate. Only trusted ingress
// mints these ledger receipts; role/channel flags can restrict, never authorize.
const crypto = require("node:crypto");
const { ownerText } = require("./privacy");
const cleanLogText = value => ownerText(value).replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted]");
const hasCredentials = value => cleanLogText(value) !== value;
function logInput(value, depth = 0) {
  if (depth > 8) return "[bounded]";
  if (typeof value === "string") return cleanLogText(value);
  if (Array.isArray(value)) return value.slice(0, 200).map(v => logInput(v, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 200).map(([k, v]) => [cleanLogText(k), logInput(v, depth + 1)]));
  return value;
}
function normalized(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalized);
  return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, normalized(value[k])]));
}
const digest = value => crypto.createHash("sha256").update(JSON.stringify(normalized(value))).digest("hex");
const appHint = job => job?.replyChannel === "app" || job?.channelId === "app" || job?.source?.channelId === "app";
function origin(data, job) {
  const visited = new Set();
  let current = job, scoped = false, missingReceipt = false;
  while (current) {
    if (visited.has(current.id)) return { scoped: true, valid: false, reason: "Cyclic task ancestry." };
    visited.add(current.id);
    const r = data.ownerMuseOrigins?.[current.id];
    scoped ||= Boolean(r) || appHint(current);
    if (data.jobs[current.id] !== current) return { scoped: true, valid: false, reason: "Task is not in the durable ledger." };
    if (r) {
      const { digest: saved, ...payload } = r;
      if (missingReceipt || saved !== digest(payload) || r.jobId !== current.id || (r.parentId || null) !== (current.codingParent || current.museParent || null))
        return { scoped: true, valid: false, reason: "Task origin binding changed or is missing." };
      if (!r.parentId) {
        if (r.via !== "authenticated-app-owner" || !r.actorId || !r.messageId) return { scoped: true, valid: false, reason: "Missing authenticated owner origin." };
        return { scoped: true, valid: true, root: r.jobId, actorId: r.actorId, digest: r.digest };
      }
      const parentReceipt = data.ownerMuseOrigins?.[r.parentId];
      if (!parentReceipt || parentReceipt.digest !== r.parentDigest) return { scoped: true, valid: false, reason: "Missing or changed parent origin." };
    } else {
      missingReceipt = true;
      if (scoped) return { scoped: true, valid: false, reason: "This saved app task lacks authenticated origin receipts. Start a new authenticated app task for writes." };
    }
    const parentId = current.codingParent || current.museParent;
    if (!parentId) return { scoped: false, valid: true };
    current = data.jobs[parentId];
    if (!current) return { scoped: true, valid: false, reason: "Missing parent task." };
  }
  return { scoped: true, valid: false, reason: "Missing task origin." };
}
function attest(ledger, config, job, message, now) {
  const existing = ledger.data.ownerMuseOrigins?.[job.id];
  if (existing) return existing;
  const payload = { jobId: job.id, via: "authenticated-app-owner", actorId: config.ownerId, messageId: message.id, messageDigest: digest(message), at: now, parentId: null };
  const receipt = { ...payload, digest: digest(payload) };
  (ledger.data.ownerMuseOrigins ||= {})[job.id] = receipt;
  ledger.audit("owner_muse_origin", { job: job.id, digest: receipt.digest });
  return receipt;
}
function inherit(ledger, parent, child) {
  const p = origin(ledger.data, parent);
  if (!p.scoped) return;
  child.museParent = parent.id;
  const parentReceipt = ledger.data.ownerMuseOrigins?.[parent.id];
  if (!p.valid || !parentReceipt) return;
  const payload = { jobId: child.id, parentId: parent.id, parentDigest: parentReceipt.digest, via: "derived-owner-app" };
  if (!ledger.data.ownerMuseOrigins?.[child.id]) (ledger.data.ownerMuseOrigins ||= {})[child.id] = { ...payload, digest: digest(payload) };
}
const READS = new Set(["discord_search", "ticket_performance", "release_efficiency", "evidence_batch", "read_servers", "read_tools", "read_tool", "recent_changes", "past_ticket", "similar_reports", "recall", "calculate", "ticket_history", "source_history", "view_attachment", "task_progress", "reporter_state", "support_tools"]);
const PRIVATE = new Set(["owner_updates", "present_choices", "task_plan", "goal_update", "feed_post", "artifact_save", "idea_suggest", "checkpoint", "finish", "watch_turn", "handoff", "delegate_fix", "delegate_investigation", "review_fix", "repository_snapshot", "local_file"]);
// A read token alone does not prove an arbitrary MCP method has no side effects.
const MCP_READS = {
  gamestate: ["entity_search", "legislation_catalog", "elections", "game_overview", "countries", "analytics_catalog", "analytics_query", "fx_quote", "player_wealth_statistics", "trace_corp", "trace_sector", "corporation_rankings", "extraction_market", "trace_character", "trace_account", "character_balance_sheet", "character_wealth_history", "trace_approval", "invariant_check"],
  support: ["support_get", "support_list", "support_search"],
  "ops-knowledge": ["knowledge_get", "knowledge_query", "code_search", "code_read", "code_exact", "kanban_brief", "kanban_list", "kanban_get"],
  engine: ["engine_health", "economy_pulse", "recent_turns"],
  railway: ["railway_status", "railway_deployments", "railway_logs"],
  turndiag: ["turn_phase_timings", "phase_history", "phase_regressions", "turn_anomalies", "lock_status"],
  "heal-ops": ["heal_list", "heal_detect", "heal_history", "heal_verify", "heal_query", "heal_count", "heal_status"],
  community: ["community_search"],
};
function fail(ledger, job, capability, reason) {
  job.ownerMuseBlocker = { code: "OWNER_MUSE_UNSUPPORTED", capability, message: reason, at: Date.now() };
  if (appHint(job)) {
    const thread = ledger.data.appThread ||= { seq: 0, messages: [], status: {}, clients: {} };
    (thread.status ||= {})[job.id] = { text: reason, at: Date.now() };
  }
  ledger.audit("owner_muse_refused", { job: job.id, capability, reason }); ledger.save();
  throw Object.assign(new Error(reason), { code: "OWNER_MUSE_UNSUPPORTED" });
}
function guard(ledger, config, job, name, input) {
  const p = origin(ledger.data, job);
  if (!p.scoped) return p;
  const deny = reason => fail(ledger, job, name, reason);
  const serialized = JSON.stringify(input);
  if (hasCredentials(serialized)) deny("Credential-shaped content cannot be sent to tools or saved in owner Muse artifacts. Use a secure credential surface.");
  if (job.ownerMuseBlocker && name === "finish" && ["done", "dismissed"].includes(input.state)) throw new Error("This task has an unsupported capability blocker. Report it honestly and finish blocked; do not claim completion.");
  if (["support_directive", "ticket_record"].includes(job.ownerMuseBlocker?.capability) && name === "channel_reply" && input.message !== job.ownerMuseBlocker.message) throw new Error(`The support handoff was refused. Report this exact status: ${job.ownerMuseBlocker.message}`);
  if (name === "local_file" && ["read", "list"].includes(input.operation)) return p;
  if (READS.has(name)) {
    if (name === "read_tool" && !MCP_READS[input.server]?.includes(input.tool)) deny(`Unsupported owner Muse read capability: ${input.server}/${input.tool}. No reviewed read adapter.`);
    return p;
  }
  if (name === "ticket_record" && input.op === "read") return p;
  if (name === "github" && ["status", "where", "ci_failures", "ci_runs", "issues", "watch", "history"].includes(input.action)) return p;
  if (name === "computer" && input.action === "look" && job.appBrowserId && !input.url && !input.html) return p;
  if (name === "sentry" && ["issues", "issue"].includes(input.action)) return p;
  // Retain conversation and inspection for legacy jobs without promoting them.
  if (["channel_reply", "progress_update", "checkpoint", "finish", "owner_updates"].includes(name) && job.replyChannel === "app" && job.source?.channelId === "app") return p;
  const report = ledger.data.ownerMuseReporting?.[job.id];
  if (report) {
    const {digest: saved, ...payload} = report;
    if (report.jobId === job.id && saved === digest(payload) && report.purpose === "private-reporting" && ["task_plan", "goal_update", "feed_post", "artifact_save", "idea_suggest"].includes(name)) return p;
  }
  if (!p.valid || p.actorId !== config.ownerId) deny(p.reason || "Authenticated origin no longer matches the configured owner. Start a new app task.");
  if (name === "github" && ["merge", "promote"].includes(input.action)) return p;
  if (PRIVATE.has(name) || ["support_directive", "ticket_record", "open_ticket", "open_suggestion"].includes(name)) return p;
  if (name === "chart" && job.replyChannel === "app" && job.source?.channelId === "app") return p;
  if (name === "request_heal" || name === "execute_action") return p;
  if (name === "shell" || name === "request_action") deny("Owner Muse cannot run arbitrary commands, host actions, remote workflows or iOS builds/uploads. Use local_file for isolated drafts; unreviewed MCP writes are unsupported.");
  if (name === "computer") {
    if (input.action === "open" && (input.url || input.html)) return p;
    if (job.appComputer && !input.url && !input.html && ["look", "scroll", "close"].includes(input.action)) return p;
    if (job.appComputer && !input.url && !input.html && ["click", "type", "key"].includes(input.action)) return p;
    deny("Unsupported computer request: open a computer workspace first. Browser input requires an exact current-screen proposal.");
  }
  deny(`Unsupported owner Muse mutation: ${name}${input.action ? `/${input.action}` : ""}. No reviewed exact-approval adapter; nothing executed and no approval was requested.`);
}
// Initial consequential allowlist: native heal plans only, not generic MCP writes.
function finiteJson(value) {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Nonfinite heal scope");
  if (value && typeof value === "object") for (const item of Object.values(value)) finiteJson(item);
}
function operation(spec) {
  const checked = require("../heal").validateRequest(spec);
  if (!checked.ok || digest(checked.spec) !== digest(spec)) throw new Error("Malformed or non-normalized heal operation");
  if (spec.kind !== "adhoc") throw new Error("Unsupported heal adapter: custom ledger and compensation execution semantics are not reviewed");
  const a = spec.action;
  const keys = Object.keys(a);
  const set = a.kind === "set" && a.set && typeof a.set === "object" && !Array.isArray(a.set) && Object.keys(a.set).length && keys.every(key => ["kind", "set"].includes(key));
  const unset = a.kind === "unset" && Array.isArray(a.unset) && a.unset.length && a.unset.every(key => typeof key === "string" && key) && keys.every(key => ["kind", "unset"].includes(key));
  if (!set && !unset) throw new Error("Unsupported custom heal execution semantics");
  const fields = set ? Object.keys(a.set) : a.unset;
  if (fields.some(key => !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,180}$/.test(key))) throw new Error("Unsupported heal field operation");
  const operators = new Set(["$and", "$or", "$nor", "$eq", "$ne", "$in", "$nin", "$lt", "$lte", "$gt", "$gte", "$exists", "$not", "$type"]);
  const inspect = (value, depth = 0) => {
    if (depth > 16) throw new Error("Heal filter is too deeply nested");
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith("$") && !operators.has(key)) throw new Error("Unsupported custom heal filter execution semantics");
      inspect(item, depth + 1);
    }
  };
  inspect(spec.filter); finiteJson(spec);
}
function scope(kind, args) {
  if (kind === "computer_input") {
    const input = args?.input;
    const allowed = { click: ["action", "x", "y"], type: ["action", "text"], key: ["action", "key"] }[input?.action];
    if (!allowed || Object.keys(input).some(k => !allowed.includes(k)) || !/^[a-f0-9-]{36}$/.test(args.browser || "") || !/^[A-Za-z0-9_.-]+\.png$/.test(args.screen || "")) throw new Error("Browser input needs an exact current screen and operation");
    if (input.action === "click" && (![input.x, input.y].every(Number.isFinite) || input.x < 0 || input.y < 0 || input.x >= 1280 || input.y >= 800)) throw new Error("Browser click is outside the screen");
    if (input.action === "type" && (typeof input.text !== "string" || !input.text.length || input.text.length > 2000)) throw new Error("Browser text must contain 1 to 2000 characters");
    if (input.action === "key" && !["Enter", "Tab", "Shift+Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(input.key)) throw new Error("Unsupported browser key");
    const target = new URL(args.url);
    if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || !args.destination?.endpoint || !args.destination?.credentialBinding) throw new Error("Browser target or worker identity is unavailable");
    return { adapter: "computer:v1", destination: args.destination, browser: args.browser, screen: args.screen, url: args.url, input };
  }
  if (kind === "github") {
    if (!args || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repository || "") || !/^[a-f0-9]{40}$/.test(args.head || "") || !/^[a-f0-9]{40}$/.test(args.base || "")) throw new Error("GitHub approval needs an exact repository and source/target commits");
    if (args.action === "merge" && Number.isSafeInteger(args.number) && args.number > 0 && ["development", "main"].includes(args.to) || args.action === "promote" && ["staging", "main"].includes(args.to) && args.from === ({staging:"development", main:"staging"})[args.to]) return { adapter: "github:v1", repository: args.repository, action: args.action, head: args.head, base: args.base, to: args.to, ...(args.action === "merge" ? { number: args.number } : { from: args.from }) };
    throw new Error("Unsupported GitHub approval scope");
  }
  if (kind !== "heal") throw new Error(`Unsupported owner Muse action adapter: ${kind}`);
  finiteJson(args);
  if (!args || typeof args !== "object") throw new Error("Malformed heal scope");
  operation(args.spec);
  if (!Number.isSafeInteger(args.affected) || args.affected < 1 || args.affected > 200 || args.plan?.affected !== args.affected || !Number.isFinite(args.plan?.moneyDelta) || !Array.isArray(args.plan?.touched) || !args.plan.touched.length || digest(args.plan) !== args.planDigest) throw new Error("Heal plan lacks finite exact target scope");
  const touched = args.plan.touched.flatMap(row => {
    if (typeof row.collection !== "string" || !Array.isArray(row.ids) || row.ids.some(id => typeof id !== "string" || !id)) throw new Error("Malformed heal touched targets");
    return row.ids.map(id => `${row.collection}:${id}`);
  });
  if (touched.length !== args.affected || new Set(touched).size !== touched.length) throw new Error("Heal target count does not match exact IDs");
  if (!/^[a-f0-9]{64}$/.test(args.destination?.executorRevision || "")) throw new Error("Unsupported heal adapter: active executor source revision is not attested; no approval card created");
  if (args.spec.kind !== "adhoc") throw new Error("Unsupported heal adapter: custom ledger and compensation execution semantics are not reviewed");
  const { kind: specKind, env, ...payload } = args.spec;
  if (digest(args.plan.payload) !== digest(payload) || args.plan.touched.some(row => row.collection !== args.spec.collection) || args.affected > args.spec.expectedMax) throw new Error("Heal operation, filter or target set does not match the executable plan");
  if (!args.destination?.endpoint || !args.destination?.credentialBinding || args.destination.server !== "heal-ops") throw new Error("Heal destination identity is unavailable");
  return { adapter: "heal-ops:v1", account: args.destination, plan: args.plan, environment: args.spec.env, target: args.spec, planDigest: args.planDigest, affected: args.affected };
}
function seal(data, config, job, kind, args) {
  const p = origin(data, job);
  if (!p.valid || !p.scoped || p.actorId !== config.ownerId) throw new Error("No authenticated owner Muse origin");
  finiteJson(args);
  const snapshot = structuredClone(normalized(args));
  const binding = scope(kind, snapshot);
  return { args: snapshot, policy: { version: 1, origin: p.digest, scope: binding, digest: digest({ kind, args: snapshot, scope: binding, origin: p.digest }) } };
}
function validate(data, config, job, action, now, requireApproval = false) {
  const p = origin(data, job);
  if (!p.scoped && !action?.ownerMuse) return false;
  if (!p.valid || !p.scoped || p.actorId !== config.ownerId || !action?.ownerMuse || action.jobId !== job.id) throw new Error("No valid exact owner Muse provenance; legacy approvals require a new authenticated app proposal");
  const expected = seal(data, config, job, action.kind, action.args).policy;
  if (digest(action.ownerMuse) !== digest(expected) || action.expiresAt <= now) throw new Error("Owner Muse proposal changed or expired");
  if (requireApproval) {
    const decision = data.decisions?.[action.ownerMuseDecision];
    const receipt = action.ownerMuseApproval;
    const allowed = [config.ownerId, config.ownerMuseDelegateId].filter(Boolean);
    const pref = require("./appcontrols").preferences(data, job);
    const yolo = receipt?.via === "owner-yolo" && !data.paused && pref.approvalMode === "yolo" && pref.authorization?.id === receipt.authorization && pref.authorization.actor === receipt.actor && pref.authorization.at <= action.at;
    if (!receipt || !decision || decision.state !== "approve" || decision.actionId !== action.id || decision.answeredBy !== receipt.actor || !allowed.includes(receipt.actor) || receipt.digest !== expected.digest || receipt.decision !== decision.id || receipt.at < action.at || receipt.at > now || (!["authenticated-app", "authenticated-discord"].includes(receipt.via) && !yolo) || action.state !== "approved")
      throw new Error("No fresh authenticated exact human approval for this owner Muse action");
  }
  return true;
}
function clearBlocker(ledger, job, capability) {
  const blocker = job.ownerMuseBlocker;
  if (blocker?.capability !== capability) return;
  if (ledger.data.appThread?.status?.[job.id]?.text === blocker.message) delete ledger.data.appThread.status[job.id];
  delete job.ownerMuseBlocker;
}
module.exports = { logInput, operation, hasCredentials, clearBlocker, origin, attest, inherit, guard, fail, seal, validate, digest, normalized, MCP_READS };
