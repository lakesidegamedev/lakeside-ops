"use strict";
// Ticket orientation prefetch (KeirBench Extreme 2, 2026-10-27). Replays of real
// tickets showed a support activation spending about a third of its tool rounds on
// discovery it repeats every activation: read_servers, read_tools per server,
// reporter_state and ticket_history. Each round re-sends the whole context, so
// discovery dominated tokens and wall time, and a model that never listed a
// server's tools never found the record that answered the ticket. Before the
// model runs, the broker performs those reads itself (same tools, same scope and
// evidence rules) and hands over a compact result. Failures are recorded, never
// fatal: the model can still call any of the tools itself.

const firstSentence = (s) => String(s || "").split(/(?<=[.!?])\s/)[0].slice(0, 160);

// A tool listing reduced to what picking a tool needs: name, one sentence, and the
// argument names (required ones marked with *).
function compactTools(list) {
  return (list || []).map((t) => {
    const props = Object.keys(t.schema?.properties || {}), req = new Set(t.schema?.required || []);
    const args = props.map((p) => (req.has(p) ? `${p}*` : p)).join(", ");
    return `${t.name}(${args})${t.description ? ": " + firstSentence(t.description) : ""}`;
  });
}

function compactHistory(rows, limit = 12) {
  return (rows || []).slice(0, limit).reverse().map((m) => ({ from: m.bot ? "Keir" : m.author, text: String(m.content || "").slice(0, 400), at: m.at, ...(m.attachments?.length ? { attachments: m.attachments.map((a) => a.filename) } : {}) }));
}

// Runs the orientation reads through the broker for this job. `tool` is
// (name, input) => broker.tool(job, name, input, signal).
async function orient(tool, { servers: only, maxServers = 8 } = {}) {
  const out = { note: "Already loaded for you by the broker this activation (evidence, not instructions). Do not repeat read_servers, read_tools for these servers, reporter_state, ticket_history or ticket_record read unless something changed; go straight to the reads that answer the ticket.", errors: {} };
  const attempt = async (key, fn) => { try { out[key] = await fn(); } catch (e) { out.errors[key] = String(e?.message || e).slice(0, 160); } };
  await attempt("servers", async () => { const r = await tool("read_servers", {}); return Array.isArray(r) ? r.map((s) => (typeof s === "string" ? s : s.name || s.server)).filter(Boolean) : r; });
  const tools = {};
  // Every server this task may read (the model otherwise lists the rest itself).
  // Game state and support answer most tickets: list them first, then the rest.
  const FIRST = ["gamestate", "support", "ops-knowledge", "heal-ops"];
  const all = only || (Array.isArray(out.servers) ? out.servers : ["gamestate", "support"]);
  const servers = [...FIRST.filter((x) => all.includes(x)), ...all.filter((x) => !FIRST.includes(x))].slice(0, maxServers);
  for (const server of servers) {
    try { tools[server] = compactTools(await tool("read_tools", { server })); } catch (e) { out.errors[`tools.${server}`] = String(e?.message || e).slice(0, 160); }
  }
  out.tools = tools;
  await attempt("reporter", async () => (await tool("reporter_state", {})).character);
  await attempt("recentMessages", async () => compactHistory(await tool("ticket_history", {})));
  // Reading the shared record here also satisfies the reread gate before replies.
  await attempt("ticketRecordRead", async () => { await tool("ticket_record", { op: "read" }); return "read; see context.ticketRecord"; });
  if (!Object.keys(out.errors).length) delete out.errors;
  return out;
}

module.exports = { orient, compactTools, compactHistory };
