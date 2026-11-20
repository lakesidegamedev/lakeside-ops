"use strict";
// Keir private owner supervisor. A first-class owner session inside the ops web
// server, independent of the support operator: the owner's messages become
// durable jobs, a real model works them with sandboxed repository tools, and
// replies land in one persistent transcript. It never approves anything: a
// finished patch becomes a proposal the owner decides through an explicit,
// digest-bound request (see routes.js), never through chat text.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { createStore, sha } = require("./store");
const { createToolServer } = require("./toolserver");
const { redact } = require("./executor");

const OPEN = ["queued", "running"];
const TITLE = /^(fix|feat|chore|docs|refactor|test|perf)(\([a-z0-9._/-]{1,40}\))?: .{3,120}$/;
const TEST_FILE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,200}\.(?:test|spec)\.[cm]?js$/;
const MAX_UPDATES = 8;

function guardianStatus(dir, now = Date.now()) {
  const file = path.join(dir, "status.json");
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return { available: false, reason: e.code === "ENOENT" ? "guardian status file not found on this server" : `guardian status unreadable (${e.code || "invalid json"})` }; }
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, typeof o[k] === "string" ? o[k].slice(0, 300) : o[k]]));
  const at = Number(raw.at) || null;
  return {
    available: true, at: at ? new Date(at).toISOString() : null, ageSeconds: at ? Math.round((now - at) / 1000) : null,
    stale: at ? now - at > 10 * 60000 : true, healthy: raw.healthy === true, disabled: raw.disabled === true, dryRun: raw.dryRun === true,
    killSwitch: raw.killSwitchFilePresent === true,
    units: Object.fromEntries(Object.entries(raw.units || {}).slice(0, 12).map(([k, v]) => [k, pick(v, ["activeState", "status", "reason", "action", "restartsInWindow"])])),
    timers: Object.fromEntries(Object.entries(raw.timers || {}).slice(0, 12).map(([k, v]) => [k, pick(v, ["activeState", "status"])])),
    recentRestarts: (raw.restarts || []).slice(-5).map((r) => ({ at: r.at ? new Date(r.at).toISOString() : null, unit: String(r.unit || "").slice(0, 60), reason: String(r.reason || "").slice(0, 200) })),
    giveUps: (raw.giveUps || []).slice(-3).map((g) => (typeof g === "object" ? pick(g, ["at", "unit", "reason"]) : String(g).slice(0, 200))),
  };
}

const TOOLS = (repoKeys) => [
  { name: "open_workspace", description: "Open the isolated workspace for an allowlisted repository (a private clone at its base branch, separate from the live checkout). Reuses this session's existing workspace for the repo, with its earlier changes, unless fresh is true (the old changes are saved as a patch first). Call this before any file or command tool.",
    input_schema: { type: "object", properties: { repo: { type: "string", enum: repoKeys }, fresh: { type: "boolean" } }, required: ["repo"], additionalProperties: false } },
  { name: "list_files", description: "List files under a path in the open workspace (relative path, depth 1-4).", input_schema: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer", minimum: 1, maximum: 4 } }, additionalProperties: false } },
  { name: "read_file", description: "Read a file in the open workspace with line numbers. Use offset/limit for long files.", input_schema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 2000 } }, required: ["path"], additionalProperties: false } },
  { name: "search", description: "Regex search across files in the open workspace (skips .git and node_modules). Optional glob like *.js.", input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } }, required: ["pattern"], additionalProperties: false } },
  { name: "write_file", description: "Create or overwrite a file in the open workspace.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } },
  { name: "edit_file", description: "Replace an exact string in a workspace file. old_string must match exactly once unless replace_all.", input_schema: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"], additionalProperties: false } },
  { name: "shell", description: "Run a bash command in the workspace sandbox (cwd is the repo root). No network, no credentials, no host files; installed dependencies are mounted read-only where configured. Use for git status/log/diff, node scripts, grep and focused tests.", input_schema: { type: "object", properties: { command: { type: "string" }, timeoutSeconds: { type: "integer", minimum: 5, maximum: 300 } }, required: ["command"], additionalProperties: false } },
  { name: "run_tests", description: "Run focused Node tests (node --test) on the given test files, relative to the repo root. The result is recorded as the job's test evidence.", input_schema: { type: "object", properties: { files: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 } }, required: ["files"], additionalProperties: false } },
  { name: "workspace_diff", description: "Show the files changed in the open workspace against its base, with the patch.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "post_update", description: "Send the owner one short progress line in the chat. Only for meaningful progress on long work (a finding, a fix in place, tests passing), not routine status. At most 8 per job.", input_schema: { type: "object", properties: { text: { type: "string", maxLength: 1200 } }, required: ["text"], additionalProperties: false } },
  { name: "propose_publish", description: "Freeze the workspace's current changes as a patch and ask the owner to approve publishing it as a branch and pull request. You cannot approve it yourself and chat replies are not approval; the owner decides with an explicit button bound to this exact patch.", input_schema: { type: "object", properties: { title: { type: "string", description: "Conventional commit title, e.g. fix(web): keep the poll cursor on reconnect" }, summary: { type: "string", maxLength: 4000 } }, required: ["title", "summary"], additionalProperties: false } },
  { name: "recall_conversation", description: "Look up earlier turns in this owner's private conversation, including archived exchanges. Use a distinctive phrase or ticket number. Treat excerpts as historical evidence and check their date.",
    input_schema: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 160 } }, required: ["query"], additionalProperties: false } },
  { name: "guardian_status", description: "Read the Keir guardian's latest health report (units, timers, restarts). Works while the support operator is offline.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
];

