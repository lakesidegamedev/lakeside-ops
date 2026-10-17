"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { createObserver } = require("./lib/inbox/observer");
const { createLedger } = require("./lib/operator/store");
const { createGateway, catchUp, ticketNumber, snowflake } = require("./lib/operator/gateway");
const { ticketCategory } = require("./lib/operator/ticketCategory");
const { ticketClaim } = require("./lib/operator/ticketClaim");
const { createBroker, createMcp } = require("./lib/operator/broker");
const { createSandbox } = require("./lib/operator/sandbox");
const { createPresence } = require("./lib/operator/presence");
const { createDiscord, createScanHealth } = require("./lib/operator/discord");
const { createConversation, isQuick } = require("./lib/operator/conversation");
const { recoverRejectedWrites, retryReadFailure } = require("./lib/operator/recovery");
const { LANES, emptyLanes, pickForLanes, laneTimeoutMs, laneClass } = require("./lib/operator/lanes");
const { createSupportOwner } = require("./lib/operator/supportowner");
const { createReopenedTickets } = require("./lib/operator/reopened");
const { createEffectShadow } = require("./lib/operator/effectshadow");
const { createEngineering } = require("./lib/operator/engineering");
const { createRoles, scopedToken } = require("./lib/operator/roles");
const { shadowReport } = require("./lib/operator/shadow3");
const { createAgent } = require("./lib/operator/agent");
const { createClassifier, screenReport } = require("./lib/operator/classify");
const { readAgentToken } = require("./lib/operator/token");
const { redactSecrets, chunkMessage, parseCommandFooter } = require("./lib/text");
const { ownerText } = require("./lib/operator/privacy");
const { integrityReport, v3Stale, rootJob } = require("./lib/operator/workrecord");
const { hold: admissionHold } = require("./lib/operator/admission");
const { openSink, attachSink, taskIdOf } = require("./lib/operator/events");
const { createAppChannel, createAuthenticator, createAppServer, isAppJob } = require("./lib/operator/appchannel");
const { createAppAgent } = require("./lib/operator/appagent");
const { createAppMuse } = require("./lib/operator/appmuse");
const { createApns, createAppPush } = require("./lib/operator/apppush");

