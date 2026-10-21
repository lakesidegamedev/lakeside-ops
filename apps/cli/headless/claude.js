"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { redactSecrets } = require("./text");
async function invokeClaude(options) {
  if (!options.completionUrl) return invokeClaudeProcess(options);
  const messages = new Map(), finalUsage = new Set(); let currentMessage;
  const observe=(id,usage)=>{if(!id||!usage)return;const prior=messages.get(id)||{};messages.set(id,{...prior,...usage,output_tokens:Math.max(prior.output_tokens||0,usage.output_tokens||0)});};
  const transcript = path.join(options.stateDir, "claude-stream-" + require("node:crypto").randomUUID() + ".jsonl");
  const ended = await require("./completion").untilAcceptedFinish(signal => invokeClaudeProcess({ ...options, signal, streamed: true, onFrame: frame => {
    fs.appendFileSync(transcript, JSON.stringify(frame) + "\n", { mode: 0o600 });
    if(frame.type==="stream_event"){
      const event=frame.event;
      if(event?.type==="message_start"){currentMessage=event.message?.id;observe(currentMessage,event.message?.usage);}
      if(event?.type==="message_delta"&&event.usage){observe(currentMessage,event.usage);if(currentMessage)finalUsage.add(currentMessage);}
      if(event?.type==="message_stop")currentMessage=null;
    }
    if (frame.type === "assistant") observe(frame.message?.id,frame.message?.usage);
  } }), { ...options, settleCompletion: async () => {
    const deadline=Date.now()+750;
    while(!options.signal.aborted && Date.now()<deadline && (!messages.size || finalUsage.size!==messages.size)) await new Promise(resolve=>setTimeout(resolve,5));
  } });
  const usage = {};
  for (const u of messages.values()) {
    for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) if (Number.isFinite(u[key])) usage[key] = (usage[key] || 0) + u[key];
    if (u.cache_creation) for (const key of ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]) if (Number.isFinite(u.cache_creation[key])) {
      usage.cache_creation ||= {}; usage.cache_creation[key] = (usage.cache_creation[key] || 0) + u.cache_creation[key];
    }
  }
  if(!ended.completion)return{...ended.process,usage:ended.process.usage||usage,provenance:{...ended.process.provenance,transcript,accounting:ended.process.timedOut||ended.process.interrupted?"partial-streamed-assistant-messages":"streamed-message-deltas",messagesObserved:messages.size,messagesWithFinalUsage:finalUsage.size}};
  return { subtype: "success", is_error: false, result: ended.completion.summary, usage, num_turns: messages.size,
    provenance: { completion: "broker-receipt", transcript, accounting: messages.size && finalUsage.size===messages.size ? "streamed-message-deltas" : messages.size ? "partial-streamed-assistant-messages" : "unavailable", messagesObserved:messages.size, messagesWithFinalUsage:finalUsage.size } };
}
// Hybrid (2026-10-18): the model's own trained tools work the workspace, which the
// caller must already have confined (bwrap); the broker's MCP tools carry effects.
const NATIVE = "Bash,Read,Edit,Write,Glob,Grep";
async function invokeClaudeProcess({ spawnImpl, prompt, tools, url, maxTurns, timeoutMs, signal, model, effort, brief, stateDir, claudeBin, streamed, onFrame, toolsMode, worktree }) {
  const hybrid = toolsMode === "hybrid";
  const cwd = hybrid ? worktree : path.join(stateDir, "claude-cwd"); if (!hybrid) fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  // The broker supplies policy and grants. Host memories, plugins and user
  // instructions must not silently become an activation's task context.
  const home = fs.mkdtempSync(path.join(stateDir, "claude-home-"));
  fs.mkdirSync(path.join(home, ".claude"), { mode: 0o700 });
  const credentials = require("./host").credential(".claude/.credentials.json");
  if (fs.existsSync(credentials)) fs.symlinkSync(credentials, path.join(home, ".claude/.credentials.json"));
    const args = ["-p", "--system-prompt", brief, "--model", model, "--effort", effort,
      "--setting-sources", "", "--tools", hybrid ? NATIVE : "", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { keir: { type: "http", url } } }),
      "--allowedTools", [...(hybrid ? [NATIVE] : []), ...tools.map((t) => `mcp__keir__${t.name}`)].join(","), ...(hybrid ? ["--permission-mode", "dontAsk"] : []), "--max-turns", String(maxTurns), "--no-session-persistence", "--output-format", "json"];
    if (streamed) { args[args.length - 1] = "stream-json"; args.push("--verbose", "--include-partial-messages"); }
    const env = { HOME: home, PATH: require("./host").searchPath(), LANG: "C.UTF-8", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    return new Promise((resolve, reject) => {
      const child = spawnImpl(claudeBin || require("./host").bin("claude"), args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "", timedOut = false, partial = "";
      let termination;
      const kill = () => { termination ||= require("./process-tree").terminateTree(child.pid); };
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      signal.addEventListener("abort", kill, { once: true });
      if (signal.aborted) kill();
      child.stdout.on("data", (c) => { out += c; if (out.length > 4e6) kill(); if (onFrame) {
        partial += c; let end; while ((end = partial.indexOf("\n")) !== -1) { const line = partial.slice(0, end); partial = partial.slice(end + 1); try { onFrame(JSON.parse(line)); } catch {} }
      } });
      child.stderr.on("data", (c) => { err = (err + c).slice(-4000); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", async (code) => {
        await termination;
        clearTimeout(timer); signal.removeEventListener("abort", kill);
        if (timedOut) return resolve({ subtype: "error_max_turns", is_error: true, timedOut: true });
        // Killed by a signal (service restart, OOM): resume later, never fail the task.
        if (code === null && !signal.aborted) return resolve({ subtype: "error_max_turns", is_error: true, interrupted: true });
        if (signal.aborted) return reject(new Error("activation aborted"));
        try { resolve(JSON.parse(out.trim().split("\n").at(-1))); }
        catch { reject(new Error(`model request failed: claude exited ${code} ${redactSecrets(err).slice(-600)}`)); }
      });
      child.stdin.end(prompt);
    });
  }

module.exports = { invokeClaude };
