// @ts-check
import { deadline } from "./deadline.mjs";
import spawn from "cross-spawn";
import skills from "../skills.js";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { readProjectFile, writeProjectFile } from "./filesystem.mjs";
import { createRequire } from "node:module";
/** @type {string} */
const PACKAGE_VERSION = String(createRequire(import.meta.url)("../package.json").version);

/** @param {import('./backends.mjs').Backend} backend @param {string} directory @param {{update: (event: acp.SessionNotification) => void, permission: (request: acp.RequestPermissionRequest, signal: AbortSignal) => Promise<acp.RequestPermissionResponse>, projectRoots?: () => string[]}} handlers @param {NodeJS.ProcessEnv} [env] */
export function connectAgent(backend, directory, handlers, env = process.env) {
  const child = spawn(backend.command, backend.args, { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Backend requires piped standard streams");
  child.stderr.resume(); // Do not copy provider diagnostics or authentication URLs into task records.
  const connection = acp.client({ name: "lakeside-code" })
    .onNotification("session/update", context => handlers.update(context.params))
    .onRequest("session/request_permission", context => handlers.permission(context.params, context.signal))
    .onRequest("fs/read_text_file", context => readProjectFile(context.params, directory, [...(handlers.projectRoots?.() || []), skills.skillRoot(), fileURLToPath(new URL("../design-skills/", import.meta.url))]))
    .onRequest("fs/write_text_file", context => writeProjectFile(context.params, directory, handlers.projectRoots?.() || []))
    .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  child.once("error", () => connection.close(new Error(`Cannot start ${backend.id}: ${backend.command}. Install or configure its ACP adapter first.`)));
  child.once("exit", () => connection.close(new Error(`Backend ${backend.id} exited. Check its installation/login; no automatic retry was attempted.`)));
  /** @type {Promise<void> | undefined} */
  let closing;
  return {
    connection,
    /** @param {acp.NewSessionRequest} params @returns {Promise<acp.NewSessionResponse>} */
    newSession(params) { return connection.agent.request("session/new", params); },
    /** @param {acp.LoadSessionRequest} params @returns {Promise<acp.LoadSessionResponse>} */
    loadSession(params) { return connection.agent.request("session/load", params); },
    initialize: () => deadline(connection.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: "lakeside-code", version: PACKAGE_VERSION }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } }), 20000, () => connection.close(new Error("ACP initialization timed out"))),
    close() {
      if (closing) return closing;
      connection.close(); child.stdin?.end(); child.kill("SIGTERM");
      // Windows keeps the directory busy until the process exits; bound the wait.
      closing = new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        exited.then(() => { clearTimeout(timer); resolve(); });
      });
      return closing;
    },
  };
}
