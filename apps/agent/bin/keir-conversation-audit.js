#!/usr/bin/env node
"use strict";
// Independent, bounded observation of live messages. Never changes tickets,
// decisions or the operator ledger. Optional kanban reporting is ops telemetry.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { auditConversation } = require("../lib/operator/conversationaudit");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const atomic = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(file + ".tmp", file); };
const now = Date.now(), deadline = AbortSignal.timeout(45000);
async function jsonFetch(url, init = {}) {
 const r = await fetch(url, { ...init, signal: AbortSignal.any([deadline, AbortSignal.timeout(6000)]) });
 if (!r.ok) { const error = new Error(`HTTP ${r.status}`); error.status = r.status; throw error; }
 return r;
}
async function main() {
 const output = option("--output", process.env.KEIR_AUDIT_OUTPUT);
 if (!output) throw new Error("--output is required");
 const stateFile = output + ".state";
 const config = JSON.parse(fs.readFileSync(option("--mcp-config", process.env.KEIR_MCP_CONFIG), "utf8"));
 const rpc = async (server, name, input) => {
  const c = config.mcpServers[server], url = new URL(c.url);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("MCP must be local");
  const r = await jsonFetch(url, { method: "POST", headers: { ...c.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: input } }) });
  let text = await r.text(); if (text.startsWith("event:")) text = text.split("\n").find(l => l.startsWith("data: ")).slice(6);
  const result = JSON.parse(text); if (result.error || result.result?.isError) throw new Error(`MCP ${name} refused`);
  return JSON.parse(result.result.content.find(c => c.type === "text").text);
 };
 const discord = async route => {
  try { return await (await jsonFetch("https://discord.com/api/v10" + route, { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, "User-Agent": "KeirConversationAudit/1.0" } })).json(); }
  catch (e) { return { error: e.name === "TimeoutError" ? "timeout" : e.message, status: e.status }; }
 };
 if (!process.env.DISCORD_BOT_TOKEN || !process.env.KEIR_OWNER_ID) throw new Error("Discord credential and owner identity must be configured");
 const data = JSON.parse(fs.readFileSync(option("--ledger", process.env.KEIR_AUDIT_LEDGER), "utf8"));
 const excludedTickets = option("--exclude", "").split(",").map(Number).filter(Boolean);
 const since = now - Math.min(120, Math.max(5, Number(option("--minutes", 30)))) * 60000;
 const max = Math.min(12, Math.max(1, Number(option("--max-tickets", 8))));
 const candidates = Object.values(data.jobs || {}).filter(j => j.kind === "ticket" && j.ticket && !excludedTickets.includes(Number(j.ticket)) && !data.channels?.[j.channelId]?.claimedBy && (!["done", "cancelled", "dismissed", "deferred"].includes(j.state) || (j.updatedAt || 0) >= since));
 const numbers = [...new Set(candidates.sort((a, b) => (b.updatedAt || b.at || 0) - (a.updatedAt || a.at || 0)).map(j => Number(j.ticket)))];
 const tickets = {}, messages = {}, errors = [];
 for (let i = 0; i < Math.min(numbers.length, max); i += 2) await Promise.all(numbers.slice(i, Math.min(i + 2, max)).map(async n => {
  try {
   const ticket = await rpc("support", "support_get", { kind: "ticket", number: n }); tickets[n] = ticket;
   const c = ticket.conversation?.channelId;
   messages[n] = c ? await discord(`/channels/${c}/messages?limit=50`) : { error: "no current channel" };
  } catch (e) { errors.push({ ticket: n, error: e.name === "TimeoutError" ? "timeout" : e.message }); }
 }));
 const decisionMessages = {};
 const observedDecisions = Object.values(data.decisions || {}).filter(x => !excludedTickets.includes(Number(data.jobs?.[x.jobId]?.ticket)));
 const copies = observedDecisions.flatMap(x => Object.values(x.sent || {}).filter(s => s.messageId && !s.deleted).map(s => ({ ...s, pending: x.state === "pending", at: x.at || 0 }))).sort((a, b) => Number(b.pending) - Number(a.pending) || b.at - a.at).slice(0, 12);
 for (let i = 0; i < copies.length; i += 2) await Promise.all(copies.slice(i, i + 2).map(async s => { decisionMessages[`${s.channelId}:${s.messageId}`] = await discord(`/channels/${s.channelId}/messages/${s.messageId}`); }));
 const report = auditConversation(data, { tickets, messages, decisionMessages, now, since, ownerId: process.env.KEIR_OWNER_ID, excludedTickets });
 report.errors = errors; report.ticketsEligible = numbers.length; report.ticketsOmitted = Math.max(0, numbers.length - max);
 report.complete = !errors.length && !report.findings.some(f => /unavailable/.test(f.kind)) && !report.ticketsOmitted;
 report.decisionsOmitted = Math.max(0, observedDecisions.reduce((n, x) => n + Object.values(x.sent || {}).filter(s => s.messageId && !s.deleted).length, 0) - copies.length);
 if (report.decisionsOmitted) report.complete = false;
 atomic(output, report);
 const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ findings: report.findings.map(({ minutes, ...f }) => f), errors, omitted: report.ticketsOmitted, decisionsOmitted: report.decisionsOmitted })).digest("hex");
 let previous = {}; try { previous = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
 const item = Number(option("--kanban-id", 0));
 if (item && (previous.fingerprint !== fingerprint || now - (previous.reportedAt || 0) > 3600000)) {
  const counts = report.findings.reduce((m, f) => ({ ...m, [f.kind]: (m[f.kind] || 0) + 1 }), {});
  const summary = `Independent conversation audit: ${report.complete ? "observations complete" : "partial observation"}; ${report.ticketsChecked} tickets and ${report.decisionsChecked} pending decisions checked. Findings: ${JSON.stringify(counts)}. Observation errors: ${errors.length}; omitted tickets/copies: ${report.ticketsOmitted}/${report.decisionsOmitted}. Evidence IDs: ${report.findings.slice(0, 10).map(f => `${f.ticket || f.decisionId}:${f.messageId || f.updateKey || f.kind}`).join(", ") || "none"}. These are review flags, not automatic verdicts or approvals. Latest private sample report: ${output}.`;
  const result = await rpc("ops-knowledge", "work_report", { id: item, event: "progress", actor: "codex-conversation-monitor", summary, idempotency_key: `conversation-audit:${fingerprint}:${Math.floor(now / 3600000)}` });
  if (!result) throw new Error("monitor report not acknowledged");
  atomic(stateFile, { fingerprint, reportedAt: now });
 }
 console.log(JSON.stringify({ at: now, tickets: report.ticketsChecked, decisions: report.decisionsChecked, findings: report.findings.length, errors: errors.length, complete: report.complete }));
 if (!report.complete) process.exitCode = 2;
}
main().catch(e => {
 const output = option("--output", process.env.KEIR_AUDIT_OUTPUT);
 if (output) {
  let report = { at: now, complete: false, errors: [] };
  try { const saved = JSON.parse(fs.readFileSync(output, "utf8")); if (saved.at === now) report = { ...saved, complete: false }; } catch {}
  report.errors = [...(report.errors || []), { error: e.name === "TimeoutError" ? "deadline exceeded" : String(e.message).slice(0, 160) }]; atomic(output, report);
 }
 console.error(`Conversation audit failed: ${e.name}`); process.exitCode = 1;
});