const env = process.env;
const positive = (name, fallback) => { const n = Number(env[name] || fallback); if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${name}`); return n; };
const config = {
  stateDir: env.KEIR_OPERATOR_STATE_DIR || "/var/lib/keir-operator",
  ownerId: env.KEIR_OWNER_ID || "333052320252297216", botId: env.KEIR_BOT_ID || "1479984768194969663",
  ownerMuseDelegateId: env.KEIR_MUSE_DELEGATE_ID || null,
  guildId: env.KEIR_GUILD_ID || "1465445442987888743", staffIds: (env.KEIR_SUPPORT_DELEGATES || "565289871799746593").split(",").filter(Boolean),
  scanChannels: (env.KEIR_SCAN_CHANNELS || "1470636730884427857,1483974659929145625,1495932687058206822,1488255716753019171,1488255794628788244,1523477015217443028,1474210643841122499,1490571412040188117").split(",").filter(Boolean),
  taskLifetimeMs: positive("KEIR_TASK_LIFETIME_HOURS", 168) * 3600000, closeGraceMs: positive("KEIR_CLOSE_GRACE_MINUTES", 60) * 60000,
  maxIntakePerHour: positive("KEIR_MAX_INTAKE_PER_HOUR", 4), maxRounds: positive("KEIR_MAX_TOOL_ROUNDS", 24),
  maxTurnMs: positive("KEIR_MAX_TURN_MINUTES", 15) * 60000, dailyBudget: positive("KEIR_DAILY_BUDGET_USD", 20),
  model: env.KEIR_MODEL || "claude-opus-5-5",
  // Model split (2026-10-12 trial): quick lane = conversation, worker lanes = coding and deep answers.
  computerUrl: env.KEIR_COMPUTER_URL || (env.WORKER_TOKEN ? "http://127.0.0.1:9770" : undefined), computerToken: env.KEIR_COMPUTER_TOKEN || env.WORKER_TOKEN,
  voiceProvider: env.KEIR_VOICE_PROVIDER || "agy:gemini-3.8-flash@low",
  quickProvider: env.KEIR_QUICK_PROVIDER || "claude", workerProvider: env.KEIR_WORKER_PROVIDER || "claude",
  rolesEnabled: env.KEIR_ROLES_ENABLED === "1", engineeringEnabled: env.KEIR_ENGINEERING === "1", engineeringScoutEnabled: env.KEIR_ENGINEERING_SCOUT === "1",
  engineeringProvider: env.KEIR_ENGINEERING_PROVIDER || "codex:gpt-6.1-sol@low",
  watchkeeperProvider: env.KEIR_WATCHKEEPER_PROVIDER || "codex:gpt-6.1-sol@low",
  watchkeeperKanbanId: Number(env.KEIR_WATCHKEEPER_KANBAN_ID || 0), engineeringKanbanId: Number(env.KEIR_ENGINEERING_KANBAN_ID || 0),
  // Keir 4.0 phase 4: lanes whose activations the Rust runner executes (quick, worker, probe).
  rustRunnerLanes: String(env.KEIR_RUST_RUNNER_LANES || "").split(",").map((s) => s.trim()).filter(Boolean), rustRunnerBin: env.KEIR_RUST_RUNNER_BIN || "/usr/local/bin/lakeside-agent",
  // Phase 5 ticket canary: with the worker lane on, only these tickets' worker activations go to Rust (empty = every ticket).
  rustRunnerTickets: String(env.KEIR_RUST_RUNNER_TICKETS || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0),
  codingProvider: env.KEIR_CODING_PROVIDER || "codex:gpt-6.1-sol@medium",
  // Incident proposals go to the staff channel that moderators and
  // developers both see (#mod-bot), pinging Server Moderator, Head
  // Moderator and Developer; any of them, or an admin, may approve.
  incidentChannel: env.KEIR_INCIDENT_CHANNEL || "1509900979410305155",
  incidentPingRoles: (env.KEIR_INCIDENT_PING_ROLES || "1483975767703552111,1509177704329511103,1470571508689535188").split(",").filter(Boolean),
  incidentApproverRoles: (env.KEIR_INCIDENT_APPROVER_ROLES || "1483975767703552111,1509177704329511103,1470571508689535188,1465491487440502804").split(",").filter(Boolean),
  investigatorProvider: env.KEIR_INVESTIGATOR_PROVIDER || env.KEIR_CODING_PROVIDER || "codex:gpt-6.1-sol@medium",
  // Vision lane (owner, 2026-10-14: "use spark standard"). Any task whose
  // screenshot matters runs here; the standard tier does not train on data.
  visionProvider: env.KEIR_VISION_PROVIDER || "claude:claude-sonnet-5-5@medium",
  agyModel: env.KEIR_AGY_MODEL || "gemini-3.8-flash", museModel: env.KEIR_MUSE_MODEL || "muse-wonder-1.0",
  // Jev picks each activation's effort (low to xhigh); KEIR_DYNAMIC_EFFORT=0 pins medium.
  dynamicEffort: env.KEIR_DYNAMIC_EFFORT !== "0",
  skills: env.KEIR_SKILLS !== "0",
  knowledgeCorrections: env.KEIR_KNOWLEDGE_CORRECT === "1",
  knowledgePreparation: env.KEIR_KNOWLEDGE_PREPARE === "1" ? { server: env.KEIR_KNOWLEDGE_SERVER || "ops-knowledge", project: env.KEIR_KNOWLEDGE_PROJECT, timeoutMs: positive("KEIR_KNOWLEDGE_TIMEOUT_MS", 5000) } : undefined,
  briefFile: path.join(__dirname, "KEIR.md"), repositories: { AHDGame: "/root/projects/AHDGame", "lakeside-operator": env.KEIR_SOURCE_REPO || "/root/projects/lakeside-ops", AHDClient: "/root/projects/AHDClient" },
  // Every public guild text channel or thread is watched for reports, except
  // ticket channels (their own tasks handle them) and explicit exclusions.
  scanExclude: (env.KEIR_SCAN_EXCLUDE || "").split(",").filter(Boolean),
  watched(channel) {
    return Boolean(channel?.id) && [0, 5, 11, 12].includes(channel.type ?? 0) && !/^ticket-/.test(channel.name || "") && !this.scanExclude.includes(channel.id);
  },
  supportDeferred() {
    try {
      const p = JSON.parse(fs.readFileSync("/root/projects/ticket-supervisor/config/policy.json", "utf8"));
      const l = JSON.parse(fs.readFileSync("/var/lib/ticket-supervisor/ledger.json", "utf8"));
      return p.mode === "shift" ? Boolean(l.shift && Date.parse(l.shift.until) > Date.now()) : ["full", "limited", "shadow"].includes(p.mode);
    } catch (e) { if (e.code === "ENOENT") return false; return true; }
  },
};
if (!env.DISCORD_BOT_TOKEN || !env.KEIR_OPERATOR_ADMIN_TOKEN) throw new Error("operator credentials are incomplete");
if (![config.ownerId, config.botId, config.guildId, ...config.staffIds, ...config.scanChannels].every(snowflake)) throw new Error("invalid Discord identity configuration");
const ledger = createLedger(path.join(config.stateDir, "ledger.json"));
const diary = require("./lib/operator/diary").createDiary({ stateDir: config.stateDir, ledger });
// Keir 5.1 routing lock: lanes never run a model that measurably failed them.
for (const c of require("./lib/operator/routing").enforce(config, { allowBlocked: env.KEIR_ALLOW_BLOCKED_ROUTES === "1" })) {
  console.log(`[keir] routing lock: ${c.lane} ${c.from} -> ${c.to} (${c.reason})`);
  ledger.notify(`error:routing-lock:${c.lane}:${c.from}`, "owner", `Keir ${c.lane} lane was set to ${c.from}; it runs ${c.to} instead (${c.reason}). KEIR_ALLOW_BLOCKED_ROUTES=1 lifts the lock for a trial.`);
}
// Keir 4.0 phase 1: the durable evidence trail beside the ledger. Every audit
// entry and delivery lands in events.db with task, attempt and ticket identity
// and the operator release that produced it.
const releaseId = (() => { try { return fs.readFileSync(path.join(__dirname, "RELEASE"), "utf8").trim().split(/\s+/)[0]; } catch { return null; } })();
const events = openSink(path.join(config.stateDir, "events.db"), { release: releaseId });
attachSink(ledger, events);
recoverRejectedWrites(ledger);
// Keir 3.0: support ownership is an explicit ledger fact. Work defers to the
// legacy supervisor policy as before, and also to any other operator that
// owns support, except tickets that operator has handed off.
const supportOwner = createSupportOwner({ ledger });
const legacyDeferred = config.supportDeferred.bind(config);
config.supportDeferred = (job) => ["watchkeeper", "engineering"].includes(job?.operatorRole) || job?.kind === "finding" || ledger.data.jobs[job?.codingParent]?.kind === "finding" ? false : legacyDeferred() || supportOwner.deferred(job);
const effectShadow = createEffectShadow({ ledger, config });
const bootTime = Date.now();
const log = (s) => console.log(new Date().toISOString(), redactSecrets(s));
const selfRecovery = require("./lib/operator/selfrecovery").createRecovery({ ledger, config, log });
// Keir 3.0 observability wiring (read-only): report how the v1 ledger maps
// onto canonical work records at startup. This changes no behavior; the
// coordinator becomes the intake owner only at the canary step.
try { log(`v3 work records: ${JSON.stringify({ ...integrityReport(ledger.data), staleV3Snapshot: v3Stale(ledger.data) })}`); }
catch (e) { log(`v3 work records unavailable: ${e.message}`); }
const observe = createObserver({ token: env.KEIR_INBOX_ADMIN_TOKEN, log });
const discord = createDiscord({ token: env.DISCORD_BOT_TOKEN, onMessages: observe });
const mcp = createMcp(env.KEIR_MCP_CONFIG || "/root/.claude.json", readAgentToken(env.KEIR_AGENT_ENV_FILE || "/etc/keir-agent.env"));
const reopenedTickets = createReopenedTickets({ ledger, config, supportOwner, readTicket: (number) => mcp.call("support", "support_get", { kind: "ticket", number }, false), readChannel: async (id) => { try { return await discord("GET", `/channels/${id}`); } catch (e) { if (e.status === 404) return null; throw e; } } });
const sandbox = createSandbox(path.join(config.stateDir, "workspaces"));
const conversation = createConversation({ ledger, config });
const appComputer = require("./lib/operator/appcomputer").createAppComputer({ ledger, config, sandbox });
// The owner's private Keir app: one more owner channel, delivered to its own thread.
const appChannel = createAppChannel({ ledger, config, conversation, readGameStatus: () => require("./lib/operator/appstatus").readGameStatus(mcp), decisions: () => decisions, agent: () => appAgent, drain: () => drain() });
const appQuestions = require("./lib/operator/appquestions").createAppQuestions({ ledger, app: appChannel, config });
// Keir 2.0: a lasting notebook.
const knowledgeLayer = require("./lib/operator/knowledge");
const notebook = knowledgeLayer.createNotebook({ file: path.join(config.stateDir, "notebook.json") });
// Keir 2.1 owner app (Muse parity): goals, feed, brief, approvals, upcoming, files.
const appMuse = createAppMuse({ ledger, config, app: appChannel, drain: () => drain() });
const broker = createBroker({ ledger, config, mcp, discord, sandbox, conversation, notebook, effectShadow, appChannel, appComputer, appQuestions, appMuse: () => appMuse });
const agent = createAgent({ ledger, broker, config });
const toolSessions = new Map(); // Keir 4.0: Rust runner tool sessions (see /v4/tool-session)
// Keir 5.7: Jev-logged feedback and a daily self-review (lib/operator/selfimprove.js).
const selfImprove = require("./lib/operator/selfimprove");
const feedbackLog = selfImprove.createFeedbackLog({ ledger, log });
const dailyReview = selfImprove.createDailyReview({ ledger, config, log, drain: () => drain(), hour: Number(env.KEIR_SELF_REVIEW_HOUR || 5) });
setInterval(() => { try { dailyReview.tick(); } catch (e) { log(`self-review: ${e.message}`); } }, 5 * 60000).unref();
const gateway = createGateway({ ledger, config, conversation, drain: () => drain(), observe: process.env.KEIR_FEEDBACK_LOG === "0" ? null : (x) => feedbackLog.observe(x) });
const { createDecisions } = require("./lib/operator/decisions");
const decisions = createDecisions({ ledger, config, discord, log, onAnswered: (x, verdict, actor, text) => {
  // Keir 2.0: owner decisions are remembered.
  try { notebook.remember({ kind: "decision", text: `${actor === config.ownerId ? "Owner" : "Danica for the owner"} ${verdict === "approve" ? "approved" : verdict === "reject" ? "rejected" : "answered"}: ${x.tldr || x.question}${text ? ` (said: ${text})` : ""}`.slice(0, 780), ticket: d0(x) }); } catch {}
} });
function d0(x) { return ledger.data.jobs[x.jobId]?.ticket || null; }
const { makeTldr, render: renderDecision } = require("./lib/operator/decisions");
const decisionTldr = makeTldr();
let checkingDecisions = false;
async function checkDecisions() {
  if (checkingDecisions) return; checkingDecisions = true;
  try { await decisions.tick(); } catch (e) { log(`decisions: ${e.message}`); } finally { checkingDecisions = false; }
  if (Object.values(ledger.data.jobs).some((j) => j.state === "queued")) drain();
}
setInterval(checkDecisions, 60000).unref();
// Keir 4.0 incidents: settle staff proposals every minute, look for a public
// chatter spike every five.
setInterval(() => broker.surgeTick().catch((e) => log(`incidents: ${e.message}`)), 60000).unref();
setInterval(() => broker.chatterTick().catch((e) => log(`chatter: ${e.message}`)), 5 * 60000).unref();
// Keir 2.3: learn the knowledge base gradually. Hourly, and only while idle,
// distill up to two unlearned or changed game docs into notebook notes.
const distill = knowledgeLayer.makeDistiller({ strict: true });
let learning = false;
async function learnKnowledge() {
  if (learning || verifying || curating || Object.values(ledger.data.jobs).some((j) => ["running", "queued"].includes(j.state))) return;
  learning = true;
  try {
    // Keir 5.2: page the whole list; one 500-row page skipped the older docs.
    const { rows: listed, complete } = await knowledgeLayer.listAll((page) => mcp.call("ops-knowledge", "knowledge_list", { project: "a-house-divided", collection: "docs", order: "name", ...page }, false));
    const rows = listed.filter(knowledgeLayer.gameKnowledge);
    const seen = (notebook.meta().kb ||= {});
    // A doc that was deleted, superseded or reclassified internal stops backing
    // notes. Two complete listings in a row must miss it, since a walk can skip
    // a row when the list changes underneath it.
    if (complete) {
      const current = new Set(rows.map((r) => r.name)), missing = (notebook.meta().kbMissing ||= {});
      for (const name of Object.keys(missing)) if (current.has(name) || !seen[name]) delete missing[name];
      for (const name of Object.keys(seen).filter((n) => !current.has(n))) {
        if ((missing[name] = (missing[name] || 0) + 1) < 2) continue;
        notebook.forgetDoc(name); delete seen[name]; delete missing[name]; ledger.audit("kb_withdrawn", { doc: name });
      }
      notebook.save();
    }
    for (const row of rows.filter((r) => seen[r.name] !== r.version).slice(0, 2)) {
      const doc = await mcp.call("ops-knowledge", "knowledge_get", { collection: "docs", name: row.name, project: "a-house-divided" }, false);
      if (!knowledgeLayer.gameKnowledge(doc)) { seen[row.name] = row.version; continue; }
      notebook.invalidateDoc(row.name, row.version);
      // Distill before retiring old notes; provider failures must not erase memory.
      const learned = await distill(doc);
      const saved = notebook.replaceDoc(row.name, row.version, learned).length;
      ledger.audit("kb_learned", { doc: row.name, version: row.version, notes: saved }); ledger.save();
    }
  } catch (e) { log(`kb learner: ${e.message}`); } finally { learning = false; }
}
// Keir 2.5: verify changed mechanics against a freshly fetched production ref.
// A small idle batch on the Meta subscription; failed checks remain stale.
const verifyNote = knowledgeLayer.makeVerifier();
const proposeKnowledgeCorrection = knowledgeLayer.makeKnowledgeCorrector();
let verifying = false;
async function refreshKnowledge() {
  const busy = () => learning || curating || Object.values(ledger.data.jobs).some((j) => ["running", "queued"].includes(j.state));
  if (verifying || busy()) return { skipped: true };
  verifying = true;
  try {
    await require("./lib/operator/broker").run("/usr/bin/git", ["-C", "/root/projects/AHDGame", "fetch", "origin", "main"], { timeout: 30000 });
    const result = await notebook.refresh(verifyNote, { limit: 2, interrupted: busy });
    ledger.audit("notebook_verified", { results: result }); ledger.save();
    // Keir 5.2: production code contradicted a note learned from a KB doc, so
    // the doc is likely stale too. Downvote it once per version for review.
    const voted = (notebook.meta().kbVotes ||= {});
    for (const r of result.filter((x) => x.status === "replaced" && x.doc && voted[x.doc] !== (x.docVersion ?? true))) {
      try { await mcp.call("ops-knowledge", "knowledge_feedback", { collection: "docs", name: r.doc, project: "a-house-divided", vote: "down", note: `Keir code verification: ${r.reason || "a learned note no longer matches production code"}`.slice(0, 400) }, false); voted[r.doc] = r.docVersion ?? true; ledger.audit("kb_downvoted", { doc: r.doc, version: r.docVersion }); }
      catch (e) { log(`kb feedback: ${e.message}`); }
    }
    if (config.knowledgeCorrections && !busy()) {
      const pending = (notebook.meta().kbCorrectionsPending ||= {});
      for (const r of result.filter(x => x.status === "replaced" && x.doc)) pending[r.doc] = { status: "retry", note: r.current, attempts: 0, at: Date.now() };
      // Keep uncertain/conflicting repairs visible. Retry only interrupted or failed
      // IO, with a bounded budget; a lost save is recovered by its operation receipt.
      for (const [docName, item] of Object.entries(pending).filter(([, p]) => p.status === "retry" && (p.attempts || 0) < 3).slice(0, 1)) {
        const note = notebook.all().find(n => n.id === item.note);
        const attempts = (item.attempts || 0) + 1;
        pending[docName] = { ...item, attempts, at: Date.now() };
        notebook.save();
        try {
          const correction = await require("./lib/operator/knowledge-correction").correctKnowledge({note,project:"a-house-divided",accepts:knowledgeLayer.gameKnowledge,interrupted:busy,
            call:(tool,args)=>mcp.call("ops-knowledge",tool,args,false),propose:proposeKnowledgeCorrection,
            readSource:async sourcePath=>{
              const repo="/root/projects/AHDGame";
              const git=async args=>(await require("./lib/operator/broker").run("/usr/bin/git",["-C",repo,...args],{timeout:10000})).trim();
              const commit=await git(["rev-parse","origin/main"]);
              return{commit,sha:await git(["rev-parse",`${commit}:${sourcePath}`]),body:await git(["show",`${commit}:${sourcePath}`])};
            }});
          ledger.audit("kb_correction",{doc:docName,...correction});
          if (["corrected", "already-applied"].includes(correction.status)) {
            notebook.invalidateDoc(docName,correction.version);
            delete pending[docName];
          } else pending[docName] = { ...correction, at: Date.now(), note: item.note, attempts };
        }catch(e){
          pending[docName] = { status: "retry", reason: String(e.message).slice(0,200), at: Date.now(), note: item.note, attempts };
          ledger.audit("kb_correction_pending",{doc:docName,error:pending[docName].reason});
        }
      }
    }
    notebook.save(); ledger.save();
    return { results: result };
  } catch (e) { log(`notebook verifier: ${e.message}`); return { error: e.message }; }
  finally { verifying = false; }
}
setTimeout(refreshKnowledge, 2 * 60000).unref();
setInterval(refreshKnowledge, 5 * 60000).unref();
// Keir 2.4: curate the notebook daily while idle (merge duplicates, tighten,
// drop no-value notes; decisions and lessons are never dropped; dated backup).
const curator = knowledgeLayer.makeCurator();
let curating = false;
async function curateIfDue(force = false) {
  if (curating || learning || verifying) return { busy: true };
  if (!force && (Object.values(ledger.data.jobs).some((j) => ["running", "queued"].includes(j.state)) || Date.now() - (notebook.meta().lastCurated || 0) < 22 * 3600000)) return { skipped: true };
  curating = true;
  try { const r = await knowledgeLayer.curateNotebook(notebook, curator, { log }); ledger.audit("notebook_curated", { actions: r.length }); ledger.save(); return { actions: r.length, notes: notebook.all().length }; }
  catch (e) { log(`curation: ${e.message}`); return { error: e.message }; } finally { curating = false; }
}
setInterval(() => curateIfDue(), 6 * 3600000).unref();
setTimeout(learnKnowledge, 10 * 60000).unref();
setInterval(learnKnowledge, 60 * 60000).unref();
setInterval(() => broker.issueSweep().catch((e) => log(`issue sweep: ${e.message}`)), 60 * 60000).unref();
const { createTurnWatch } = require("./lib/operator/capabilities");
const turnWatch = createTurnWatch({ ledger, log, currentTurn: async () => Number((await mcp.call("gamestate", "game_overview", {}, false)).turn) });
setInterval(async () => {
  try { await turnWatch.tick(); } catch (e) { log(`turnwatch: ${e.message}`); }
  if (Object.values(ledger.data.jobs).some((j) => j.state === "queued")) drain();
}, 60000).unref();
// Keir 5.0 watch: sensors after each processed turn and on their own cadence.
const { createWatch, sentryWatchQuery } = require("./lib/operator/watch");
const sentryIssues = async (query, period) => {
  const token = process.env.SENTRY_API_TOKEN, org = process.env.SENTRY_ORG, base = (process.env.SENTRY_API_URL || "https://sentry.io").replace(/\/$/, "");
  if (!token || !org) return null;
  const scoped = sentryWatchQuery(query, { project: env.SENTRY_PROJECT || "a-house-divided", environment: env.SENTRY_ENVIRONMENT || "production" });
  const r = await fetch(`${base}/api/0/organizations/${org}/issues/?query=${encodeURIComponent(scoped)}&statsPeriod=${period}&sort=new&limit=25`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Sentry ${r.status}`);
  return (await r.json()).map((i) => ({ id: i.id, shortId: i.shortId, title: i.title, culprit: i.culprit, count: i.count, users: i.userCount, firstSeen: i.firstSeen, release: i.lastRelease?.shortVersion }));
};
const watch = createWatch({ ledger, mcp, log, config: { enabled: env.KEIR_WATCH !== "0", mode: env.KEIR_WATCH === "report" ? "report" : "active" }, sentry: sentryIssues,
  viewPage: (url) => require("./lib/operator/capabilities").viewPage(url), propose: (p) => broker.proposeIncident(p) });
