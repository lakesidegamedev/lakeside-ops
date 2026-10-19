"use strict";
// The owner's Keir as a personal agent in Lakeside Ops: threads, visible
// work with receipts, result cards, ideas with evidence, owner watches that
// keep checking, and the memory Keir keeps. Everything here is owner-only and
// rides the app channel's authentication; it never widens what a task may do.
const crypto = require("node:crypto");
const { threadOf, isAppJob } = require("./appchannel");

const CLOSED = ["done", "dismissed", "cancelled"];
const MAIN = "main";
const WATCHES = "watches";
const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const id = () => crypto.randomBytes(6).toString("hex");
const NO_CHANGE = /^\s*no change\.?\s*$/i;

function agentState(d) {
  const t = threadOf(d);
  t.threads ||= { [MAIN]: { id: MAIN, title: "Keir", at: 0 }, [WATCHES]: { id: WATCHES, title: "Watches", at: 0, system: true } };
  t.watches ||= {};
  t.ideas ||= { dismissed: {}, accepted: {} };
  return t;
}

// Effect receipts as the owner reads them: what was done, when, and whether it held.
function receiptOf(key, effect) {
  const kind = key.split(":")[0];
  const r = effect.result || {};
  const label = {
    merge: `Merged PR ${r.number ? `#${r.number}` : ""}`.trim(), "promote-pr": "Opened a promotion PR", "close-pr": "Closed a PR", issue: `Filed issue ${r.number ? `#${r.number}` : ""}`.trim(),
    "issue-comment": "Commented on an issue", "ticket-update": `Updated ticket ${r.number ? `#${r.number}` : ""}`.trim(), "status-card": "Updated a ticket status card", "sentry-note": "Noted a Sentry issue",
    action: "Ran an approved action", intake: "Opened a ticket", heal: "Applied a data heal",
  }[kind] || (/^[a-f0-9]{40,}$/.test(kind) ? "External action" : kind.replace(/-/g, " "));
  return { key: clip(key, 80), kind, label, state: effect.state, at: effect.at || null, url: r.html_url || r.url || null };
}

function cardsFor(d, job) {
  if (!job) return [];
  const cards = [];
  const tickets = new Set([job.ticket, ...Object.values(job.openedTickets || {}).map((t) => t.number)].filter(Boolean).map(Number));
  for (const n of tickets) cards.push({ type: "ticket", number: n, title: d.ticketRecords?.[n]?.title || d.channels && Object.values(d.channels).find((c) => c.ticket === n)?.name || null });
  for (const url of job.pullRequests || []) { const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url); if (m) cards.push({ type: "pr", repository: m[1], number: Number(m[2]), url }); }
  for (const issue of Object.values(d.keirIssues || {}).filter((i) => i.jobId === job.id)) cards.push({ type: "issue", number: issue.number, title: issue.title, url: issue.url, state: issue.state });
  for (const [key, e] of Object.entries(job.effects || {})) if (/^heal/.test(key) && e.state === "done") cards.push({ type: "receipt", ...receiptOf(key, e) });
  return cards.slice(0, 8);
}