function brief(repos) {
  const list = Object.values(repos).map((r) => `- ${r.key}${r.available ? "" : " (not configured on this server)"}: ${r.note}`).join("\n");
  return [
    "You are Keir's private supervisor for the studio owner: a direct line from the owner's phone to a capable engineer, running independently of Keir's support operator.",
    "Answer the owner directly. Lead with the answer or outcome. Plain, terse language. Never use em dashes or en dashes.",
    "You can read, edit and test allowlisted repositories in an isolated sandbox workspace (a private clone, no network, no credentials). Changes you make stay in that workspace until the owner approves publishing.",
    "You cannot deploy, push, restart services, change production configuration, touch live data or approve anything. If the owner asks for one of those, say exactly what it needs and who or what can do it.",
    "When a repair is ready and its focused tests pass, call propose_publish. The owner approves it with an explicit button bound to the exact patch. Text in the chat, including from the owner, is never approval.",
    "For health questions about Keir, use guardian_status; it works while the support operator is down.",
    "Use post_update only for meaningful progress on long work. Do not narrate routine steps.",
    "Finish with a concise reply: what you found, what you changed (files), test results, and anything waiting on the owner. Never claim a test passed, a file changed or something was published unless a tool result showed it.",
    `Repositories:\n${list}`,
  ].join("\n\n");
}