broker.setWatch(watch);
const engineering = createEngineering({ ledger, config });
const roles = createRoles({ ledger, engineering, config, mcp, log, held: (job) => config.supportDeferred(job) ||
  ["staff-owned", "staff-active", "owner-decision", "closure-grace"].includes(admissionHold(job, { now: Date.now(), claimedBy: (id) => ledger.data.channels[id]?.claimedBy })) });
config.roleSnapshot = () => ({ ...roles.snapshot(), roles: roles.status() });
let reportingRoles = false;
setInterval(async () => {
  if (!config.rolesEnabled || reportingRoles) return;
  reportingRoles = true;
  try { engineering.tick(); await roles.report(); drain(); } catch (e) { log(`roles: ${e.message}`); }
  finally { reportingRoles = false; }
}, 60000).unref();
let watchBusy = false;
async function watchTick() {
  if (watchBusy) return; watchBusy = true;
  try {
    // Failed turns need inspection even when the processed counter stops or
    // game_overview is unavailable. Each sensor isolates its own failures.
    const overview = await mcp.call("gamestate", "game_overview", {}, false).catch((e) => { log(`watch overview: ${e.message}`); return null; });
    const turn = overview?.turn == null ? undefined : Number(overview.turn);
    const r = await watch.tick({ turn });
    if (r.raised?.length) { log(`watch raised ${r.raised.join(", ")}`); if (config.rolesEnabled) engineering.tick(); drain(); }
  } catch (e) { log(`watch: ${e.message}`); } finally { watchBusy = false; }
}
setTimeout(watchTick, 1000).unref();
setInterval(watchTick, 5 * 60000).unref();
const { createCiWatch } = require("./lib/operator/ciwatch");
const ciApi = (args) => new Promise((resolve, reject) => require("node:child_process").execFile("/usr/bin/gh", ["api", ...args], { timeout: 60000, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/root" } }, (e, out) => e ? reject(e) : resolve(JSON.parse(out || "null"))));
const ciWatch = createCiWatch({ ledger, api: ciApi, log, onWaiting: (job, info) => broker.waitingUpdate(job, info) });
// Developer changes related to open tickets (owner, 2026-10-14).
const { createDevMerges } = require("./lib/operator/devmerges");
const devMerges = createDevMerges({ ledger, api: ciApi, log });
let watchingMerges = false;
setInterval(async () => {
  if (watchingMerges) return; watchingMerges = true;
  try { await devMerges.tick(); } catch (e) { log(`devmerges: ${e.message}`); } finally { watchingMerges = false; }
  if (Object.values(ledger.data.jobs).some((j) => j.state === "queued")) drain();
}, 5 * 60000).unref();
let watchingCi = false;
setInterval(async () => {
  if (watchingCi) return; watchingCi = true;
  try { await ciWatch.tick(); } catch (e) { log(`ciwatch: ${e.message}`); } finally { watchingCi = false; }
  if (Object.values(ledger.data.jobs).some((j) => j.state === "queued")) drain();
}, 60000).unref();
// Developer questions remain observable after filing, without model polling.
const { createDeveloperWatch } = require("./lib/operator/developerwatch");
const developerWatch = createDeveloperWatch({ ledger, mcp, log, held: (job) => config.supportDeferred(job) ||
  ["staff-owned", "staff-active"].includes(admissionHold(rootJob(job, ledger.data.jobs), { now: Date.now(), claimedBy: (id) => ledger.data.channels[id]?.claimedBy })) });
let watchingDevelopers = false;
setInterval(async () => {
  if (watchingDevelopers) return; watchingDevelopers = true;
  try { await developerWatch.tick(); } catch (e) { log(`developerwatch: ${e.message}`); } finally { watchingDevelopers = false; }
  if (Object.values(ledger.data.jobs).some((j) => j.state === "queued")) drain();
}, 60000).unref();
// Keir 3.0: six lanes, one per admission slot (two conversation, one owner,
// two investigation, one coding), so replies and owner corrections never
// wait behind a long fix and the total stays inside the service budget.
const active = emptyLanes();
const RESUME_HORIZON_MS = positive("KEIR_RESUME_HORIZON_MINUTES", 30) * 60000;
let ticking = false, delivering = false, stopping = false;
const presence = createPresence({ discord });
const scanHealth = createScanHealth({ ledger });

async function ensureDm(recipient) {
  const d = ledger.data;
  d.directMessages ||= {};
  if (recipient === config.ownerId && d.ownerDm) d.directMessages[recipient] ||= d.ownerDm;
  if (!d.directMessages[recipient]) {
    // Listen from registration onward without replaying historical DM commands.
    const cursor = ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
    const dm = await discord("POST", "/users/@me/channels", { recipient_id: recipient });
    d.directMessages[recipient] = dm.id;
    d.cursors[dm.id] ||= cursor;
    if (recipient === config.ownerId) d.ownerDm = dm.id;
    ledger.save();
  }
  return d.directMessages[recipient];
}

// One morning DM replaces scattered operational pings: what Keir did in the
// last day, what is still open and what was logged instead of sent.
function digest() {
  const d = ledger.data, et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const today = et.toISOString().slice(0, 10);
  if (et.getHours() < 9 || d.digestDate === today) return;
  const since = Date.now() - 86400000, jobs = Object.values(d.jobs).filter((j) => (j.updatedAt || j.at) > since);
  const line = (j) => `- ${j.ticket ? `#${j.ticket} ` : ""}${(j.summary || j.source?.content || j.kind).replace(/\s+/g, " ").slice(0, 160)}`;
  const prs = jobs.flatMap((j) => j.pullRequests || []);
  const done = jobs.filter((j) => j.state === "done" && ["command", "ticket"].includes(j.kind) && !/closed externally/.test(j.summary || ""));
  const open = Object.values(d.jobs).filter((j) => ["queued", "running", "waiting", "blocked"].includes(j.state) && j.kind !== "conversation");
  const alerts = (d.alerts || []).filter((a) => a.at > since);
  // Keir 5.1: the mission score leads the operational detail.
  const parts = ["Keir, last 24h.", d.watch?.headline || "",
    `Tickets opened: ${d.intake.filter((x) => x.at > since).length}. PRs opened: ${prs.length}${prs.length ? "\n" + prs.map((u) => "- " + u).join("\n") : ""}`,
    done.length ? `Finished:\n${done.slice(-8).map(line).join("\n")}` : "",
    open.length ? `Still open (${open.length}):\n${open.slice(0, 8).map((j) => line(j) + ` [${j.state}]`).join("\n")}` : "Nothing open.",
    alerts.length ? `Logged, not sent (${alerts.length}): ${[...new Set(alerts.map((a) => a.key.split(":")[0]))].join(", ")}` : ""].filter(Boolean);
  d.digestDate = today;
  ledger.notify(`digest:${today}`, "owner", parts.join("\n\n"));
  ledger.save();
}

async function flushOutbox() {
  if (delivering) return; delivering = true;
  try {
  outboxEntries: for (const [key, entry] of Object.entries(ledger.data.outbox).filter(([, e]) => !e.deliveredAt && (!e.retryAt || e.retryAt <= Date.now())).slice(0, 5)) {
    if (ledger.data.control?.stopped && !entry.controlResponse) continue;
    if (require("./lib/operator/supporttakeover").suppressOutbox(ledger, key, entry, Date.now())) continue;
    // Resume safety: an acknowledgment, or a message for a task that already
    // finished, that is older than the resume horizon would arrive as noise.
    const staleJob = typeof entry.destination === "string" && entry.destination.startsWith("channel:") ? ledger.data.jobs[entry.destination.slice(8)] : null;
    if (Date.now() - (entry.at || 0) > RESUME_HORIZON_MS && (key.startsWith("ack:") || (staleJob && ["done", "cancelled", "dismissed"].includes(staleJob.state)))) {
      entry.deliveredAt = Date.now(); entry.skipped = "stale on resume"; ledger.audit("outbox_skipped_stale", { key }); ledger.save(); continue;
    }
    try {
      // Decision DMs lead with a short TL;DR, written once per decision.
      if (entry.decision && !entry.tldrDone) {
        const x = ledger.data.decisions?.[entry.decision];
        if (x) { if (!x.tldr) { const job = ledger.data.jobs[x.jobId], root = job ? (require("./lib/operator/workrecord").rootJob(job, ledger.data.jobs) || job) : null; x.tldr = await decisionTldr(x.question, { ticket: job?.ticket || root?.ticket || null, ask: root?.source?.content || job?.source?.content || "" }); } entry.content = renderDecision(x.question, { onBehalf: entry.recipient !== config.ownerId, tldr: x.tldr, signoff: x.signoff }); }
        entry.tldrDone = true; ledger.save();
      }
      if (ledger.data.control?.stopped && !entry.controlResponse) continue;
      const channelJob = typeof entry.destination === "string" && entry.destination.startsWith("channel:") ? ledger.data.jobs[entry.destination.slice(8)] : null;
      if (channelJob && isAppJob(channelJob)) {
        entry.messageIds = appChannel.deliver(key, entry, channelJob); entry.deliveredChunks = 1; entry.deliveredAt = Date.now(); ledger.save();
        events.append("delivery", { taskId: taskIdOf(channelJob, ledger.data.jobs), attemptId: channelJob.id, ticket: null, key, destination: "app", messageIds: entry.messageIds, chunks: 1, chars: String(entry.content || "").length, decision: null });
        continue;
      }
      let dmId, clean;
      if (channelJob) {
        if (!channelJob.replyChannel || channelJob.replyChannel !== channelJob.source?.channelId) throw new Error("untrusted channel destination");
        // Only Keir's own rendered charts may carry an attachment into a channel.
        if (entry.files?.length && !(entry.chart && entry.files.every((f) => f.chart && /\/artifacts\/chart-[a-f0-9]{12}-[a-f0-9]{12}\.png$/.test(f.path)))) throw new Error("private attachments cannot be delivered to channels");
        const channel = await discord("GET", `/channels/${channelJob.replyChannel}`);
        if (channel.guild_id !== config.guildId) throw new Error("reply channel outside configured guild");
        clean = redactSecrets(entry.content);
        if (clean !== entry.content || /<@|@everyone|@here/.test(clean)) throw new Error("unsafe public outbox text");
        dmId = channelJob.replyChannel;
      } else {
        const recipient = entry.destination === "owner" ? config.ownerId : entry.destination;
        if (![config.ownerId, ...config.staffIds].includes(recipient)) throw new Error("untrusted notification recipient");
        dmId = await ensureDm(recipient);
        clean = recipient === config.ownerId ? ownerText(entry.content) : redactSecrets(entry.content);
      }
      const chunks = chunkMessage(clean.replace(/[\u2013\u2014]/g, ","));
      for (let i = entry.deliveredChunks || 0; i < chunks.length; i++) {
        if (ledger.data.control?.stopped && !entry.controlResponse) continue outboxEntries;
        if (require("./lib/operator/supporttakeover").suppressOutbox(ledger, key, entry, Date.now())) continue outboxEntries;
        const files = i === 0 ? entry.files || [] : [];
        // Answers thread under the request that asked for them.
        const reference = channelJob && i === 0 && !key.startsWith("ack:") && snowflake(channelJob.source?.messageId) ? { message_reference: { message_id: channelJob.source.messageId, fail_if_not_exists: false } } : {};
        const sent = await discord("POST", `/channels/${dmId}/messages`, { content: chunks[i], allowed_mentions: { parse: [] }, nonce: `${entry.id}-${i}`, enforce_nonce: true, ...reference,
          ...(entry.components && i === chunks.length - 1 ? { components: entry.components } : {}),
          ...(files.length ? { attachments: files.map((f, id) => ({ id, filename: f.name })) } : {}) }, files);
        if (entry.decision && i === chunks.length - 1) { entry.sentContent = chunks[i]; decisions.delivered(entry, dmId, sent.id); }
        if (channelJob) conversation.record({ id: dmId }, { ...sent, content: chunks[i], author: { id: config.botId, bot: true, username: "Keir" }, timestamp: sent.timestamp || new Date().toISOString() });
        entry.messageIds ||= []; entry.messageIds.push(sent.id); entry.deliveredChunks = i + 1; ledger.save();
      }
      entry.deliveredAt = Date.now(); ledger.save();
      events.append("delivery", { taskId: channelJob ? taskIdOf(channelJob, ledger.data.jobs) : null, attemptId: channelJob?.id || null, ticket: channelJob?.ticket || null,
        key, destination: channelJob ? "channel" : String(entry.destination), messageIds: entry.messageIds, chunks: entry.deliveredChunks, chars: clean.length, decision: entry.decision || null });
      if (channelJob && key.startsWith("ack:")) { channelJob.progressMessageId = entry.messageIds?.[0]; ledger.save(); }
      else if (channelJob?.progressMessageId && /^(channel-reply|finish|error-reply):/.test(key)) {
        // The answer replaces the status line; keep the channel to one message per task.
        const id = channelJob.progressMessageId; delete channelJob.progressMessageId; ledger.save();
        discord("DELETE", `/channels/${dmId}/messages/${id}`).catch(() => {});
      }
    } catch (e) {
      entry.attempts++; entry.retryAt = Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(7, entry.attempts)); entry.error = redactSecrets(e.message); ledger.save(); log(`owner delivery retry: ${e.message}`);
    }
  }
  } finally { delivering = false; }
}

// Moderation tickets are for human moderators. Stand down any support work
// already running on one; developer-directed tasks there are left alone.
function stopModerationTicket(channelId, number, category = "moderation") {
  const job = ledger.data.jobs[ledger.data.seen[`ticket:${number}`]];
  for (const j of Object.values(ledger.data.jobs)) {
    if ((j === job || (j.channelId === channelId && j.kind === "ticket")) && !["done", "cancelled", "dismissed"].includes(j.state)) {
      j.state = "cancelled"; j.summary = category === "incident" ? "Incident ticket: staff own it; repeat reports merge into it." : "Moderation ticket: left to the moderators.";
      ledger.audit(`${category}_ticket_skipped`, { job: j.id, ticket: number });
    }
  }
}

async function scan() {
  const channels = await discord("GET", `/guilds/${config.guildId}/channels`);
  for (const recipient of new Set([config.ownerId, ...config.staffIds])) {
    try { channels.push({ id: await ensureDm(recipient), name: "authorized-dm", type: 1 }); }
    catch (e) { log(`DM registration failed: ${redactSecrets(e.message)}`); }
  }
  for (const ch of channels.filter((c) => [0, 1, 5, 10, 11, 12].includes(c.type))) {
    if (!ch.last_message_id && ch.type !== 1) continue;
    const prior = ledger.data.cursors[ch.id];
    if (prior && ticketNumber(ch.name) && !ledger.data.channels[ch.id]?.category) {
      // Tickets adopted before categories were recorded: read the intake card once.
      try {
        const first = await discord("GET", `/channels/${ch.id}/messages?after=0&limit=10`);
        const category = ticketCategory(first, config.botId) || "unknown";
        ledger.data.channels[ch.id] = { ...ledger.data.channels[ch.id], category };
        if (category === "moderation" || category === "incident") stopModerationTicket(ch.id, ticketNumber(ch.name), category);
        ledger.save();
      } catch (e) { log(`categorize ${ch.name}: ${e.message}`); }
    }
    if (ch.last_message_id && prior === ch.last_message_id) continue;
    try {
      if (!prior) {
        if (ticketNumber(ch.name)) {
          // Adopt live tickets from actual cards/history, while preserving staff ownership.
          const rows = await discord("GET", `/channels/${ch.id}/messages?limit=100`);
          rows.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
          // Adopt an existing staff claim only from the bot's actual claim message.
          const claim = rows.map((m) => ticketClaim(m, config, ledger.data.channels[ch.id]?.claimReleasedAt)).find(Boolean);
          const staff = claim ? { author: { id: claim } } : null;
          if (staff) ledger.data.channels[ch.id] = { claimedBy: staff.author.id };
          const category = ticketCategory(rows, config.botId);
          if (category) ledger.data.channels[ch.id] = { ...ledger.data.channels[ch.id], category };
          for (const msg of rows) gateway.ingest(ch, msg, { historical: true });
          // A newly opened ticket may have only bot intake messages.
          if (!staff && !ledger.data.channels[ch.id]?.claimedBy && category !== "moderation" && category !== "incident" && !ledger.data.seen[`ticket:${ticketNumber(ch.name)}`]) {
            const card = rows.find((m) => m.author.id === config.botId && m.embeds?.length);
            if (card) {
              const number = ticketNumber(ch.name);
              const job = ledger.createJob(`ticket:${number}`, { kind: "ticket", role: "support", ticket: number, channelId: ch.id,
                source: { channelId: ch.id, channelName: ch.name, content: "New ticket intake; read support_get and ticket_history before acting.", at: card.timestamp }, deadline: Date.now() + config.taskLifetimeMs });
              job.summary = "New ticket needs investigation.";
            }
          }
          ledger.data.cursors[ch.id] = rows.at(-1)?.id || ch.last_message_id;
        } else {
          if (ch.last_message_id) ledger.data.cursors[ch.id] = ch.last_message_id;
          else {
            const rows = await discord("GET", `/channels/${ch.id}/messages?limit=1`);
            ledger.data.cursors[ch.id] = rows[0]?.id || "0";
          }
        }
        ledger.save(); continue;
      }
      await catchUp(discord, ch.id, prior, async (m) => {
        // Resuming after a pause or outage replays everything since the
        // cursor. Outside ticket channels, a request older than the resume
        // horizon is history, not a live instruction: it is recorded as
        // context and listed for the owner, never executed hours late.
        const stale = !ticketNumber(ch.name) && Date.now() - Date.parse(m.timestamp) > RESUME_HORIZON_MS;
        gateway.ingest(ch, m, stale ? { historical: true } : undefined);
        if (stale && !m.author?.bot && (ch.type === 1 || (m.mentions || []).some((u) => u.id === config.botId)))
          ledger.notify(`recovery:resume-skipped:${m.id}`, "owner", `Not acted on (sent ${m.timestamp}, before resume): ${String(m.content || "").slice(0, 200)}`);
        ledger.data.cursors[ch.id] = m.id; ledger.save();
      });
    } catch (e) { log(`scan ${ch.name}: ${e.message}`); }
  }
  const liveChannels = new Set(channels.map((c) => c.id));
  // Standing sweep: every open ticket channel has an owner. A channel with no
  // task at all (opened while Keir was down, or adopted before a restart) gets
  // a support task so nothing sits unanswered (owner, 2026-10-13).
  for (const ch of channels) {
    const n = ticketNumber(ch.name);
    if (!n || (["moderation", "incident"].includes(ledger.data.channels[ch.id]?.category) && !ledger.data.channels[ch.id]?.ownerDirectedAt) || ledger.data.channels[ch.id]?.claimedBy) continue;
    const known = ledger.data.jobs[ledger.data.seen[`ticket:${n}`]];
    if (known?.channelClosed && known.channelId !== ch.id) {
      try { await reopenedTickets.adopt(n, ch); } catch (e) { log(`reopened ticket ${n}: ${e.message}`); }
    }
    // A ticket adopted from a handoff before its channel was seen gets it now.
    if (known && (!known.channelId || (!known.replyChannel && known.channelId === ch.id))) {
      known.channelId ||= ch.id;
      known.replyChannel ||= ch.id;
      known.source = { ...known.source, channelId: ch.id, channelName: ch.name };
      ledger.save();
    }
    if (ledger.data.seen[`ticket:${n}`]) continue;
    const job = ledger.createJob(`ticket:${n}`, { kind: "ticket", role: "support", ticket: n, channelId: ch.id, source: { content: `Open ticket channel #${ch.name} with no Keir task; adopted by the sweep. Read its history and pick it up.`, channelId: ch.id, at: new Date().toISOString() }, deadline: Date.now() + config.taskLifetimeMs });
    ledger.audit("ticket_adopted_by_sweep", { job: job.id, ticket: n }); ledger.save();
  }
  for (const job of Object.values(ledger.data.jobs)) {
    if (job.ticket && !liveChannels.has(job.channelId) && !["done", "cancelled"].includes(job.state)) {
      // The guild list is read once at the start of the scan; a ticket channel
      // created since (ticket 1555, opened by Keir mid-scan) is missing from it
      // without being closed. Only Discord saying the channel is gone closes it.
      try { await discord("GET", `/channels/${job.channelId}`); continue; }
      catch (e) { if (e.status !== 404) continue; }
      job.state = "done"; job.channelClosed = true; job.summary = "Ticket channel was closed externally; stopped work.";
      if (job.resolutionSubmitted) {
        job.resolved = true; job.summary = "Resolution receipt recorded and ticket-channel closure verified.";
        // Verified closure is routine; no owner DM.
      }
      for (const slot of Object.values(active)) if (slot?.job.id === job.id) slot.controller.abort();
    }
  }
  ledger.save();
}

// A handed-off ticket needs a ticket job to carry the handoff, even if this
// operator never saw the ticket while it was paused.
function ensureTicketJob(n) {
  const d = ledger.data;
  if (!Number.isInteger(n) || n <= 0) return null;
  const existing = d.jobs[d.seen[`ticket:${n}`]];
  if (existing) return existing;
  const channelId = Object.entries(d.channels).find(([, c]) => c.ticket === n)?.[0] || null;
  const job = ledger.createJob(`ticket:${n}`, { kind: "ticket", role: "support", ticket: n, channelId, replyChannel: channelId,
    source: { content: `Ticket ${n} handed off by another operator. Read its history and the handoff, then continue it.`, channelId, at: new Date().toISOString() },
    deadline: Date.now() + config.taskLifetimeMs });
  ledger.audit("ticket_adopted_by_handoff", { job: job.id, ticket: n });
  return job;
}

function legacyHandoff() {
  try {
    const file = "/root/projects/ticket-supervisor/config/policy.json";
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    const l = JSON.parse(fs.readFileSync("/var/lib/ticket-supervisor/ledger.json", "utf8"));
    for (const job of Object.values(ledger.data.jobs).filter((j) => j.ticket)) {
      const ticket = l.tickets?.[job.ticket];
      if (!ticket) continue;
      const notes = (ticket.notes || []).slice(-8).map((n) => ({ at: n.at, text: redactSecrets(n.text) }));
      job.legacyTicket = { notes, promises: (ticket.promises || []).filter((p) => !p.doneAt).map((p) => ({ text: redactSecrets(p.text) })),
        prWatches: (l.prWatches || []).filter((w) => !w.doneAt && w.tickets.includes(job.ticket)).map((w) => ({ pr: w.pr, lastState: w.lastState })) };
      const claimed = config.staffIds.includes(ticket.claimedBy) ? ticket.claimedBy : notes.some((n) => /Ariane owns|Ariane's work|Leave reply\/fix\/close to her/i.test(n.text)) ? config.staffIds[0] : null;
      if (claimed) ledger.data.channels[job.channelId] = { ...ledger.data.channels[job.channelId], claimedBy: claimed };
      const lastNote = notes.at(-1)?.text || "";
      job.ownerDecisionPending = /awaiting.*(?:owner|product).*decision|owner.*(?:scope|decision).*pending|no (?:implementation|closure).*authorized/i.test(lastNote);
    }
    if (p.mode !== "shift") return;
    if (l.shift && Date.parse(l.shift.until) > Date.now()) {
      ledger.data.legacyShift = { agentId: l.shift.agentId, until: l.shift.until };
      return;
    }
    const adopted = ledger.data.legacyShift;
    if (!adopted || l.shift || l.lastShift?.agentId !== adopted.agentId || l.lastShift?.until !== adopted.until || Date.parse(adopted.until) > Date.now()) return;
    // The legacy supervisor has already ended the adopted shift. Turn its
    // delivery/alerts off so it does not page about work now owned here.
    p.mode = "off";
    const tmp = `${file}.operator-tmp`; fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n"); fs.renameSync(tmp, file);
    ledger.data.legacyHandoffAt = Date.now();
    delete ledger.data.legacyShift;
    ledger.audit("legacy_handoff", { agentId: adopted.agentId });
    ledger.notify("legacy-handoff:1", "owner", "The existing ticket shift has ended. Keir's standing support desk now owns automatic scanning and unclaimed ticket work; the old supervisor is in off mode.");
    ledger.save();
  } catch (e) { if (e.code !== "ENOENT") log("legacy handoff: " + e.message); }
}

function drain() {
  if (stopping) return;
  const d = ledger.data;
  const staffHeld = (job) => ["staff-owned", "staff-active"].includes(admissionHold(rootJob(job, d.jobs), { now: Date.now(), claimedBy: (id) => d.channels[id]?.claimedBy }));
  for (const slot of Object.values(active)) {
    if (slot && (d.paused || (slot.job.state === "cancelled" || slot.job.appPaused) || staffHeld(slot.job) || (slot.job.role === "support" && !["command", "conversation"].includes(slot.job.kind) && (config.supportDeferred(slot.job) || d.channels[slot.job.channelId]?.claimedBy)))) slot.controller.abort();
  }
  if (d.paused) return;
  broker.delegationTick?.();
  const now = Date.now();
  require("./lib/operator/workqueue").reviewWaits(ledger, config, now);
  selfRecovery.tick(active, { supportDeferred: (j) => config.supportDeferred(j), setTicketOwner: (t, o) => supportOwner.setTicketOwner(t, o, "self-recovery", {}), canRun: (j) => !(config.supportDeferred(j) || d.channels[j.channelId]?.claimedBy || broker.supportDirectiveHeld(j) || staffHeld(j)) });
  for (const j of Object.values(d.jobs)) {
    if (j.codingParent && !j.operatorRole) {
      const role = rootJob(j, d.jobs).operatorRole;
      if (["watchkeeper", "engineering"].includes(role)) j.operatorRole = role;
    }
    if (j.role !== "owner" && !["command", "conversation"].includes(j.kind) && j.ticket && !["done", "cancelled"].includes(j.state)) {
      if (d.channels[j.channelId]?.claimedBy) { j.state = "deferred"; j.summary = "Staff owns this ticket; automatic work is deferred."; continue; }
      if (j.ownerDecisionPending) { j.state = "blocked"; j.summary = "The existing coordinator recorded an outstanding owner decision; automatic changes and closure are held."; continue; }
    }
    if (j.resolutionSubmitted && !j.resolved && !["done", "cancelled", "blocked"].includes(j.state)) {
      if (now - j.resolutionSubmittedAt > 20 * 60000) {
        j.state = "blocked"; j.summary = "Resolution is recorded, but the bot has not closed the ticket channel after 20 minutes. Inspect receipt delivery.";
        ledger.notify(`close-stalled:${j.id}`, "owner", `Ticket ${j.ticket}: ${j.summary}`);
      } else { j.state = "waiting"; }
      continue;
    }
    // Keir 4.0: Keir clears its own dead ends. A blocked probe or benchmark
    // run is dismissed after an hour; a blocked subworker whose report already
    // reached its parent is dismissed after half an hour.
    if (j.state === "blocked" && (((j.internalProbe || j.kind === "probe") && now - (j.updatedAt || 0) > 3600000) || (j.codingParent && j.codingReported && now - (j.updatedAt || 0) > 30 * 60000))) {
      j.state = "dismissed"; j.summary = `Dismissed automatically: ${j.codingParent ? "its report already reached the parent task" : "a probe or benchmark left blocked"}. Was: ${String(j.summary || "").slice(0, 300)}`;
      ledger.audit("job_dismissed", { job: j.id, by: "keir", reason: j.codingParent ? "subworker_reported" : "probe_blocked" }); continue;
    }
    if (broker.supportDirectiveHeld(j)) continue;
    if (j.state === "waiting" && (j.wakeAt <= now || (j.inbox?.length && !j.debounceWake))) { j.state = "queued"; delete j.debounceWake; }
    // A message that arrived while the task was running (a handoff, a staff
    // note) is still unread when that run settles as blocked; it must wake the
    // task rather than wait for a human (ticket 1522, 2026-10-14).
    else if (j.state === "blocked" && j.inbox?.length && !j.ownerDecisionPending && !j.codingParent && !j.internalProbe && !j.channelClosed) { j.state = "queued"; ledger.audit("requeued_for_inbox", { job: j.id, ticket: j.ticket || null, messages: j.inbox.length }); }
    // Keir 5.6 (owner, 2026-10-16): an open owner decision holds writes and
    // closure, never the conversation. A player or staff message still wakes
    // the ticket so it gets an answer; supportAuthority keeps effects held.
    else if (j.state === "blocked" && j.ownerDecisionPending && j.kind === "ticket" && !j.channelClosed && (j.inbox || []).some((m) => m.role !== "system" && !/^(developer-watch|system|engineering-followup)$/.test(String(m.authorId || "")))) { j.state = "queued"; ledger.audit("requeued_for_conversation", { job: j.id, ticket: j.ticket || null }); }
    const expiry = require("./lib/operator/deadline").expireDeadline(j, now, { lifetimeMs: config.taskLifetimeMs });
    if (expiry === "extended") ledger.audit("deadline_extended", { job: j.id, ticket: j.ticket || null, until: j.deadline });
    else if (expiry === "blocked") ledger.notify(`deadline:${j.id}`, "owner", `Task ${j.id}: ${j.summary}`);
  }
  ledger.save();
  // Keir 3.0 admission: reserved conversation and owner capacity, aging so
  // nothing starves, one attempt per work record, support preference, and
  // the holds above (support ownership, staff claims, owner decisions).
  const picks = pickForLanes(Object.values(d.jobs).filter((j) => !broker.supportDirectiveHeld(j)), active, { now,
    supportDeferred: (j) => config.supportDeferred(j) || config.engineeringEnabled && j.kind === "finding" && !j.operatorRole && Object.values(d.watch?.findings || {}).some((f) => f.jobId === j.id && !f.correlatedWith), claimedBy: (channelId) => d.channels[channelId]?.claimedBy });
  for (const { lane, job } of picks) {
    if (active[lane]) continue;
    supportOwner.incorporateFor(job);
    const stopTyping = presence.begin(job.replyChannel);
    const controller = new AbortController(), startedAt = Date.now(); active[lane] = { job, controller, startedAt };
    const deadline = setTimeout(() => controller.abort(), laneTimeoutMs(lane, config.maxTurnMs));
    agent.run(job, controller.signal).catch((e) => {
      // A self-recovery park sets "waiting" or "blocked" before aborting: not an error.
      if (["done", "cancelled", "queued", "paused"].includes(job.state) || (["waiting", "blocked"].includes(job.state) && /^Self-recovery:/.test(job.summary || ""))) return;
      // Only a write this activation started makes an abort uncertain; an older
      // unsettled receipt is effect recovery's job (a restart blocked ticket 1578).
      const startedHere = Object.values(job.effects).some((e) => e.state === "started" && (e.at || 0) >= startedAt);
      if (controller.signal.aborted && (d.paused || config.supportDeferred(job) || stopping || staffHeld(job) || (job.kind === "ticket" && job.role !== "owner" && d.channels[job.channelId]?.claimedBy)) && !startedHere) { job.state = "waiting"; job.wakeAt = Math.max(Date.now() + 60000, rootJob(job, d.jobs).staffActiveUntil || 0); }
      else if (retryReadFailure(job, e)) { ledger.audit("transient_retry", {job:job.id, attempt:job.transientFailures}); }
      else {
        job.state = "blocked"; job.summary = redactSecrets(e.message);
        ledger.notify(`error:${job.id}:${job.rounds}`, "owner", `Task ${job.id} stopped: ${job.summary}`);
        if (job.kind === "command" && job.replyChannel) ledger.notify(`error-reply:${job.id}:${job.rounds}`, `channel:${job.id}`, "I hit an error and stopped on this one. Ask again and I'll pick it back up.");
      }
      ledger.save();
    }).finally(() => { broker.codingComplete?.(job); clearTimeout(deadline); stopTyping(); active[lane] = null; });
  }
}

function authorized(req) {
  const actual = Buffer.from(String(req.headers.authorization || "")), expected = Buffer.from(`Bearer ${env.KEIR_OPERATOR_ADMIN_TOKEN}`);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
const server = http.createServer(async (req, res) => {
  const reply = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  if (req.url === "/health" && req.method === "GET") {
    const healthy = Date.now() - (ledger.data.heartbeat || bootTime) < 120000;
    return reply(healthy ? 200 : 503, { ok: healthy, paused: ledger.data.paused, supportDeferred: config.supportDeferred(), supportOwner: supportOwner.owner(), active: Object.values(active).some(Boolean), lanes: Object.fromEntries(Object.entries(active).map(([k, s]) => [k, s?.job.id || null])), heartbeat: ledger.data.heartbeat, scan: { consecutiveFailures: scanHealth.state.failures, lastSuccessAt: scanHealth.state.lastSuccessAt } });
  }
  if (req.url === "/v5/roles/snapshot" && req.method === "GET") {
    if (!authorized(req) && !scopedToken(req, env.KEIR_WATCHKEEPER_TOKEN)) return reply(401, { error: "unauthorized" });
    return reply(200, roles.snapshot());
  }
  if (["/v5/watchkeeper/observations", "/v5/watchkeeper/heartbeat"].includes(req.url) && req.method === "POST") {
    if (!authorized(req) && !scopedToken(req, env.KEIR_WATCHKEEPER_TOKEN)) return reply(401, { error: "unauthorized" });
    let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 12000) return reply(413, { error: "too large" }); }
    try { const input = JSON.parse(raw || "{}"); const result = req.url.endsWith("heartbeat") ? roles.heartbeat(input) : roles.observe(input); drain(); return reply(200, result); }
    catch (e) { return reply(400, { error: String(e.message).slice(0, 200) }); }
  }
  if (!authorized(req)) return reply(401, { error: "unauthorized" });
  if (req.url === "/v5/usage" && req.method === "GET") {
    const until = Date.now();
    try {
      const report = await require("./lib/operator/usage").readUsage(config.usageFile || path.join(config.stateDir, "usage.jsonl"), { since: until - 86400000, until });
      const { CLASSES, classOf } = require("./lib/operator/admission");
      const queued = {};
      for (const job of Object.values(ledger.data.jobs)) if (job.state === "queued") queued[classOf(job)] = (queued[classOf(job)] || 0) + 1;
      report.scheduler = { capacities: Object.fromEntries(Object.entries(CLASSES).map(([k, v]) => [k, v.capacity])),
        active: Object.fromEntries(Object.entries(active).map(([k, s]) => [k, s?.job.id || null])), queuedByClass: queued };
      return reply(200, report);
    }
    catch { return reply(503, { error: "Usage log unavailable" }); }
  }
  if (req.url === "/v5/app/recover" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 4000) return reply(413, { error: "too large" }); }
    try {
      const result = require("./lib/operator/apprecovery").recover({ ledger, config, app: appChannel, agent: appAgent }, JSON.parse(raw));
      return reply(200, result);
    } catch (e) { return reply(e.status || 409, { error: String(e.message).slice(0, 300) }); }
  }
  if (req.url === "/v3/support-directive" && req.method === "POST") {
    let raw=""; for await (const chunk of req) {raw+=chunk;if(raw.length>12000)return reply(413,{error:"too large"});}
    try {const b=JSON.parse(raw);const job=ledger.data.jobs[b.sourceTaskId];if(!job)throw new Error("unknown source task");
      const receipt=await broker.supportDirective(job,b);drain();return reply(200,receipt);
    } catch(e) {return reply(409,{error:String(e.message).slice(0,300)});}
  }
  if (req.url === "/v5/roles/status" && req.method === "GET") return reply(200, roles.status());
  if (req.url === "/v5/watchkeeper/verify" && req.method === "POST") {
    try { const result = roles.verify(); drain(); return reply(202, result); } catch (e) { return reply(409, { error: String(e.message).slice(0, 200) }); }
  }
  if (req.url === "/v5/engineering/followup" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 12000) return reply(413, { error: "too large" }); }
    try { const result = engineering.followup(JSON.parse(raw)); drain(); return reply(202, result); }
    catch (e) { return reply(409, { error: String(e.message).slice(0, 200) }); }
  }
  if (req.url === "/v5/engineering/tasks" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 12000) return reply(413, { error: "too large" }); }
    try { const job = engineering.enqueue(JSON.parse(raw)); if (!job) return reply(409, { error: "engineering disabled or backlog full" }); drain(); return reply(202, { task: job.id, state: job.state }); }
    catch (e) { return reply(400, { error: String(e.message).slice(0, 200) }); }
  }
  if (req.url === "/status" && req.method === "GET") return reply(200, { paused: ledger.data.paused, jobs: Object.values(ledger.data.jobs).map(({ id, kind, role, state, ticket, summary }) => ({ id, kind, role, state, ticket, summary })) });
  // Keir 3.0 operator visibility and the support handoff.
  if (req.url === "/v3/status" && req.method === "GET") {
    return reply(200, { supportOwner: supportOwner.status(), lanes: Object.fromEntries(Object.entries(active).map(([k, s]) => [k, s?.job.id || null])),
      recoveries: (ledger.data.recoveries || []).slice(-10), feedback: (ledger.data.feedbackLog || []).slice(-10), selfReview: (ledger.data.selfReview?.runs || []).slice(-3), effectGate: effectShadow.summary(Date.now() - 7 * 86400000), shadow: shadowReport(ledger.data, { now: Date.now(), ownerId: config.ownerId, staffIds: config.staffIds }) });
  }
  if ((req.url === "/v3/handoff" || req.url === "/v3/support-owner" || req.url === "/v3/ticket-owner" || req.url === "/v3/ticket-model" || req.url === "/v3/status-card") && req.method === "POST") {
    let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 64000) return reply(413, { error: "too large" }); }
    let b; try { b = JSON.parse(body); } catch { return reply(400, { error: "invalid json" }); }
    try {
      if (req.url === "/v3/support-owner") return reply(200, supportOwner.setOwner(String(b.owner || ""), String(b.by || "admin")));
      if (req.url === "/v3/status-card") return reply(200, await broker.adminStatusCard(Number(b.ticket), { items: b.items, status: b.status }));
      if (req.url === "/v3/ticket-model") return reply(200, supportOwner.assignModel(b.ticket, String(b.model || ""), String(b.by || "admin"), { ensureTicketJob }));
      if (req.url === "/v3/ticket-owner") { const r = supportOwner.setTicketOwner(b.ticket, String(b.owner || ""), String(b.by || "admin"), { id: b.id, implementationOwner: b.implementationOwner, correction: b.correction, remainingWork: b.remainingWork }); drain(); return reply(200, r); }
      const result = supportOwner.receive(b, { ensureTicketJob });
      const reopened = [];
      for (const ticket of b.tickets || []) { const adopted = await reopenedTickets.adopt(Number(ticket)); if (adopted) reopened.push(adopted); }
      drain(); return reply(result.duplicate ? 200 : 201, { ...result, ...(reopened.length ? { reopened } : {}) });
    } catch (e) { return reply(400, { error: e.message }); }
  }
  if (req.url === "/channels" && req.method === "GET") {
    const channels = new Set(Object.values(ledger.data.jobs).filter((j) => !["done", "cancelled", "dismissed"].includes(j.state) && snowflake(j.channelId)).map((j) => j.channelId));
    for (const [id, c] of Object.entries(ledger.data.conversations || {})) if (c.until > Date.now()) channels.add(id);
    for (const id of Object.keys(ledger.data.summonedChannels || {})) channels.add(id);
    return reply(200, { channels: [...channels] });
  }
  const channelMatch = /^\/channel-status\/(\d{15,22})$/.exec(req.url);
  if (channelMatch && req.method === "GET") {
    const jobs = Object.values(ledger.data.jobs).filter((j) => j.channelId === channelMatch[1] && !["done", "cancelled", "dismissed"].includes(j.state));
    const conversation = ledger.data.conversations?.[channelMatch[1]];
    const standing = ledger.data.summonedChannels?.[channelMatch[1]];
    const live = standing || conversation?.until > Date.now();
    return reply(200, { active: Boolean(jobs.length || live), working: jobs.some((j) => j.state === "running"), startedAt: new Date(jobs[0]?.at || standing?.at || conversation?.startedAt || Date.now()).toISOString(), summonedBy: jobs[0]?.actorId || standing?.actorId || conversation?.actorId,
      queued: jobs.filter((j) => j.state === "queued").length, checkIns: jobs.filter((j) => j.state === "waiting").length, healPending: false, model: config.model });
  }
  if (req.url === "/probe/quick" && req.method === "POST") {
    const job = ledger.createJob(`quick-probe:${ledger.id()}`, { kind: "conversation", role: "owner", actorId: config.ownerId, internalProbe: true, deadline: Date.now() + 300000,
      source: { content: "Deployment verification only. Discover the gamestate read tools, call game_overview, and finish done with the concrete current turn and mode. This is an internal probe without a reply channel. Do not hand off, request actions, change tickets or send messages.", at: new Date().toISOString() } });
    ledger.audit("admin_quick_probe", { job: job.id }); ledger.save(); drain(); return reply(202, { task: job.id });
  }
  // Keir 4.0 phase 3: a tool session for the Rust runner, bound to an existing
  // job and a tool subset, with a 30 minute abort. Policy stays in the broker.
  if (req.url === "/v4/tool-session" && req.method === "POST" && authorized(req)) {
    let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 8000) return reply(413, { error: "too large" }); }
    let parsed; try { parsed = JSON.parse(body || "{}"); } catch { return reply(400, { error: "invalid json" }); }
    const job = ledger.data.jobs[String(parsed.jobId || "")];
    if (!job) return reply(404, { error: "unknown job" });
    const names = Array.isArray(parsed.tools) ? parsed.tools.map(String) : [];
    const controller = new AbortController();
    const opened = await agent.openToolSession(job, names, controller.signal);
    const id = crypto.randomBytes(8).toString("hex");
    const timer = setTimeout(() => { controller.abort(); opened.close(); toolSessions.delete(id); }, 30 * 60000); timer.unref();
    toolSessions.set(id, { close: () => { clearTimeout(timer); controller.abort(); opened.close(); } });
    ledger.audit("tool_session_opened", { job: job.id, ticket: job.ticket, session: id, tools: opened.session.tools.length }); ledger.save();
    return reply(200, { session: id, url: opened.url, tools: opened.session.tools.map((t) => t.name) });
  }
  if (req.url.startsWith("/v4/tool-session/") && req.method === "DELETE" && authorized(req)) {
    const id = req.url.slice("/v4/tool-session/".length);
    const s = toolSessions.get(id); if (s) { s.close(); toolSessions.delete(id); ledger.audit("tool_session_closed", { session: id }); }
    return reply(200, { closed: Boolean(s) });
  }
  if (req.url === "/notebook/refresh" && req.method === "POST" && authorized(req)) return reply(200, await refreshKnowledge());
  if (req.url === "/notebook/curate" && req.method === "POST" && authorized(req)) return reply(200, await curateIfDue(true));
  if (req.url === "/notebook" && req.method === "POST" && authorized(req)) {
    // Keir 2.0: shadow-review corrections become lessons (bin/keir-lesson.js).
    let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 8000) return reply(413, { error: "too large" }); }
    try { const b = JSON.parse(body); return reply(200, { saved: notebook.remember({ kind: b.kind || "lesson", text: b.text, path: b.path, ticket: b.ticket, player: b.player, doc: b.doc, docVersion: b.docVersion, paths: b.paths, source: b.source, supersedes: b.supersedes, contradicts: b.contradicts, reason: b.reason, by: b.by || "shadow-review" }) }); }
    catch (e) { return reply(400, { error: e.message }); }
  }
  if (req.url === "/bench" && req.method === "POST" && authorized(req)) {
    // Benchmark one model on one question: read-only internal probe with the
    // runner, model and (optionally) effort pinned. bin/keir-bench.js grades it.
    let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 20000) return reply(413, { error: "too large" }); }
    let b; try { b = JSON.parse(body); } catch { return reply(400, { error: "invalid json" }); }
    const lane = b.lane === "worker" ? "worker" : "quick";
    if (!["agy", "muse", "codex", "claude"].includes(b.runner) || !b.model || !b.question) return reply(400, { error: "runner, model and question required" });
    const job = ledger.createJob(`bench:${ledger.id()}`, { kind: lane === "quick" ? "conversation" : "probe", role: "owner", actorId: config.ownerId, internalProbe: true, benchmark: b.id || true, channelId: "bench", deadline: Date.now() + 900000,
      provider: { lane, runner: b.runner, model: String(b.model), at: Date.now() }, ...(["low", "medium", "high", "xhigh"].includes(b.effort) ? { effortPin: b.effort } : {}),
      source: { content: "Benchmark question. Read-only: do not request actions, heals or patches, do not open or update tickets, do not send messages. Verify with your tools, then finish done with a precise answer (figures exactly as the tools give them) in the summary.\n\n" + String(b.question).slice(0, 4000), at: new Date().toISOString() } });
    ledger.audit("benchmark", { job: job.id, runner: b.runner, model: b.model, id: b.id }); ledger.save(); drain(); return reply(202, { task: job.id });
  }
  if (req.url === "/probe" && req.method === "POST") {
    const job = ledger.createJob(`probe:${Date.now()}`, { kind: "probe", role: "owner", actorId: config.ownerId, internalProbe: true, channelId: "probe", deadline: Date.now() + 600000,
      source: { content: "Deployment verification only. Use shell to write and read a small task-local file and show that /root and /etc are absent. Do not request actions, open tickets, change game state or send support updates. Then finish done with the concrete probe result.", at: new Date().toISOString() } });
    ledger.audit("admin_probe", { job: job.id }); ledger.save(); drain(); return reply(202, { task: job.id });
  }
  if (req.url !== "/poke" || req.method !== "POST") return reply(404, { error: "not found" });
  try {
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw new Error("oversized poke"); }
    const { channelId, messageId } = JSON.parse(raw);
    if (!snowflake(channelId) || !snowflake(messageId)) return reply(400, { error: "invalid ids" });
    const ch = await discord("GET", `/channels/${channelId}`);
    if (ch.guild_id !== config.guildId && !(ch.type === 1 && ch.recipients?.some((u) => [config.ownerId, ...config.staffIds].includes(u.id)))) return reply(403, { error: "wrong channel" });
    const msg = await discord("GET", `/channels/${channelId}/messages/${messageId}`);
    // A decision button was pressed: adhd-bot stamped the verdict on this DM.
    // Re-read it through the decision checker; nothing in the poke is trusted.
    const pending = Object.values(ledger.data.decisions || {}).find((x) => x.state === "pending" && Object.values(x.sent).some((s) => s.messageId === messageId));
    if (pending) { const answered = await decisions.check(pending); if (answered) drain(); return reply(202, { ok: true, decision: answered ? pending.state : "pending" }); }
    if (Date.now() - Date.parse(msg.timestamp) > 15 * 60000) return reply(410, { error: "stale message" });
    if (msg.author.id === config.botId) {
      const meta = msg.interaction_metadata || msg.interaction || {};
      const footer = msg.embeds?.[0]?.footer?.text;
      const action = parseCommandFooter(footer);
      const commandName = meta.name || msg.interaction?.name;
      const slashCommand = commandName ? /^summon\b/.test(commandName) : meta.type === 2;
      if (!slashCommand || ![config.ownerId, ...config.staffIds].includes(meta.user?.id) || !["start", "stop"].includes(action)) return reply(403, { error: "invalid summon provenance" });
      if (action === "stop") {
        for (const j of Object.values(ledger.data.jobs)) if (j.channelId === ch.id && j.actorId === meta.user.id && j.kind === "command" && !["done", "cancelled"].includes(j.state)) j.state = "cancelled";
        if (ledger.data.conversations?.[ch.id]?.actorId === meta.user.id) delete ledger.data.conversations[ch.id];
        if (ledger.data.summonedChannels?.[ch.id]?.actorId === meta.user.id || meta.user.id === config.ownerId) {
          delete ledger.data.summonedChannels?.[ch.id];
          for (const key of Object.keys(ledger.data.participantLeases || {})) if (key.startsWith(`${ch.id}:`)) delete ledger.data.participantLeases[key];
          for (const j of Object.values(ledger.data.jobs)) if (j.kind === "conversation" && j.channelId === ch.id && !["done", "cancelled"].includes(j.state)) j.state = "cancelled";
        }
        ledger.save(); drain();
      } else gateway.ingest(ch, msg, { summonTask: { actor: meta.user.id, content: msg.embeds[0].description || "" } });
    } else gateway.ingest(ch, msg);
    drain(); return reply(200, { ok: true });
  } catch (e) { log(e.message); return reply(502, { error: redactSecrets(e.message) }); }
});
async function tick() {
  if (ticking) return;
  ticking = true;
  try { legacyHandoff(); broker.supportDirectiveTick(); try { digest(); } catch (e) { log(`digest: ${e.message}`); } drain(); await flushOutbox(); await scan(); const recovered = scanHealth.success(); if (recovered) log(`channel scan recovered after ${recovered} failed tick(s)`); drain(); ledger.data.heartbeat = Date.now(); ledger.save(); }
  catch (e) { log(`tick: ${e.message}`); if (scanHealth.failure(e)) ledger.notify(`scan-error:${new Date().toISOString().slice(0, 13)}`, "owner", "Keir channel scanning encountered an error and will retry: " + redactSecrets(e.message)); ledger.save(); }
  finally { ticking = false; }
}
ledger.recover();
server.listen(positive("KEIR_OPERATOR_PORT", 9765), "127.0.0.1", () => { log("Keir operator started"); tick(); });
// Every app request re-checks the caller's own ops session; nothing here trusts a header.
// Keir as the owner's personal agent: threads, activity, ideas, watches, memory.
const appAgent = createAppAgent({ ledger, config, app: appChannel, notebook, muse: appMuse, mcp, drain: () => drain() });
const publicationRecovery = require("./lib/operator/publication-recovery").createPublicationRecovery({ ledger, config, log });
publicationRecovery.tick().catch(e => log(`publication recovery: ${e.message}`));
setInterval(() => publicationRecovery.tick().catch(e => log(`publication recovery: ${e.message}`)), 60000).unref();
const effectRecovery = require("./lib/operator/effectrecovery").createEffectRecovery({ ledger, log,
  api: (endpoint) => ciApi([endpoint]),
  running: (job) => Object.values(active).some((s) => s?.job.id === job.id) });
