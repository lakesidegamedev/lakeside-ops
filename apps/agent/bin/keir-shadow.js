#!/usr/bin/env node
"use strict";
// Shadow review of Keir's behavior since a timestamp. Read-only: it inspects
// the operator ledger and reports anything that breaks the operating rules.
// Usage: keir-shadow.js [minutesBack | sinceEpochMs] [--json file]   (default: 15 minutes)
// keir-shadow.timer runs it every 20 minutes with --json for the ops dashboard.
const fs = require("node:fs");
const arg = Number(process.argv[2]) || 15;
const since = arg > 1e11 ? arg : Date.now() - arg * 60000;
const d = JSON.parse(fs.readFileSync("/var/lib/keir-operator/ledger.json", "utf8"));
const now = Date.now(), flags = [], notes = [];
const ownerId = "333052320252297216", staff = ["565289871799746593"];
const jobOf = (dest) => typeof dest === "string" && dest.startsWith("channel:") ? d.jobs[dest.slice(8)] : null;
const short = (t, n = 160) => String(t || "").replace(/\s+/g, " ").slice(0, n);

// Messages Keir sent in the window.
for (const [key, o] of Object.entries(d.outbox)) {
  if ((o.deliveredAt || o.at) < since) continue;
  const job = jobOf(o.destination), text = String(o.content || "");
  if (!job) {
    if (o.decision && d.decisions?.[o.decision] && o.recipient === ownerId) { notes.push(`Mirrored owner decision [${o.decision}]`); continue; }
    if (o.destination === "owner" || o.destination === ownerId) flags.push(`DM to owner [${key.split(":")[0]}]: ${short(text)}`);
    else notes.push(`DM to ${o.destination} [${key.split(":")[0]}]: ${short(text, 100)}`);
    continue;
  }
  const where = job.ticket ? `ticket ${job.ticket}` : job.source?.channelName || job.channelId;
  notes.push(`${where} [${key.split(":")[0]}]: ${short(text, 120)}`);
  if (text.length > 700) flags.push(`Long reply (${text.length} chars) in ${where}: ${short(text, 100)}`);
  if (/```|\/root\/|\/var\/lib|src\/[\w/.-]+\.(?:ts|tsx|js)|publish_patch|repository_snapshot|mcp__|\bsha\b|[0-9a-f]{10,40}/i.test(text) && (job.role !== "owner" || job.ticket))
    flags.push(`Technical detail in a non-owner channel (${where}): ${short(text, 120)}`);
  if (/^(?:i['’]m on it|on it|looking into it)[.!]*$/i.test(text.trim())) flags.push(`Generic acknowledgement in ${where}`);
  if (job.role === "player" && !job.ticket && !d.summonedChannels?.[job.channelId]) flags.push(`Replied to a player outside a ticket/opened channel (${where})`);
  if (!o.deliveredAt && now - o.at > 120000) flags.push(`Undelivered for ${Math.round((now - o.at) / 60000)}m (${where}): ${o.error || "pending"}`);
}
// Repeated text in one channel.
const seenText = {};
for (const o of Object.values(d.outbox)) { const j = jobOf(o.destination); if (!j || (o.at || 0) < since) continue; const k = j.replyChannel + "|" + short(o.content, 80); if (seenText[k]) flags.push(`Repeated message in ${j.source?.channelName || j.replyChannel}: ${short(o.content, 80)}`); seenText[k] = 1; }

// Tasks.
for (const j of Object.values(d.jobs)) {
  const age = now - (j.at || 0), idle = now - (j.updatedAt || j.at || 0);
  const dev = [ownerId, ...staff].includes(j.actorId) && j.kind === "command";
  if (dev && !["done", "dismissed", "cancelled"].includes(j.state) && age > 20 * 60000 && (j.updatedAt || 0) > since - 6 * 3600000) {
    const answered = Object.keys(d.outbox).some((k) => k.includes(j.id) && !k.startsWith("ack:")) || Object.keys(j.effects || {}).some((k) => k.startsWith("ticket-update:")) || Boolean(j.lastPublishedAt);
    if (!answered) flags.push(`Developer request unanswered for ${Math.round(age / 60000)}m [${j.id} ${j.state}]: ${short(j.source?.content, 100)}`);
  }
  if (j.state === "blocked" && (j.updatedAt || 0) > since) flags.push(`Task blocked [${j.id} ${j.kind}${j.ticket ? " #" + j.ticket : ""}]: ${short(j.summary)}`);
  const quiet = now - (j.lastPublishedAt || j.at || 0);
  if (j.kind === "ticket" && !["done", "cancelled", "deferred"].includes(j.state) && !j.resolutionReadyAt && quiet > 2 * 3600000 && !d.channels[j.channelId]?.claimedBy)
    flags.push(`Ticket ${j.ticket}: player has heard nothing for ${Math.round(quiet / 3600000)}h: ${short(j.summary, 100)}`);
  // Anything waiting on the owner is a stall the shadow operator resolves itself.
  if ((j.ownerDecisionPending || j.state === "blocked") && !["done", "cancelled", "dismissed"].includes(j.state))
    flags.push(`Waiting on an owner decision or blocked [${j.id} ${j.kind}${j.ticket ? " #" + j.ticket : ""}]: ${short(j.summary)}`);
  for (const a of Object.values(d.actions || {})) if (a.jobId === j.id && a.state === "pending") flags.push(`Pending approval [${a.id} ${a.kind}] on task ${j.id}`);
  if (j.state === "running" && now - (j.startedAt || 0) > 20 * 60000) flags.push(`Task running ${Math.round((now - j.startedAt) / 60000)}m [${j.id}]`);
  if ((j.updatedAt || 0) > since && ["done", "dismissed"].includes(j.state)) notes.push(`${j.state} ${j.kind}${j.ticket ? " #" + j.ticket : ""}: ${short(j.summary, 120)}`);
}
for (const a of (d.alerts || []).filter((a) => a.at > since && !a.key.startsWith("digest:"))) flags.push(`Alert ${a.key}: ${short(a.content)}`);
const audits = (d.audit || []).filter((a) => a.at > since);
const classified = audits.filter((a) => a.kind === "classified"), screened = audits.filter((a) => a.kind === "screened");
const day = new Date().toISOString().slice(0, 10), stats = d.screenStats?.[day] || { screened: 0, candidates: 0 };
notes.push(`Classifier: ${classified.length} checks (${classified.filter((a) => a.forKeir).length} for Keir). Screening today: ${stats.screened} posts, ${stats.candidates} candidates. Opened tickets in window: ${audits.filter((a) => a.kind === "effect" && /intake/.test(a.key || "")).length}.`);

// Keir 5.1: the watch mission score heads the notes; decision DMs per hour
// are flagged once they pass the audit's ceiling (one yes per chain).
if (d.watch?.headline) notes.unshift(d.watch.headline);
const recentDecisions = Object.values(d.decisions || {}).filter((x) => (x.at || 0) > now - 3 * 3600000).length;
if (recentDecisions > 3) flags.push(`Owner decision DMs: ${recentDecisions} in the last 3h, above one an hour`);

const jsonAt = process.argv.indexOf("--json");
if (jsonAt > 0 && process.argv[jsonAt + 1]) {
  const file = process.argv[jsonAt + 1], tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ at: now, since, anomalies: flags, notes: notes.slice(-40) }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
console.log(`KEIR SHADOW ${new Date(since).toISOString()} -> ${new Date(now).toISOString()}`);
console.log(`ANOMALIES: ${flags.length}`);
for (const f of flags) console.log("! " + f);
for (const n of notes.slice(-40)) console.log("- " + n);

// Model A/B: every activation in the window with its runner, for side-by-side review.
try {
  const lines = fs.readFileSync("/var/lib/keir-operator/usage.jsonl", "utf8").trim().split("\n").slice(-400).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((u) => u && Date.parse(u.at) >= since);
  if (lines.length) {
    console.log("\nACTIVATIONS BY MODEL");
    for (const u of lines) {
      const j = d.jobs[u.job] || {};
      console.log(`- ${u.at.slice(11, 19)} ${String(u.model).padEnd(28)} ${String(u.effort || "-").padEnd(6)} ${String(u.kind).padEnd(12)} ${u.ticket ? "#" + u.ticket : "-"} ${Math.round(u.durationMs / 1000)}s ${u.outcome} | ${short(j.summary, 140)}`);
    }
  }
} catch {}