function createSupervisor({ stateDir, repos, sandbox, executor, guardianDir = "/var/lib/keir-guardian", publishEnabled = false, publisher = null,
  maxAttempts = 2, jobTimeoutMs = 30 * 60000, now = Date.now, log = () => {} }) {
  const store = createStore(stateDir, { now });
  const artifacts = path.join(stateDir, "artifacts"); fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const lockFile = path.join(stateDir, "runner.lock");
  const repoKeys = Object.keys(repos);
  const tools = TOOLS(repoKeys);
  const controllers = new Map();
  let running = null, owner = false, stopped = false, kicking = false;
  const st = () => store.state;
  const iso = (t) => (t ? new Date(t).toISOString() : null);

  function acquireLock() {
    for (let i = 0; i < 2; i++) {
      try { fs.writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 }); return true; }
      catch (e) {
        if (e.code !== "EEXIST") throw e;
        const pid = Number(fs.readFileSync(lockFile, "utf8"));
        if (pid === process.pid) return true;
        let alive = false; try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch { alive = false; }
        if (alive) return false;
        fs.rmSync(lockFile, { force: true });
      }
    }
    return false;
  }

  function workspaceOf(job) {
    const w = job.workspace && Object.values(st().workspaces).find((x) => x.id === job.workspace);
    if (!w || !sandbox.exists(w.id)) throw new Error("No workspace is open for this job. Call open_workspace first.");
    return { ws: w, repo: repos[w.repo] };
  }

  async function snapshot(wsId, repo, label) {
    try {
      const d = await sandbox.op(wsId, repo, "diff", { patch: true });
      if (!d.files.length) return { files: [], patch: null };
      const name = `${wsId}-${label}-${Date.now()}.patch`;
      fs.writeFileSync(path.join(artifacts, name), d.patch, { mode: 0o600 });
      return { files: d.files, patch: name };
    } catch (e) { return { files: [], patch: null, error: e.message }; }
  }

  async function call(job, name, input, signal) {
    const live = st().jobs[job.id] || job;
    if (name === "recall_conversation") return store.recall(input.query, st().messages.find((m) => m.jobId === job.id)?.seq ?? st().seq, signal);
    if (name === "guardian_status") return guardianStatus(guardianDir, now());
    if (name === "post_update") {
      if ((live.updates || 0) >= MAX_UPDATES) throw new Error("Update limit reached for this job; put the rest in your final reply.");
      const text = String(input.text || "").trim().replace(/[\u2013\u2014]/g, ", ").slice(0, 1200);
      if (!text) throw new Error("text is required");
      live.updates = (live.updates || 0) + 1;
      store.append({ role: "supervisor", kind: "update", text, jobId: live.id }); store.save();
      return { posted: true };
    }
    if (name === "open_workspace") {
      const repo = repos[input.repo];
      if (!repo) throw new Error(`unknown repository; allowlisted: ${repoKeys.join(", ")}`);
      if (!repo.available) throw new Error(`repository ${repo.key} is not configured on this server (${repo.reason})`);
      const existing = st().workspaces[repo.key];
      if (existing && sandbox.exists(existing.id) && !input.fresh) {
        live.workspace = existing.id; live.repo = repo.key; existing.lastJob = live.id; store.save();
        const d = await sandbox.op(existing.id, repo, "diff", { patch: false }, { signal });
        return { workspace: existing.id, repo: repo.key, base: `origin/${repo.base}`, commit: existing.commit.slice(0, 12), reused: true, changedFiles: d.files,
          note: d.files.length ? "This workspace already holds earlier changes from this session. Review them with workspace_diff before building on them." : "Clean workspace at the base commit." };
      }
      let saved = null;
      if (existing && sandbox.exists(existing.id)) { saved = await snapshot(existing.id, repo, "replaced"); sandbox.remove(existing.id); }
      const wsId = `w_${crypto.randomBytes(8).toString("hex")}`;
      const prepared = await sandbox.prepare(wsId, repo);
      st().workspaces[repo.key] = { id: wsId, repo: repo.key, base: repo.base, commit: prepared.commit, createdAt: now(), lastJob: live.id };
      live.workspace = wsId; live.repo = repo.key; store.save();
      return { workspace: wsId, repo: repo.key, base: `origin/${repo.base}`, commit: prepared.commit.slice(0, 12), reused: false,
        ...(saved?.patch ? { previousChangesSavedAs: saved.patch, previousFiles: saved.files } : {}) };
    }
    const { ws, repo } = workspaceOf(live);
    if (name === "list_files") return sandbox.op(ws.id, repo, "list", { path: input.path || ".", depth: input.depth }, { signal });
    if (name === "read_file") return sandbox.op(ws.id, repo, "read", input, { signal });
    if (name === "search") return sandbox.op(ws.id, repo, "search", input, { signal });
    if (name === "write_file") return sandbox.op(ws.id, repo, "write", input, { signal });
    if (name === "edit_file") return sandbox.op(ws.id, repo, "edit", input, { signal });
    if (name === "workspace_diff") return sandbox.op(ws.id, repo, "diff", { patch: true }, { signal });
    if (name === "shell") {
      const r = await sandbox.shell(ws.id, repo, String(input.command || ""), { timeoutMs: Math.min(300, Math.max(5, Number(input.timeoutSeconds) || 120)) * 1000, signal });
      return { exitCode: r.code, timedOut: r.timedOut, truncated: r.truncated, output: r.output.slice(-20000) };
    }
    if (name === "run_tests") {
      const files = Array.isArray(input.files) ? input.files : [];
      if (!files.length || files.some((f) => typeof f !== "string" || !TEST_FILE.test(f))) throw new Error("files must be relative test file paths ending in .test.js, .spec.js, .test.mjs or similar");
      const quoted = files.map((f) => `'${f}'`).join(" ");
      const r = await sandbox.shell(ws.id, repo, `/opt/keir-runtime/node --test --test-reporter=spec -- ${quoted} 2>&1`, { timeoutMs: 300000, signal });
      const count = (k) => Number((new RegExp(`^\\S*\\s*${k} (\\d+)`, "m").exec(r.output) || [])[1] || 0);
      const result = { passed: r.code === 0 && !r.timedOut, exitCode: r.code, timedOut: r.timedOut, tests: count("tests"), pass: count("pass"), fail: count("fail"), files };
      live.tests = { ...result, at: now(), workspace: ws.id };
      store.save();
      return { ...result, output: r.output.slice(-12000) };
    }
    if (name === "propose_publish") {
      const title = String(input.title || "").trim();
      if (!TITLE.test(title)) throw new Error("title must be a conventional commit title, e.g. fix(web): keep the poll cursor on reconnect");
      const d = await sandbox.op(ws.id, repo, "diff", { patch: true }, { signal });
      if (!d.files.length) throw new Error("The workspace has no changes to publish.");
      if (/(?:new file mode|new mode) 120000|GIT binary patch/.test(d.patch)) throw new Error("Symlinks and binary changes cannot be published through this route.");
      if (Buffer.byteLength(d.patch) > 2 * 1024 * 1024) throw new Error("Patch is larger than 2 MB; split the change.");
      if (redact(d.patch) !== d.patch) throw new Error("The patch contains something that looks like a credential. Remove it first.");
      const digest = sha(d.patch);
      for (const p of Object.values(st().proposals)) if (p.state === "pending" && p.workspace === ws.id) { p.state = "superseded"; p.decidedAt = now(); }
      const proposal = { id: `p_${crypto.randomBytes(8).toString("hex")}`, jobId: live.id, repo: repo.key, workspace: ws.id, baseCommit: ws.commit,
        title, summary: String(input.summary || "").slice(0, 4000), files: d.files.slice(0, 200), digest, state: "pending", createdAt: now(),
        tests: live.tests && live.tests.workspace === ws.id ? `node --test ${live.tests.files.join(" ")}: ${live.tests.passed ? "passed" : "FAILED"} (pass ${live.tests.pass}, fail ${live.tests.fail})` : "no focused test recorded in this job" };
      fs.writeFileSync(path.join(artifacts, `${proposal.id}.patch`), d.patch, { mode: 0o600 });
      st().proposals[proposal.id] = proposal;
      store.append({ role: "supervisor", kind: "approval", proposalId: proposal.id, jobId: live.id,
        text: `Approval needed to publish "${title}" to ${repo.key} (${d.files.length} file${d.files.length === 1 ? "" : "s"}: ${d.files.slice(0, 6).join(", ")}${d.files.length > 6 ? ", ..." : ""}). Tests: ${proposal.tests}. Approve or reject it with the proposal buttons; a chat reply is not approval. Patch ${digest.slice(0, 12)}.` });
      store.save();
      return { proposal: proposal.id, digest, state: "pending", files: d.files, publishing: publishEnabled ? "approval publishes a branch and pull request" : "publishing is not enabled on this server; the owner can still review and the patch is saved" };
    }
    throw new Error(`unknown tool ${name}`);
  }

  const toolServer = createToolServer({ tools, call });

  function context(job) {
    const rows = st().messages.filter((m) => m.seq < job.messageSeq).slice(-40);
    const lines = []; let size = 0;
    for (const m of rows.reverse()) {
      const line = `[${m.role === "owner" ? "owner" : "you"}${m.kind && m.kind !== "message" && m.kind !== "answer" ? ` ${m.kind}` : ""}] ${m.text.slice(0, 1500)}`;
      if (size + line.length > 14000) break;
      lines.unshift(line); size += line.length;
    }
    const spaces = Object.values(st().workspaces).map((w) => `- ${w.repo}: workspace ${w.id} at ${w.commit.slice(0, 12)} (base origin/${w.base})`).join("\n") || "- none yet";
    const owner = st().messages.find((m) => m.id === job.messageId);
    return [
      `Session ${st().session}. Now ${new Date(now()).toISOString()}.`,
      `## Conversation so far (oldest first)\n${lines.join("\n") || "(this is the first message)"}`,
      `## Open workspaces\n${spaces}`,
      ...(job.resumeNote ? [`## Resume note\nAttempt ${job.attempts} of ${maxAttempts}. ${job.resumeNote} Continue from the current workspace state; check workspace_diff first and do not redo finished steps.`] : []),
      `## The owner's message\n${owner ? owner.text : "(message missing)"}`,
    ].join("\n\n");
  }

  function finish(job, state, fields = {}) {
    Object.assign(job, { state, finishedAt: now() }, fields);
    controllers.delete(job.id);
  }

  async function execute(job) {
    const ac = new AbortController(); controllers.set(job.id, ac);
    const exec = executor.available();
    if (!exec.available) {
      finish(job, "blocked", { reason: exec.reason });
      store.append({ role: "supervisor", kind: "error", jobId: job.id, text: `I could not start the model on this server: ${exec.reason}. Your message is saved and nothing was changed. Send it again once the model is available.` });
      store.save(); return;
    }
    const session = await toolServer.open(job, ac.signal);
    let r;
    try {
      r = await executor.run({ brief: brief(repos), prompt: context(job), toolUrl: session.url, toolNames: tools.map((t) => t.name), signal: ac.signal, timeoutMs: jobTimeoutMs, stateDir });
    } catch (e) { r = e.unavailable ? { unavailable: e.message } : { interrupted: true, reason: e.message }; }
    finally { session.close(); }
    if (r.unavailable) {
      finish(job, "blocked", { reason: r.unavailable });
      store.append({ role: "supervisor", kind: "error", jobId: job.id, text: `I could not start the model on this server: ${r.unavailable}. Your message is saved and nothing was changed.` });
      store.save(); return;
    }
    let changed = [];
    if (job.workspace && sandbox.exists(job.workspace)) {
      try { changed = (await sandbox.op(job.workspace, repos[job.repo], "diff", { patch: false })).files; } catch { /* reported below if relevant */ }
    }
    if (job.state === "cancelled" || r.cancelled) {
      finish(job, "cancelled", { changedFiles: changed });
      store.append({ role: "supervisor", kind: "notice", jobId: job.id, text: `Stopped as asked.${changed.length ? ` The workspace keeps ${changed.length} changed file(s): ${changed.slice(0, 6).join(", ")}.` : ""}` });
      store.save(); return;
    }
    if (r.text && !r.interrupted && !r.timedOut) {
      finish(job, "done", { changedFiles: changed, usage: r.usage || null });
      store.append({ role: "supervisor", kind: "answer", jobId: job.id, text: r.text.replace(/[\u2013\u2014]/g, ", ").trim() });
      store.save(); return;
    }
    const reason = r.timedOut ? `it ran past the ${Math.round(jobTimeoutMs / 60000)} minute limit` : (r.reason || "the model returned no answer");
    const kept = job.workspace && sandbox.exists(job.workspace) ? await snapshot(job.workspace, repos[job.repo], `attempt${job.attempts}`) : { files: [] };
    (job.preserved ||= []).push({ attempt: job.attempts, reason: String(reason).slice(0, 300), files: kept.files, patch: kept.patch, at: now() });
    const keptLine = kept.files.length ? ` The workspace kept ${kept.files.length} changed file(s) (${kept.files.slice(0, 6).join(", ")}), also saved as ${kept.patch}.` : "";
    if (job.attempts < maxAttempts && !r.timedOut) {
      job.state = "queued"; job.resumeNote = `The previous attempt stopped partway because ${reason}.${keptLine}`;
      controllers.delete(job.id);
      store.append({ role: "supervisor", kind: "notice", jobId: job.id, text: `The model stopped partway (${reason}). Resuming from the saved workspace.${keptLine}` });
    } else {
      finish(job, "failed", { reason, changedFiles: kept.files });
      store.append({ role: "supervisor", kind: "error", jobId: job.id, text: `I could not finish this: ${reason}.${keptLine} Ask me to continue and I will pick up from the workspace.` });
    }
    store.save();
  }

  async function kick() {
    if (kicking || stopped || !owner) return;
    kicking = true;
    try {
      for (;;) {
        if (stopped) break;
        const next = st().jobOrder.map((id) => st().jobs[id]).find((j) => j?.state === "queued");
        if (!next) break;
        running = next; next.state = "running"; next.attempts += 1; next.startedAt = now(); store.save();
        try { await execute(next); }
        catch (e) {
          log(`keir-supervisor: job ${next.id} failed unexpectedly: ${e.message}`);
          finish(next, "failed", { reason: e.message });
          store.append({ role: "supervisor", kind: "error", jobId: next.id, text: `Something went wrong running this request: ${redact(e.message).slice(0, 300)}. Your message is saved.` });
          store.save();
        } finally { running = null; }
      }
    } finally { kicking = false; }
  }

  // Recover after a restart: a job that was running when the process died is
  // resumed from its workspace (or failed after the attempt limit).
  async function start() {
    owner = acquireLock();
    if (!owner) { log("keir-supervisor: another process owns the runner lock; this instance stays passive"); return { owner }; }
    // No model run can be alive before this process starts one: scratch homes
    // left by a crash are removed (rmSync does not follow the credential link).
    fs.rmSync(path.join(stateDir, "model-homes"), { recursive: true, force: true });
    const interrupted = Object.values(st().jobs).filter((j) => j.state === "running");
    for (const job of interrupted) {
      const kept = job.workspace && sandbox.exists(job.workspace) ? await snapshot(job.workspace, repos[job.repo], `restart${job.attempts}`) : { files: [] };
      (job.preserved ||= []).push({ attempt: job.attempts, reason: "web service restarted", files: kept.files, patch: kept.patch, at: now() });
      const keptLine = kept.files.length ? ` The workspace kept ${kept.files.length} changed file(s): ${kept.files.slice(0, 6).join(", ")}.` : "";
      if (job.attempts < maxAttempts) {
        job.state = "queued"; job.resumeNote = `The web service restarted during the previous attempt.${keptLine}`;
        store.append({ role: "supervisor", kind: "notice", jobId: job.id, text: `The server restarted while I was working on this. Resuming from the saved workspace.${keptLine}` });
      } else {
        finish(job, "failed", { reason: "web service restarted after the last attempt", changedFiles: kept.files });
        store.append({ role: "supervisor", kind: "error", jobId: job.id, text: `The server restarted during my last attempt at this.${keptLine} Ask me to continue and I will pick up from the workspace.` });
      }
    }
    for (const p of Object.values(st().proposals)) if (p.state === "publishing") { p.state = "failed"; p.error = "web service restarted while publishing; check the branch before retrying"; }
    if (interrupted.length) store.save();
    setImmediate(() => kick());
    return { owner, recovered: interrupted.length };
  }

  function post(text, clientId) {
    if (!owner) throw Object.assign(new Error("The supervisor runner is owned by another web process."), { status: 503 });
    const body = String(text || "").trim();
    if (!body || body.length > 8000) throw Object.assign(new Error("text must be 1-8000 characters"), { status: 400 });
    if (typeof clientId !== "string" || !/^[A-Za-z0-9_.:-]{8,128}$/.test(clientId)) throw Object.assign(new Error("clientId must be 8-128 characters of letters, digits, _ . : -"), { status: 400 });
    const seen = st().clientIds[clientId];
    if (seen) {
      if (seen.textHash !== sha(body)) throw Object.assign(new Error("clientId was already used for a different message"), { status: 409 });
      return { accepted: true, duplicate: true, ...receipt(seen.messageId, seen.jobId) };
    }
    const message = store.append({ role: "owner", kind: "message", text: body, clientId });
    const job = store.addJob({ messageId: message.id, messageSeq: message.seq });
    message.jobId = job.id;
    st().clientIds[clientId] = { messageId: message.id, jobId: job.id, textHash: sha(body), at: now() };
    store.save();
    setImmediate(() => kick());
    return { accepted: true, duplicate: false, ...receipt(message.id, job.id) };
  }

  function jobView(job) {
    if (!job) return null;
    return { id: job.id, state: job.state, attempts: job.attempts, repo: job.repo || null, workspace: job.workspace || null, changedFiles: job.changedFiles || [],
      reason: job.reason || null, createdAt: iso(job.createdAt), startedAt: iso(job.startedAt), finishedAt: iso(job.finishedAt),
      tests: job.tests ? { passed: job.tests.passed, pass: job.tests.pass, fail: job.tests.fail, files: job.tests.files } : null,
      preserved: (job.preserved || []).map((p) => ({ attempt: p.attempt, reason: p.reason, files: p.files })) };
  }

  function receipt(messageId, jobId) {
    const message = st().messages.find((m) => m.id === messageId);
    const job = st().jobs[jobId];
    const queued = st().jobOrder.map((id) => st().jobs[id]).filter((j) => j && OPEN.includes(j.state));
    return { message: message ? messageView(message) : { id: messageId }, job: job ? { ...jobView(job), queuePosition: Math.max(0, queued.findIndex((j) => j.id === jobId)) } : { id: jobId } };
  }

  function messageView(m) {
    return { id: m.id, seq: m.seq, role: m.role, kind: m.kind || "message", text: m.text, at: iso(m.at), jobId: m.jobId || null,
      ...(m.clientId ? { clientId: m.clientId } : {}), ...(m.proposalId ? { proposalId: m.proposalId } : {}) };
  }

  function proposalView(p) {
    return { id: p.id, jobId: p.jobId, repo: p.repo, state: p.state, title: p.title, summary: p.summary, files: p.files, digest: p.digest, tests: p.tests,
      createdAt: iso(p.createdAt), decidedAt: iso(p.decidedAt), ...(p.branch ? { branch: p.branch } : {}), ...(p.prUrl ? { prUrl: p.prUrl } : {}), ...(p.error ? { error: p.error } : {}) };
  }

  function proposals() {
    return Object.values(st().proposals).sort((a, b) => (a.state === "pending") === (b.state === "pending") ? b.createdAt - a.createdAt : a.state === "pending" ? -1 : 1).slice(0, 20).map(proposalView);
  }

  function thread({ after = null, limit = 50 } = {}) {
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    const rows = after === null ? st().messages.slice(-n) : st().messages.filter((m) => m.seq > after).slice(0, n);
    const jobs = st().jobOrder.map((id) => st().jobs[id]).filter(Boolean);
    const open = jobs.filter((j) => OPEN.includes(j.state));
    return { messages: rows.map(messageView), cursor: rows.length ? rows.at(-1).seq : (after ?? st().seq), latest: st().seq, archived: st().archived,
      working: open.length > 0, version: String(st().rev), session: st().session,
      current: jobView(jobs.find((j) => j.state === "running")), queued: open.filter((j) => j.state === "queued").length,
      jobs: jobs.slice(-10).reverse().map(jobView), proposals: proposals().filter((p) => p.state === "pending"), executor: executor.available() };
  }

  function cancel(jobId) {
    const job = st().jobs[jobId];
    if (!job) throw Object.assign(new Error("job not found"), { status: 404 });
    if (!OPEN.includes(job.state)) throw Object.assign(new Error(`job is already ${job.state}`), { status: 409 });
    if (job.state === "queued") {
      finish(job, "cancelled");
      store.append({ role: "supervisor", kind: "notice", jobId: job.id, text: "Cancelled before I started on it." });
    } else { job.state = "cancelled"; controllers.get(job.id)?.abort(); }
    store.save();
    return { cancelled: true, job: jobView(job) };
  }

  async function decide(proposalId, verdict, digest) {
    const p = st().proposals[proposalId];
    if (!p) throw Object.assign(new Error("proposal not found"), { status: 404 });
    if (!["approve", "reject"].includes(verdict)) throw Object.assign(new Error("verdict must be approve or reject"), { status: 400 });
    if (typeof digest !== "string" || digest !== p.digest) throw Object.assign(new Error("digest does not match this proposal's patch"), { status: 409 });
    if (p.state !== "pending") throw Object.assign(new Error(`proposal is already ${p.state}`), { status: 409 });
    if (verdict === "reject") {
      Object.assign(p, { state: "rejected", decidedAt: now(), decidedVia: "owner-request" });
      store.append({ role: "supervisor", kind: "notice", proposalId: p.id, jobId: p.jobId, text: `Rejected "${p.title}". Nothing was published; the workspace keeps the changes.` });
      store.save(); return { proposal: proposalView(p) };
    }
    if (!publishEnabled || !publisher) throw Object.assign(new Error("Publishing is not enabled on this server. The patch stays saved and the proposal stays pending."), { status: 409, proposal: proposalView(p) });
    const repo = repos[p.repo];
    if (!repo?.available) throw Object.assign(new Error(`repository ${p.repo} is not configured on this server`), { status: 409 });
    const file = path.join(artifacts, `${p.id}.patch`);
    const patch = fs.readFileSync(file, "utf8");
    if (sha(patch) !== p.digest) throw Object.assign(new Error("saved patch no longer matches its digest; refusing to publish"), { status: 409 });
    Object.assign(p, { state: "publishing", decidedAt: now(), decidedVia: "owner-request" }); store.save();
    try {
      const out = await publisher({ proposal: p, patchFile: file, repo, workDir: path.join(stateDir, "publish") });
      Object.assign(p, { state: "published", branch: out.branch, prUrl: out.prUrl || null });
      store.append({ role: "supervisor", kind: "notice", proposalId: p.id, jobId: p.jobId, text: `Published "${p.title}" as branch ${out.branch}${out.prUrl ? `, pull request ${out.prUrl}` : ""}. Nothing was merged or deployed.` });
    } catch (e) {
      Object.assign(p, { state: "failed", error: redact(e.message).slice(0, 500) });
      store.append({ role: "supervisor", kind: "error", proposalId: p.id, jobId: p.jobId, text: `Publishing "${p.title}" failed: ${p.error}. The patch is still saved.` });
    }
    store.save();
    return { proposal: proposalView(p) };
  }

  function status() {
    return { owner, queued: Object.values(st().jobs).filter((j) => j.state === "queued").length, running: running ? jobView(running) : null, session: st().session };
  }

  function stop() { stopped = true; for (const c of controllers.values()) c.abort(); toolServer.close(); if (owner) { try { if (Number(fs.readFileSync(lockFile, "utf8")) === process.pid) fs.rmSync(lockFile, { force: true }); } catch { /* gone */ } } }

  async function idle(timeoutMs = 60000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (!kicking && !Object.values(st().jobs).some((j) => OPEN.includes(j.state))) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  return { start, post, thread, cancel, decide, proposals, status, stop, idle, store, waitForChange: store.waitForChange, get owner() { return owner; }, guardian: () => guardianStatus(guardianDir, now()), tools };
}