setInterval(() => effectRecovery.tick().catch((e) => log(`effect recovery: ${e.message}`)), 5 * 60000).unref();
setInterval(() => { try { appAgent.tickWatches(); appMuse.tick(); } catch (e) { log(`app agent: ${e.message}`); } }, 60000).unref();
const appUpdates = require("./lib/operator/appupdates").createAppUpdates({ ledger, config });
const updateTick = () => { try { appUpdates.tick(); } catch (e) { log(`app updates: ${e.message}`); } };
updateTick();
setInterval(updateTick, 20000).unref();
const desktop = require("./lib/operator/desktop").createDesktopGateway({ mcp, readTools: JSON.parse(env.KEIR_DESKTOP_READ_TOOLS || "{}"), projects: () => { const file = env.KEIR_PROJECTS_MANIFEST; if (!file) return config.repositories; const entries = JSON.parse(fs.readFileSync(file, "utf8")).entries; // Only real repositories: git, a remote, not the infra/data/dormant "misc" category.
  return Object.fromEntries(Object.entries(entries).filter(([, project]) => project.git && project.remote && project.category !== "misc").map(([name, project]) => [name, project.path])); }, audit: tool => ledger.audit("desktop_tool", { tool }) });
const appServer = createAppServer({ app: appChannel, sessionExchangeUrl: env.KEIR_APP_SESSION_EXCHANGE_URL || "http://127.0.0.1:9788/api/auth/native-session", agentRoutes: async (...args) => (await desktop.route(...args)) ?? (await appPush.route(...args)) ?? (await appQuestions.route(...args)) ?? (await appComputer.route(...args)) ?? appAgent.route(...args), artifactsDir: path.join(config.stateDir, "artifacts"), log,
  authenticate: createAuthenticator({ config, checkUrl: env.KEIR_APP_AUTH_URL || "http://127.0.0.1:9788/api/auth/admin-check" }) });
