"use strict";

// ─── SECURITY ALERTING ────────────────────────────────────────────────────
// Turns new high/critical security findings into Discord messages, once each.
//
// The console page is pull-based: nobody is looking at it at 04:00. This module
// is the push half of the monitoring, and it is deliberately conservative:
//
//   * only `critical` and `high` findings alert (medium/low stay on the page);
//   * a finding alerts once, keyed on its stable `id`, then never again;
//   * a finding that clears posts a short recovery line, then is forgotten;
//   * state is persisted, so a deploy or crash mid-incident does not re-spam;
//   * a notification failure never throws and never blocks the caller.
//
// If no Discord webhook is configured the whole thing degrades to a no-op — the
// page still shows everything.

const fs = require("fs");
const path = require("path");

const ALERTING_SEVERITIES = new Set(["critical", "high"]);
const DEFAULT_STATE = process.env.SECURITY_ALERT_STATE || "/var/lib/lakeside-ops-dashboard/security-alerts.json";
const MAX_ITEMS_PER_MESSAGE = 8;

function loadState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.alerted && typeof parsed.alerted === "object") {
      return { alerted: parsed.alerted, updatedAt: parsed.updatedAt || null };
    }
  } catch {
    /* first run or corrupt state: start clean rather than crash */
  }
  return { alerted: {}, updatedAt: null };
}

function saveState(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, statePath);
  } catch {
    /* alerting must never take the dashboard down */
  }
}

// Pure: given a snapshot and previous state, work out what to say.
function diff(snapshot, state) {
  const findings = Array.isArray(snapshot && snapshot.findings) ? snapshot.findings : [];
  const previously = (state && state.alerted) || {};
  const current = new Map();

  for (const f of findings) {
    if (!f || !f.id || !ALERTING_SEVERITIES.has(f.severity)) continue;
    current.set(f.id, f);
  }

  const fresh = [];
  for (const [id, f] of current) {
    if (!previously[id]) fresh.push(f);
  }

  const resolved = [];
  for (const [id, prev] of Object.entries(previously)) {
    if (!current.has(id)) resolved.push({ id, ...prev });
  }

  const nextAlerted = {};
  for (const [id, f] of current) {
    nextAlerted[id] = {
      severity: f.severity,
      title: f.title,
      host: f.host,
      firstAlertedAt: previously[id]?.firstAlertedAt || new Date().toISOString(),
    };
  }

  return { fresh, resolved, nextAlerted };
}

function describe(f) {
  const bits = [`[${String(f.severity || "").toUpperCase()}] ${f.title || f.id}`];
  if (f.hostLabel || f.host) bits.push(`host: ${f.hostLabel || f.host}`);
  if (f.detail) bits.push(f.detail);
  if (f.remedy) bits.push(`Fix: ${f.remedy}`);
  return bits.join("\n");
}

function truncate(lines) {
  const kept = lines.slice(0, MAX_ITEMS_PER_MESSAGE);
  const rest = lines.length - kept.length;
  if (rest > 0) kept.push(`…and ${rest} more on /security`);
  return kept.join("\n\n");
}

async function notifyNew(fresh, notify, snapshot) {
  const criticals = fresh.filter((f) => f.severity === "critical");
  const highs = fresh.filter((f) => f.severity === "high");
  const title =
    criticals.length > 0
      ? `${criticals.length} critical security finding(s)`
      : `${highs.length} high security finding(s)`;
  const ordered = [...criticals, ...highs];
  const hosts = [...new Set(ordered.map((f) => f.hostLabel || f.host))].join(", ");
  return notify({
    kind: "security",
    title,
    description: truncate(ordered.map(describe)),
    color: criticals.length > 0 ? 0xed4245 : 0xfee75c,
    url: process.env.OPS_PUBLIC_URL ? `${process.env.OPS_PUBLIC_URL.replace(/\/$/, "")}/security` : undefined,
    fields: [
      { name: "Hosts", value: hosts || "—", inline: true },
      { name: "Posture", value: String((snapshot && snapshot.summary && snapshot.summary.posture) || "—"), inline: true },
      { name: "Score", value: String((snapshot && snapshot.summary && snapshot.summary.score) ?? "—"), inline: true },
    ],
    footer: "Lakeside ops · security probe",
  });
}

async function notifyResolved(resolved, notify) {
  return notify({
    kind: "security",
    title: `${resolved.length} security finding(s) cleared`,
    description: truncate(resolved.map((f) => `[CLEARED] ${f.title || f.id}${f.host ? ` (${f.host})` : ""}`)),
    color: 0x57f287,
    footer: "Lakeside ops · security probe",
  });
}

// Entry point used by server.js on a timer. `snapshot` is a getter so a stale
// cache cannot be alerted twice.
async function runAlertCheck({
  snapshot,
  statePath = DEFAULT_STATE,
  notify,
  now = () => new Date(),
} = {}) {
  if (typeof notify !== "function") return { skipped: "no notifier" };
  let snap;
  try {
    snap = await snapshot();
  } catch (error) {
    return { error: `snapshot failed: ${error && error.message}` };
  }
  if (!snap || !snap.summary) return { skipped: "no snapshot" };

  const state = loadState(statePath);
  const { fresh, resolved, nextAlerted } = diff(snap, state);

  const result = { fresh: fresh.length, resolved: resolved.length, posted: [] };

  if (fresh.length) {
    try {
      result.posted.push(await notifyNew(fresh, notify, snap));
    } catch (error) {
      result.posted.push({ error: String(error && error.message) });
    }
  }
  if (resolved.length) {
    try {
      result.posted.push(await notifyResolved(resolved, notify));
    } catch (error) {
      result.posted.push({ error: String(error && error.message) });
    }
  }

  if (fresh.length || resolved.length) {
    saveState(statePath, { alerted: nextAlerted, updatedAt: now().toISOString() });
  }
  return result;
}

module.exports = { runAlertCheck, diff, describe, ALERTING_SEVERITIES, MAX_ITEMS_PER_MESSAGE };
