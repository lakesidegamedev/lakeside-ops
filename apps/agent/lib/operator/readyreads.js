"use strict";
// Keir 7: two-call answers. Before the model starts, the broker loads the read
// tools that match the request, with their exact input schemas, so the first
// call can be the read and the second the reply. Measured 2026-10-25 to 11-01:
// a ticket took a median 9 tool calls, and an owner's "how many players logged
// on in the last 7 days" spent four calls listing servers and tools before one
// geo_aggregate read, then ran out of steps.
//
// Matching is by meaning (the box's embedding proxy), over two sources:
// - the tool's own name and description, and
// - examples: questions that a tool actually answered before. Every read that
//   returns something in a task with a human question is remembered, so the
//   index learns the words players and staff really use ("logged on" for
//   active players). Seeds cover known misses.
// Everything fails open: no embedder, a slow catalog or an unreadable server
// means fewer or no ready reads, never a refused activation.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_EXAMPLES = 3000;
const CATALOG_TTL_MS = 10 * 60000;
const SEEDS = [
  ["how many players have logged on in the last 7 days", "gamestate", "geo_aggregate"],
  ["how many people played this week", "gamestate", "geo_aggregate"],
  ["active players per country", "gamestate", "geo_aggregate"],
  ["how many players are online today", "gamestate", "geo_aggregate"],
  ["why is the turn stuck", "turndiag", "lock_status"],
  ["what is the price of steel", "gamestate", "commodity_market"],
  ["what does my corporation own and earn", "gamestate", "trace_corp"],
  ["my money went missing", "gamestate", "trace_account"],
  ["who won the election", "gamestate", "trace_election"],
  ["when does the cabinet nomination vote end", "gamestate", "nomination_records"],
  ["is my supreme court nominee confirmed", "gamestate", "nomination_records"],
  ["what shares do I own", "gamestate", "character_holdings"],
  ["who controls my company", "gamestate", "character_holdings"],
  ["why did the turn fail", "turndiag", "turn_failure_detail"],
];

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const cosine = (a, b) => { let s = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? s / Math.sqrt(x * y) : 0; };
const docOf = (t) => `${t.server} ${String(t.name).replace(/_/g, " ")}: ${String(t.description || "").slice(0, 600)}`;

