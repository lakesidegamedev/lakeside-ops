"use strict";
// Authenticated owner preferences are separate from agent-written task state.
const crypto = require("node:crypto");
const skills = require("./skills");
const { models, resolveModel } = require("./appmodels");
const CLOSED = new Set(["done", "dismissed", "cancelled"]);
const LANES = ["conversation", "voice", "coding", "investigation", "coordination"];
const COMMANDS = [
  ["/stop", "Stop Keir and all active work"], ["/start", "Enable new work"],
  ["/status", "Show runtime status"], ["/model", "Show or set a work type's provider"],
  ["/approval", "Set ask or yolo for this conversation"], ["/skills", "Show or select skills"],
  ["/audit", "Sweep account and money anomalies; /audit preview opens no tickets"],
  ["/tasks", "Show active tasks"], ["/new", "Start a conversation"],
].map(([id, detail]) => ({ id, detail }));
const err = (status, message) => Object.assign(new Error(message), { status });
function rootOf(data, job) {
  const visited = new Set();
  while (job && !visited.has(job.id)) {
    visited.add(job.id);
    const parent = job.codingParent || job.museParent;
    if (!parent) return job;
    job = data.jobs[parent];
  }
  return null;
}
function preferences(data, job) {
  const root = rootOf(data, job);
  if (root?.role !== "owner") return {};
  return data.appThread?.preferences?.[root?.appThread || "main"] || {};
}
function laneOf(job, quick) { return job.codingParent ? job.investigation ? "investigation" : "coding" : quick ? "conversation" : "coordination"; }
function skillLane(lane) { return { voice: "quick", conversation: "quick", coding: "coder", investigation: "investigator", coordination: "worker" }[lane]; }
function catalog(config) {
  try {
    const loaded = skills.load(config.skillsRoot);
    return Object.entries(loaded.manifest.skills).map(([id, meta]) => ({ id, ...meta, available: Boolean(loaded.text[id]), defaults: Object.entries(loaded.manifest.lanes).filter(([, list]) => list.includes(id)).map(([lane]) => lane) }));
  } catch { return []; }
}
function createControls({ ledger, config, drain = () => {}, now = Date.now }) {
  const d = ledger.data;
  function checkThread(thread) {
    if (thread === "watches" || (thread !== "main" && !Object.hasOwn(d.appThread?.threads || {}, thread))) throw err(404, "Unknown conversation");
  }
  function view(thread = "main") {
    const p = d.appThread?.preferences?.[thread] || {};
    return { supported: true, stopped: Boolean(d.paused), changedAt: d.control?.at || null,
      approvalMode: p.approvalMode || "ask", routes: p.routes || {}, skills: p.skills || {}, updates: (d.appThread?.preferences?.main || {}).updates !== false,
      defaults: { voice: "Gemini 3.8 Flash / DeepSeek V4.1 Flash (alternating)", conversation: config.quickProvider || config.defaultRoute || "claude", coding: config.codingProvider || config.defaultRoute || "muse:muse-wonder-full-1.0@medium", investigation: config.investigatorProvider || config.codingProvider || config.defaultRoute || "muse:muse-wonder-full-1.0@medium", coordination: config.workerProvider || config.defaultRoute || "claude" },
      options: Object.fromEntries(LANES.map(lane => [lane, models(config, lane)])), catalog: catalog(config), commands: COMMANDS,
      active: Object.values(d.jobs).filter(j => !CLOSED.has(j.state)).length };
  }
  function update(body = {}) {
    const thread = String(body.thread || "main"); checkThread(thread);
    if (body.action === "stop") {
      d.paused = true; d.control = { stopped: true, at: now(), actor: config.ownerId };
      for (const j of Object.values(d.jobs)) if (!CLOSED.has(j.state)) {
        j.state = "cancelled"; j.summary = "Stopped with the owner kill switch."; j.updatedAt = now();
      }
      for (const a of Object.values(d.actions || {})) if (["pending", "approved"].includes(a.state)) a.state = "cancelled";
      for (const x of Object.values(d.decisions || {})) if (x.state === "pending") x.state = "cancelled";
      // Pending publications must not reappear when Start is pressed.
      for (const channel of Object.values(d.discordChannels || {})) channel.outbox = [];
      for (const e of Object.values(d.outbox || {})) if (!e.deliveredAt) { e.deliveredAt = now(); e.skipped = "owner kill switch"; }
    } else if (body.action === "start") {
      d.paused = false; d.control = { stopped: false, at: now(), actor: config.ownerId };
    } else if (body.action === "configure") {
      if (body.taskId && body.approvalMode !== undefined) throw err(400, "Approval mode belongs to the conversation");
      const old = body.taskId ? d.jobs[body.taskId]?.appOverrides || {} : d.appThread?.preferences?.[thread] || {};
      const next = structuredClone(old);
      if (body.approvalMode !== undefined) {
        if (!["ask", "yolo"].includes(body.approvalMode)) throw err(400, "Choose ask or yolo");
        next.approvalMode = body.approvalMode;
        next.authorization = { id: crypto.randomBytes(16).toString("hex"), actor: config.ownerId, at: now(), mode: body.approvalMode, thread };
      }
      if (body.updates !== undefined) {
        if (typeof body.updates !== "boolean" || body.taskId || thread !== "main") throw err(400, "Progress updates are a main conversation setting");
        next.updates = body.updates;
      }
      if (body.routes !== undefined) {
        if (!body.routes || typeof body.routes !== "object" || Array.isArray(body.routes)) throw err(400, "Invalid routes");
        for (const [lane, selection] of Object.entries(body.routes)) {
          if (!LANES.includes(lane)) throw err(400, "Unknown work type");
          if (selection === "inherit" && body.taskId) { if (next.routes) delete next.routes[lane]; continue; }
          resolveModel(config, selection, lane);
          (next.routes ||= {})[lane] = selection;
        }
      }
      if (body.skills !== undefined) {
        if (!body.skills || typeof body.skills !== "object" || Array.isArray(body.skills)) throw err(400, "Invalid skills");
        const installed = catalog(config).filter(s => s.available).map(s => s.id);
        for (const [lane, names] of Object.entries(body.skills)) {
          if (!LANES.includes(lane) || !(names === null || Array.isArray(names) && names.length <= 20 && names.every(n => installed.includes(n)))) throw err(400, "Unknown work type or unavailable skill");
          (next.skills ||= {})[lane] = names === null ? null : [...new Set(names)];
        }
      }
      if (body.taskId) {
        const j = d.jobs[body.taskId], root = rootOf(d, j);
        if (!j || root?.role !== "owner" || root.actorId !== config.ownerId || (root.appThread || "main") !== thread || CLOSED.has(j.state)) throw err(404, "Unknown active owner task");
        // Task overrides affect future activations only. Authority remains in the thread receipt.
        j.appOverrides = { routes: next.routes || {}, skills: next.skills || {} };
      } else {
        const t = d.appThread ||= { seq: 0, messages: [], status: {}, clients: {} };
        (t.preferences ||= {})[thread] = next;
        if (body.approvalMode !== undefined && old.authorization) {
          for (const action of Object.values(d.actions || {})) {
            if (action.state !== "approved" || action.ownerMuseApproval?.via !== "owner-yolo" || action.ownerMuseApproval.authorization !== old.authorization.id) continue;
            (action.revokedApprovals ||= []).push({ ...action.ownerMuseApproval, revokedAt: now() });
            delete action.ownerMuseApproval; delete action.approvedBy; delete action.approvalMessage; delete action.approvedAt;
            const prior = d.decisions?.[action.ownerMuseDecision];
            if (prior) prior.state = "revoked";
            const job = d.jobs[action.jobId];
            if (!job || CLOSED.has(job.state) || action.expiresAt <= now()) { action.state = "cancelled"; continue; }
            action.state = "pending";
            const decision = require("./decisions").openDecision(ledger, config, { jobId: job.id, actionId: action.id, question: prior?.question || "Approve this exact action after YOLO was changed?" });
            action.ownerMuseDecision = decision.id;
          }
        }
      }
    } else throw err(400, "Unknown control action");
    ledger.audit("owner_control", { action: body.action, thread, task: body.taskId || null, actor: config.ownerId, approvalMode: body.approvalMode, routes: body.routes, skills: body.skills });
    ledger.save(); drain(); return view(thread);
  }
  function command(text, thread = "main", newThread = null) {
    const [verb, ...args] = text.trim().split(/\s+/);
    if (!COMMANDS.some(c => c.id === verb)) return null;
    if (verb === "/audit") { if (args.length > 1 || args.length && args[0] !== "preview") throw err(400, "Use /audit or /audit preview"); return null; }
    if (["/stop", "/start"].includes(verb)) { if (args.length) throw err(400, `Use ${verb} without arguments`); update({ action: verb.slice(1), thread }); }
    if (verb === "/approval" && args.length) update({ action: "configure", thread, approvalMode: args[0] });
    if (verb === "/model" && args.length) { if (args.length !== 2) throw err(400, "Use /model conversation|voice|coding|investigation auto|provider:model"); update({ action: "configure", thread, routes: { [args[0]]: args[1] } }); }
    if (verb === "/skills" && args.length) { if (args.length !== 2) throw err(400, "Use /skills conversation|coding|investigation default|none|skill,skill"); update({ action: "configure", thread, skills: { [args[0]]: args[1] === "default" ? null : args[1] === "none" ? [] : args[1].split(",") } }); }
    if (verb === "/new") { if (!newThread) throw err(400, "Open the conversation picker to start a thread"); return { text: "Conversation created.", thread: newThread(args.join(" ") || "New conversation").id }; }
    const state = view(thread);
    const details = verb === "/model" ? LANES.map(l => `${l}: ${state.routes[l] && state.routes[l] !== "auto" ? state.routes[l] : state.defaults[l]}`).join("\n")
      : verb === "/skills" ? state.catalog.map(s => `${s.id}${s.available ? "" : " (unavailable)"}`).join("\n")
      : verb === "/tasks" ? Object.values(d.jobs).filter(j => !CLOSED.has(j.state)).slice(-20).map(j => `${j.id}: ${j.state}`).join("\n") || "No active tasks."
      : `Keir ${state.stopped ? "stopped" : "ready"}. ${state.active} open tasks. Approvals: ${state.approvalMode}.`;
    return { text: details, controls: state };
  }
  return { view, update, command };
}
// A YOLO grant never authorizes an unsupported adapter or a different owner.
function authorizeYolo(data, config, job, action, decision, now) {
  const origin = require("./ownermuse-policy").origin(data, job), p = preferences(data, job), auth = p.authorization;
  if (data.paused || !origin.valid || !origin.scoped || origin.actorId !== config.ownerId || p.approvalMode !== "yolo" || auth?.actor !== config.ownerId || auth.mode !== "yolo" || action.at < auth.at) return false;
  decision.state = "approve"; decision.answeredBy = config.ownerId; decision.answeredAt = now; decision.answeredVia = "owner-yolo";
  action.state = "approved"; action.approvedBy = config.ownerId; action.approvalMessage = `yolo:${auth.id}`; action.approvedAt = now;
  action.ownerMuseApproval = { actor: config.ownerId, decision: decision.id, digest: action.ownerMuse.digest, at: now, via: "owner-yolo", authorization: auth.id };
  return true;
}
function activityState(data, now = Date.now()) {
  const jobs = Object.values(data.jobs).filter(j => j.replyChannel === "app" && ["queued", "running", "waiting", "blocked", "paused"].includes(j.state));
  const pending = Object.values(data.decisions || {}).filter(x => x.state === "pending" && jobs.some(j => j.id === x.jobId));
  const count = jobs.length;
  const questions = Object.values(data.appThread?.questions || {}).filter(q => q.state === "pending" && jobs.some(j => j.id === q.jobId));
  const blocked = jobs.filter(j => j.state === "blocked").length;
  const waiting = count && jobs.every(j => ["waiting", "paused"].includes(j.state));
  return { status: data.paused ? "Stopped" : pending.length ? "Needs your approval" : questions.length ? "Waiting for your answer" : blocked ? "Needs attention" : waiting ? "Waiting for an update" : count ? `${count} task${count === 1 ? "" : "s"} in progress` : "Work finished", count, stopped: Boolean(data.paused), updatedAt: Math.max(data.control?.at || 0, ...jobs.map(j => j.updatedAt || j.at || 0), 0) || now };
}
module.exports = { createControls, preferences, rootOf, laneOf, skillLane, authorizeYolo, activityState, COMMANDS };
