"use strict";
const { JOB_TERMINAL } = require("../operator/machines");
const fs = require("node:fs");

// What needs a human, read from the operator ledger, the prod hold file and the
// shadow review. Keir no longer DMs the owner, so this is where its alerts,
// pending approvals and blocked tasks surface (ops dashboard /inbox).
// Read-only: the operator process is the ledger's only writer.
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const OPEN = new Set(JOB_TERMINAL);
const clip = (t, n = 400) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);

function readAlerts({ ledgerFile = "/var/lib/keir-operator/ledger.json", holdFile = "/var/lib/keir-operator/prod-hold", shadowFile = "/var/lib/keir-operator/shadow.json", now = Date.now() } = {}) {
  const d = readJson(ledgerFile) || {};
  const jobs = d.jobs || {};
  let prodHold = null;
  try { const until = Date.parse(fs.readFileSync(holdFile, "utf8").trim()); if (until > now) prodHold = new Date(until).toISOString(); } catch {}
  const pendingApprovals = Object.values(d.actions || {})
    .filter((a) => a.state === "pending" && (a.expiresAt || 0) > now && jobs[a.jobId] && !OPEN.has(jobs[a.jobId].state))
    .map((a) => ({ id: a.id, kind: a.kind, jobId: a.jobId, ticket: jobs[a.jobId].ticket || null, summary: clip(a.args?.summary || a.args?.spec?.description || a.args?.reason || jobs[a.jobId].summary), at: a.at, expiresAt: a.expiresAt }))
    .sort((a, b) => b.at - a.at);
  const blocked = Object.values(jobs).filter((j) => j.state === "blocked")
    .map((j) => ({ id: j.id, kind: j.kind, ticket: j.ticket || null, summary: clip(j.summary), updatedAt: j.updatedAt || j.at }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const alerts = (d.alerts || []).filter((a) => a.at > now - 86_400_000 && !String(a.key).startsWith("digest:"))
    .sort((a, b) => b.at - a.at).slice(0, 50).map((a) => ({ key: a.key, content: clip(a.content, 600), at: a.at }));
  const s = readJson(shadowFile);
  const shadow = s && Array.isArray(s.anomalies) ? { at: s.at, anomalies: s.anomalies.slice(0, 50).map((x) => clip(x, 300)) } : null;
  return { prodHold, pendingApprovals, blocked, alerts, shadow };
}
module.exports = { readAlerts };
