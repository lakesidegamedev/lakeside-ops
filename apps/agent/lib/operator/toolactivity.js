"use strict";
const crypto = require("node:crypto");
const { logInput } = require("./ownermuse-policy");
const SOURCES = {
  gamestate: ["Game state", "globe.europe.africa"], support: ["Support", "bubble.left.and.bubble.right"],
  "ops-knowledge": ["Knowledge", "books.vertical"], engine: ["Game engine", "gearshape.2"],
  turndiag: ["Turn diagnostics", "waveform.path.ecg"], railway: ["Deployments", "shippingbox"],
  community: ["Community", "person.3"], "heal-ops": ["Game records", "externaldrive"],
};
const TITLES = { game_overview: "Check game status", trace_corp: "Inspect corporation", trace_sector: "Inspect sector", support_get: "Read ticket", support_search: "Search support", knowledge_query: "Search knowledge", code_read: "Read source", code_search: "Search code", railway_status: "Check deployments", phase_history: "Read turn history" };
const LOCAL = {
  channel_reply: ["Reply", "bubble.left"], progress_update: ["Update progress", "text.bubble"],
  repository_snapshot: ["Load repository", "folder"], shell: ["Run workspace command", "terminal"],
  github: ["GitHub", "chevron.left.forwardslash.chevron.right"], calculate: ["Calculate", "number"],
  checkpoint: ["Save checkpoint", "bookmark"], finish: ["Finish turn", "checkmark.circle"],
  chart: ["Create chart", "chart.bar"], present_choices: ["Ask a question", "list.bullet"],
  open_ticket: ["Open ticket", "ticket"], open_suggestion: ["File suggestion", "lightbulb"],
  load_context: ["Load context", "doc.text.magnifyingglass"], task_plan: ["Update plan", "list.bullet.clipboard"],
};
const words = value => String(value || "").replace(/^mcp__[^_]+__/, "").replace(/[_-]+/g, " ").replace(/^./, s => s.toUpperCase());
function describe(name, input = {}) {
  const i = logInput(input), server = ["read_tool", "read_tools"].includes(name) ? i.server : null;
  const source = SOURCES[server] || (server ? [words(server), "network"] : null);
  const operation = name === "read_tool" ? i.tool : name;
  const local = LOCAL[name] || [words(name), "wrench.and.screwdriver"];
  return { tool: name, server, operation, title: TITLES[operation] || (source ? name === "read_tools" ? "Discover tools" : words(operation) : local[0]),
    source: source?.[0] || (name === "github" ? "GitHub" : "Keir"), icon: source?.[1] || local[1],
    what: (JSON.stringify(i).includes("[redacted]") ? "[redacted] " : "") + String(server ? i.tool || "Available tools" : i.action || i.query || i.path || i.section || i.kind || "").slice(0, 100) };
}
function start(job, name, input, now = Date.now()) {
  if (job.role !== "owner" || job.internalProbe) return null;
  const id = crypto.randomUUID();
  job.liveLog = [...(job.liveLog || []), { id, at: now, ...describe(name, input), state: "running", ok: null, ms: null }].slice(-60);
  return id;
}
function finish(job, id, ok, ms, now = Date.now()) {
  const row = job.liveLog?.find(r => r.id === id);
  if (row) Object.assign(row, { state: ok ? "completed" : "failed", ok, ms, finishedAt: now });
}
function forReply(job) {
  const rows = (job.liveLog || []).filter(row => !["channel_reply", "progress_update", "finish"].includes(row.tool));
  const delivered = new Set(job.replyToolIds || []);
  const fresh = rows.filter(row => row.state !== "running" && !delivered.has(row.id));
  job.replyToolIds = [...new Set([...(job.replyToolIds || []), ...fresh.map(row => row.id)])].slice(-60);
  return fresh.slice(-8);
}
function pending(job) {
  const delivered = new Set(job.replyToolIds || []);
  return (job.liveLog || []).filter(row => !delivered.has(row.id) && !["channel_reply", "progress_update", "finish"].includes(row.tool)).slice(-8);
}
module.exports = { describe, start, finish, forReply, pending };
