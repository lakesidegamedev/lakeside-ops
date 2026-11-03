"use strict";

// ─── ECONOMY PAGE ─────────────────────────────────────────────────────────
// The AHD macro tracker, inside the dashboard. A separate exporter reads the
// game database read-only once per turn and writes one compact JSON feed
// (ECONOMY_FEED_FILE); this module only renders it.
//
// Server-rendered: tabs and the time range are plain links (?tab=, ?range=),
// so the page carries no client script. Returns { extraCss, body }.

const fs = require("fs");

const FEED_FILE = process.env.ECONOMY_FEED_FILE || "/var/lib/ahd-economy/economy.json";

const TABS = [
  ["overview", "Overview"],
  ["markets", "Markets"],
  ["companies", "Companies"],
  ["players", "Players"],
  ["countries", "Countries"],
  ["fixes", "Fixes"],
];

const CSS = `
.eco{display:flex;flex-direction:column;gap:var(--s-4);max-width:1440px;margin:0 auto;padding:var(--s-5) var(--s-5) var(--s-8)}
.eco-wide{grid-column:1/-1}
.eco-head{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--s-3);flex-wrap:wrap}
.eco-head h1{font-size:var(--fs-h1);margin:0}
.eco-sub{color:var(--text-3);font-size:var(--fs-sm)}
.eco-seg{display:inline-flex;border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden}
.eco-seg a{padding:.3rem .7rem;font-size:var(--fs-xs);color:var(--text-2);text-decoration:none}
.eco-seg a+a{border-left:1px solid var(--border)}
.eco-seg a.on{background:var(--accent-soft);color:var(--text)}
.eco-scores{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s-3)}
.eco-score{display:grid;grid-template-columns:auto 1fr;gap:.2rem var(--s-3);align-items:center;padding:var(--s-3) var(--s-4);border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface)}
.eco-score .lbl{grid-column:1/-1;font-size:var(--fs-xs);color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.eco-score b{font-size:1.6rem;font-family:var(--mono);line-height:1}
.eco-score .d{font-size:var(--fs-xs);font-family:var(--mono)}
.eco-score svg{grid-column:1/-1;width:100%;height:34px}
.eco-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);overflow-x:auto}
.eco-tabs a{padding:.55rem .9rem;font-size:var(--fs-sm);color:var(--text-2);text-decoration:none;border-bottom:2px solid transparent;white-space:nowrap}
.eco-tabs a.on{color:var(--text);border-bottom-color:var(--accent);font-weight:600}
.eco-tabs a .n{margin-left:.35rem;font-size:var(--fs-2xs,.7rem);font-family:var(--mono);color:var(--red)}
.eco-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(560px,1fr));gap:var(--s-4);align-items:start}
.eco-card{border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);min-width:0}
.eco-card>h2{font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);font-weight:700;margin:0;padding:var(--s-3) var(--s-4) var(--s-2)}
.eco-card>p{margin:0;padding:0 var(--s-4) var(--s-3);color:var(--text-3);font-size:var(--fs-xs)}
.eco-t{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}
.eco-t th{font-size:var(--fs-2xs,.7rem);text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);font-weight:600;text-align:right;padding:.35rem .6rem;border-bottom:1px solid var(--border);white-space:nowrap}
.eco-t th:first-child,.eco-t td:first-child{text-align:left;padding-left:var(--s-4)}
.eco-t td{padding:.32rem .6rem;border-bottom:1px solid var(--border);text-align:right;font-family:var(--mono);font-size:var(--fs-xs);white-space:nowrap}
.eco-t td:first-child{font-family:inherit;font-size:var(--fs-sm);white-space:normal}
.eco-t tr:last-child td{border-bottom:0}
.eco-t tr.grp td{background:var(--glass-1);font-family:inherit;font-size:var(--fs-2xs,.7rem);text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);font-weight:700}
.eco-t td.sp{width:132px;padding-top:.15rem;padding-bottom:.15rem}
.eco-t td.sp svg{width:120px;height:22px;display:block;margin-left:auto}
.eco-t .muted{color:var(--text-3)}
.dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;margin-right:.45rem;vertical-align:middle;background:var(--text-3)}
.dot.green{background:var(--green)}.dot.amber{background:var(--amber)}.dot.red{background:var(--red)}
.up{color:var(--green)}.down{color:var(--red)}
.st-live{color:var(--green)}.st-merged{color:var(--blue)}.st-open,.st-draft{color:var(--amber)}.st-closed,.st-planned,.st-watch{color:var(--text-3)}
.eco-multi{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:1px;background:var(--border);border-top:1px solid var(--border);border-radius:0 0 var(--r-lg) var(--r-lg);overflow:hidden}
.eco-mini{background:var(--surface);padding:var(--s-2) var(--s-3) var(--s-1)}
.eco-mini .top{display:flex;justify-content:space-between;align-items:baseline;gap:.5rem}
.eco-mini .top span{font-size:var(--fs-xs);color:var(--text-3)}
.eco-mini .top b{font-family:var(--mono);font-size:var(--fs-sm)}
.eco-mini svg{width:100%;height:56px;display:block}
.eco-empty{padding:var(--s-6);text-align:center;color:var(--text-3);border:1px dashed var(--border);border-radius:var(--r-lg)}
@media (max-width:760px){.eco-scores{grid-template-columns:1fr}.eco-cols{grid-template-columns:1fr}.eco-t td.sp{display:none}.eco-t th.sp{display:none}}
`;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function readFeed(file = FEED_FILE) {
  try {
    const feed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { feed, mtime: fs.statSync(file).mtime };
  } catch (e) {
    return { feed: null, error: e.code === "ENOENT" ? "The economy feed has not been written yet." : e.message };
  }
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const titleCase = (k) => String(k).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function compact(v) {
  if (!isNum(v)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

function fmt(v, unit) {
  if (!isNum(v)) return "-";
  if (unit === "%") return v.toFixed(Math.abs(v) >= 100 ? 0 : 1) + "%";
  if (unit === "x") return v.toFixed(2) + "x";
  if (unit === "pts") return v.toFixed(1) + " pts";
  if (v === 999 && !unit) return "no burn";
  if (Math.abs(v) >= 998) return compact(v);
  if (Math.abs(v) >= 10) return v.toFixed(0);
  return v.toFixed(Math.abs(v) >= 1 ? 2 : 3);
}

function delta(now, prev, unit, goodUp) {
  if (!isNum(now) || !isNum(prev)) return '<span class="muted">-</span>';
  const d = now - prev;
  if (Math.abs(d) < 1e-9) return '<span class="muted">0</span>';
  const txt = (d > 0 ? "+" : "") + (unit === "x" ? d.toFixed(2) : Math.abs(d) >= 10 ? d.toFixed(0) : d.toFixed(Math.abs(d) >= 1 ? 1 : 2));
  const cls = goodUp == null ? "" : (d > 0) === goodUp ? "up" : "down";
  return `<span class="${cls}">${esc(txt)}</span>`;
}

// Is a higher value better for this band? Bands open at the top read "higher is better".
function goodDirection(g) {
  if (!g.green) return null;
  const [lo, hi] = g.green;
  if (hi >= 1e8) return true;
  if (lo <= 0 && g.amber && g.amber[0] <= 0) return false;
  return null;
}

function bandText(g) {
  if (!g.green) return "";
  const [lo, hi] = g.green;
  if (hi >= 1e8) return "at least " + fmt(lo, g.unit);
  if (lo <= 0 && hi > 0 && g.amber && g.amber[0] <= 0) return "at most " + fmt(hi, g.unit);
  return fmt(lo, g.unit) + " to " + fmt(hi, g.unit);
}

// Sparkline / mini chart. pts: [[turn, value]]. Optional green band and reset markers.
function spark(pts, { w = 120, h = 22, band = null, marks = [], stroke = "var(--accent)" } = {}) {
  const vals = pts.filter((p) => isNum(p[1]));
  if (vals.length < 2) return "";
  const t0 = vals[0][0], t1 = vals[vals.length - 1][0] || t0 + 1;
  let lo = Math.min(...vals.map((p) => p[1])), hi = Math.max(...vals.map((p) => p[1]));
  if (band) {
    const bl = Math.max(band[0], lo - (hi - lo)), bh = Math.min(band[1], hi + (hi - lo));
    lo = Math.min(lo, bl); hi = Math.max(hi, bh);
  }
  if (hi === lo) { hi += 1; lo -= 1; }
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * w;
  const y = (v) => h - 2 - ((v - lo) / (hi - lo)) * (h - 4);
  let out = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">`;
  if (band) {
    const yt = y(Math.min(band[1], hi)), yb = y(Math.max(band[0], lo));
    if (yb > yt) out += `<rect x="0" y="${yt.toFixed(1)}" width="${w}" height="${(yb - yt).toFixed(1)}" fill="var(--green)" opacity=".12"/>`;
  }
  for (const m of marks) if (m > t0 && m < t1) out += `<line x1="${x(m).toFixed(1)}" x2="${x(m).toFixed(1)}" y1="0" y2="${h}" stroke="var(--text-3)" stroke-dasharray="2 2" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  const line = vals.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  out += `<polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  const last = vals[vals.length - 1];
  out += `<circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="1.8" fill="${stroke}"/></svg>`;
  return out;
}

function windowStart(feed, range) {
  const resets = feed.resets || [];
  if (range === "all" || !resets.length) return feed.firstTurn || 0;
  return resets[resets.length - 1];
}

const inRange = (pts, from) => (pts || []).filter((p) => p[0] >= from);

function seriesPts(s, field, from) {
  if (!s || !s.fields) return [];
  const i = s.fields.indexOf(field);
  if (i < 0) return [];
  return s.rows.filter((r) => r[0] >= from).map((r) => [r[0], r[i + 1]]);
}

function gateRows(gates, ctx) {
  let html = "", group = null;
  for (const g of gates) {
    if (ctx.grouped && g.group !== group) { group = g.group; html += `<tr class="grp"><td colspan="5">${esc(group)}</td></tr>`; }
    const status = g.openingInfo && g.status === "info" ? "info" : g.status;
    html += `<tr><td title="${esc(g.note)}"><span class="dot ${esc(status)}"></span>${esc(g.label)}</td>`
      + `<td>${esc(fmt(g.now, g.unit))}</td><td>${delta(g.now, g.prev12, g.unit, goodDirection(g))}</td>`
      + `<td class="muted">${esc(bandText(g))}</td>`
      + `<td class="sp">${spark(inRange(g.pts, ctx.from), { band: g.green && g.green[1] < 1e8 ? g.green : g.green ? [g.green[0], Infinity] : null, marks: ctx.marks, stroke: status === "red" ? "var(--red)" : status === "amber" ? "var(--amber)" : "var(--green)" })}</td></tr>`;
  }
  return html;
}

function gateTable(title, gates, ctx, note) {
  if (!gates.length) return "";
  return `<section class="eco-card"><h2>${esc(title)}</h2>${note ? `<p>${esc(note)}</p>` : ""}<table class="eco-t"><thead><tr><th>Measure</th><th>Now</th><th>12 turns</th><th>Healthy</th><th class="sp">Trend</th></tr></thead><tbody>${gateRows(gates, ctx)}</tbody></table></section>`;
}

function miniGrid(title, items, ctx, note) {
  const cells = items.map(([label, pts, unit, band]) => {
    const last = pts.filter((p) => isNum(p[1])).pop();
    return `<div class="eco-mini"><div class="top"><span>${esc(label)}</span><b>${esc(last ? fmt(last[1], unit) : "-")}</b></div>${spark(pts, { w: 240, h: 56, marks: ctx.marks, band })}</div>`;
  }).join("");
  return `<section class="eco-card"><h2>${esc(title)}</h2>${note ? `<p>${esc(note)}</p>` : ""}<div class="eco-multi">${cells}</div></section>`;
}

function scoreCell(label, pts, from, marks) {
  const r = inRange(pts, from);
  const now = r.length ? r[r.length - 1][1] : null;
  const prev = r.filter((p) => p[0] <= (r.length ? r[r.length - 1][0] - 12 : 0)).pop();
  const cls = !isNum(now) ? "" : now >= 75 ? "up" : now >= 50 ? "" : "down";
  return `<div class="eco-score"><span class="lbl">${esc(label)}</span><b class="${cls}">${isNum(now) ? now.toFixed(0) + "%" : "-"}</b><span class="d">${delta(now, prev && prev[1], "%", true)} over 12 turns</span>${spark(r, { w: 300, h: 34, band: [75, 100], marks })}</div>`;
}

function worldMacro(feed, ctx) {
  const m = feed.macro;
  return miniGrid("World macro", [
    ["Inflation", seriesPts(m, "infl", ctx.from), "%"],
    ["GDP growth", seriesPts(m, "growth", ctx.from), "%"],
    ["Unemployment", seriesPts(m, "unemp", ctx.from), "%"],
    ["Prime rate", seriesPts(m, "prime", ctx.from), "%"],
    ["Real rate", seriesPts(m, "realRate", ctx.from), "%"],
    ["Demand filled", seriesPts(m, "fill", ctx.from), "%", [85, 100]],
    ["Trade orders filled", seriesPts(m, "intent", ctx.from), "%", [80, 100]],
    ["Median real price vs base", seriesPts(m, "realMedian", ctx.from), "x", [0.8, 1.3]],
  ], ctx, "Population and GDP weighted world readings. Dashed lines mark economy resets.");
}

function overviewTab(feed, ctx) {
  const rank = { red: 0, amber: 1 };
  // A measure can count in two scores; list it once.
  const seen = new Set();
  const attention = feed.gates.filter((g) => g.status === "red" || g.status === "amber")
    .filter((g) => { const id = g.src && g.field ? g.src + ":" + g.field : g.key; if (seen.has(id)) return false; seen.add(id); return true; })
    .sort((a, b) => rank[a.status] - rank[b.status] || a.sub - b.sub);
  const macro = worldMacro(feed, ctx);
  const c = feed.corpSeries, w = feed.wealth;
  const activity = miniGrid("Activity and wealth", [
    ["Active companies", seriesPts(c, "nActive", ctx.from), ""],
    ["Founded per 12 turns", seriesPts(c, "foundedPer12", ctx.from), ""],
    ["Listed market cap", seriesPts(c, "mcap", ctx.from), ""],
    ["Corporate net income", seriesPts(c, "net", ctx.from), ""],
    ["Players with wealth", seriesPts(w, "n", ctx.from), ""],
    ["Median player wealth", seriesPts(w, "median", ctx.from), ""],
    ["Player wealth Gini", seriesPts(w, "gini", ctx.from), ""],
    ["Share trades per turn", seriesPts(feed.trades, "n", ctx.from), ""],
  ], ctx, "Money in anchor currency.");
  return `<div class="eco-cols">${gateTable(`Needs attention (${attention.length})`, attention, { ...ctx, grouped: false }, "Every red or amber measure across all three scores. Hover a measure for its definition.")}<div style="display:flex;flex-direction:column;gap:var(--s-4)">${macro}${activity}</div></div>`;
}

function marketsTab(feed, ctx) {
  const rows = [...(feed.commodities || [])].sort((a, b) => (a.sd ?? 9) - (b.sd ?? 9)).map((c) => {
    const sdCls = !isNum(c.sd) ? "" : c.sd < 0.7 ? "down" : c.sd > 1.5 ? "down" : c.sd >= 0.85 && c.sd <= 1.15 ? "up" : "";
    const pts = (arr) => arr.map((v, i) => [i, v]);
    return `<tr><td>${esc(titleCase(c.key))}</td><td class="${sdCls}">${esc(fmt(c.sd, "x"))}</td><td>${delta(c.sd, c.sd12, "x", null)}</td><td class="sp">${spark(pts(c.sdPts || []), { band: [0.85, 1.15] })}</td>`
      + `<td>${esc(fmt(c.real, "x"))}</td><td>${delta(c.real, c.real12, "x", null)}</td><td class="sp">${spark(pts(c.realPts || []), { band: [0.8, 1.3], stroke: "var(--blue)" })}</td>`
      + `<td>${esc(compact(c.price))}</td><td class="muted">${esc(compact(c.base))}</td></tr>`;
  }).join("");
  const table = `<section class="eco-card eco-wide"><h2>Commodities</h2><p>Supply over demand and real price (deflated by the global price index) over base. Trends cover the last 96 recorded turns. Sorted by tightest market first.</p><table class="eco-t"><thead><tr><th>Commodity</th><th>Supply / demand</th><th>12 turns</th><th class="sp">Trend</th><th>Real price</th><th>12 turns</th><th class="sp">Trend</th><th>Price</th><th>Base</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  const m = feed.macro;
  const balance = miniGrid("Market balance", [
    ["Demand filled", seriesPts(m, "fill", ctx.from), "%", [85, 100]],
    ["Trade orders filled", seriesPts(m, "intent", ctx.from), "%", [80, 100]],
    ["Median supply / demand", seriesPts(m, "sdMedian", ctx.from), "x", [0.85, 1.15]],
    ["Median real price vs base", seriesPts(m, "realMedian", ctx.from), "x", [0.8, 1.3]],
    ["Deep shortages (supply under 70%)", seriesPts(m, "deepShort", ctx.from), ""],
    ["Gluts (supply over 1.5x)", seriesPts(m, "glut", ctx.from), ""],
  ], ctx);
  return `<div class="eco-cols">${gateTable("Commodity health", feed.gates.filter((g) => g.sub === 3), { ...ctx, grouped: true })}${balance}${table}</div>`;
}

function breakdownTable(title, obj, sortKey = "mcap") {
  const rows = Object.entries(obj || {}).sort((a, b) => (b[1][sortKey] || 0) - (a[1][sortKey] || 0)).map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td>${esc(compact(v.n))}</td><td>${esc(compact(v.rev))}</td><td>${esc(compact(v.net))}</td><td>${esc(fmt(v.medMargin, "%"))}</td><td>${esc(fmt(v.lossShare, "%"))}</td><td>${esc(compact(v.mcap))}</td><td>${esc(compact(v.cash))}</td></tr>`).join("");
  return `<section class="eco-card"><h2>${esc(title)}</h2><table class="eco-t"><thead><tr><th></th><th>Firms</th><th>Revenue</th><th>Net</th><th>Median margin</th><th>Losing</th><th>Market cap</th><th>Cash</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function companiesTab(feed, ctx) {
  const health = gateTable("Corporate and market health", feed.gates.filter((g) => g.sub === 1 && g.group !== "Macro"), { ...ctx, grouped: true });
  const top = (feed.topCorps || []).slice(0, 20).map((c) =>
    `<tr><td>${esc(c.name)} <span class="muted">${esc(c.country)} · ${esc(c.family)}</span></td><td>${esc(c.owner)}</td><td>${esc(compact(c.mcap))}</td><td>${esc(compact(c.rev))}</td><td>${esc(compact(c.net))}</td><td>${esc(compact(c.cash))}</td><td>${esc(c.rating)}</td></tr>`).join("");
  const mv = (rows) => rows.map((r) => `<tr><td>${esc(r[0])} <span class="muted">${esc(r[3])}</span></td><td>${esc(r[4])}</td><td class="${r[5] >= 0 ? "up" : "down"}">${esc((r[5] >= 0 ? "+" : "") + r[5].toFixed(1) + "%")}</td><td>${esc(compact(r[6]))}</td></tr>`).join("");
  const movers = feed.movers ? `<section class="eco-card"><h2>12-turn share price movers</h2><table class="eco-t"><thead><tr><th>Company</th><th>Owner</th><th>Return</th><th>Market cap</th></tr></thead><tbody><tr class="grp"><td colspan="4">Best</td></tr>${mv(feed.movers.up || [])}<tr class="grp"><td colspan="4">Worst</td></tr>${mv(feed.movers.down || [])}</tbody></table></section>` : "";
  return `<div class="eco-cols">${health}<div style="display:flex;flex-direction:column;gap:var(--s-4)">${breakdownTable("By sector family", feed.breakdown.family)}${breakdownTable("By owner", feed.breakdown.owner)}</div>`
    + `<section class="eco-card"><h2>Largest companies</h2><table class="eco-t"><thead><tr><th>Company</th><th>Owner</th><th>Market cap</th><th>Revenue</th><th>Net</th><th>Cash</th><th>Rating</th></tr></thead><tbody>${top}</tbody></table></section>${movers}</div>`;
}

function playersTab(feed, ctx) {
  const w = feed.wealth, c = feed.corpSeries;
  const charts = miniGrid("Player wealth", [
    ["Players with wealth", seriesPts(w, "n", ctx.from), ""],
    ["Median wealth", seriesPts(w, "median", ctx.from), ""],
    ["Total player wealth", seriesPts(w, "total", ctx.from), ""],
    ["Wealth Gini", seriesPts(w, "gini", ctx.from), ""],
    ["Richest player share", seriesPts(w, "top1", ctx.from), "%"],
    ["Player share of market cap", seriesPts(c, "plMcapShare", ctx.from), "%"],
    ["Player share of revenue", seriesPts(c, "plRevShare", ctx.from), "%"],
    ["Share trades per turn", seriesPts(feed.trades, "n", ctx.from), ""],
  ], ctx, "Player-vs-player fairness matters here; players out-earning NPP companies is fine.");
  return `<div class="eco-cols">${gateTable("Gameplay health", feed.gates.filter((g) => g.sub === 2), { ...ctx, grouped: true })}${charts}</div>`;
}

function countriesTab(feed, ctx) {
  const rows = [...(feed.countries || [])].sort((a, b) => (b.gdpA || 0) - (a.gdpA || 0)).map((c) =>
    `<tr><td>${esc(c.id)}</td><td>${esc(compact(c.gdpA))}</td><td>${esc(fmt(c.growth, "%"))}</td><td>${delta(c.growth, c.growth12, "%", true)}</td><td>${esc(fmt(c.infl, "%"))}</td><td>${delta(c.infl, c.infl12, "%", false)}</td><td>${esc(fmt(c.unemp, "%"))}</td><td>${delta(c.unemp, c.unemp12, "%", false)}</td><td>${esc(fmt(c.prime, "%"))}</td><td>${esc(fmt(c.gap, ""))}</td><td>${esc(fmt(c.bal, "%"))}</td><td>${esc(c.rating || "-")}</td></tr>`).join("");
  const macroGates = gateTable("Macro health", feed.gates.filter((g) => g.group === "Macro"), { ...ctx, grouped: false });
  return `<div class="eco-cols">${macroGates}${worldMacro(feed, ctx)}<section class="eco-card eco-wide"><h2>Countries</h2><p>GDP in anchor currency. Changes are against 12 turns earlier.</p><table class="eco-t"><thead><tr><th>Country</th><th>GDP</th><th>Growth</th><th>12 turns</th><th>Inflation</th><th>12 turns</th><th>Unemployment</th><th>12 turns</th><th>Prime</th><th>Output gap</th><th>Budget balance</th><th>Rating</th></tr></thead><tbody>${rows}</tbody></table></section></div>`;
}

function fixesTab(feed) {
  const order = { open: 0, draft: 1, merged: 2, planned: 3, watch: 4, live: 5, closed: 6 };
  const rows = [...(feed.fixes || [])].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)).map((f) => {
    const prs = (f.prs || []).map((n) => `<a href="https://github.com/lakesidegamedev/AHDGame/pull/${encodeURIComponent(n)}">#${esc(n)}</a>`).join(" ");
    return `<tr><td title="${esc(f.success)}">${esc(f.title)}</td><td class="muted">${esc(f.area)}</td><td>${esc(f.priority)}</td><td class="st-${esc(f.status)}">${esc(f.status)}${f.liveTurn != null ? ` t${esc(f.liveTurn)}` : ""}</td><td>${prs}</td></tr>`;
  }).join("");
  return `<section class="eco-card"><h2>Tracked fixes (${(feed.fixes || []).length})</h2><p>Status resolves itself: merged once every PR merges, live at the first turn whose deployed commit contains them all.</p><table class="eco-t"><thead><tr><th>Fix</th><th>Area</th><th>Priority</th><th>Status</th><th>PRs</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function ago(d) {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 90) return "just now";
  if (s < 5400) return Math.round(s / 60) + " min ago";
  return Math.round(s / 3600) + " h ago";
}

function makeEconomyBody({ feed, error, mtime, tab = "overview", range = "reset" }) {
  if (!feed) return { extraCss: CSS, body: `<div class="eco"><div class="eco-head"><h1>Economy</h1></div><div class="eco-empty">${esc(error || "No data.")}</div></div>` };
  if (!TABS.some(([k]) => k === tab)) tab = "overview";
  if (range !== "all") range = "reset";
  const from = windowStart(feed, range);
  const ctx = { from, marks: (feed.resets || []).filter((t) => t > from) };
  const link = (t, r) => `/economy?tab=${t}${r === "all" ? "&range=all" : ""}`;
  const counts = {
    overview: feed.gates.filter((g) => g.status === "red").length,
    markets: feed.gates.filter((g) => g.sub === 3 && g.status === "red").length,
    companies: feed.gates.filter((g) => g.sub === 1 && g.group !== "Macro" && g.status === "red").length,
    players: feed.gates.filter((g) => g.sub === 2 && g.status === "red").length,
    countries: feed.gates.filter((g) => g.group === "Macro" && g.status === "red").length,
  };
  const tabs = TABS.map(([k, label]) => `<a class="${k === tab ? "on" : ""}" href="${link(k, range)}">${esc(label)}${counts[k] ? `<span class="n">${counts[k]}</span>` : ""}</a>`).join("");
  const resetTurn = (feed.resets || []).slice(-1)[0];
  const game = feed.game || {};
  const content = tab === "markets" ? marketsTab(feed, ctx) : tab === "companies" ? companiesTab(feed, ctx) : tab === "players" ? playersTab(feed, ctx)
    : tab === "countries" ? countriesTab(feed, ctx) : tab === "fixes" ? fixesTab(feed) : overviewTab(feed, ctx);
  const body = `<div class="eco">
  <div class="eco-head"><div><h1>Economy</h1><div class="eco-sub">Turn ${esc(feed.latest)}${game.year ? " · " + esc(game.year) : ""} · ${esc(String(feed.worldId || "").replace(":", " "))} · updated ${esc(ago(feed.generatedAt || mtime))}</div></div>
  <div class="eco-seg" aria-label="Time range">${resetTurn != null ? `<a class="${range === "reset" ? "on" : ""}" href="${link(tab, "reset")}">Since reset (t${esc(resetTurn)})</a>` : ""}<a class="${range === "all" ? "on" : ""}" href="${link(tab, "all")}">Whole world (t${esc(feed.firstTurn)})</a></div></div>
  <div class="eco-scores">${scoreCell("Economic health", feed.scores.health, from, ctx.marks)}${scoreCell("Gameplay", feed.scores.gameplay, from, ctx.marks)}${scoreCell("Commodities", feed.scores.commodities, from, ctx.marks)}</div>
  <nav class="eco-tabs">${tabs}</nav>
  ${content}
</div>`;
  return { extraCss: CSS, body };
}

module.exports = { makeEconomyBody, readFeed, FEED_FILE, fmt, bandText, spark };
