"use strict";
// The owner's private Keir app (Lakeside Ops on iOS). It is one more owner
// channel: requests become owner-directed jobs exactly like an owner DM, and
// every reply that would go to that channel lands in the app thread instead of
// Discord. Nothing here is reachable by anyone but the owner: each request is
// re-authenticated against the ops dashboard with the caller's own session.
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { quickQuestion, isQuick } = require("./conversation");
const { ownerText } = require("./privacy");
const musePolicy = require("./ownermuse-policy");

const APP_CHANNEL = "app";
const isAppJob = (job) => Boolean(job && job.replyChannel === APP_CHANNEL && job.source?.channelId === APP_CHANNEL);
const CLOSED = ["done", "dismissed", "cancelled"];
// Short remarks in the owner's app are questions in disguise ("Railway still
// down"). They belong in the quick lane, which answers now and hands off for the
// deeper pass. Explicit work still routes to the work lane.
const ACTION_WORD = /\b(?:deploy|fix|change|open|close|create|delete|remove|cancel|approve|reject|restart|merge|publish|install|update|set|run|build|implement|investigate|inspect|examine|audit|verify|confirm|trace|scan|search|find|compare|test|diagnose|debug|ship|promote|rollback|heal|grant|refund|ban|mute|write|add|move|rename|kill|stop|start|check|look|review|send|post|reply|file|raise)\b/i;
const WORK_REFERENCE = /\bticket\s*#?\d+|#\d+|\bPR\b|pull request|\bissue\s*#?\d+/i;
function conversationalRemark(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 280 || /\n/.test(t)) return false;
  if (ACTION_WORD.test(t) || WORK_REFERENCE.test(t)) return false;
  return t.split(/\s+/).length <= 12;
}
const MAX_MESSAGES = 400;
// Background work digests are glanceable, not conversation. Keep only the
// newest few so they never push the owner's own exchanges out of the thread.
const MAX_UPDATES = 30;
const MAX_TEXT = 6000;

function threadOf(data) {
  const t = data.appThread ||= { seq: 0, messages: [], status: {}, clients: {} };
  t.status ||= {}; t.clients ||= {}; t.answers ||= {}; t.rev ||= 0;
  return t;
}

// A client opts into answer revisions by asking for the thread with edits=1.
// Older app builds only append by id, so once one has connected we keep posting
// new messages for as long as the flag is set by the newest reader.
function editsEnabled(data) { return threadOf(data).edits === true; }

function append(data, row, now) {
  const t = threadOf(data);
  const message = { seq: ++t.seq, id: row.id || `app-${t.seq}-${crypto.randomBytes(3).toString("hex")}`, at: now, ...row };
  let messages = [...t.messages, message];
  const updates = messages.filter((m) => m.update);
  if (updates.length > MAX_UPDATES) { const drop = new Set(updates.slice(0, -MAX_UPDATES)); messages = messages.filter((m) => !drop.has(m)); }
  t.messages = messages.slice(-MAX_MESSAGES);
  return message;
}

// Keir answers in stages: a quick first answer now, then the same message is
// revised when the investigation lands. `answers` points a conversational turn
// at the one message its answer lives in, so a revision edits that row instead
// of posting a second, near-duplicate reply. Only provisional rows are revised;
// an ordinary follow-up answer stays a new message.
function answerRow(data, jobId) {
  const t = threadOf(data), slot = t.answers[jobId];
  return slot ? t.messages.find((m) => m.id === slot.messageId) || null : null;
}
function claimAnswer(data, jobId, message, now) {
  threadOf(data).answers[jobId] = { messageId: message.id, at: now };
  return message;
}
function revise(data, message, patch, now) {
  const t = threadOf(data);
  const i = t.messages.findIndex((m) => m.id === message.id);
  if (i < 0) return null;
  const current = t.messages[i];
  const clearsProvisional = patch.provisional !== true && current.provisional !== undefined;
  const clearsProgress = patch.progress === undefined && current.progress !== undefined;
  const changed = Object.keys(patch).some((k) => patch[k] !== undefined && current[k] !== patch[k]) || clearsProvisional || clearsProgress;
  // A repeated status line is not news: leave the row and the thread version alone.
  if (!changed) return current;
  const next = { ...current, ...patch, rev: ++t.rev };
  // Only a changed answer is "edited"; a moving progress line is not.
  if (patch.text !== undefined && patch.text !== current.text) next.editedAt = now;
  if (patch.provisional !== true) delete next.provisional;
  if (patch.progress === undefined) delete next.progress;
  // An accepted voice acknowledgment becomes the provisional answer; it is no
  // longer a "got it" progress row. Only clear it when the caller asked.
  if (Object.prototype.hasOwnProperty.call(patch, "voiceProgress") && patch.voiceProgress === undefined) delete next.voiceProgress;
  t.messages = t.messages.map((m, n) => (n === i ? next : m));
  return next;
}

// The status line for a running app job. The answer replaces it.
function setStatus(data, jobId, text, now) {
  threadOf(data).status[jobId] = { text: String(text || "").slice(0, 1900), at: now };
}
function clearStatus(data, jobId) { delete threadOf(data).status[jobId]; }

