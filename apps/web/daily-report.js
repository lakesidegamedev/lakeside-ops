// daily-report.js — gathers telemetry across the WHOLE platform (engine, game,
// community, support, traffic, errors/Sentry, deploys/Railway, LLM usage,
// security, infra) and has the LLM (Kimi) synthesize a detailed Daily
// Operations Report: an executive summary (for the dashboard card), detailed
// sections (for the /reports page), and actionable items (each with a ready
// prompt to launch a code agent). Stored one-per-day in `daily_reports`.
const fs = require("fs");
const { execSync } = require("child_process");
const { callChat } = require("./llm");
const { engineHealth } = require("./engine-health");
const { watchtowerScan } = require("./watchtower");
const { getDashboardMetrics } = require("./metrics");

const COLLECTION = "daily_reports";

async function gatherReportData(db) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const d = { date, generatedAt: now };

  await Promise.all([
    (async () => { try { d.engine = await engineHealth(db); } catch (e) { d.engine = { error: e.message }; } })(),
    (async () => { try { d.watchtower = await watchtowerScan(db); } catch (e) { d.watchtower = { error: e.message }; } })(),
    (async () => {
      try {
        const gs = await db.collection("gameState").findOne({ isActive: true });
        d.game = { turn: gs && gs.currentTurn, year: gs && gs.currentYear, paused: !!(gs && gs.pausedAt),
          players: await db.collection("characters").countDocuments({}),
          activeElections: await db.collection("elections").countDocuments({ status: "active" }),
          parties: await db.collection("politicalParties").countDocuments({}) };
      } catch (e) { d.game = { error: e.message }; }
    })(),
    (async () => {
      try {
        d.community = {
          messages24h: await db.collection("discord_messages").countDocuments({ ts: { $gte: since } }),
          totalMessages: await db.collection("discord_messages").countDocuments({}),
          activeAuthors24h: (await db.collection("discord_messages").distinct("author", { ts: { $gte: since } })).length,
        };
        const top = await db.collection("discord_messages").aggregate([
          { $match: { ts: { $gte: since } } }, { $group: { _id: "$channelName", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 4 },
        ]).toArray();
        d.community.topChannels24h = top.map((t) => `#${t._id} (${t.n})`);
        const meta = await db.collection("ideas_meta").findOne({ _id: "latest" });
        if (meta) d.community.themes = (meta.themes || []).map((t) => t.title);
        // Actual message content from the last 24h (not just counts), so the
        // Community section is grounded in what people actually said rather
        // than restating stats. Capped and truncated to keep the prompt small.
        const recent = await db.collection("discord_messages")
          .find({ ts: { $gte: since }, content: { $exists: true, $ne: "" } })
          .sort({ ts: -1 }).limit(80)
          .project({ channelName: 1, author: 1, content: 1 }).toArray();
        d.community.recentSample24h = recent.map((m) => `[${m.channelName}] ${m.author}: ${(m.content || "").replace(/\n/g, " ").slice(0, 160)}`);
      } catch (e) { d.community = { error: e.message }; }
    })(),
    // The whole dashboard metrics blob: users, tickets, sentry, traffic, railway, llmUsage.
    (async () => { try { d.metrics = await getDashboardMetrics(db); } catch (e) { d.metrics = { error: e.message }; } })(),
    // Market-rework dials (week-1 clearing/capital watchlist, t900): the four
    // numbers that tell us whether the −24% sim scenario is materializing and
    // whether the price signal is transmitting.
    (async () => {
      try {
        const gs = await db.collection("gameState").findOne({ isActive: true }, { projection: { currentTurn: 1 } });
        const turn = gs && gs.currentTurn;
        const flows = await db.collection("commodityFlows")
          .find({ turn }, { projection: { commodity: 1, supplyUnits: 1, demandUnits: 1, unmetDemandUnits: 1, stockUnits: 1, spoiledUnits: 1 } }).toArray();
        const demand = flows.reduce((s, f) => s + (f.demandUnits || 0), 0);
        const unmet = flows.reduce((s, f) => s + (f.unmetDemandUnits || 0), 0);
        const spoiled = flows.reduce((s, f) => s + (f.spoiledUnits || 0), 0);
        const stock = flows.reduce((s, f) => s + (f.stockUnits || 0), 0);
        const shortages = flows.filter((f) => f.demandUnits > 0 && f.supplyUnits / f.demandUnits < 0.5)
          .map((f) => `${f.commodity} ${(f.supplyUnits / f.demandUnits).toFixed(2)}`);
        const negLC = await db.collection("corporations").countDocuments({ isNationalized: { $ne: true }, liquidCapital: { $lt: 0 } });
        const drift = await db.collection("commodityPrices")
          .find({ scarcityMult: { $exists: true, $ne: 1 } }, { projection: { commodity: 1, scarcityMult: 1 } })
          .sort({ scarcityMult: -1 }).limit(5).toArray();
        d.marketDials = {
          turn,
          unmetSharePct: demand > 0 ? Math.round((unmet / demand) * 100) : null,
          worstShortages: shortages,
          negativeLcCorps: negLC,
          stockUnits: Math.round(stock),
          spoiledPerTurn: Math.round(spoiled),
          topDrift: drift.map((p) => `${p.commodity} ${p.scarcityMult.toFixed(2)}x`),
        };
      } catch (e) { d.marketDials = { error: e.message }; }
    })(),
  ]);

  try {
    const a = JSON.parse(fs.readFileSync("/var/lib/ahd-semgrep/latest.json", "utf8")); const res = a.results || [];
    d.security = { total: res.length, errors: res.filter((r) => (r.extra || {}).severity === "ERROR").length, warnings: res.filter((r) => (r.extra || {}).severity === "WARNING").length };
  } catch { d.security = null; }

  try {
    const free = execSync("free -m", { timeout: 4000 }).toString().split("\n");
    const mem = (free.find((l) => l.startsWith("Mem:")) || "").split(/\s+/);
    const swap = (free.find((l) => l.startsWith("Swap:")) || "").split(/\s+/);
    d.infra = { memUsedMb: +mem[2] || null, memAvailMb: +mem[6] || null, swapUsedMb: +swap[2] || null, load1: +require("os").loadavg()[0].toFixed(2) };
  } catch (e) { d.infra = { error: e.message }; }

  return d;
}