appServer.listen(positive("KEIR_APP_PORT", 9768), "127.0.0.1", () => log("Keir app channel started"));
const appPush = createAppPush({ ledger, log, apns: createApns({ teamId: env.KEIR_APNS_TEAM_ID, keyId: env.KEIR_APNS_KEY_ID, keyFile: env.KEIR_APNS_KEY_FILE, topic: env.KEIR_APNS_TOPIC }) });
setInterval(() => { appPush.tick().catch((e) => log(`app push: ${e.message}`)); }, 5000).unref();
setInterval(() => { appComputer.cleanup().catch((e) => log(`app computer cleanup: ${e.message}`)); }, 5000).unref();
setInterval(tick, 20000);
// Private reflection runs independently so a provider wait cannot delay intake.
// Keep failures generic: diary contents never enter operational logs or APIs.
const diaryTick = () => diary.tick().catch(() => log("private diary update failed; retry in 30 minutes"));
diaryTick();
setInterval(diaryTick, 60000).unref();
setInterval(drain, 1000);
setInterval(() => flushOutbox().catch((e) => log(`outbox: ${e.message}`)), 1000);

// Housekeeping keeps state small: finished tasks lose their workspaces after
// an hour, unused shared checkouts after a day, artifacts after 30 days, and
// finished tickets leave the ledger for an archive file after 7 days, other
// finished tasks after six hours.
function housekeeping() {
  const d = ledger.data, now = Date.now(), terminal = ["done", "dismissed", "cancelled"];
  const finished = (id) => { const j = d.jobs[id]; return !j || (terminal.includes(j.state) && now - (j.updatedAt || j.at || 0) > 3600000); };
  const ws = path.join(config.stateDir, "workspaces"), bases = path.join(config.stateDir, "base"), art = path.join(config.stateDir, "artifacts");
  let freed = 0;
  for (const name of fs.existsSync(ws) ? fs.readdirSync(ws) : []) {
    const id = name.replace(/\.ov$/, "");
    if (/^[a-f0-9]{12}$/.test(id) && finished(id)) { sandbox.remove(id); freed++; }
  }
  const inUse = new Set();
  for (const name of fs.existsSync(ws) ? fs.readdirSync(ws).filter((n) => n.endsWith(".ov")) : []) { try { inUse.add(fs.readFileSync(path.join(ws, name, "base"), "utf8")); } catch {} }
  for (const name of fs.existsSync(bases) ? fs.readdirSync(bases) : []) {
    const dir = path.join(bases, name);
    if (!inUse.has(dir) && now - fs.statSync(dir).mtimeMs > 86400000) { fs.rmSync(dir, { recursive: true, force: true }); freed++; }
  }
  for (const name of fs.existsSync(art) ? fs.readdirSync(art) : []) {
    const file = path.join(art, name), age = now - fs.statSync(file).mtimeMs;
    if ((name.endsWith(".tar") && finished(name.slice(0, 12))) || age > 30 * 86400000) { fs.rmSync(file, { force: true }); freed++; }
  }
  const archived = [];
  for (const [id, j] of Object.entries(d.jobs)) {
    // A ticket can reopen onto its task, so it stays a week. Nothing reopens a
    // finished command, conversation, probe or coding task; six hours is enough
    // for the hub and review, and every ledger save rewrites the whole file.
    const keep = j.kind === "ticket" ? 7 * 86400000 : 6 * 3600000;
    if (terminal.includes(j.state) && now - (j.updatedAt || j.at || 0) > keep) { archived.push(JSON.stringify(j)); delete d.jobs[id]; }
  }
  if (archived.length) fs.appendFileSync(path.join(config.stateDir, "jobs-archive.jsonl"), archived.join("\n") + "\n", { mode: 0o600 });
  for (const [key, o] of Object.entries(d.outbox)) if (o.deliveredAt && now - o.deliveredAt > 7 * 86400000) delete d.outbox[key];
  if (freed || archived.length) { ledger.audit("housekeeping", { freed, archived: archived.length }); ledger.save(); log(`housekeeping: removed ${freed} paths, archived ${archived.length} tasks`); }
}
setTimeout(() => { try { housekeeping(); } catch (e) { log(`housekeeping: ${e.message}`); } }, 60000);
setInterval(() => { try { housekeeping(); } catch (e) { log(`housekeeping: ${e.message}`); } }, 3600000);

