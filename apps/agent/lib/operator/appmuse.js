"use strict";
// Owner app goals, planning and artifacts. This is partial Muse capability:
// goals Keir plans and
// advances on its own, a feed Keir writes, a morning brief, an approvals
// queue, what is coming up, the files Keir made, plans shown before the work,
// a live view of each task's tool calls, and the owner's identity settings.
// Everything is owner-only and rides the app channel's authentication; goal
// and brief tasks are ordinary owner-directed tasks with the usual gates.
const crypto = require("node:crypto");
const { threadOf } = require("./appchannel");

const CLOSED = ["done", "dismissed", "cancelled"];
const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const id = () => crypto.randomBytes(6).toString("hex");
const CADENCE = { "6h": 21600000, daily: 86400000, "3d": 3 * 86400000, weekly: 7 * 86400000 };
const STEP = ["pending", "running", "done", "failed", "waiting"];
// Tools only owner tasks get.
const MUSE_TOOLS = ["task_plan", "goal_update", "feed_post", "artifact_save", "idea_suggest"];

function museState(d) {
  const t = threadOf(d);
  t.goals ||= {};
  t.feed ||= [];
  t.artifacts ||= {};
  t.suggested ||= {};
  t.identity ||= { tone: "concise", showUpdates: true, briefHour: 8, briefOn: true };
  t.marks ||= { feedScanAt: Date.now(), briefDay: null };
  return t;
}