// Host-side publisher. Runs only after an owner decision bound to the frozen
// patch digest. It never runs git inside the model's workspace: it applies the
// frozen patch to a fresh clone of the source, commits with hooks disabled,
// pushes one new branch, and opens a pull request when a GitHub slug is set.
function createPublisher({ git = "/usr/bin/git", gh = "gh", env = process.env } = {}) {
  const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 120000, maxBuffer: 8e6, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, ...opts },
    (e, out, err) => (e ? reject(new Error(redact(String(err || e.message)).trim().slice(-500))) : resolve(String(out).trim()))));
  return async function publish({ proposal, patchFile, repo, workDir }) {
    const dir = path.join(workDir, proposal.id);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const branch = `keir-supervisor/${proposal.id}`;
    try {
      const remote = await run(git, ["-C", repo.source, "remote", "get-url", "origin"]);
      await run(git, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", "--", repo.source, dir], { timeout: 300000 });
      await run(git, ["-C", dir, "checkout", "--quiet", "-b", branch, proposal.baseCommit]);
      await run(git, ["-C", dir, "apply", "--index", "--whitespace=nowarn", patchFile]);
      const message = `${proposal.title}\n\n${proposal.summary}\n\nPrepared by the Keir private supervisor (${proposal.id}); published after the owner's explicit approval of patch ${proposal.digest.slice(0, 12)}.`;
      await run(git, ["-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Keir supervisor", "-c", "user.email=keir-supervisor@users.noreply.github.com", "commit", "--quiet", "--no-verify", "-m", message]);
      await run(git, ["-C", dir, "-c", "core.hooksPath=/dev/null", "push", "--quiet", "--no-verify", remote, `HEAD:refs/heads/${branch}`], { timeout: 180000 });
      let prUrl = null;
      if (repo.github) prUrl = (await run(gh, ["pr", "create", "--repo", repo.github, "--base", repo.base, "--head", branch, "--title", proposal.title, "--body", `${proposal.summary}\n\nTests: ${proposal.tests}\n\nPrepared by the Keir private supervisor and published after the owner's explicit approval.`], { cwd: dir })).split("\n").find((l) => /^https:\/\//.test(l)) || null;
      return { branch, prUrl };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

module.exports = { createSupervisor, createPublisher, guardianStatus, TOOLS, brief };