function createAppChannel({ ledger, config, conversation, decisions = () => null, agent = () => null, readGameStatus = null, drain = () => {}, now = () => Date.now() }) {
  const d = ledger.data;
  const uploads = config.stateDir ? require("./appuploads").createUploads({ ledger, config, now }) : null;
  const controls = require("./appcontrols").createControls({ ledger, config, drain, now });
  const rootOf = job => require("./appcontrols").rootOf(d, job);
  const appJob = job => isAppJob(job) || Boolean(job?.codingParent && isAppJob(rootOf(job)));
  const appThread = job => job.appThread || rootOf(job)?.appThread || "main";
  const record = (row) => conversation?.record({ id: APP_CHANNEL }, { id: row.id, author: row.role === "owner" ? { id: config.ownerId, username: "owner" } : { id: config.botId, bot: true, username: "Keir" },
    content: row.text, timestamp: new Date(row.at).toISOString() });

  function post(text, clientId, threadId = "main", options = {}, authenticated = false) {
    const content = String(text || "").trim();
    if (options.attachments !== undefined && (!Array.isArray(options.attachments) || options.attachments.length > 6)) throw Object.assign(new Error("Choose at most six attachments"), { status: 400 });
    if (musePolicy.hasCredentials(content)) throw Object.assign(new Error("Use a secure credential surface; credentials cannot be saved in app chat."), { status: 400 });
    if (content.length > MAX_TEXT) throw Object.assign(new Error(`Message exceeds ${MAX_TEXT} characters. Shorten it before sending.`), { status: 400 });
    if (!content && !options.attachments?.length) throw Object.assign(new Error("empty message"), { status: 400 });
    const t = threadOf(d);
    const client = clientId ? String(clientId).slice(0, 80) : null;
    const requestDigest = crypto.createHash("sha256").update(JSON.stringify([content, threadId || "main", options.mode || "followup", options.taskId || null, options.voice === true, (options.attachments || []).map(a => [a?.id, a?.sha256])])).digest("hex");
    if (client && t.clients[client]) {
      if (t.clients[client].requestDigest && t.clients[client].requestDigest !== requestDigest) throw Object.assign(new Error("This send id already belongs to a different message"), { status: 409 });
      const prior = t.messages.find((m) => m.id === t.clients[client].messageId);
      return { duplicate: true, message: prior || null, jobId: t.clients[client].jobId };
    }
    const thread = String(threadId || "main");
    if (options.attachments?.length && (!authenticated || !uploads)) throw Object.assign(new Error("Authenticated uploads are unavailable"), { status: 403 });
    let attachments = options.attachments?.length ? uploads.resolve(options.attachments, thread) : [];
    if (attachments.length && content.startsWith("/")) throw Object.assign(new Error("Send attachments as a message rather than a slash command"), { status: 400 });
    if (thread === "watches" || (thread !== "main" && !Object.hasOwn(t.threads || {}, thread))) throw Object.assign(new Error("unknown thread"), { status: 404 });
    if (authenticated && content.startsWith("/")) {
      const result = controls.command(content, thread, title => agent().createThread(title));
      if (result) {
        const message = append(d, { role: "keir", text: result.text, thread }, now());
        if (client) t.clients[client] = { messageId: message.id, jobId: null, requestDigest, at: now() };
        ledger.save(); return { message, command: true, ...result };
      }
    }
    if (d.paused) throw Object.assign(new Error("Keir is stopped. Press Start before sending work."), { status: 409 });
    const mode = options.mode || "followup";
    if (!["followup", "steer", "new"].includes(mode)) throw Object.assign(new Error("invalid message mode"), { status: 400 });
    const target = options.taskId && d.jobs[options.taskId];
    if (mode === "steer" && authenticated && !musePolicy.origin(d, target).valid) throw Object.assign(new Error("This saved task needs a new authenticated app request for writes."), { status: 409 });
    if (mode === "steer" && (!isAppJob(target) || target.appWatch || (target.appThread || "main") !== thread || CLOSED.includes(target.state)))
      throw Object.assign(new Error("the task is no longer available to steer"), { status: 409 });
    const voice = authenticated && options.voice === true;
    const statusRequest = authenticated && readGameStatus && !attachments.length && mode !== "steer" && require("./appstatus").isGameStatusQuery(content);
    const auditRequest = authenticated && /^\/audit(?: preview)?$/i.test(content) && config.runAccountAudit && !attachments.length && mode !== "steer";
    const quick = voice || auditRequest || statusRequest || quickQuestion(content) || conversationalRemark(content);
    const connectionCheck = authenticated && quick && !attachments.length && mode !== "steer" && /^(?:test|ping)[.!?]*$/i.test(content);
    if (voice && mode === "steer") throw Object.assign(new Error("Send a new voice turn rather than steering a task"), { status: 400 });
    const live = voice || mode === "new" || connectionCheck || auditRequest || statusRequest ? null : mode === "steer" ? target : Object.values(d.jobs).find((j) => isAppJob(j) && !j.appWatch && (j.appThread || "main") === thread && (!authenticated || musePolicy.origin(d, j).valid) && Boolean(j.voiceMode) === voice && isQuick(j) === quick && !CLOSED.includes(j.state));
    if ((live?.appAttachments?.length || 0) + attachments.length > 120) throw Object.assign(new Error("Start a separate task to add more files"), { status: 413 });
    attachments = attachments.map((a, i) => ({ ...a, index: (live?.appAttachments?.length || 0) + i }));
    const voiceRoute = voice ? require("./appmodels").voiceRoute(config, d, thread) : null;
    const message = append(d, { role: "owner", text: content, thread, mode, ...(voice ? { voice: true, selectedRoute: voiceRoute } : {}), ...(attachments.length ? { attachments } : {}) }, now());
    record(message);
    const at = new Date(message.at).toISOString();
    const s = { messageId: message.id, channelId: APP_CHANNEL, channelName: "keir-app", authorId: config.ownerId, author: "owner", content, at, attachments, embeds: [] };
    let job;
    if (live) {
      job = live; if (mode === "steer") live.appSteering = true; d.seen[`app:${message.id}`] = live.id; (live.inbox ||= []).push(s); delete live.waitingFor;
      if (["waiting", "blocked"].includes(live.state)) live.state = "queued";
    } else {
      job = ledger.createJob(`app:${message.id}`, { kind: quick ? "conversation" : "command", role: "owner", actorId: config.ownerId, channelId: APP_CHANNEL, replyChannel: APP_CHANNEL,
        appThread: thread, ...(voice ? { voiceMode: true, voiceRoute } : {}), source: s, deadline: now() + config.taskLifetimeMs });
      if (authenticated) musePolicy.attest(ledger, config, job, message, now());
      if (!quick) job.needsAck = true;
    }
    message.jobId = job.id;
    if (attachments.length) {
      (job.appAttachments ||= []).push(...attachments.map(a => ({ ...a, messageId: message.id })));
      uploads.claim(attachments, message.id);
    }
    if (client) t.clients[client] = { messageId: message.id, jobId: job.id, requestDigest, at: now() };
    for (const [k, v] of Object.entries(t.clients)) if (v.at < now() - 7 * 86400000) delete t.clients[k];
    // Acceptance is immediate and independent of provider startup or tool calls.
    // A progress acknowledgment never counts as the substantive answer.
    if (voice && !connectionCheck && !statusRequest && !auditRequest) {
      const acknowledgment = append(d, { role: "keir", text: "Got it.", jobId: job.id, thread, voice: true, voiceProgress: true }, now());
      job.voiceAcknowledgedAt = now();
      job.voiceAcknowledgmentId = acknowledgment.id;
    }
    if (connectionCheck) {
      job.state = "done"; job.summary = "Received. I’m here."; job.provider = { runner: "local", model: "connection-check", lane: "quick" };
      const reply = append(d, { role: "keir", text: job.summary, jobId: job.id, thread, ...(voice ? { voice: true, provider: job.provider } : {}) }, now()); record(reply);
      ledger.audit("app_connection_check", { job: job.id, message: message.id }); ledger.save(); return { message, jobId: job.id };
    }
    if (auditRequest) {
      job.state = "running"; job.provider = { runner: "local", model: "account-audit", lane: "quick" };
      ledger.save();
      Promise.resolve().then(() => config.runAccountAudit({ dryRun: / preview$/i.test(content) })).then(report => {
        job.state = "done"; job.summary = require("./account-audit").reportText(report); job.updatedAt = now();
        deliver(`finish:${job.id}`, { content: job.summary }, job); ledger.save();
      }).catch(error => {
        job.state = "blocked"; job.summary = `Account audit could not complete: ${error.message}`; job.updatedAt = now();
        deliver(`error-reply:${job.id}`, { content: job.summary }, job); ledger.save();
      });
      return { message, jobId: job.id };
    }
    if (statusRequest) {
      job.state = "running"; job.provider = { runner: "local", model: "live-game-status", lane: "quick" };
      ledger.audit("app_game_status", { job: job.id }); ledger.save();
      Promise.resolve().then(() => readGameStatus()).then(text => {
        if (d.paused || job.state !== "running") return;
        job.state = "done"; job.summary = text; job.updatedAt = now();
        deliver(`finish:${job.id}`, { content: text }, job); ledger.save();
      }).catch(() => {
        if (d.paused || job.state !== "running") return;
        job.state = "blocked"; job.summary = "I couldn't read the current game status. Please try again."; job.updatedAt = now();
        deliver(`error-reply:${job.id}`, { content: job.summary }, job); ledger.save();
      });
      return { message, jobId: job.id };
    }
    ledger.audit("app_message", { job: job.id, message: message.id, quick }); ledger.save(); drain();
    return { message, jobId: job.id };
  }

  // Called by the outbox for an entry whose destination job is an app job.
  function deliver(key, entry, job) {
    const text = ownerText(entry.content).replace(/[–—]/g, ",");
    if (key.startsWith("ack:")) { setStatus(d, job.id, text, now()); job.progressMessageId = `app-status-${job.id}`; return [job.progressMessageId]; }
    // A watch speaks only when its condition is met.
    if (job.appWatch && agent() && !agent().onWatchReply(job, text)) { clearStatus(d, job.id); return [`watch-${job.appWatch}-quiet`]; }
    const chart = entry.chart && entry.files?.[0] && /^chart-[a-f0-9]{12}-[a-f0-9]{12}\.png$/.test(path.basename(entry.files[0].path)) ? path.basename(entry.files[0].path) : undefined;
    const cards = agent()?.cardsFor(job) || [];
    const voiceRoot = rootOf(job)?.voiceMode ? rootOf(job) : job.voiceMode ? job : null;
    if (!job.firstReplyAt && /^(channel-reply|finish):/.test(key) && entry.voiceProgress !== true) {
      job.firstReplyAt = now();
      const root = rootOf(job) || job;
      const firstReplyMs = Math.max(0, now() - (root.at || job.at || now()));
      if (job.contextBudget) job.contextBudget.firstReplyMs = firstReplyMs;
      ledger.audit("chat_delivery", { job: job.id, firstReplyMs, queueMs: Math.max(0, now() - (entry.at || now())) });
    }
    const activity = require("./toolactivity").forReply(job);
    const root = rootOf(job) || job;
    const edits = editsEnabled(d);
    const slot = edits && isAppJob(root) && !root.appWatch ? answerRow(d, root.id) : null;
    // A progress line from a running task belongs under the answer it will
    // revise, not in a second bubble. Without an answer yet it opens one, so the
    // owner sees the work start instead of a silent thread.
    if (entry.voiceProgress === true && edits) {
      const line = text.slice(0, 400);
      if (slot) { revise(d, slot, { progress: line }, now()); return [slot.id]; }
      const row = append(d, { role: "keir", text: "", progress: line, provisional: true, ...(voiceRoot ? { voice: true, provider: job.provider || voiceRoot.provider || null } : {}), jobId: root.id, thread: appThread(job) }, now());
      claimAnswer(d, root.id, row, now()); record(row);
      return [row.id];
    }
    // The deeper pass edits the provisional answer in place: same row, same
    // place in the thread, marked as edited.
    if (edits && slot?.provisional && /^(channel-reply|finish|error-reply|chart):/.test(key)) {
      const revised = revise(d, slot, { text, progress: undefined, ...(activity.length ? { activity } : {}), ...(chart ? { chart } : {}), ...(cards.length ? { cards } : {}), ...(job.appComputer ? { computer: { title: job.appComputer.title, file: job.appComputer.file } } : {}) }, now());
      if (revised) {
        record(revised);
        if (/^(channel-reply|finish|error-reply):/.test(key)) { clearStatus(d, job.id); delete job.progressMessageId; }
        ledger.audit("app_answer_revised", { job: job.id, message: revised.id, editedAt: revised.editedAt });
        return [revised.id];
      }
    }
    const message = append(d, { role: "keir", text, ...(activity.length ? { activity } : {}), ...(edits && root.provisionalAnswer && /^(channel-reply|finish|error-reply):/.test(key) ? { provisional: true } : {}), jobId: voiceRoot?.id || job.id, ...(voiceRoot && voiceRoot.id !== job.id ? { taskId: job.id } : {}), ...(job.appComputer ? { computer: { title: job.appComputer.title, file: job.appComputer.file } } : {}), ...(voiceRoot ? { voice: true, provider: job.provider || voiceRoot.provider || null } : {}), thread: appThread(job), ...(job.appWatch ? { watch: job.appWatch } : {}), ...(chart ? { chart } : {}), ...(cards.length ? { cards } : {}) }, now());
    if (message.provisional) { claimAnswer(d, root.id, message, now()); if (root.provisionalAnswer) root.provisionalAnswer = false; }
    record(message);
    if (/^(channel-reply|finish|error-reply):/.test(key)) { clearStatus(d, job.id); delete job.progressMessageId; }
    return [message.id];
  }

  // A quick turn hands its best answer to a deeper pass. That answer becomes the
  // provisional message the worker revises; without one, Keir opens the slot with
  // an honest line so the owner never waits on a silent thread.
  function handoffAnswer(job, answer, worker = null) {
    const root = rootOf(job) || job;
    if (!isAppJob(root) || root.appWatch || !editsEnabled(d)) return null;
    const text = String(answer || "").trim();
    const t = threadOf(d);
    const source = t.messages.find((m) => m.id === root.source?.messageId);
    // The answer already posted for *this* turn (not an earlier follow-up on the
    // same conversation job) becomes the provisional row the worker revises.
    // A voice acknowledgment already posted for this turn ("Got it.") is
    // reused as the provisional answer instead of opening a second bubble.
    const posted = [...t.messages].reverse().find((m) => m.role === "keir" && m.jobId === root.id && (!source || m.seq > source.seq));
    const slot = answerRow(d, root.id);
    if (posted && !slot) { claimAnswer(d, root.id, posted, now()); revise(d, posted, { provisional: true, progress: undefined, voiceProgress: undefined, ...(worker?.id && worker.id !== root.id ? { taskId: worker.id } : {}), ...(text ? { text } : {}) }, now()); return posted.id; }
    if (slot && text) { revise(d, slot, { text, provisional: true, progress: undefined }, now()); return slot.id; }
    if (slot) { if (slot.provisional) revise(d, slot, { provisional: true }, now()); return slot.id; }
    const row = append(d, { role: "keir", text: text || "I'm checking this now. I'll update this same message with the answer.", provisional: true, ...(root.voiceMode ? { voice: true, provider: root.provider || null } : {}), jobId: root.id, ...(worker?.id && worker.id !== root.id ? { taskId: worker.id } : {}), thread: appThread(job) }, now());
    claimAnswer(d, root.id, row, now()); record(row);
    ledger.audit("app_provisional_answer", { job: job.id, root: root.id, message: row.id, answeredNow: Boolean(text) });
    return row.id;
  }

  function updateStatus(job, text) {
    const line = ownerText(text);
    setStatus(d, job.id, line, now());
    // The owner reads the chat, not the task row: keep the line on the answer
    // bubble while the work is running.
    const root = rootOf(job) || job;
    const slot = isAppJob(root) && !root.appWatch ? answerRow(d, root.id) : null;
    if (slot) revise(d, slot, { progress: line.slice(0, 400) }, now());
  }

  function view(after = 0, thread = null, editsRequested = false) {
    const t = threadOf(d);
    // Callers that render revisions ask for them; everyone else keeps the
    // append-only behaviour of an older app build.
    if (editsRequested) t.edits = true;
    for (const id of Object.keys(t.status)) if (!d.jobs[id] || CLOSED.includes(d.jobs[id].state)) delete t.status[id];
    // Keep a provisional answer's slot until it is revised, even though the quick
    // turn that opened it is already closed; drop the rest with their jobs.
    for (const [id] of Object.entries(t.answers)) {
      const row = t.messages.find((m) => m.id === t.answers[id].messageId);
      if (!row || (!row.provisional && (!d.jobs[id] || CLOSED.includes(d.jobs[id].state)))) delete t.answers[id];
    }
    const jobs = Object.values(d.jobs).filter((j) => appJob(j) && !CLOSED.includes(j.state));
    const inThread = (x) => !thread || (x || "main") === thread;
    const tasks = jobs.filter((j) => inThread(appThread(j))).map((j) => ({ id: j.id, kind: j.kind, state: j.state, status: t.status[j.id]?.text || null, at: j.at, thread: appThread(j), title: String(j.codingParent ? `${j.investigation ? "Investigation" : "Coding"}: ${d.jobs[j.codingParent]?.source?.content || "Delegated work"}` : j.source?.content || "Task").slice(0, 100), overrides: j.appOverrides || {}, provider: j.provider ? { ...j.provider, effort: j.effort?.effort || j.provider.effort || null } : null, skills: j.activeSkills || [], live: require("./toolactivity").pending(j), contextBudget: j.contextBudget || null, model: j.provider?.model || null, modelRoute: j.provider?.route || "auto", steering: Boolean(j.appSteering), computer: j.appComputer || null, blocker: j.ownerMuseBlocker || null, approvals: pendingDecisions().filter(x => x.jobId === j.id) }));
    // The working-now board covers all of Keir's work, not only app tasks. It is
    // computed on the update tick; only its content, not its clock, changes the version.
    const b = t.updates?.board || null;
    const team = b ? { open: b.open, working: b.working, needsYou: b.needsYou, stuck: b.stuck, waiting: b.waiting, held: b.held, items: b.items } : null;
    const version = crypto.createHash("sha256").update(JSON.stringify([t.seq, t.rev, t.questions, tasks, jobs.map((j) => [j.id, j.state, j.updatedAt]), t.modelSelections, t.preferences, d.paused, pendingDecisions(), team])).digest("hex").slice(0, 16);
    const queued = (thread ? jobs.filter((j) => inThread(appThread(j))) : jobs).reduce((n, j) => n + (j.state === "running" ? (j.inbox || []).length : 0), 0);
    // A revised message keeps its seq so it stays in place. Its new text rides in
    // `revised`, and `rev` in the version hash wakes the long poll.
    const revised = after && t.edits ? t.messages.filter((m) => m.rev && m.seq <= after && inThread(m.thread)).sort((a, b) => a.rev - b.rev).slice(-8) : [];
    return { activity: require("./appcontrols").activityState(d, now()), controls: controls.view(thread || "main"), cursor: t.seq, version, team, modelSelection: t.modelSelections?.[thread || "main"] || "auto", questions: Object.values(t.questions || {}).filter((q) => inThread(q.thread) && q.state === "pending" && d.jobs[q.jobId] && !CLOSED.includes(d.jobs[q.jobId].state)), messages: t.messages.filter((m) => m.seq > after && inThread(m.thread)), revised, tasks, queued, backgroundTasks: jobs.filter((j) => !inThread(appThread(j))).map((j) => ({ id: j.id, thread: appThread(j), title: String(j.codingParent ? `${j.investigation ? "Investigation" : "Coding"}: ${d.jobs[j.codingParent]?.source?.content || "Delegated work"}` : j.source?.content || "Task").slice(0, 100), state: j.state })), working: tasks.some((x) => x.state === "running") };
  }

  function modelOptions(thread = "main") {
    return { models: require("./appmodels").models(config), selection: threadOf(d).modelSelections?.[thread] || "auto" };
  }
  function selectModel(thread, selection) {
    const t = threadOf(d);
    if (thread === "watches" || (thread !== "main" && !Object.hasOwn(t.threads || {}, thread))) throw Object.assign(new Error("unknown thread"), { status: 404 });
    require("./appmodels").resolveModel(config, selection);
    (t.modelSelections ||= {})[thread] = selection;
    ledger.audit("app_model_selected", { thread, selection }); ledger.save();
    return modelOptions(thread);
  }

  function cancel(jobId) {
    const job = d.jobs[String(jobId || "")];
    if (!appJob(job)) throw Object.assign(new Error("unknown task"), { status: 404 });
    if (CLOSED.includes(job.state)) return { state: job.state };
    for (const candidate of Object.values(d.jobs)) {
      let current = candidate; const seen = new Set();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        if (current.id === job.id) {
          if (!CLOSED.includes(candidate.state)) { candidate.state = "cancelled"; candidate.summary = "Stopped from the app."; clearStatus(d, candidate.id); }
          break;
        }
        current = d.jobs[current.codingParent || current.museParent];
      }
    }
    ledger.audit("app_cancel", { job: job.id }); ledger.save(); drain();
    return { state: job.state };
  }

  // Recent thread rows for the model's source_history tool.
  function history(limit = 20, thread = null) {
    // Work digests are not part of the conversation a model reads.
    return threadOf(d).messages.filter((m) => !m.update && (!thread || (m.thread || "main") === thread)).slice(-limit).map((m) => ({ id: m.id, author: m.role === "owner" ? "owner" : "Keir", authorId: m.role === "owner" ? config.ownerId : config.botId, bot: m.role !== "owner", content: m.text, attachments: (m.attachments || []).map(a => ({ ...a, index: d.jobs[m.jobId]?.appAttachments?.findIndex(x => x.id === a.id && x.messageId === m.id) })), at: new Date(m.at).toISOString() }));
  }

  // Keir's open questions for the owner, answerable from the app. The answer
  // goes through the same path as the Discord buttons.
  function pendingDecisions() {
    return Object.values(d.decisions || {}).filter((x) => x.state === "pending" && (!musePolicy.origin(d, d.jobs[x.jobId]).scoped || musePolicy.origin(d, d.jobs[x.jobId]).valid)).sort((a, b) => b.at - a.at)
      .map((x) => require("./appdecision").decisionView(d, x, now()));
  }
  async function answer(id, verdict, text, authenticated = false) {
    const x = d.decisions?.[String(id || "")];
    if (!x) throw Object.assign(new Error("unknown decision"), { status: 404 });
    if (x.state !== "pending") throw Object.assign(new Error(`already ${x.state}`), { status: 409 });
    if (verdict === "refresh") {
      const job = d.jobs[x.jobId], origin = musePolicy.origin(d, job), action = d.actions[x.actionId];
      if (!authenticated) throw Object.assign(new Error("Authenticated owner refresh required"), { status: 403 });
      if (!job || CLOSED.includes(job.state) || d.paused || job.appPaused || origin.scoped && !origin.valid) throw Object.assign(new Error("Start a fresh authenticated conversation to replace this saved proposal."), { status: 409 });
      if (Object.values(job.effects || {}).some(e => ["started", "executing"].includes(e.state)) || Object.values(d.actions).some(a => a.jobId === job.id && a.state === "executing")) throw Object.assign(new Error("Inspect the earlier action outcome before requesting another proposal."), { status: 409 });
      for (const entry of Object.values(d.outbox || {})) if (entry.decision === x.id && !entry.deliveredAt) { entry.deliveredAt = now(); entry.skipped = "owner refreshed proposal"; }
      x.state = "superseded"; x.answeredVia = "app-refresh"; x.answeredBy = config.ownerId; x.answeredAt = now();
      if (action && ["pending", "approved"].includes(action.state)) action.state = "superseded";
      (job.inbox ||= []).push({ role: "owner", authorId: config.ownerId, at: new Date(now()).toISOString(), content: "The owner requested a fresh review of decision " + x.id + ". Re-read current targets and present a new exact proposal if needed. This request is not approval; do not repeat verified or uncertain actions." });
      delete job.ownerDecisionPending;
      if (job.ownerMuseBlocker) musePolicy.clearBlocker(ledger, job, job.ownerMuseBlocker.capability);
      job.state = "queued"; job.wakeAt = 0; job.deadline = now() + config.taskLifetimeMs;
      ledger.audit("app_decision_refresh", { decision: x.id, job: job.id, actor: config.ownerId }); ledger.save(); drain();
      return { ...require("./appdecision").decisionView(d, x, now()), taskState: job.state };
    }
    if (!["approve", "reject", "explain"].includes(verdict) && !(x.options && /^choose:[1-6]$/.test(verdict))) throw Object.assign(new Error("verdict must be approve, reject or explain"), { status: 400 });
    if (verdict === "explain" && !String(text || "").trim()) throw Object.assign(new Error("say what to explain"), { status: 400 });
    const api = decisions();
    if (!api) throw Object.assign(new Error("decisions unavailable"), { status: 503 });
    try { await (authenticated ? api.applyAuthenticatedApp : api.apply)(x, verdict, config.ownerId, String(text || "").trim().slice(0, 2000)); }
    catch (error) { if (musePolicy.origin(d, d.jobs[x.jobId]).scoped) error.status ||= 409; throw error; }
    x.answeredVia = "app"; ledger.save();
    drain();
    return { ...require("./appdecision").decisionView(d, x, now()), taskState: d.jobs[x.jobId]?.state || null };
  }
  // Recent owner alerts (the quiet ledger feed that replaced alert DMs).
  function alerts(limit = 50) {
    // Only alerts the owner can read and act on. Watchkeeper's own sensor
    // timeouts and undescribed incidents used to fill this feed with
    // "Monitoring event. Diagnostic details are recorded in Ops."
    const describe = (a) => alertKind(a.key) === "incident" ? require("./notification-policy").describeAlert(a, d, now()).text || "" : a.content;
    return (d.alerts || []).filter((a) => !/^recovery:watchkeeper:/.test(String(a.key)) && describe(a)).slice(-limit).reverse().map((a) => ({ key: a.key, kind: alertKind(a.key), text: ownerText(describe(a)).slice(0, 2000), at: a.at }));
  }
  function register(token, fields = {}) {
    const t = threadOf(d);
    const value = String(token || "");
    if (!/^[a-f0-9]{64,200}$/i.test(value)) throw Object.assign(new Error("invalid device token"), { status: 400 });
    const prefs = { feed: fields.feed !== false, replies: fields.replies !== false, decisions: fields.decisions !== false, incidents: fields.incidents !== false };
    t.devices = [...(t.devices || []).filter((x) => x.token !== value), { token: value, prefs, at: now() }].slice(-5);
    ledger.audit("app_device", { devices: t.devices.length }); ledger.save();
    return { registered: true, prefs };
  }
  function removeActivity(activityId) {
    const t = threadOf(d); t.activities = (t.activities || []).filter(a => a.id !== activityId); ledger.save(); return { removed: true };
  }
  function registerActivity(token, activityId) {
    if (!/^[a-f0-9]{64,200}$/i.test(String(token || "")) || !/^[a-zA-Z0-9-]{1,100}$/.test(String(activityId || ""))) throw Object.assign(new Error("Invalid activity registration"), { status: 400 });
    const t = threadOf(d);
    t.activities = [...(t.activities || []).filter(a => a.id !== activityId && a.token !== token && a.expiresAt > now()), { id: activityId, token, expiresAt: now() + 8 * 3600000 }].slice(-8);
    ledger.save(); return { registered: true };
  }
  return { uploads, removeActivity, registerActivity, controls, answerEdits: () => editsEnabled(d), authenticatedPost: (text, clientId, threadId, options) => post(text, clientId, threadId, options, true), authenticatedAnswer: (id, verdict, text) => answer(id, verdict, text, true), modelOptions, selectModel, post, deliver, handoffAnswer, updateStatus, view, cancel, history, pendingDecisions, answer, alerts, register };
}

