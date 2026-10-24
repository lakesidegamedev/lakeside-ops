"use strict";
const { rootOf } = require("./appcontrols");
function voiceRoot(data, job) {
  // Coding delegates report to their parent and cannot call channel_reply.
  if (job?.codingParent) return null;
  const root = rootOf(data, job);
  return root?.voiceMode && root.replyChannel === "app" ? root : null;
}
function finalReplyQueued(data, job) {
  const root = voiceRoot(data, job);
  if (!root) return false;
  if ((data.appThread?.messages || []).some(m => m.role === "keir" && m.jobId === root.id && !m.voiceProgress && !m.provisional && m.text)) return true;
  return Object.entries(data.outbox || {}).some(([key, entry]) => key.startsWith("channel-reply:") && entry.content && entry.destination?.startsWith("channel:") && voiceRoot(data, data.jobs[entry.destination.slice(8)])?.id === root.id);
}
function context(data, job) {
  const root = voiceRoot(data, job);
  if (!root) return null;
  const messages = data.appThread?.messages || [], source = messages.find(m => m.id === root.source?.messageId);
  return { turn: { jobId: root.id, sourceMessageId: root.source?.messageId, replyRequired: !finalReplyQueued(data, job), instruction: "Answer this accepted voice turn. Similar wording or an answer to a different job ID does not count as delivery. Use fresh evidence, then channel_reply before finish. Progress acknowledgements are not final answers." },
    conversation: { evidenceOnly: true, messages: messages.filter(m => !m.update && (m.thread || "main") === (root.appThread || "main") && (!source || m.seq <= source.seq)).slice(-12).map(m => ({ role: m.role, content: m.text, at: m.at, jobId: m.jobId })) } };
}
const READS = { "ops-knowledge": ["kanban_list", "kanban_get"], engine: ["engine_health"], support: ["support_get", "support_search"], gamestate: ["entity_search", "trace_corp"] };
async function readSchemas(mcp, signal) {
  if (!mcp.list) return [];
  const present = new Set(mcp.servers());
  const deadline = AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]);
  const pending = Promise.allSettled(Object.entries(READS).filter(([server]) => present.has(server)).map(async ([server, names]) => (await mcp.list(server, deadline)).filter(t => names.includes(t.name)).map(t => ({ server, tool: t.name, schema: t.inputSchema }))));
  // Injected or unavailable adapters must not delay voice even if they ignore cancellation.
  let timer;
  try {
    const rows = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve([]), 2100); })]);
    return rows.filter(r => r.status === "fulfilled").flatMap(r => r.value);
  } finally { clearTimeout(timer); }
}
module.exports = { voiceRoot, finalReplyQueued, context, readSchemas };
