#!/usr/bin/env node
"use strict";
// Keir guardian runner (keir-guardian.timer, every minute). See lib/operator/guardian.js for the policy.
// Writes /var/lib/keir-guardian/status.json every run: that file is the health check for the whole stack.
//   node bin/keir-guardian.js            one pass
//   node bin/keir-guardian.js --dry-run  decide and write status, but never restart or message anyone
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { decideUnit, judgeOperatorHealth, OWNER_ALERT, DEFAULTS } = require("../lib/operator/guardian");

const HOURMS = 3600000;
const env = process.env, dry = process.argv.includes("--dry-run");
const dir = env.KEIR_GUARDIAN_DIR || "/var/lib/keir-guardian";
const stateFile = path.join(dir, "state.json"), statusFile = path.join(dir, "status.json");
const ownerId = env.KEIR_OWNER_ID || "333052320252297216";
const UNITS = (env.KEIR_GUARDIAN_UNITS || "keir-operator,keir-summon,keir-inbox").split(",").map((s) => s.trim()).filter(Boolean);
// Timers that must be armed. A timer that stopped re-arming went unnoticed for ten days (conversation audit, 2026-10-26).
const TIMERS = (env.KEIR_GUARDIAN_TIMERS || "keir-watchkeeper.timer,keir-conversation-audit.timer,keir-self-review.timer,keir-shadow.timer").split(",").map((s) => s.trim()).filter(Boolean);
const PROBES = { "keir-operator": env.KEIR_GUARDIAN_OPERATOR_URL || "http://127.0.0.1:9765/health", "keir-summon": env.KEIR_GUARDIAN_SUMMON_URL || "http://127.0.0.1:9763/api/summon/health", "keir-inbox": env.KEIR_GUARDIAN_INBOX_URL || null };
const cfg = { ...DEFAULTS, ...(env.KEIR_GUARDIAN_MAX_RESTARTS ? { maxRestarts: Number(env.KEIR_GUARDIAN_MAX_RESTARTS) } : {}), ...(env.KEIR_GUARDIAN_HANG_GRACE_MS ? { hangGraceMs: Number(env.KEIR_GUARDIAN_HANG_GRACE_MS) } : {}) };

const sh = (cmd, args, timeout = 20000) => new Promise((resolve) => execFile(cmd, args, { timeout }, (e, out, err) => resolve({ ok: !e, out: String(out || "").trim(), err: String(err || e?.message || "").trim() })));
async function activeState(unit) { const r = await sh("/usr/bin/systemctl", ["show", unit, "-p", "ActiveState", "--value"]); return r.out || "unknown"; }
async function probe(url) {
  if (!url) return null;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; }
  catch (e) { return { error: e.cause?.code || e.name || e.message }; }
}
function load() { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return { units: {}, restarts: [], giveUps: [] }; } }
function write(file, value) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n", { mode: 0o600 }); fs.renameSync(tmp, file); }

// Owner rule 2026-11-23: a failed Keir unit is a fix-it job, not a phone ping. One kanban card per unit (alert_key keeps it
// to one card and closes it when the unit's next run succeeds), which agents pick up. The old direct owner DM is gone.
async function fixIt(unit, reason) {
  const call = env.KEIR_GUARDIAN_MCPCALL || "/root/bin/mcpcall.sh";
  const args = { product: "lakeside-mcp", area: "keir", kind: "ops", impact: "high", lane: "inbox", actor: "keir-guardian",
    title: `Fix: Keir unit ${unit} keeps failing`, detail: `${reason}\n\nThe guardian restarted it and it failed again. Find the cause (journalctl -u ${unit}), fix it, and confirm the next run succeeds.`,
    alert_key: `unit-failed:${unit}`, alert_check: `systemd:${unit}` };
  const r = await sh(call, ["ops-knowledge", "kanban_add", JSON.stringify(args)], 60000);
  return { filed: r.ok, ...(r.ok ? {} : { error: r.err.slice(0, 200) }) };
}