function defaultEmbed(url, model) {
  return async (inputs, timeoutMs = 2500) => {
    const res = await fetch(`${url}/api/embed`, { method: "POST", body: JSON.stringify({ model, input: inputs }), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`embed ${res.status}`);
    const out = await res.json();
    if (!Array.isArray(out.embeddings) || out.embeddings.length !== inputs.length) throw new Error("embed returned no vectors");
    return out.embeddings;
  };
}

function createReadyReads({ mcp, stateDir, readable = () => true, embed = null, embedUrl = "http://127.0.0.1:11437", embedModel = "nemotron-embed-1b-v2", now = () => Date.now(), log = () => {} }) {
  const embedder = embed || defaultEmbed(embedUrl, embedModel);
  const file = stateDir ? path.join(stateDir, "readyreads-examples.json") : null;
  let examples = [];
  try { if (file && fs.existsSync(file)) examples = JSON.parse(fs.readFileSync(file, "utf8")).examples || []; } catch { examples = []; }
  const vectors = new Map(); // text hash -> vector
  let catalog = { at: 0, tools: [] };

  async function vectorsFor(texts) {
    const missing = [...new Set(texts.filter((t) => !vectors.has(hash(t))))];
    for (let i = 0; i < missing.length; i += 64) {
      const batch = missing.slice(i, i + 64);
      const out = await embedder(batch, 8000);
      batch.forEach((t, j) => vectors.set(hash(t), out[j]));
    }
    return texts.map((t) => vectors.get(hash(t)));
  }

  // The first build lists ~300 tools and embeds their descriptions, which
  // took over 4 s cold on 2026-11-01. warm() does it in the background at
  // startup and on a timer, so pick() never waits on a listing.
  let warming = null;
  function warm(servers) {
    if (warming) return warming;
    warming = (async () => { catalog = { at: 0, tools: catalog.tools }; const tools = await loadCatalog(servers); await vectorsFor([...tools.map(docOf), ...[...SEEDS.map(([q]) => q), ...examples.map((e) => e.q)]]); return tools.length; })()
      .catch((e) => { log(`readyreads warm: ${e.message}`); return 0; }).finally(() => { warming = null; });
    return warming;
  }
  async function loadCatalog(servers) {
    if (now() - catalog.at < CATALOG_TTL_MS && catalog.tools.length) return catalog.tools;
    const rows = await Promise.allSettled(servers.map(async (server) => (await mcp.list(server, AbortSignal.timeout(3000))).map((t) => ({ server, name: t.name, description: t.description || "", inputSchema: t.inputSchema || t.input_schema || null }))));
    const tools = rows.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
    if (tools.length) catalog = { at: now(), tools };
    return catalog.tools;
  }

  // The request's own words: the opening message and the newest human input.
  function questionOf(job) {
    const human = [...(job.requestInbox || []), ...(job.inbox || [])].filter((m) => m && m.role !== "system" && m.role !== "assistant").map((m) => m.content);
    return [job.source?.content, ...human.slice(-2)].filter(Boolean).join("\n").slice(0, 1200).trim();
  }

  async function pick(job, options = {}) {
    try { return await rank(job, options); } catch (e) { log(`readyreads: ${e.message}`); return []; }
  }
  async function rank(job, { servers = [], k = 6 } = {}) {
    const question = questionOf(job);
    if (!question || !servers.length) return [];
    // Never wait on a cold build: serve what is warm, and warm the rest.
    if (!catalog.tools.length) { warm(servers); return []; }
    if (now() - catalog.at >= CATALOG_TTL_MS) warm(servers);
    const tools = catalog.tools.filter((t) => readable(job, t.server, t.name) && !/(?:_catalog|_tools|_servers)$/.test(t.name));
    if (!tools.length) return [];
    const seeded = [...SEEDS.map(([q, server, tool]) => ({ q, server, tool })), ...examples];
    const exampleRows = seeded.filter((e) => tools.some((t) => t.server === e.server && t.name === e.tool));
    const [qv, ...rest] = await vectorsFor([question, ...tools.map(docOf), ...exampleRows.map((e) => e.q)]);
    const docV = rest.slice(0, tools.length), exV = rest.slice(tools.length);
    const best = new Map();
    tools.forEach((t, i) => best.set(`${t.server}/${t.name}`, cosine(qv, docV[i])));
    // An example someone really asked counts for a little more than a description.
    exampleRows.forEach((e, i) => { const key = `${e.server}/${e.tool}`; best.set(key, Math.max(best.get(key) ?? 0, cosine(qv, exV[i]) + 0.05)); });
    const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
    return ranked.map(([key, score]) => {
      const t = tools.find((x) => `${x.server}/${x.name}` === key);
      return { server: t.server, tool: t.name, description: String(t.description).slice(0, 400), inputSchema: t.inputSchema, score: Number(score.toFixed(3)) };
    });
  }

  // A read that returned something, in a task with a human question.
  function learn(job, server, tool) {
    const q = questionOf(job);
    if (!q || q.length < 8 || !server || !tool) return;
    const seen = (job.readyReadsLearned ||= []);
    const key = `${server}/${tool}`;
    if (seen.includes(key) || seen.length >= 3) return;
    seen.push(key);
    examples = [...examples.filter((e) => !(e.q === q.slice(0, 300) && e.server === server && e.tool === tool)), { q: q.slice(0, 300), server, tool, at: now() }].slice(-MAX_EXAMPLES);
    if (file) { try { fs.writeFileSync(file, JSON.stringify({ examples }), { mode: 0o600 }); } catch (e) { log(`readyreads: ${e.message}`); } }
  }

  return { pick, learn, warm, questionOf, examples: () => examples };
}

module.exports = { createReadyReads, SEEDS, cosine };