// Player posts are screened by Jev before Opus sees them. A decisive "no" is
// dropped without creating a task; "yes" or unsure becomes a candidate.
const screening = new Set();
setInterval(() => {
  const queue = ledger.data.screen || {};
  for (const [id, entry] of Object.entries(queue).sort((a, b) => a[1].at - b[1].at)) {
    if (screening.has(id)) continue;
    if (Date.now() - entry.at > 30 * 60000) { delete queue[id]; continue; }
    if (screening.size >= 4) break;
    screening.add(id);
    const transcript = (ledger.data.channelContext[entry.channel.id] || []).filter((r) => r.id !== id);
    screenReport({ transcript, message: { author: entry.source.author, content: entry.source.content || "", images: (entry.source.attachments || []).filter((a) => /^image\//.test(a.type || "")).length } })
      .then((v) => {
        delete queue[id];
        const stats = ledger.data.screenStats ||= {};
        const day = new Date().toISOString().slice(0, 10); stats[day] ||= { screened: 0, candidates: 0 }; stats[day].screened++;
        for (const k of Object.keys(stats).sort().slice(0, -14)) delete stats[k];
        if (!(v && !v.value) && !ledger.data.seen[entry.key]) {
          const job = ledger.createJob(entry.key, { kind: "candidate", role: "support", actorId: entry.actor, channelId: entry.channel.id, source: entry.source, deadline: Date.now() + config.taskLifetimeMs, screen: v ? v.probability : null });
          stats[day].candidates++;
          ledger.audit("screened", { job: job.id, p: v?.probability ?? null });
        }
        ledger.save(); drain();
      })
      .catch((e) => log(`screen: ${e.message}`))
      .finally(() => screening.delete(id));
  }
}, 1000);

// Ambiguous messages wait here for the fast "is this for Keir?" check, then
// re-enter the gateway with the verdict. Stale ones are dropped quietly.
const classify = createClassifier({ cwd: path.join(config.stateDir, "claude-cwd"), onVerdict: (v) => log(`classified via ${v.via}: ${v.forKeir}${v.probability !== undefined ? ` (${v.probability.toFixed(2)})` : ""}`) });
const classifying = new Set();
setInterval(() => {
  const queue = ledger.data.classify || {};
  for (const [id, entry] of Object.entries(queue).sort((a, b) => a[1].at - b[1].at)) {
    if (classifying.has(id)) continue;
    if (Date.now() - entry.at > 10 * 60000) { delete queue[id]; ledger.data.seen[`discord:${id}`] ||= "classify-expired"; ledger.save(); continue; }
    if (classifying.size >= 2) break;
    classifying.add(id);
    const transcript = (ledger.data.channelContext[entry.channel.id] || []).filter((r) => r.id !== id);
    const role = entry.message.author.id === config.ownerId ? "owner" : config.staffIds.includes(entry.message.author.id) ? "support" : "player";
    classify({ transcript, message: { author: entry.message.author.global_name || entry.message.author.username, role, content: entry.message.content || "" } })
      .then((forKeir) => {
        delete queue[id];
        ledger.audit("classified", { message: id, channel: entry.channel.id, forKeir });
        gateway.ingest(entry.channel, entry.message, { classified: forKeir });
        ledger.save(); drain();
      })
      .catch((e) => log(`classify: ${e.message}`))
      .finally(() => classifying.delete(id));
  }
}, 1000);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  stopping = true;
  for (const slot of Object.values(active)) slot?.controller.abort();
  server.close(); setTimeout(() => process.exit(0), 1500);
});
