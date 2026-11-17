"use strict";
// Keir 10 evidence pack. Before the model's first run on a ticket, code gathers
// the reads that lane almost always needs, in parallel and with a short timeout,
// so the model starts from evidence instead of spending rounds discovering it.
// A read that fails or a tool that does not exist yet is listed under `missing`
// with the reason; it never blocks the activation.

const STOP = new Set("about after again also and any are because been before being but can cannot could did does doing dont down even every from have having here how into its just know like make many more most much must need not now off only other our out over please same should show since some still such than that the their them then there these they this those through too under until very want was way well were what when where which while who why will with without would your yours you yes get got how what does".split(" "));

// The main words of the player's text, longest first, for keyword search.
function keywords(text, n = 3) {
  const words = String(text || "").toLowerCase().replace(/https?:\/\/\S+/g, " ").match(/[a-z][a-z'-]{3,}/g) || [];
  const seen = new Set(), out = [];
  for (const w of words.sort((a, b) => b.length - a.length)) { const k = w.replace(/'s$/, ""); if (!STOP.has(k) && !seen.has(k)) { seen.add(k); out.push(k); } if (out.length >= n) break; }
  return out;
}

const clip = (v, max) => { const s = typeof v === "string" ? v : JSON.stringify(v ?? null); return s.length > max ? `${s.slice(0, max)} [cut, ${s.length} chars]` : s; };

// Which reads each lane gets. Each step: { id, needs: "read:<server>" | "tool:<name>", run(ctx) }.
function plan(lane, ctx) {
  const q = ctx.question;
  const wiki = { id: "wiki", needs: "read:lore", run: async (c) => {
    const pages = new Map();
    for (const k of keywords(q, 2)) {
      const r = await c.read("lore", "lore_wiki_search", { q: k, limit: 4 });
      for (const p of r?.pages || []) if (!pages.has(p.slug)) pages.set(p.slug, { slug: p.slug, title: p.title, description: p.description });
    }
    return { pages: [...pages.values()].slice(0, 5), note: "Player wiki pages. Open one with read_tool lore lore_wiki_page {slug} before quoting it." };
  } };
  const code = { id: "code", needs: "read:ops-knowledge", run: (c) => c.read("ops-knowledge", "code_search", { question: q.slice(0, 400), claimType: "mechanic", source: "prod", topK: 4, maxChars: 6000 }) };
  const reporter = { id: "reporter", needs: "tool:resolve_reporter", run: (c) => c.tool("resolve_reporter", {}) };
  const trail = { id: "player_trail", needs: "tool:player_trail", run: (c) => c.tool("player_trail", {}) };
  const turn = { id: "turn_status", needs: "tool:turn_status", run: (c) => c.tool("turn_status", {}) };
  // Keir 10.4 (ticket 1852): who else is already on this. Only a result with something in it is kept.
  const team = { id: "team_activity", needs: "tool:team_activity", run: async (c) => {
    const r = await c.tool("team_activity", { topic: keywords(q, 5).join(" ") });
    return r && r.report && /^\d\. .*:$/m.test(r.report) ? { covered: r.covered === true, report: r.report, instruction: r.instruction } : null;
  } };
  const ask = { id: "ask_health", needs: "tool:ask", run: (c) => c.tool("ask", { action: "health" }) };
  // Keir 10 (replay 2026-11-15): an outage never found the open incident it belonged to; look for it up front.
  const similar = { id: "similar_reports", needs: "tool:similar_reports", run: (c) => c.tool("similar_reports", { text: q.slice(0, 300) }) };
  return ({
    question: [wiki, code, ask, team],
    idea: [wiki, code, team],
    advice: [ask, wiki],
    bug: [reporter, trail, code, similar, team],
    data_repair: [reporter, team],
    outage: [turn, similar, team],
    people: [reporter, team],
  })[lane] || [];
}

// build({ job, lane, question, servers, tools, read, tool, timeoutMs, maxChars })
// read(server, tool, args) and tool(name, input) call the broker; servers and
// tools are what this task may use. Returns { items, missing, ms }.
async function build({ lane, question, servers = [], tools = [], read, tool, timeoutMs = 6000, maxChars = 9000, now = Date.now }) {
  const started = now(), steps = plan(lane, { question: String(question || "") });
  const ctx = { read, tool };
  const avail = (needs) => { const [k, v] = needs.split(":"); return k === "read" ? servers.includes(v) : tools.includes(v); };
  const missing = [], runnable = [];
  for (const s of steps) {
    if (avail(s.needs)) runnable.push(s);
    else missing.push({ id: s.id, reason: `${s.needs.replace(":", " ")} is not available to this task` });
  }
  const per = Math.max(800, Math.floor(maxChars / Math.max(1, runnable.length)));
  const results = await Promise.allSettled(runnable.map((s) => {
    let timer; const late = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs); });
    return Promise.race([Promise.resolve().then(() => s.run(ctx)), late]).finally(() => clearTimeout(timer));
  }));
  const items = [];
  results.forEach((r, i) => {
    const s = runnable[i];
    if (r.status === "fulfilled") { if (r.value != null) items.push({ id: s.id, result: clip(r.value, per) }); }
    else missing.push({ id: s.id, reason: String(r.reason?.message || r.reason).slice(0, 200) });
  });
  return { lane, items, missing, ms: now() - started };
}

module.exports = { build, plan, keywords };