// Hour and date in America/New_York, the owner's timezone.
function eastern(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

function createAppMuse({ ledger, config, app, starmer = null, now = () => Date.now(), drain = () => {} }) {
  const d = ledger.data;
  const owner = () => ({ authorId: config.ownerId, author: "owner", channelId: "app", channelName: "keir-app", attachments: [], embeds: [] });

  function ownerTask(key, content, fields = {}) {
    const at = new Date(now()).toISOString();
    const job = ledger.createJob(key, { kind: "command", role: "owner", actorId: config.ownerId, channelId: "app", replyChannel: "app",
      appThread: fields.appThread || "main", source: { ...owner(), messageId: key, content, at }, deadline: now() + (fields.deadlineMs || config.taskLifetimeMs), ...fields });
    job.needsAck = true;
    return job;
  }

  function registerReporting(job) {
    const payload = { jobId: job.id, purpose: "private-reporting", at: now() };
    (d.ownerMuseReporting ||= {})[job.id] = { ...payload, digest: require("./ownermuse-policy").digest(payload) };
  }

  // Feed: Keir's written updates plus what happened, newest first.
  function addFeed(item) {
    const t = museState(d);
    const entry = { id: id(), at: now(), kind: item.kind || "update", title: clip(item.title, 140), body: String(item.body || "").slice(0, 4000), links: (item.links || []).slice(0, 6), source: item.source || "keir", ...(item.goal ? { goal: item.goal } : {}), ...(item.task ? { task: item.task } : {}) };
    if (item.key && t.feed.some((f) => f.key === item.key)) return null;
    if (item.key) entry.key = item.key;
    t.feed = [entry, ...t.feed].slice(0, 300);
    return entry;
  }
  function feed(limit = 80) { return museState(d).feed.slice(0, limit); }
  // Facts Keir produced without being asked to narrate them.
  function scanFeed() {
    const t = museState(d), since = t.marks.feedScanAt || 0;
    for (const job of Object.values(d.jobs)) {
      if ((job.updatedAt || job.at || 0) < since - 3600000) continue;
      for (const [k, e] of Object.entries(job.effects || {})) {
        if (e.state !== "done" || (e.at || 0) <= since) continue;
        const kind = k.split(":")[0], r = e.result || {};
        if (kind === "merge" && r.number) addFeed({ key: `merge:${r.number}`, kind: "win", title: `Merged PR #${r.number}`, body: clip(job.summary, 400), task: job.id, links: r.html_url ? [{ title: `PR #${r.number}`, url: r.html_url }] : [], source: "event" });
        if (kind === "promote-pr" && r.number) addFeed({ key: `promote:${r.number}`, kind: "update", title: `Opened promotion PR #${r.number}`, body: clip(job.summary, 400), task: job.id, source: "event" });
        if (kind === "issue" && r.number) addFeed({ key: `issue:${r.number}`, kind: "insight", title: `Filed issue #${r.number}`, body: clip(job.summary, 400), task: job.id, source: "event" });
      }
      if (job.kind === "ticket" && job.resolved && (job.updatedAt || 0) > since) addFeed({ key: `resolved:${job.ticket}`, kind: "win", title: `Ticket #${job.ticket} resolved`, body: clip(job.summary, 400), task: job.id, source: "event" });
    }
    t.marks.feedScanAt = now();
  }

  // Goals: an outcome Keir plans into milestones and keeps advancing.
  function goals() {
    return Object.values(museState(d).goals).sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || b.at - a.at).map((g) => ({ ...g,
      working: Boolean(g.taskId && d.jobs[g.taskId] && !CLOSED.includes(d.jobs[g.taskId].state)),
      nextStep: g.milestones.find(m => !m.done)?.title || (g.status === "completed" ? "Complete" : "Plan the milestones"),
      blocker: d.jobs[g.taskId]?.ownerMuseBlocker ? "Restart this goal’s task with the latest capabilities" : ["blocked", "waiting"].includes(d.jobs[g.taskId]?.state) ? clip(d.jobs[g.taskId]?.summary, 300) : null,
      progress: g.milestones.length ? g.milestones.filter((m) => m.done).length / g.milestones.length : 0 }));
  }
  function addGoal({ title, description = "", category = "A House Divided", cadence = "daily", milestones = [] }) {
    if (d.paused) throw err(409, "Keir is stopped. Start before creating a goal.");
    const t = museState(d);
    const name = clip(title, 160);
    if (name.length < 4) throw err(400, "name the goal");
    if (!CADENCE[cadence]) throw err(400, `cadence must be one of ${Object.keys(CADENCE).join(", ")}`);
    if (Object.values(t.goals).filter((g) => g.status === "active").length >= 12) throw err(409, "twelve goals are active; finish or pause one first");
    const g = { id: id(), title: name, description: String(description || "").slice(0, 4000), category: clip(category, 60), cadence, status: "active", at: now(),
      milestones: milestones.slice(0, 20).map((m) => ({ id: id(), title: clip(m, 200), done: false })), notes: [], nextAt: now(), lastAdvancedAt: null, taskId: null };
    t.goals[g.id] = g;
    addFeed({ kind: "goal", title: `New goal: ${g.title}`, body: g.description, goal: g.id, source: "owner" });
    ledger.audit("app_goal_added", { goal: g.id }); ledger.save();
    advance(g.id, { reason: "planning" });
    return g;
  }
  function updateGoal(goalId, { status, cadence, title, description }) {
    const g = museState(d).goals[goalId];
    if (!g) throw err(404, "unknown goal");
    if (status && !["active", "paused", "completed"].includes(status)) throw err(400, "status must be active, paused or completed");
    if (cadence && !CADENCE[cadence]) throw err(400, "unknown cadence");
    if (status) { g.status = status; if (status === "active") g.nextAt = now(); if (status === "completed") addFeed({ kind: "win", title: `Goal complete: ${g.title}`, goal: g.id, source: "owner" }); }
    if (cadence) g.cadence = cadence;
    if (title) g.title = clip(title, 160);
    if (description !== undefined) g.description = String(description).slice(0, 4000);
    ledger.save(); return g;
  }
  function advance(goalId, { reason = "scheduled", note = "" } = {}) {
    if (d.paused) throw err(409, "Keir is stopped. Start before advancing a goal.");
    const g = museState(d).goals[goalId];
    if (!g) throw err(404, "unknown goal");
    if (g.taskId && d.jobs[g.taskId] && !CLOSED.includes(d.jobs[g.taskId].state)) return { taskId: g.taskId, already: true };
    const open = g.milestones.filter((m) => !m.done).map((m) => `- [${m.id}] ${m.title}`).join("\n") || "(none yet)";
    const done = g.milestones.filter((m) => m.done).map((m) => `- ${m.title}`).join("\n") || "(none)";
    const content = reason === "planning"
      ? `New owner goal (${g.category}): "${g.title}". ${g.description}\n\nGoal id ${g.id}. Investigate where things stand with your tools. Then call goal_update with 3 to 8 concrete milestones in order (the first ones doable now) and a short note on the plan. Then do the first milestone if it is within the owner's standing authority, mark it with goal_update when it is verifiably done, post one feed_post with what you did and what is next, and finish.`
      : `Advance the owner goal "${g.title}" (${g.category}, goal id ${g.id}). ${g.description}\n\nOpen milestones:\n${open}\n\nDone:\n${done}\n\n${note ? `Owner note: ${note}\n\n` : ""}Pick the next milestone, make real progress on it with your tools, and mark milestones done with goal_update only when verified. If the plan is wrong, revise it with goal_update. Post one feed_post with what changed and what is next. If something needs the owner, ask through the normal decision path. Then finish.`;
    let job;
    if (["planning", "owner"].includes(reason)) {
      const posted = app.authenticatedPost(`Work towards my goal: ${g.title}\n${g.description}${note ? `\n${note}` : ""}`, null, "main", { mode: "new" });
      job = d.jobs[posted.jobId]; job.source.content = content; job.appGoal = g.id; g.originTaskId = job.id;
    } else {
      job = ownerTask(`goal:${g.id}:${(g.runs || 0) + 1}`, content, { appGoal: g.id, appThread: "main" });
      const parent = d.jobs[g.originTaskId];
      if (parent) require("./ownermuse-policy").inherit(ledger, parent, job);
      if (!require("./ownermuse-policy").origin(d, job).valid) registerReporting(job);
    }
    g.runs = (g.runs || 0) + 1; g.taskId = job.id; g.lastAdvancedAt = now(); g.nextAt = now() + CADENCE[g.cadence];
    ledger.audit("app_goal_advance", { goal: g.id, job: job.id, reason }); ledger.save(); drain();
    return { taskId: job.id };
  }

  // The morning brief: once a day at the owner's hour, Keir reads everything
  // and writes one feed entry, plus ideas with evidence.
  function brief(reason = "scheduled") {
    if (d.paused) throw err(409, "Keir is stopped. Start before requesting a brief.");
    const live = Object.values(d.jobs).find((j) => j.appBrief && !CLOSED.includes(j.state));
    if (live) return { taskId: live.id, already: true };
    let content = `Write the owner's ${reason === "scheduled" ? "morning " : ""}brief for Lakeside Games. Use your read tools: the live game (turns, timing, failures, economy pulse), open support tickets and what changed overnight, your own tasks and PRs, CI and deploy state, production errors, and notable Discord community activity. Then call feed_post once with kind "brief", a short title, and a body of 4 to 8 bullet lines, most important first, each concrete with numbers. Call idea_suggest for up to 3 opportunities you found with evidence and a ready-to-run prompt. Include one suggested ongoing goal when the evidence supports a measurable outcome. Compare trends, flag anomalies, and name the next useful action. Avoid repeating existing goals or suggestions. Do not change anything. Then finish.`;
    // 5.6.2: work parked overnight on unclaimed handoffs reaches the owner here,
    // once, instead of being polled all night.
    const { pendingHandoffs } = require("./developerwatch");
    const parked = [];
    for (const j of Object.values(d.jobs)) {
      if (CLOSED.includes(j.state)) continue;
      for (const r of pendingHandoffs(j)) if (r.watch?.parkedAt && !r.watch?.acceptedAt) parked.push(`#${r.id} ${clip(r.title, 100)}${j.ticket ? ` (ticket ${j.ticket})` : j.kind === "finding" ? " (game finding)" : ""}`);
    }
    if (parked.length) content += ` These developer handoffs are unclaimed and their tasks are parked until someone acts; give them one bullet naming each and the decision or owner it needs: ${[...new Set(parked)].slice(0, 12).join("; ")}.`;
    const job = ownerTask(`brief:${eastern(now()).day}:${reason}:${id()}`, content, { appBrief: reason, appThread: "main", deadlineMs: 30 * 60000 });
    job.needsAck = false; registerReporting(job);
    ledger.audit("app_brief", { job: job.id, reason }); ledger.save(); drain();
    return { taskId: job.id };
  }

  function tick() {
    const t = museState(d);
    scanFeed();
    if (d.paused) { ledger.save(); return; }
    for (const g of Object.values(t.goals)) if (g.status === "active" && g.nextAt <= now()) { try { advance(g.id); } catch {} }
    const e = eastern(now());
    if (t.identity.briefOn && e.hour === t.identity.briefHour && t.marks.briefDay !== e.day) { t.marks.briefDay = e.day; brief("scheduled"); }
    ledger.save();
  }

  // Continuity: what happened since the owner last opened the app, so a
  // session starts on the work that moved while they were away instead of a
  // cold feed. The app fetches this before acknowledging, then acknowledges,
  // so the same recap is not shown twice. It reads existing records only.
  function recap() {
    const t = museState(d);
    const since = t.marks.recapAt || now() - 12 * 3600000;
    const items = [];
    for (const f of t.feed) {
      if (f.at <= since) continue;
      items.push({ id: f.id, kind: f.kind, title: f.title, detail: clip(f.body, 240), at: f.at, goal: f.goal || null, task: f.task || null, source: f.source || "keir" });
    }
    // Quiet owner work that never reached the feed is still a result.
    for (const j of Object.values(d.jobs)) {
      const at = j.updatedAt || 0;
      if (at <= since || j.state !== "done" || j.role !== "owner" || j.appBrief) continue;
      if (items.some((i) => i.task === j.id)) continue;
      items.push({ id: `task:${j.id}`, kind: "task", title: clip(j.summary || j.source?.content, 140) || "Finished a task", detail: clip(j.summary, 240), at, task: j.id, source: "task" });
    }
    // Decisions the owner answered while away, named with their verdict.
    for (const x of Object.values(d.decisions || {})) {
      const at = x.answeredAt || 0;
      if (at <= since || x.state === "pending") continue;
      items.push({ id: `decision:${x.id}`, kind: "decision", title: clip(x.tldr || x.question, 140), detail: `${x.state} by the owner`, at, task: x.jobId || null, source: "owner" });
    }
    items.sort((a, b) => b.at - a.at);
    return { since, total: items.length, items: items.slice(0, 20) };
  }
  // Acknowledging marks the visit; it changes no work, goal, decision or feed.
  function ackRecap() {
    const t = museState(d);
    const acknowledgedAt = now();
    t.marks.recapAt = acknowledgedAt;
    ledger.audit("app_recap_ack", { at: acknowledgedAt }); ledger.save();
    return { acknowledgedAt };
  }

  // Approvals: everything waiting on the owner, with what it would do.
  function approvals() {
    return Object.values(d.decisions || {}).filter((x) => { const origin = require("./ownermuse-policy").origin(d, d.jobs[x.jobId]); return x.state === "pending" && (!origin.scoped || origin.valid); }).sort((a, b) => b.at - a.at).map((x) => {
      const a = x.actionId && d.actions?.[x.actionId];
      const job = d.jobs[x.jobId];
      return { id: x.id, question: x.question, tldr: x.tldr || null, at: x.at, signoff: Boolean(x.signoff), ticket: job?.ticket || null, task: x.jobId,
        taskTitle: clip(job?.source?.content || job?.summary, 140) || null,
        action: a ? { kind: a.kind, summary: clip(a.args?.title || a.args?.action && `${a.args.action} ${a.args.number ? `#${a.args.number}` : ""}` || JSON.stringify(a.args || {}), 200), expiresAt: a.expiresAt || null } : null,
        binds: x.binds || null };
    });
  }

  // Upcoming: what Keir will do next, and when.
  function upcoming() {
    const t = museState(d), out = [];
    for (const w of Object.values(t.watches || {})) if (w.active) out.push({ kind: "watch", at: w.nextAt, title: w.condition, ref: w.id });
    for (const g of Object.values(t.goals)) if (g.status === "active") out.push({ kind: "goal", at: g.nextAt, title: `Advance: ${g.title}`, ref: g.id });
    if (t.identity.briefOn) {
      const e = eastern(now()); let next = now() + ((t.identity.briefHour - e.hour + 24) % 24) * 3600000;
      if (t.marks.briefDay === e.day && next <= now() + 3600000) next += 86400000;
      out.push({ kind: "brief", at: next - (next % 3600000), title: "Morning brief" });
    }
    for (const j of Object.values(d.jobs)) if (j.state === "waiting" && j.wakeAt && j.wakeAt > now() && (j.role === "owner" || j.ticket))
      out.push({ kind: j.ticket ? "ticket" : "task", at: j.wakeAt, title: j.ticket ? `Ticket #${j.ticket}: ${clip(j.summary, 100)}` : clip(j.source?.content || j.summary, 120), ref: j.id });
    for (const j of Object.values(d.jobs)) if (j.turnWatch && !CLOSED.includes(j.state)) out.push({ kind: "turn", at: null, title: `After turn ${j.turnWatch.turn}: ${clip(j.turnWatch.note || j.summary, 100)}`, ref: j.id });
    return out.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)).slice(0, 60);
  }

  // Files: what Keir made, charts and written artifacts.
  function artifacts() {
    const t = museState(d), list = Object.values(t.artifacts).map((a) => ({ id: a.id, kind: a.kind, title: a.title, summary: a.summary, at: a.at, task: a.task }));
    for (const m of t.messages || []) if (m.chart) list.push({ id: m.chart, kind: "chart", title: clip(m.text, 120) || "Chart", summary: null, at: m.at, task: m.jobId, file: m.chart });
    return list.sort((a, b) => b.at - a.at).slice(0, 120);
  }
  function artifact(artifactId) {
    const a = museState(d).artifacts[artifactId];
    if (!a) throw err(404, "unknown artifact");
    return a;
  }

  function identity(patch) {
    const t = museState(d);
    if (patch) {
      if (patch.tone !== undefined && !["concise", "warm", "thorough"].includes(patch.tone)) throw err(400, "tone must be concise, warm or thorough");
      if (patch.briefHour !== undefined && !(Number.isInteger(patch.briefHour) && patch.briefHour >= 0 && patch.briefHour <= 23)) throw err(400, "briefHour is 0 to 23");
      for (const k of ["tone", "showUpdates", "briefHour", "briefOn"]) if (patch[k] !== undefined) t.identity[k] = patch[k];
      ledger.save();
    }
    return t.identity;
  }

  // Live work: the last tool calls of an owner task, as they happen.
  function startTool(job, name, input) {
    const id = require("./toolactivity").start(job, name, input, now());
    if (id) ledger.save();
    return id;
  }
  function noteTool(job, name, input, ok, ms, callId) {
    if (job.role !== "owner" || job.internalProbe) return;
    const id = callId || require("./toolactivity").start(job, name, input, now());
    require("./toolactivity").finish(job, id, ok, ms, now());
    ledger.save();
  }

  // Tool calls from Keir's own tasks.
  function toolCall(job, name, input = {}) {
    if (job.role !== "owner") throw new Error(`${name} is for owner tasks`);
    const t = museState(d);
    if (name === "task_plan") {
      const steps = (Array.isArray(input.steps) ? input.steps : []).slice(0, 12).map((s) => ({ title: clip(s.title, 160), status: STEP.includes(s.status) ? s.status : "pending", detail: s.detail ? clip(s.detail, 300) : undefined }));
      if (!steps.length) throw new Error("give the plan as steps: [{title, status}]");
      job.plan = steps; job.planAt = now(); ledger.save();
      return { saved: steps.length, instruction: "Call task_plan again with updated statuses as steps finish." };
    }
    if (name === "goal_update") {
      const g = t.goals[String(input.goalId || job.appGoal || "")];
      if (!g) throw new Error("unknown goal id");
      if (Array.isArray(input.milestones)) {
        const prior = new Map(g.milestones.map((m) => [m.id, m]));
        g.milestones = input.milestones.slice(0, 20).map((m) => {
          const keep = m.id && prior.get(m.id);
          const doneNow = Boolean(m.done);
          if (doneNow && !(keep?.done)) addFeed({ kind: "win", title: `Milestone done: ${clip(m.title || keep?.title, 120)}`, body: clip(m.evidence, 600), goal: g.id, task: job.id });
          return { id: keep ? keep.id : id(), title: clip(m.title || keep?.title, 200), done: doneNow, ...(m.evidence ? { evidence: clip(m.evidence, 600) } : keep?.evidence ? { evidence: keep.evidence } : {}), ...(doneNow ? { doneAt: keep?.doneAt || now() } : {}) };
        });
      }
      if (input.note) g.notes = [...(g.notes || []), { at: now(), text: clip(input.note, 1500), task: job.id }].slice(-30);
      if (input.status === "completed" && g.status !== "completed") { g.status = "completed"; addFeed({ kind: "win", title: `Goal complete: ${g.title}`, goal: g.id, task: job.id }); }
      ledger.save();
      return { goal: g.id, milestones: g.milestones.map((m) => ({ id: m.id, title: m.title, done: m.done })) };
    }
    if (name === "feed_post") {
      const entry = addFeed({ kind: ["brief", "insight", "warning", "win", "update"].includes(input.kind) ? input.kind : "update", title: input.title, body: input.body,
        links: (input.links || []).filter((l) => /^https:\/\//.test(String(l.url || ""))).map((l) => ({ title: clip(l.title, 80), url: String(l.url).slice(0, 500) })), goal: job.appGoal, task: job.id });
      ledger.save();
      return { posted: Boolean(entry) };
    }
    if (name === "artifact_save") {
      const body = String(input.markdown || "");
      if (body.length < 20) throw new Error("an artifact needs markdown content");
      if (body.length > 60000) throw new Error("keep an artifact under 60,000 characters");
      const a = { id: id(), kind: ["report", "table", "plan", "analysis"].includes(input.kind) ? input.kind : "report", title: clip(input.title, 140) || "Report", summary: clip(input.summary, 300), markdown: body, at: now(), task: job.id };
      t.artifacts[a.id] = a;
      const ids = Object.values(t.artifacts).sort((x, y) => y.at - x.at).map((x) => x.id);
      for (const old of ids.slice(150)) delete t.artifacts[old];
      ledger.save();
      return { saved: a.id, instruction: "The owner can open it in the app's Files. Mention it in your reply." };
    }
    if (name === "idea_suggest") {
      const title = clip(input.title, 160);
      if (title.length < 8 || !input.prompt) throw new Error("an idea needs a title and a ready-to-run prompt");
      const prior = Object.values(t.suggested).find(s => s.title.toLowerCase() === title.toLowerCase() && (s.status !== "dismissed" || now() - s.at < 30 * 86400000));
      if (prior) return { suggested: prior.id, duplicate: true };
      const s = { id: id(), title, reason: clip(input.reason, 800), prompt: clip(input.prompt, 2000), evidence: (input.evidence || []).slice(0, 5).map((e) => ({ title: clip(e.title, 120), excerpt: clip(e.excerpt, 400), url: /^https:\/\//.test(String(e.url || "")) ? String(e.url).slice(0, 500) : undefined })), at: now(), status: "new", task: job.id };
      t.suggested[s.id] = s;
      const ids = Object.values(t.suggested).sort((x, y) => y.at - x.at).map((x) => x.id);
      for (const old of ids.slice(100)) delete t.suggested[old];
      ledger.save();
      return { suggested: s.id };
    }
    throw new Error(`unknown tool ${name}`);
  }

  // Ideas Keir suggested in briefs and tasks, alongside its filed issues.
  function suggestedIdeas() {
    return Object.values(museState(d).suggested).filter((s) => s.status === "new" || s.status === "accepted").sort((a, b) => b.at - a.at)
      .map((s) => ({ id: `s-${s.id}`, title: s.title, url: null, at: s.at, evidence: s.reason, sources: s.evidence, accepted: s.status === "accepted", kind: "suggestion", prompt: s.prompt }));
  }
  function decideSuggestion(sid, verdict) {
    const s = museState(d).suggested[sid];
    if (!s) throw err(404, "unknown idea");
    if (verdict === "dismiss") { s.status = "dismissed"; ledger.save(); return { dismissed: true }; }
    if (verdict !== "accept") throw err(400, "verdict must be accept or dismiss");
    if (s.taskId) return { taskId: s.taskId };
    const posted = app.authenticatedPost(s.prompt, `suggestion-${sid}`);
    s.status = "accepted"; s.taskId = posted.jobId; ledger.save();
    addFeed({ kind: "update", title: `Started: ${s.title}`, task: posted.jobId, source: "owner" });
    return { taskId: posted.jobId };
  }

  // Context the model sees on owner tasks from the app.
  function context(job) {
    const t = museState(d);
    const g = job.appGoal && t.goals[job.appGoal];
    return { ownerMuseOrigin: require("./ownermuse-policy").origin(d, job), enforcement: "Opening text is not consent. Exact supported actions need an authenticated app decision. Guidance never conveys action consent. Inspect coordinator receipts and holds before reporting delivery.", ownerPreferences: { tone: t.identity.tone, narrateProgress: t.identity.showUpdates },
      ...(g ? { goal: { id: g.id, title: g.title, milestones: g.milestones.map((m) => ({ id: m.id, title: m.title, done: m.done })), recentNotes: (g.notes || []).slice(-3) } } : {}),
      planning: "For multi-step work, call task_plan first with the steps you intend, then again as each one finishes. The owner sees the plan live." };
  }

  async function route(path, method, body) {
    if (path === "/feed" && method === "GET") return { feed: feed(), recap: recap() };
    if (path === "/feed/brief" && method === "POST") return brief("on demand");
    if (path === "/recap" && method === "GET") return recap();
    if (path === "/recap/ack" && method === "POST") return ackRecap();
    if (path === "/starmer" && method === "GET") return starmer ? starmer.view() : { text: null, working: null };
    if (path === "/starmer/refresh" && method === "POST") return starmer ? starmer.refresh() : { text: null, working: null };
    if (path === "/goals" && method === "GET") return { goals: goals(), cadences: Object.keys(CADENCE) };
    if (path === "/goals" && method === "POST") return addGoal(body);
    let m = /^\/goals\/([a-f0-9]{12})(?:\/(advance))?$/.exec(path);
    if (m && method === "POST" && m[2] === "advance") return advance(m[1], { reason: "owner", note: clip(body.note, 600) });
    if (m && method === "POST") return updateGoal(m[1], body);
    if (m && method === "GET") { const g = goals().find((x) => x.id === m[1]); if (!g) throw err(404, "unknown goal"); return g; }
    if (path === "/approvals" && method === "GET") return { approvals: approvals() };
    if (path === "/upcoming" && method === "GET") return { upcoming: upcoming() };
    if (path === "/files" && method === "GET") return { files: artifacts() };
    m = /^\/files\/([a-f0-9]{12})$/.exec(path);
    if (m && method === "GET") return artifact(m[1]);
    if (path === "/identity" && method === "GET") return identity();
    if (path === "/identity" && method === "POST") return identity(body);
    m = /^\/ideas\/s-([a-f0-9]{12})$/.exec(path);
    if (m && method === "POST") return decideSuggestion(m[1], body.verdict);
    return undefined;
  }

  return { route, tick, toolCall, startTool, noteTool, context, feed, addFeed, goals, addGoal, updateGoal, advance, brief, recap, ackRecap, approvals, upcoming, artifacts, identity, suggestedIdeas, decideSuggestion };
}

module.exports = { createAppMuse, MUSE_TOOLS, museState, eastern };