function alertKind(key) {
  if (/^(?:error:watch|recovery:watchkeeper)/.test(key)) return "incident";
  if (/^decision:/.test(key)) return "decision";
  if (/^digest:/.test(key)) return "digest";
  return "operator";
}

// Owner identity on the ops dashboard is the Discord-SSO email form.
function ownerIdentity(config) { return config.appOwnerIdentity || `discord_${config.ownerId}@discord.local`; }

function createAuthenticator({ config, checkUrl, fetchImpl = fetch, now = () => Date.now() }) {
  const cache = new Map();
  return async function authenticate(req) {
    const cookie = String(req.headers.cookie || "");
    if (!/(?:^|;\s*)ops_session=[^;]{16,}/.test(cookie)) return false;
    const token = /(?:^|;\s*)ops_session=([^;]+)/.exec(cookie)[1];
    const key = crypto.createHash("sha256").update(token).digest("hex");
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.ok;
    // "owner" passes; "staff" is a valid admin session that is not the owner's
    // (refused without signing them out); false is no valid session.
    let ok = false;
    try {
      const r = await fetchImpl(checkUrl, { headers: { cookie: `ops_session=${token}` }, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (r.status >= 500) throw Object.assign(new Error("sign-in check is temporarily unavailable"), { status: 503 });
      if (r.status === 200 && r.headers.get("x-auth-role") === "admin") ok = r.headers.get("x-auth-user") === ownerIdentity(config) ? "owner" : "staff";
    } catch { throw Object.assign(new Error("sign-in check is temporarily unavailable"), { status: 503 }); }
    cache.set(key, { ok, until: now() + (ok ? 60000 : 10000) });
    if (cache.size > 64) for (const k of [...cache.keys()].slice(0, cache.size - 64)) cache.delete(k);
    return ok;
  };
}

function createAppServer({ app, authenticate, artifactsDir, agentRoutes = null, log = () => {}, pollMs = 1000, speech = require("./appvoice").createSpeech(), sessionExchangeUrl = null, fetchImpl = fetch }) {
  const PREFIX = "/api/keir/app";
  return http.createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, "http://app.local");
      if (!url.pathname.startsWith(PREFIX)) return reply(404, { error: "not found" });
      const route = url.pathname.slice(PREFIX.length) || "/";
      if (route === "/health" && req.method === "GET") return reply(200, { ok: true });
      const who = await authenticate(req);
      if (who === "staff") return reply(403, { error: "Keir's app channel is for the owner only." });
      if (who !== "owner") return reply(401, { error: "unauthorized" });
      if (route === "/desktop/token" && req.method === "GET") {
        const token = /(?:^|;\s*)ops_session=([A-Za-z0-9_-]{16,256})(?:;|$)/.exec(String(req.headers.cookie || ""))?.[1];
        if (!token) return reply(400, { error: "Owner session token unavailable" });
        // Exchange the one-day browser session for a 30-day device session, as the
        // iOS app does, so the terminal does not need a fresh file every day.
        let issued = token, expiresAt = null;
        if (sessionExchangeUrl) {
          try {
            const r = await fetchImpl(sessionExchangeUrl, { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
              headers: { cookie: `ops_session=${token}`, origin: `https://${String(req.headers.host || "")}`, "x-lakeside-client": "desktop" } });
            const body = r.ok ? await r.json() : null;
            if (body && /^[A-Za-z0-9_-]{16,256}$/.test(String(body.token || ""))) { issued = body.token; expiresAt = Number(body.expiresAt) || null; }
          } catch { /* fall back to the browser session below */ }
        }
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="keir-vps.token"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
          "X-Session-Expires": expiresAt ? new Date(expiresAt).toISOString() : "browser-session" });
        return res.end(issued + "\n");
      }
      if (["POST", "DELETE"].includes(req.method)) {
        if (!(route === "/uploads" && req.method === "POST") && req.method === "POST" && String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") return reply(415, { error: "JSON required" });
        // Native clients omit Origin. Browser writes must originate on this host.
        if (req.headers.origin) {
          const host = String(req.headers.host || "");
          let valid = false;
          try {
            const target = new URL(`https://${host}`), local = ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
            valid = req.headers.origin === target.origin || local && req.headers.origin === new URL(`http://${host}`).origin;
          } catch {}
          if (!valid) return reply(403, { error: "Unexpected origin" });
        }
      }
      if (route === "/uploads" && req.method === "POST") {
        if (!app.uploads) return reply(503, { error: "Uploads unavailable" });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > require("./appuploads").MAX_FILE) return reply(413, { error: "Files must be at most 10 MB" }); chunks.push(chunk); }
        let filename; try { filename = decodeURIComponent(String(req.headers["x-filename"] || "Attachment")); } catch { return reply(400, { error: "Invalid filename" }); }
        return reply(201, await app.uploads.put(Buffer.concat(chunks), filename, req.headers["content-type"], String(req.headers["x-keir-thread"] || "main")));
      }
      const upload = /^\/uploads\/([a-f0-9]{32})$/.exec(route);
      if (upload && app.uploads && req.method === "GET") {
        const { item, bytes } = app.uploads.lookup(upload[1]);
        res.writeHead(200, { "Content-Type": item.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(item.name) }); return res.end(bytes);
      }
      if (upload && app.uploads && req.method === "DELETE") return reply(200, app.uploads.remove(upload[1]));
      if (route === "/voice" && req.method === "GET") return reply(200, speech.status());
      if (route === "/voice/speech" && req.method === "POST") {
        let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 32000) return reply(413, { error: "too large" }); }
        let input; try { input = JSON.parse(body); } catch { return reply(400, { error: "invalid json" }); }
        if (app.controls.view().stopped) return reply(409, { error: "Keir is stopped. Press Start before using voice." });
        const controller = new AbortController(); res.once("close", () => controller.abort());
        const audio = await speech.synthesize(input.text, controller.signal);
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" }); return res.end(audio);
      }
      if (route === "/thread" && req.method === "GET") {
        const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
        const wait = Math.min(25, Math.max(0, Number(url.searchParams.get("wait")) || 0)) * 1000;
        const started = Date.now();
        const since = url.searchParams.get("since");
        const thread = url.searchParams.get("thread") || null;
        let view = app.view(after, thread, url.searchParams.get("edits") === "1");
        // Long poll: answer as soon as the thread or a task changes from the caller's version.
        while (wait && since && view.version === since && Date.now() - started < wait) {
          if (req.destroyed) return;
          await new Promise((r) => setTimeout(r, pollMs));
          view = app.view(after, thread, true);
        }
        return reply(200, view);
      }
      if (route === "/controls" && req.method === "GET") return reply(200, app.controls.view(url.searchParams.get("thread") || "main"));
      if (route === "/models" && req.method === "GET") return reply(200, app.modelOptions(url.searchParams.get("thread") || "main"));
      if (route === "/decisions" && req.method === "GET") return reply(200, { decisions: app.pendingDecisions() });
      if (route === "/alerts" && req.method === "GET") return reply(200, { alerts: app.alerts() });
      const decision = /^\/decisions\/([a-f0-9]{12})$/.exec(route);
      if ((route === "/activities" || route === "/controls" || route === "/messages" || route === "/models" || route === "/cancel" || route === "/devices" || decision) && req.method === "POST") {
        let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 32000) return reply(413, { error: "too large" }); }
        let b; try { b = JSON.parse(body || "{}"); } catch { return reply(400, { error: "invalid json" }); }
        if (route === "/activities") return reply(200, (b.remove ? app.removeActivity(b.activityId) : app.registerActivity(b.token, b.activityId)));
        if (route === "/controls") return reply(200, app.controls.update(b));
        if (route === "/models") return reply(200, app.selectModel(b.thread || "main", b.selection));
        if (route === "/cancel") return reply(200, app.cancel(b.taskId));
        if (route === "/devices") return reply(200, app.register(b.token, b.prefs || {}));
        if (decision) return reply(200, await app.authenticatedAnswer(decision[1], b.verdict, b.text));
        const r = app.authenticatedPost(b.text, b.clientId, b.thread, { mode: b.mode, taskId: b.taskId, voice: b.voice, attachments: b.attachments });
        return reply(r.duplicate ? 200 : 201, r);
      }
      if (agentRoutes) {
        let b = {};
        if (req.method === "POST") { let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 32000) return reply(413, { error: "too large" }); } try { b = JSON.parse(body || "{}"); } catch { return reply(400, { error: "invalid json" }); } }
        const out = await agentRoutes(route, req.method, b, url.searchParams);
        if (out !== undefined) return reply(200, out);
      }
      const art = /^\/artifacts\/((?:chart|computer)-[a-f0-9]{12}-[a-f0-9]{12}\.png)$/.exec(route);
      if (art && req.method === "GET") {
        const file = path.join(artifactsDir, art[1]);
        if (!fs.existsSync(file)) return reply(404, { error: "not found" });
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" }); return res.end(fs.readFileSync(file));
      }
      return reply(404, { error: "not found" });
    } catch (e) {
      if (e.status) return reply(e.status, { error: e.message });
      log(`app: ${e.message}`); return reply(500, { error: "server error" });
    }
  });
}

module.exports = { APP_CHANNEL, alertKind, threadOf, appendMessage: append, isAppJob, createAppChannel, createAuthenticator, createAppServer, ownerIdentity };