// Readable fact list (embedding raw JSON makes the coding model misbehave).
function factsText(data) {
  const e = data.engine || {}, g = data.game || {}, c = data.community || {}, inf = data.infra || {}, sec = data.security;
  const m = data.metrics || {}, gt = m.sentry || {}, tr = m.traffic || {}, rw = m.railway || {}, tk = m.tickets || {}, us = m.users || {}, lu = m.llmUsage || {};
  const lt = e.lastTurn, ec = e.economy;
  const lines = [
    `Game: turn ${g.turn} (year ${g.year}), ${g.players} players, ${g.activeElections} active elections, ${g.parties} parties${g.paused ? " — PAUSED" : ""}`,
    lt ? `Engine: last turn ${lt.turn} ${lt.success === false ? "FAILED" : "ok"}, ${Math.round((lt.durationMs || 0) / 1000)}s, ${(lt.failedPhases || []).length} failed phases; ${(e.elections || {}).overdue || 0} stuck elections` : "",
    `Engine flags: ${(e.flags || []).length ? e.flags.map((f) => `${f.level}:${f.msg}`).join("; ") : "none — nominal"}`,
    (() => { const w = data.watchtower; if (!w || w.error || !(w.alerts || []).length) return w && w.error ? `Watchtower: probe error (${w.error})` : "Watchtower: no cross-instrument anomalies"; return `Watchtower (cross-instrument anomalies): ${w.alerts.map((a) => `${a.severity}:${a.title}${a.metric ? ` [${a.metric}]` : ""}`).join("; ")}`; })(),
    ec && ec.topInflation ? `Economy: hottest ${ec.topInflation.commodity} ${ec.topInflation.x}x base, coldest ${ec.topDeflation && ec.topDeflation.commodity} ${ec.topDeflation && ec.topDeflation.x}x` : "",
    (() => { const md = data.marketDials; if (!md || md.error) return md && md.error ? `Market dials: error (${md.error})` : ""; return `Market dials (rework watchlist): ${md.unmetSharePct}% of demand unmet; shortages s/d<0.5: ${(md.worstShortages || []).join(", ") || "none"}; ${md.negativeLcCorps} corps negative-LC; stock ${Math.round(md.stockUnits / 1e6)}M units, spoilage ${Math.round(md.spoiledPerTurn / 1e6)}M/turn; scarcity drift: ${(md.topDrift || []).join(", ") || "off/neutral"}`; })(),
    `Community: ${c.messages24h} Discord msgs in 24h from ${c.activeAuthors24h} authors (${c.totalMessages} all-time). Top channels: ${(c.topChannels24h || []).join(", ")}. Themes: ${(c.themes || []).slice(0, 6).join(", ")}`,
    (c.recentSample24h || []).length ? `Actual Discord messages from the last 24h (quote specific ones in the Community section, don't just restate the counts above):\n${c.recentSample24h.slice(0, 40).join("\n")}` : "",
    `Players: ${us.ok ? us.total : "?"} total${us.new7d ? `, +${us.new7d} this week` : ""}${us.banned != null ? `, ${us.banned} banned` : ""}`,
    tr.ok ? `Traffic (Cloudflare): ${tr.uniquesToday} visitors today, ${tr.uniques7d} in 7d, ${tr.pageViews7d} pageviews/7d, ${tr.requests7d} requests/7d, ${tr.cacheHit}% cache hit` : "",
    `Errors (Sentry): ${gt.ok ? `${gt.count} open issues` : "n/a"}${gt.ok && (gt.issues || []).length ? " — top: " + gt.issues.slice(0, 5).map((i) => `[${i.level}] ${i.title}${i.seen ? ` ×${i.seen}` : ""}`).join(" | ") : ""}`,
    `Deploys (Railway): ${rw.ok ? (rw.services || []).map((s) => `${s.name}=${(s.status || "?").toLowerCase()}`).join(", ") : "n/a"}`,
    `Support: ${tk.newTickets24h || 0} NEW tickets + ${tk.newSuggestions24h || 0} NEW suggestions opened in the last 24h. ${tk.outstandingTickets} open tickets, ${tk.outstandingSuggestions} open suggestions total, ${tk.completedTickets} resolved all-time, avg ${tk.avgDuration || "n/a"}`,
    sec ? `Security (Semgrep): ${sec.total} findings — ${sec.errors} errors, ${sec.warnings} warnings` : "Security: no recent scan",
    `Infra: ${inf.memAvailMb}MB RAM available, ${inf.swapUsedMb}MB swap in use, load ${inf.load1}`,
    lu ? `LLM usage (7d): Kimi ${(lu.kimi || {}).calls || 0} calls, Ollama ${(lu.ollama || {}).calls || 0} calls` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function tryParseReport(content) {
  let t = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const mm = t.match(/\{[\s\S]*\}/);
  if (mm) t = mm[0];
  t = t.replace(/,\s*([}\]])/g, "$1");
  try { const p = JSON.parse(t); if (p && p.sections) return p; } catch { /* no */ }
  return null;
}

