"use strict";
// Staff actions for the Discord desk. The running operator does the work (lib/operator/deskactions.js);
// this module only calls its local endpoint and answers in plain words. It never writes the ledger and never posts to a player.
// run({ action, ticket, actor: { id, role }, config }) -> { content }
// config: { env, fetchImpl, killSwitch, startUnit }; the port and token come from env and are never logged.
const { execFile } = require("node:child_process");

const NEEDS_TICKET = new Set(["nudge", "release", "pause", "resume"]);
const DEV_ONLY = new Set(["on", "off"]);
const ROLES = ["junior", "dev", "owner"];
const OFF_TEXT = "Keir is off right now, so that cannot run. A developer can switch Keir on first.";

function allowed(action, role) {
  if (DEV_ONLY.has(action)) return role === "dev" || role === "owner";
  return ROLES.includes(role);
}

async function call(config, body) {
  const env = config?.env || process.env;
  const f = config?.fetchImpl || fetch;
  const res = await f(`http://127.0.0.1:${env.KEIR_OPERATOR_PORT || 9765}/v5/desk/action`, {
    method: "POST", headers: { Authorization: `Bearer ${env.KEIR_OPERATOR_ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  let data = null; try { data = await res.json(); } catch { /* not json */ }
  if (res.status === 401) throw Object.assign(new Error("auth"), { code: "AUTH" });
  if (!res.ok) throw Object.assign(new Error("http"), { code: "HTTP", status: res.status });
  return data || {};
}

// With the operator down, "on" releases the kill switch file and asks for the unit to start; the guardian also starts it within a minute.
async function switchOnWhileDown(actor, config) {
  const env = config?.env || process.env;
  const file = env.KEIR_KILL_SWITCH_FILE || "/var/lib/keir-operator/kill-switch";
  const ks = config?.killSwitch || require("../operator/killswitch").createKillSwitch({ file, env: {}, ttlMs: 0 });
  ks.release();
  const start = config?.startUnit || (() => new Promise((resolve) => execFile("/usr/bin/systemctl", ["start", "keir-operator"], { timeout: 20000 }, (e) => resolve(!e))));
  const started = await start();
  return { content: started ? "Keir was down. The kill switch is cleared and Keir is starting now." : "Keir was down. The kill switch is cleared; the guardian will start Keir within a minute. The staff channel line and audit row are written once it is up." };
}

async function run({ action, ticket, actor, config } = {}) {
  action = String(action || "").toLowerCase();
  const role = String(actor?.role || "");
  if (!["nudge", "release", "pause", "resume", "on", "off"].includes(action)) return { content: "Actions are nudge, release, pause, resume, on and off." };
  if (!allowed(action, role)) return { content: DEV_ONLY.has(action) ? "Only developers can switch Keir on or off." : "Only junior developers and developers can do that." };
  let n;
  if (NEEDS_TICKET.has(action)) {
    n = Number(ticket);
    if (!Number.isInteger(n) || n <= 0) return { content: `Say which ticket: ${action} <ticket number>.` };
  }
  try {
    const out = await call(config, { action, ...(n ? { ticket: n } : {}), actor: { id: actor?.id, role } });
    return { content: out.message || (out.ok ? "Done." : "That did not go through.") };
  } catch (e) {
    if (e.code === "AUTH") return { content: "The desk is not allowed to talk to Keir (credentials rejected). A developer needs to check the desk setup." };
    if (e.code === "HTTP") return { content: "Keir refused that request. Nothing changed." };
    if (action === "on") return switchOnWhileDown(actor, config);
    if (action === "off") return { content: "Keir is already off (it is not running)." };
    return { content: OFF_TEXT };
  }
}

module.exports = { run, allowed, call };
