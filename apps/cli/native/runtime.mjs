import { withVpsCredential } from "../vps-profile.mjs";
import { loadedProjects, loadProject, unloadProject, workspaceStatus, workspaceInstructions } from "../workspace/session.mjs";
// @ts-check
import { deadline } from "./deadline.mjs";
import fs from "node:fs";
import { loadConnections } from "../integrations/mcp.mjs";
import { connectAgent } from "./transport.mjs";
import { newRun, readRun, saveRun, claimRun } from "./store.mjs";
import { PermissionBroker } from "./permissions.mjs";
import { applyUpdate } from "./updates.mjs";
import { carryContext, nativeInstructions } from "./context.mjs";

/** @typedef {{backend: import('./backends.mjs').Backend, directory: string, runId?: string, model?: string, carry?: string}} Options */
/** @param {Options} options @param {NodeJS.ProcessEnv} [env] */
export function createNativeRuntime(options, env = process.env) {
  env = withVpsCredential(env);
  const directory = fs.realpathSync(options.directory);
  const run = options.runId ? readRun(options.runId, env) : newRun(options.backend.id, directory);
  if (run.backend !== options.backend.id || run.directory !== directory) throw new Error("A run can only resume with its original backend and project. Use --carry for an explicit task transfer.");
  if (options.runId && !run.sessionId) throw new Error("Original session creation is uncertain. No replacement was created; inspect the native backend before starting fresh.");
  if (["running", "permission", "starting"].includes(run.state) && options.runId) { run.state = "uncertain"; run.error = "Prior process stopped without a final response. Reconcile before continuing."; }
  const originalState = run.state;
  const instructions = nativeInstructions(carryContext(options.carry, env), env);
  const permissions = new PermissionBroker();
  let closing = false, loading = Boolean(options.runId), busy = false, creating = false;
  /** @type {Promise<void> | undefined} */
  let closed;
  /** @type {import('@agentclientprotocol/sdk').NewSessionResponse['configOptions']} */
  let configOptions;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const persist = () => { if (timer) clearTimeout(timer); timer = undefined; saveRun(run, env); };
  const changed = () => { if (!closing && !timer) timer = setTimeout(persist, 200); };
  const release = claimRun(run.id, env);
  try { persist(); } catch (error) { release(); throw error; }
  /** @type {ReturnType<typeof connectAgent>} */
  let agent;
  try { agent = connectAgent(options.backend, directory, {
    projectRoots: () => loadedProjects(run.id, env).filter(project => { try { return fs.realpathSync(project.directory) === project.directory; } catch { return false; } }).map(project => project.directory),
    update(event) { if (!loading && (!run.sessionId || event.sessionId === run.sessionId)) { applyUpdate(run, event); changed(); } },
    permission(request, signal) {
      if (request.sessionId !== run.sessionId || closing) return Promise.resolve({ outcome: { outcome: "cancelled" } });
      run.state = "permission"; persist();
      return permissions.ask(request, signal, () => { if (!closing) { run.state = permissions.pending.size ? "permission" : "running"; persist(); } });
    },
  }, env); } catch (error) { release(); throw error; }
  const ready = (async () => {
    try {
      const init = await agent.initialize();
      if (init.protocolVersion !== 1) throw new Error("Backend does not support ACP protocol version 1");
      const configured = loadConnections(env);
      const enabled = configured.filter(row => !row.tokenEnv || env[row.tokenEnv]);
      if (enabled.length && !init.agentCapabilities?.mcpCapabilities?.http) throw new Error("This backend does not advertise HTTP MCP support. No configured MCP tools were silently omitted.");
      const mcpServers = enabled.map(row => ({ type: /** @type {const} */ ("http"), name: row.id, url: row.url, headers: row.tokenEnv ? row.auth === "cookie" ? [{ name: "Cookie", value: `${row.cookieName || "ops_session"}=${env[row.tokenEnv]}` }] : [{ name: "Authorization", value: `Bearer ${env[row.tokenEnv]}` }] : [] }));
      const expire = () => agent.connection.close(new Error("Native session negotiation timed out"));
      const session = options.runId
        ? (init.agentCapabilities?.loadSession ? await deadline(agent.loadSession({ sessionId: /** @type {string} */ (run.sessionId), cwd: directory, mcpServers }), 30000, expire) : (() => { throw new Error("Backend cannot load its original session. No replacement was created."); })())
        : await (() => { creating = true; return deadline(agent.newSession({ cwd: directory, mcpServers }), 30000, expire); })();
      if ("sessionId" in session && typeof session.sessionId === "string") run.sessionId = session.sessionId;
      persist();
      configOptions = session.configOptions;
      if (options.model) {
        const config = session.configOptions?.find(option => option.category === "model" || option.id === "model");
        if (config) await deadline(agent.connection.agent.request("session/set_config_option", { sessionId: /** @type {string} */ (run.sessionId), configId: config.id, value: options.model }), 15000, expire);
        else throw new Error("Backend did not advertise model selection. No alternative model was selected.");
        run.model = options.model;
      }
      const selected = configOptions?.find(option => option.category === "model" || option.id === "model");
      if (!options.model && selected && typeof selected.currentValue === "string") run.model = selected.currentValue;
      loading = false;
      run.state = options.runId ? originalState : "idle";
      persist();
    } catch (error) {
      if (closing) throw error;
      run.state = creating && !run.sessionId ? "uncertain" : "failed";
      run.error = error instanceof Error ? error.message : "Native backend setup failed";
      persist(); throw error;
    }
  })();
  void ready.catch(() => {});
  void agent.connection.closed.then(() => {
    if (closing || busy || run.error) return;
    run.error = "Native backend disconnected. Resume explicitly; no prompt was replayed.";
    if (run.state === "idle") run.state = "failed";
    persist();
  });
  return {
    ready,
    /** @returns {import('./contracts.js').Snapshot} */
    snapshot() { return { ...run, connected: !agent.connection.signal.aborted, entries: [...run.entries], configOptions, permissions: permissions.snapshot() }; },
    /** @param {string} text @param {string} id */
    async submit(text, id) {
      await ready;
      if (closing || agent.connection.signal.aborted) throw new Error("Backend disconnected. Resume explicitly; the task was not replayed.");
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("Prompt needs a UUID request id");
      const prior = run.entries.find(entry => entry.id === id);
      if (prior) {
        if (prior.role !== "user" || prior.text !== text) throw new Error("Prompt id is already bound to a different request");
        return { id: run.id, accepted: true, meaning: "Existing durable intent; the prompt was not replayed" };
      }
      if (busy) throw new Error("A prompt is already active");
      if (typeof text !== "string" || !text.trim() || text.length > 60000) throw new Error("Prompt must have 1 to 60000 characters");
      const command = text.match(/^\/(projects|project)(?:\s+(.*))?$/s);
      if (command) {
        let status;
        if (command[1] === "projects" && !command[2] || command[1] === "project" && !command[2]) status = workspaceStatus(run.id, env);
        else {
          const action = command[2]?.match(/^(load|unload)\s+(.+)$/s);
          if (!action) throw new Error("Use /projects, /project load NAME_OR_PATH, or /project unload NAME_OR_PATH");
          let target = action[2].trim();
          if (target.startsWith('"') && target.endsWith('"') || target.startsWith("'") && target.endsWith("'")) target = target.slice(1, -1);
          // Local typed commands explicitly select additional filesystem roots.
          status = action[1] === "load" ? loadProject(run.id, target, env, directory) : unloadProject(run.id, target, env, directory);
        }
        run.entries.push({ id, role: "user", text }, { id: `${id}-workspace`, role: "notice", text: JSON.stringify(status, null, 2) });
        persist();
        return { id: run.id, accepted: true, meaning: "Local workspace updated; no provider request sent" };
      }
      const workspace = workspaceInstructions(run.id, env);
      busy = true; run.state = "running"; delete run.error; delete run.stopReason;
      run.entries.push({ id, role: "user", text });
      persist(); // Durable intent exists before any provider request is sent.
      void agent.connection.agent.request("session/prompt", { sessionId: /** @type {string} */ (run.sessionId), prompt: [{ type: "text", text: `${instructions}\n${workspace}\n\nOwner's current request:\n${text}` }] }).then(result => {
        if (closing) return;
        run.stopReason = result.stopReason;
        run.state = result.stopReason === "cancelled" ? "cancelled" : result.stopReason === "end_turn" ? "completed" : "idle";
        persist();
      }).catch(error => {
        if (closing) return;
        run.state = "uncertain";
        run.error = `Native prompt did not return a final response: ${error instanceof Error ? error.message : "connection lost"}. Inspect actual effects before retrying.`;
        persist();
      }).finally(() => { busy = false; permissions.cancelAll(); });
      return { id: run.id, accepted: true, meaning: "Local intent saved; completion is not established" };
    },
    /** @param {string} id @param {string | null} option */
    permission(id, option) { permissions.select(id, option); },
    async cancel() {
      if (!busy || !run.sessionId) return { requested: false };
      run.state = "uncertain"; run.error = "Cancellation requested; final backend outcome is not established."; persist();
      await agent.connection.agent.notify("session/cancel", { sessionId: run.sessionId });
      permissions.cancelAll();
      return { requested: true, confirmed: false };
    },
    close() {
      if (closed) return closed;
      closing = true;
      if (busy || run.state === "permission") { run.state = "uncertain"; run.error = "Client closed before a final response. No automatic replay."; }
      permissions.cancelAll();
      try { persist(); } finally { closed = agent.close(); release(); }
      return closed;
    },
  };
}