async function generateReport(data) {
  const prompt = `You are the senior operations analyst for "A House Divided", a live multiplayer political-simulation game. Write a DETAILED DAILY OPERATIONS REPORT for ${data.date} from the telemetry.

Respond with ONLY valid JSON (no prose, no code fences):
{
 "headline":"<one vivid sentence>",
 "mood":"good|watch|alert",
 "executiveSummary":"<2-3 sentence summary for an exec glance — the single most important things today>",
 "sections":[
   {"emoji":"🎮","title":"Game & engine","body":"<3-5 sentences, specific numbers, trends, concerns>"},
   {"emoji":"💬","title":"Community","body":"..."},
   {"emoji":"📈","title":"Economy","body":"..."},
   {"emoji":"🛟","title":"Support & ops","body":"..."},
   {"emoji":"🐛","title":"Errors & reliability","body":"<reference the Sentry issues by name>"},
   {"emoji":"🚦","title":"Traffic & deploys","body":"..."},
   {"emoji":"🛡️","title":"Security & infra","body":"..."}
 ],
 "actions":[
   {"title":"<short imperative>","detail":"<why it matters + what to do>","severity":"high|med|low","agentPrompt":"<a complete, self-contained prompt a coding agent can act on to investigate/fix this in the A House Divided codebase>"}
 ]
}

Rules: be detailed and cite ACTUAL numbers/error names. mood="alert" if engine has error flags, a turn failed, or security has errors; "watch" for warnings/pressure/notable error counts; else "good". Create an "actions" item for each genuinely actionable problem (failed engine phases, recurring Sentry errors, security errors, stuck elections, churn signals). 0-5 actions. Each agentPrompt must be concrete and standalone.

TELEMETRY:
${factsText(data)}`;
  let lastContent = "", model = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await callChat({ messages: [{ role: "user", content: prompt }], maxTokens: 6000, temperature: 1 });
    lastContent = r.content || ""; model = r.model;
    const parsed = tryParseReport(lastContent);
    if (parsed) return { ...parsed, model };
  }
  return { headline: "Daily operations report", mood: "good", executiveSummary: String(lastContent).slice(0, 300), sections: [{ emoji: "📋", title: "Summary", body: String(lastContent).slice(0, 600) || "(no content)" }], actions: [], model };
}

async function buildAndSave(db) {
  const data = await gatherReportData(db);
  const r = await generateReport(data);
  const m = data.metrics || {};
  const doc = {
    _id: data.date, date: data.date, generatedAt: new Date(),
    headline: r.headline || "Daily operations report", mood: r.mood || "good",
    executiveSummary: r.executiveSummary || r.headline || "", sections: r.sections || [],
    actions: (r.actions || []).filter((a) => a && a.title), model: r.model,
    metrics: {
      players: data.game && data.game.players, turn: data.game && data.game.turn,
      messages24h: data.community && data.community.messages24h,
      visitorsToday: (m.traffic || {}).uniquesToday, openIssues: (m.sentry || {}).count,
      openTickets: (m.tickets || {}).outstandingTickets,
      engineFlags: ((data.engine && data.engine.flags) || []).length,
      securityErrors: data.security && data.security.errors,
    },
  };
  await db.collection(COLLECTION).replaceOne({ _id: data.date }, doc, { upsert: true });
  return doc;
}

async function getReports(db, limit = 30) {
  return db.collection(COLLECTION).find({}, { projection: { _id: 0 } }).sort({ date: -1 }).limit(limit).toArray();
}
async function getReport(db, date) { return db.collection(COLLECTION).findOne({ _id: date }, { projection: { _id: 0 } }); }

module.exports = { gatherReportData, generateReport, buildAndSave, getReports, getReport, COLLECTION };