function createAppAgent({ ledger, config, app, notebook = null, muse = null, mcp = null, now = () => Date.now(), drain = () => {} }) {
  const d = ledger.data;
  const appTask = job => isAppJob(require("./appcontrols").rootOf(d, job));

  // Threads: separate lines of work with the same owner authority. Keir's
  // short-term context is shared; the UI and the live task are per thread.
  function threads() {
    const t = agentState(d);
    return Object.values(t.threads).filter((x) => !x.archived).map((x) => {
      const last = [...t.messages].reverse().find((m) => (m.thread || MAIN) === x.id);
      return { id: x.id, title: x.title, system: Boolean(x.system), at: last?.at || x.at, preview: last ? clip(last.text, 120) : null,
        working: Object.values(d.jobs).some((j) => isAppJob(j) && (j.appThread || MAIN) === x.id && j.state === "running") };
    }).sort((a, b) => (b.id === MAIN) - (a.id === MAIN) || b.at - a.at);
  }
  function createThread(title) {
    const t = agentState(d);
    const thread = { id: id(), title: clip(title || "New thread", 60), at: now() };
    t.threads[thread.id] = thread; ledger.save(); return thread;
  }
  function updateThread(threadId, { title, archived }) {
    const x = agentState(d).threads[threadId];
    if (!x || x.system || threadId === MAIN) throw err(404, "unknown thread");
    if (title !== undefined) x.title = clip(title, 60) || x.title;
    if (archived !== undefined) x.archived = Boolean(archived);
    ledger.save(); return x;
  }

  const uncertainOutcome = j => Object.values(j.effects || {}).some(e => ["started", "executing"].includes(e.state)) || Object.values(d.actions || {}).some(a => a.jobId === j.id && a.state === "executing");
  function attention(j) {
    if (CLOSED.includes(j.state)) return null;
    if (j.state !== "running" && uncertainOutcome(j)) {
      const publication = Object.values(d.actions || {}).some(a => a.jobId === j.id && a.state === "executing" && a.kind === "publish_patch");
      return { kind: "blocked", title: publication ? "Keir is checking the earlier publication" : "Verify the earlier action", detail: publication ? "Keir checks the saved patch against GitHub automatically. No approval is needed for this check, and the publication will not run twice. Saved reports remain available." : "An earlier action has no confirmed completion receipt. Its outcome must be checked before it can run again. Saved reports remain available.", action: null };
    }
    const origin = require("./ownermuse-policy").origin(d, j);
    if (origin.scoped && !origin.valid) return { kind: "blocked", title: "Restart this saved task", detail: "This older task needs a fresh authenticated request. Its checkpoint and links will be kept; approvals must be reviewed again.", action: "retry" };
    const pending = Object.values(d.decisions || {}).filter(x => x.jobId === j.id && x.state === "pending");
    if (pending.length) return { kind: "approval", title: "Review the pending decision", detail: pending[0].question, action: "review", decisionId: pending[0].id };
    const questions = Object.values(d.appThread?.questions || {}).filter(x => x.jobId === j.id && x.state === "pending");
    if (questions.length) return { kind: "question", title: "Answer Keir’s question", detail: questions[0].title, action: "reply" };
    if (j.ownerMuseBlocker) return { kind: "blocked", title: "Restart with the latest Keir capabilities", detail: "This task stopped at an unavailable operation. Retry to check it again; previous approvals are kept in history.", action: "retry" };
    if (j.state === "blocked") return { kind: "blocked", title: "This task needs another attempt", detail: clip(j.summary, 300), action: "retry" };
    if (j.state === "waiting") return { kind: "waiting", title: "Waiting for an update", detail: clip(j.summary, 300), action: "reply" };
    return null;
  }
  const workQueue = require("./workqueue").createWorkQueue({ ledger, config, mcp, now });
  // Activity: every owner task, from the app or Discord, with its receipts.
  function tasks({ limit = 40 } = {}) {
    return Object.values(d.jobs).filter((j) => j.role === "owner" && !j.internalProbe && !j.benchmark && !j.appWatch)
      .sort((a, b) => Number(CLOSED.includes(a.state)) - Number(CLOSED.includes(b.state)) || (b.updatedAt || b.at) - (a.updatedAt || a.at))
      .filter((j, i, all) => !CLOSED.includes(j.state) || all.slice(0, i).filter(x => CLOSED.includes(x.state)).length < limit)
      .map((j) => ({ id: j.id, kind: j.kind, state: j.state, title: clip(j.codingParent ? `${j.investigation ? "Investigation" : "Coding"}: ${d.jobs[j.codingParent]?.source?.content || "Delegated work"}` : j.source?.content || j.summary, 120), summary: clip(j.ownerMuseBlocker?.message || j.summary, 500), at: j.at, updatedAt: j.updatedAt || j.at,
        surface: appTask(j) ? "app" : "discord", thread: j.appThread || require("./appcontrols").rootOf(d, j)?.appThread || null, ticket: j.ticket || null, receipts: Object.keys(j.effects || {}).length,
        timing: require("./workqueue").workStatus(d, j, { now: now(), config }), attention: attention(j), decisionPending: Object.values(d.decisions || {}).some((x) => x.jobId === j.id && x.state === "pending"),
        goal: j.appGoal || null, brief: Boolean(j.appBrief), plan: j.plan ? { done: j.plan.filter((p) => p.status === "done").length, total: j.plan.length, current: j.plan.find((p) => p.status === "running")?.title || null } : null }));
  }
  function task(taskId) {
    const j = d.jobs[String(taskId || "")];
    if (!j || j.role !== "owner") throw err(404, "unknown task");
    const origin = require("./ownermuse-policy").origin(d, j), unproven = origin.scoped && !origin.valid;
    return { id: j.id, kind: j.kind, state: j.state, request: j.source?.content || null, summary: j.ownerMuseBlocker?.message || j.summary || null, blocker: j.ownerMuseBlocker || null, attention: attention(j), timing: require("./workqueue").workStatus(d, j, { now: now(), config }), at: j.at, updatedAt: j.updatedAt || j.at,
      surface: appTask(j) ? "app" : "discord", thread: j.appThread || require("./appcontrols").rootOf(d, j)?.appThread || null, ticket: j.ticket || null, model: j.provider ? `${j.provider.runner}:${j.provider.model}` : null,
      status: threadOf(d).status?.[j.id]?.text || null, provider: j.provider || null, activeSkills: j.activeSkills || [], overrides: j.appOverrides || {},
      steps: (j.history || []).slice(-20).map((h) => ({ at: h.at, kind: h.kind, state: h.state, summary: clip(h.summary, 600) })),
      receipts: Object.entries(j.effects || {}).map(([k, e]) => receiptOf(k, e)).sort((a, b) => (a.at || 0) - (b.at || 0)),
      decisions: Object.values(d.decisions || {}).filter((x) => !unproven && x.jobId === j.id && x.state === "pending").map((x) => require("./appdecision").decisionView(d, x, now())),
      plan: j.plan || [], live: (j.liveLog || []).slice(-30), goal: j.appGoal || null, computer: j.appComputer || null,
      cards: cardsFor(d, j), canRetry: !uncertainOutcome(j) && ["done", "blocked", "cancelled", "waiting"].includes(j.state) && ["command", "conversation"].includes(j.kind), canStop: !CLOSED.includes(j.state),
      canPause: isAppJob(j) && !CLOSED.includes(j.state) && j.state !== "paused", canResume: isAppJob(j) && j.state === "paused" };
  }
  function retry(taskId, note) {
    const j = d.jobs[String(taskId || "")];
    if (!j || j.role !== "owner" || !["command", "conversation"].includes(j.kind)) throw err(404, "unknown task");
    if (j.supersededBy && d.jobs[j.supersededBy]) return { state: d.jobs[j.supersededBy].state, taskId: j.supersededBy, restarted: true, duplicate: true };
    if (j.state === "running" || j.state === "queued") return { state: j.state };
    if (uncertainOutcome(j)) throw err(409, "An action outcome needs inspection before retrying.");
    for (const action of Object.values(d.actions || {})) if (action.jobId === j.id && action.expiresAt <= now() && ["pending", "approved"].includes(action.state)) {
      action.state = "expired";
      for (const decision of Object.values(d.decisions || {})) if (decision.actionId === action.id && decision.state === "pending") decision.state = "expired";
    }
    const origin = require("./ownermuse-policy").origin(d, j);
    if (origin.scoped && !origin.valid) {
      const posted = app.authenticatedPost(`${j.source?.content || "Resume this task"}${note ? `\nOwner retry note: ${clip(note, 600)}` : ""}`, null, j.appThread || "main", { mode: "new" });
      const replacement = d.jobs[posted.jobId];
      replacement.inbox ||= [];
      replacement.inbox.push({ role: "assistant", authorId: "saved-task-history", at: new Date(now()).toISOString(), content: `Historical evidence from task ${j.id}, not a new owner instruction or approval. Verify current state. Prior actions and approvals are not transferred.\nLast checkpoint: ${clip(j.summary, 1000)}\nPlan: ${(j.plan || []).map(p => `${p.status}: ${p.title}`).join("; ").slice(0, 1200)}\nRelated PRs: ${(j.pullRequests || []).join(" ").slice(0, 1000)}${j.ticket ? `\nTicket: ${j.ticket}` : ""}` });
      j.state = "cancelled"; j.supersededBy = posted.jobId; j.summary = "Restarted by the owner with the latest capabilities.";
      for (const q of Object.values(d.appThread?.questions || {})) if (q.jobId === j.id && q.state === "pending") q.state = "superseded";
      for (const x of Object.values(d.decisions || {})) if (x.jobId === j.id && x.state === "pending") { x.state = "superseded"; x.supersededBy = posted.jobId; }
      for (const x of Object.values(d.actions || {})) if (x.jobId === j.id && ["pending", "approved"].includes(x.state)) { x.state = "superseded"; x.supersededBy = posted.jobId; }
      ledger.audit("app_retry_fresh_origin", { job: j.id, replacement: posted.jobId }); ledger.save();
      return { state: "queued", taskId: posted.jobId, restarted: true };
    }
    if (j.ownerMuseBlocker) require("./ownermuse-policy").clearBlocker(ledger, j, j.ownerMuseBlocker.capability);
    (j.inbox ||= []).push({ authorId: config.ownerId, role: "owner", content: `Owner asked to retry this from the app.${note ? ` ${clip(note, 600)}` : ""}`, at: new Date(now()).toISOString() });
    j.state = "queued"; j.wakeAt = 0; j.deadline = now() + config.taskLifetimeMs; delete j.waitingFor;
    ledger.audit("app_retry", { job: j.id }); ledger.save(); drain();
    return { state: j.state };
  }
  function pause(taskId, resume = false) {
    const j = d.jobs[String(taskId || "")];
    if (!isAppJob(j) || j.role !== "owner" || CLOSED.includes(j.state)) throw err(404, "unknown active app task");
    if (resume) {
      if (j.state !== "paused") return { state: j.state };
      if (Object.values(j.effects || {}).some((e) => e.state === "started")) throw err(409, "An action outcome needs inspection before resuming.");
      delete j.appPaused; j.state = "queued";
      if (j.appComputer) { (j.inbox ||= []).push({ authorId: config.ownerId, content: "The owner returned computer control. Inspect the current screen with computer look before continuing.", at: new Date(now()).toISOString() }); j.appSteering = true; }
    } else {
      if (Object.values(j.effects || {}).some((e) => e.state === "started")) throw err(409, "An action is in progress or needs verification. Let it finish before pausing.");
      j.appPaused = true; j.state = "paused";
    }
    ledger.audit(resume ? "app_resume" : "app_pause", { job: j.id }); ledger.save(); drain();
    return { state: j.state };
  }
  function stop(taskId) {
    const j = d.jobs[String(taskId || "")];
    if (!j || j.role !== "owner") throw err(404, "unknown task");
    if (CLOSED.includes(j.state)) return { state: j.state };
    if (appTask(j)) return app.cancel(j.id);
    j.state = "cancelled"; j.summary = "Stopped by the owner from the app.";
    ledger.audit("app_stop", { job: j.id }); ledger.save(); drain();
    return { state: j.state };
  }

  // Ideas: issues Keir found on its own, with evidence, waiting for a yes.
  function ideas() {
    const t = agentState(d);
    return [...(muse ? muse.suggestedIdeas() : []), ...Object.values(d.keirIssues || {}).filter((i) => i.state === "open" && !t.ideas.dismissed[i.number])
      .sort((a, b) => b.at - a.at).slice(0, 30)
      .map((i) => ({ id: String(i.number), title: i.title, url: i.url, at: i.at, tickets: i.tickets || [], accepted: Boolean(t.ideas.accepted[i.number]),
        evidence: clip(d.jobs[i.jobId]?.summary, 400) || null, kanban: i.item || null, kind: "issue" }))];
  }
  function decideIdea(ideaId, verdict) {
    const t = agentState(d);
    const issue = d.keirIssues?.[ideaId];
    if (!issue) throw err(404, "unknown idea");
    if (verdict === "dismiss") { t.ideas.dismissed[ideaId] = now(); ledger.save(); return { dismissed: true }; }
    if (verdict !== "accept") throw err(400, "verdict must be accept or dismiss");
    if (t.ideas.accepted[ideaId]) return { taskId: t.ideas.accepted[ideaId] };
    const posted = app.authenticatedPost(`Fix ${issue.url} (${issue.title}). Investigate, open a fix PR to development, and report back here.`, `idea-${ideaId}`);
    t.ideas.accepted[ideaId] = posted.jobId; ledger.save();
    return { taskId: posted.jobId };
  }

  // Watches: the owner names a condition; Keir checks it on a schedule with a
  // read-only quick task and speaks only when it is met.
  const INTERVALS = { "15m": 900000, hourly: 3600000, "6h": 21600000, daily: 86400000 };
  function watches() {
    return Object.values(agentState(d).watches).sort((a, b) => b.at - a.at).map((w) => ({ ...w, intervalMs: undefined, running: Boolean(w.jobId && d.jobs[w.jobId] && !CLOSED.includes(d.jobs[w.jobId].state)) }));
  }
  function addWatch({ condition, every = "hourly", once = true }) {
    const text = clip(condition, 500);
    if (text.length < 8) throw err(400, "say what to watch for");
    if (!INTERVALS[every]) throw err(400, `every must be one of ${Object.keys(INTERVALS).join(", ")}`);
    const t = agentState(d);
    if (Object.values(t.watches).filter((w) => w.active).length >= 20) throw err(409, "twenty watches are active; remove one first");
    const w = { id: id(), condition: text, every, once: once !== false, active: true, at: now(), nextAt: now(), runs: 0, hits: 0, lastRunAt: null, lastHitAt: null, lastResult: null };
    t.watches[w.id] = w; ledger.audit("app_watch_added", { watch: w.id, every }); ledger.save();
    return w;
  }
  function updateWatch(watchId, { active, remove }) {
    const t = agentState(d), w = t.watches[watchId];
    if (!w) throw err(404, "unknown watch");
    if (remove) { delete t.watches[watchId]; ledger.save(); return { removed: true }; }
    if (active !== undefined) { w.active = Boolean(active); if (w.active) w.nextAt = now(); }
    ledger.save(); return w;
  }
  function tickWatches() {
    if (d.paused) return;
    const t = agentState(d);
    for (const w of Object.values(t.watches)) {
      if (!w.active || w.nextAt > now()) continue;
      if (w.jobId && d.jobs[w.jobId] && !CLOSED.includes(d.jobs[w.jobId].state)) continue;
      const at = new Date(now()).toISOString();
      const s = { messageId: `watch-${w.id}-${w.runs + 1}`, channelId: "app", channelName: "keir-app", authorId: config.ownerId, author: "owner", at, attachments: [], embeds: [],
        content: `Owner watch, checked ${w.every}: "${w.condition}". Read-only: verify it now with your tools. If the condition is not met, call channel_reply with exactly NO CHANGE and finish. If it is met, call channel_reply with one or two plain sentences saying what is now true and the evidence, then finish.` };
      const job = ledger.createJob(`watch:${w.id}:${w.runs + 1}`, { kind: "conversation", role: "owner", actorId: config.ownerId, channelId: "app", replyChannel: "app",
        appThread: WATCHES, appWatch: w.id, source: s, deadline: now() + 15 * 60000 });
      w.jobId = job.id; w.runs += 1; w.lastRunAt = now(); w.nextAt = now() + INTERVALS[w.every];
      ledger.audit("app_watch_run", { watch: w.id, job: job.id });
    }
    ledger.save(); drain();
  }
  // Called by the app channel before a watch reply is shown. Returns false to
  // keep a "no change" out of the thread.
  function onWatchReply(job, text) {
    const w = agentState(d).watches[job.appWatch];
    if (!w) return true;
    w.lastResult = NO_CHANGE.test(text) ? "no change" : clip(text, 300);
    if (NO_CHANGE.test(text)) { ledger.save(); return false; }
    w.hits += 1; w.lastHitAt = now();
    muse?.addFeed({ kind: "warning", title: `Watch met: ${clip(w.condition, 120)}`, body: clip(text, 800), task: job.id, source: "watch" });
    if (w.once) w.active = false;
    ledger.save(); return true;
  }

  // Memory: what Keir has learned, and what the owner tells it to keep.
  const MEMORY_KINDS = ["lesson", "decision", "knowledge", "mechanic", "resolution"];
  function memory({ q = "", kind = "", limit = 60 } = {}) {
    if (!notebook) return { notes: [], total: 0 };
    const query = String(q || "").toLowerCase();
    const all = notebook.all().filter((n) => MEMORY_KINDS.includes(n.kind) && (!kind || n.kind === kind) && (!query || String(n.text).toLowerCase().includes(query)));
    return { total: all.length, notes: all.slice(-Math.min(200, limit)).reverse().map((n) => ({ id: n.id, kind: n.kind, text: n.text, at: n.at || n.createdAt || null, owner: n.by === "owner-app", ticket: n.ticket || null })) };
  }
  function remember(text) {
    if (!notebook) throw err(503, "memory unavailable");
    try { return notebook.remember({ kind: "lesson", text: String(text || "").trim(), by: "owner-app", source: "Owner, Lakeside Ops app" }); }
    catch (e) { throw err(400, e.message); }
  }
  function forget(noteId) {
    if (!notebook) throw err(503, "memory unavailable");
    if (!notebook.forget(String(noteId || ""))) throw err(404, "unknown note");
    ledger.audit("app_memory_forget", { note: noteId }); return { forgotten: true };
  }

  // One router for the app server.
  async function route(path, method, body, query) {
    if (muse) { const out = await muse.route(path, method, body, query); if (out !== undefined) return out; }
    if (path === "/threads" && method === "GET") return { threads: threads() };
    if (path === "/threads" && method === "POST") return createThread(body.title);
    let m = /^\/threads\/([a-z0-9]{6,12})$/.exec(path);
    if (m && method === "POST") return updateThread(m[1], body);
    const ticketMatch = /^\/tickets\/(\d{1,7})$/.exec(path);
    if (ticketMatch && method === "GET") return require("./apptickets").ticketDetail(d, Number(ticketMatch[1]), now(), config);
    if (path === "/work" && method === "GET") return workQueue.view();
    if (path === "/tasks" && method === "GET") return { tasks: tasks() };
    m = /^\/tasks\/([a-f0-9]{12})(?:\/(retry|stop|pause|resume))?$/.exec(path);
    if (m && method === "GET" && !m[2]) return task(m[1]);
    if (m && method === "POST" && m[2] === "retry") return retry(m[1], body.note);
    if (m && method === "POST" && ["pause", "resume"].includes(m[2])) return pause(m[1], m[2] === "resume");
    if (m && method === "POST" && m[2] === "stop") return stop(m[1]);
    if (path === "/ideas" && method === "GET") return { ideas: ideas() };
    m = /^\/ideas\/(\d{1,7})$/.exec(path);
    if (m && method === "POST") return decideIdea(m[1], body.verdict);
    if (path === "/watches" && method === "GET") return { watches: watches(), intervals: Object.keys(INTERVALS) };
    if (path === "/watches" && method === "POST") return addWatch(body);
    m = /^\/watches\/([a-f0-9]{12})$/.exec(path);
    if (m && method === "POST") return updateWatch(m[1], body);
    if (path === "/memory" && method === "GET") return memory({ q: query.get("q"), kind: query.get("kind") });
    if (path === "/memory" && method === "POST") return { saved: remember(body.text) };
    m = /^\/memory\/([a-zA-Z0-9]{6,24})\/forget$/.exec(path);
    if (m && method === "POST") return forget(m[1]);
    return undefined;
  }

  return { route, threads, createThread, updateThread, tasks, task, retry, pause, stop, ideas, decideIdea, watches, addWatch, updateWatch, tickWatches, onWatchReply, memory, remember, forget, cardsFor: (job) => cardsFor(d, job) };
}

module.exports = { createAppAgent, cardsFor, receiptOf, agentState, MAIN, WATCHES };