(async () => {
  const at = Date.now(), state = load();
  state.units ||= {}; state.restarts ||= []; state.giveUps ||= [];
  if (fs.existsSync(path.join(dir, "disabled"))) { write(statusFile, { at, disabled: true, note: "guardian disabled by marker file" }); return; }
  const report = { at, dryRun: dry, units: {}, timers: {}, alerts: [] };
  for (const unit of UNITS) {
    const s = (state.units[unit] ||= {});
    const active = await activeState(unit);
    let health = null, judged = { ok: null, detail: "no probe" };
    if (active === "active" && PROBES[unit]) {
      health = await probe(PROBES[unit]);
      judged = unit === "keir-operator" ? judgeOperatorHealth(health) : { ok: health?.status === 200, detail: health?.error || `health returned ${health?.status}` };
    }
    const d = decideUnit({ unit, activeState: active, healthOk: judged.ok, healthDetail: judged.detail }, s, at, cfg);
    const entry = { activeState: active, status: d.status, reason: d.reason, action: d.action, restartsInWindow: s.restarts.length };
    if (d.action === "restart" && !dry) {
      const r = await sh("/usr/bin/systemctl", ["restart", unit], 150000);
      entry.restartOk = r.ok; if (!r.ok) entry.restartError = r.err.slice(0, 200);
      state.restarts.push({ at, unit, reason: d.reason }); state.restarts = state.restarts.filter((x) => at - x.at < 7 * 86400000);
    }
    if (d.action === "give_up_alert") {
      state.giveUps.push({ at, unit, reason: d.reason }); state.giveUps = state.giveUps.filter((x) => at - x.at < 7 * 86400000);
      if (!dry) entry.fixIt = await fixIt(unit, OWNER_ALERT(unit, d.reason)); report.alerts.push(unit);
    }
    report.units[unit] = entry;
  }
  for (const timer of TIMERS) {
    const active = await activeState(timer), s = (state.units[timer] ||= {});
    const entry = { activeState: active };
    // A timer left inactive is either off on purpose or silently dead. Re-enable only if the owner has not stopped Keir:
    // when the operator is deliberately stopped, its timers stay as they are.
    const operatorStopped = report.units["keir-operator"]?.status === "stopped";
    if (active !== "active" && !operatorStopped) {
      s.timerDownSince ||= at; entry.status = "down";
      if (at - s.timerDownSince >= 5 * 60000 && at - (s.timerRestartedAt || 0) >= HOURMS) {
        s.timerRestartedAt = at; entry.action = "start";
        if (!dry) { const r = await sh("/usr/bin/systemctl", ["start", timer]); entry.startOk = r.ok; state.restarts.push({ at, unit: timer, reason: "timer was not active" }); }
      }
    } else { delete s.timerDownSince; entry.status = active === "active" ? "armed" : "stopped"; }
    // 2026-11-23: an armed timer whose runs all fail looked healthy here. keir-watchkeeper and keir-conversation-audit
    // failed at namespace setup on every run from 11-22 04:45 and nobody noticed. Check the last run of the service too.
    const svc = timer.replace(/\.timer$/, ".service");
    const shown = await sh("/usr/bin/systemctl", ["show", svc, "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus"]);
    const props = Object.fromEntries(shown.out.split("\n").map((l) => l.split("=")).filter((kv) => kv.length === 2));
    const svcFailed = props.ActiveState === "failed" || (props.Result && props.Result !== "success");
    entry.service = { unit: svc, activeState: props.ActiveState || "unknown", result: props.Result || "unknown" };
    if (svcFailed && !operatorStopped) {
      entry.status = "failing"; s.serviceFails = (s.serviceFails || 0) + (s.lastFailSeenResultAt === props.Result + ":" + Math.floor(at / HOURMS) ? 0 : 1);
      s.lastFailSeenResultAt = props.Result + ":" + Math.floor(at / HOURMS);
      if (at - (s.serviceFixAt || 0) >= HOURMS) {
        s.serviceFixAt = at; entry.action = "rerun";
        if (!dry) {
          await sh("/usr/bin/systemctl", ["reset-failed", svc]);
          const r = await sh("/usr/bin/systemctl", ["start", "--no-block", svc]);
          entry.rerunOk = r.ok; state.restarts.push({ at, unit: svc, reason: `last run failed (${props.Result})` });
        }
      }
      if (s.serviceFails >= 3 && at - (s.fixItAt || 0) >= 24 * HOURMS) { s.fixItAt = at; if (!dry) entry.fixIt = await fixIt(svc, `${svc} failed ${s.serviceFails} times in a row (last result ${props.Result}).`); report.alerts.push(svc); }
    } else if (!svcFailed) { s.serviceFails = 0; }
    report.timers[timer] = entry;
  }
  const kill = await sh("/usr/bin/test", ["-e", env.KEIR_KILL_SWITCH_FILE || "/var/lib/keir-operator/kill-switch"]);
  report.killSwitchFilePresent = kill.ok;
  report.restarts = state.restarts; report.giveUps = state.giveUps;
  report.healthy = Object.values(report.units).every((u) => ["healthy", "stopped", "starting"].includes(u.status)) && Object.values(report.timers).every((t) => !["down", "failing"].includes(t.status));
  state.lastRunAt = at;
  write(stateFile, state); write(statusFile, report);
  console.log(`keir-guardian: ${report.healthy ? "healthy" : "NOT healthy"} ${JSON.stringify(Object.fromEntries(Object.entries(report.units).map(([k, v]) => [k, v.status])))}`);
})().catch((e) => { console.error(`keir-guardian failed: ${e.stack || e.message}`); process.exitCode = 1; });
