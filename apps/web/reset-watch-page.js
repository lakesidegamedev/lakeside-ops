// reset-watch-page.js: renders the Reset Watch snapshot (reset-watch.js) as one
// page. Server-rendered, no client data fetching. Returns { extraCss, body }.
//
// Layout rule: one verdict strip, then five sections that each answer one
// question in plain words, with the method tucked into a <details> so the page
// stays readable for someone who just wants to know whether the reset is OK.

"use strict";

const { lineChart, CHART_CSS, CHART_JS } = require("./reset-watch-charts");
const rwModel = require("./reset-watch");
const { EXPLOIT_THRESHOLDS } = require("./reset-watch-exploits");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const pct = (v, d = 0) => (v == null ? "-" : `${(v * 100).toFixed(d)}%`);
const fixed = (v, d = 1) => (v == null || !Number.isFinite(v) ? "-" : Number(v).toFixed(d));
const signed = (v, d = 1) => (v == null || !Number.isFinite(v) ? "-" : `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(d)}`);
const secs = (ms) => (ms == null ? "-" : ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${Math.round(ms / 1000)}s`);
const mins = (s) => (s == null ? "-" : s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);
function money(v) {
  if (v == null || !Number.isFinite(v)) return "-";
  const a = Math.abs(v);
  if (a >= 1e9) return `₳${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `₳${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `₳${Math.round(v / 1e3)}k`;
  return `₳${Math.round(v)}`;
}
function ago(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
}
function years(turns, perYear) {
  if (turns == null) return "-";
  if (!Number.isFinite(turns)) return "never";
  const y = turns / perYear;
  return y >= 10 ? `${Math.round(y)} yrs` : `${y.toFixed(1)} yrs`;
}

const LEVEL_WORD = { ok: "Healthy", warn: "Watch", bad: "Act", none: "Waiting" };
const dot = (lvl, title) => `<span class="rw-dot ${esc(lvl || "none")}"${title ? ` title="${esc(title)}"` : ""}></span>`;

// Return bar: the plant's yearly return with the local prime rate as a tick.
function returnBar(ret, prime, scaleMax) {
  if (ret == null) return "-";
  const sx = (v) => Math.max(0, Math.min(100, (v / scaleMax) * 100));
  const lvl = prime == null ? "none" : ret - prime >= 2 ? "ok" : ret - prime >= 0 ? "warn" : "bad";
  const tick = prime != null ? `<span class="rw-tick" style="left:${sx(prime).toFixed(1)}%" title="Prime rate ${prime}%"></span>` : "";
  return `<span class="rw-rbar"><span class="rw-rfill ${lvl}" style="width:${sx(ret).toFixed(1)}%"></span>${tick}</span><span class="rw-num">${fixed(ret)}%</span>`;
}

// Diverging bar around zero for "edge" readings.
function edgeBar(v, maxAbs) {
  if (v == null) return "-";
  const w = Math.min(50, (Math.abs(v) / maxAbs) * 50);
  const side = v >= 0 ? `left:50%;width:${w.toFixed(1)}%` : `left:${(50 - w).toFixed(1)}%;width:${w.toFixed(1)}%`;
  const lvl = Math.abs(v) >= 3 ? "bad" : Math.abs(v) >= 1.5 ? "warn" : "ok";
  return `<span class="rw-ebar"><span class="rw-emid"></span><span class="rw-efill ${lvl}" style="${side}"></span></span><span class="rw-num">${signed(v)}</span>`;
}

function stack(parts) {
  const total = parts.reduce((a, p) => a + p.n, 0) || 1;
  return `<span class="rw-stack">${parts.filter((p) => p.n > 0).map((p) => `<span class="${p.cls}" style="width:${((100 * p.n) / total).toFixed(2)}%" title="${esc(p.label)}: ${p.n}"></span>`).join("")}</span>`;
}

function partyChip(p) {
  if (!p) return '<span class="rw-muted">-</span>';
  const color = p.color && /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : "#7b8494";
  return `<span class="rw-party"><span class="rw-swatch" style="background:${color}"></span>${esc(p.abbr || p.name)}</span>`;
}

const CSS = `
.rw{max-width:1180px;margin:0 auto;padding:22px 18px 72px;display:flex;flex-direction:column;gap:30px}
.rw a{color:var(--accent)}
.rw-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
.rw-head h1{margin:0;font-size:1.55rem;font-weight:700;letter-spacing:-.02em}
.rw-sub{color:var(--text-2);font-size:.88rem;margin-top:4px}
.rw-muted{color:var(--text-3)}
.rw-small{font-size:.78rem}
.rw-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
@media(max-width:900px){.rw-strip{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:520px){.rw-strip{grid-template-columns:1fr}}
.rw-tile{display:block;text-decoration:none;color:inherit;padding:14px 16px;border-radius:12px;border:1px solid var(--border);background:var(--surface)}
.rw-tile:hover{border-color:var(--border-2,var(--border))}
.rw-tile .k{display:flex;align-items:center;gap:8px;font-size:.74rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3)}
.rw-tile .k .w{margin-left:auto;letter-spacing:.02em;text-transform:none;font-weight:600}
.rw-tile .h{font-size:1.15rem;font-weight:700;margin:8px 0 3px;color:var(--text)}
.rw-tile .d{font-size:.84rem;color:var(--text-2)}
.rw-tile.ok{background:color-mix(in srgb,var(--green,#34d399) 7%,var(--surface))}
.rw-tile.warn{background:color-mix(in srgb,var(--amber,#f5a623) 8%,var(--surface))}
.rw-tile.bad{background:color-mix(in srgb,var(--red,#e5484d) 9%,var(--surface))}
.rw-tile.ok .w{color:var(--green,#34d399)}.rw-tile.warn .w{color:var(--amber,#f5a623)}.rw-tile.bad .w{color:var(--red,#e5484d)}
.rw-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--text-3);flex:none}
.rw-dot.ok{background:var(--green,#34d399)}.rw-dot.warn{background:var(--amber,#f5a623)}.rw-dot.bad{background:var(--red,#e5484d)}
.rw-sec h2{margin:0;font-size:1.2rem;font-weight:700;letter-spacing:-.01em}
.rw-sec .q{color:var(--text-2);font-size:.9rem;margin:4px 0 12px;max-width:85ch}
.rw-sec h3{margin:20px 0 8px;font-size:.95rem;font-weight:700}
.rw-key{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 10px;font-size:.84rem;color:var(--text-2)}
.rw-key b{color:var(--text);font-weight:700}
.rw-tw{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--surface)}
table.rw-t{width:100%;border-collapse:collapse;font-size:.84rem}
.rw-t th{text-align:left;font-weight:600;color:var(--text-3);font-size:.74rem;padding:9px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
.rw-t td{padding:8px 10px;border-bottom:1px solid color-mix(in srgb,var(--border) 60%,transparent);vertical-align:middle;white-space:nowrap}
.rw-t tr:last-child td{border-bottom:0}
.rw-t td.n,.rw-t th.n{text-align:right;font-variant-numeric:tabular-nums}
.rw-t td.why{white-space:normal;color:var(--text-2);font-size:.8rem;min-width:220px}
.rw-t .nm{font-weight:600;color:var(--text)}
.rw-why{white-space:normal;color:var(--text-2);font-size:.76rem;margin:2px 0 0 15px;max-width:34ch;line-height:1.35}
.rw-num{display:inline-block;min-width:44px;text-align:right;font-variant-numeric:tabular-nums;margin-left:6px}
.rw-rbar{display:inline-block;position:relative;width:110px;height:8px;border-radius:4px;background:var(--surface-2,#1a1c22);vertical-align:middle}
.rw-rfill{position:absolute;left:0;top:0;bottom:0;border-radius:4px}
.rw-rfill.ok,.rw-efill.ok{background:var(--green,#34d399)}.rw-rfill.warn,.rw-efill.warn{background:var(--amber,#f5a623)}.rw-rfill.bad,.rw-efill.bad{background:var(--red,#e5484d)}.rw-rfill.none{background:var(--text-3)}
.rw-tick{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--text);opacity:.85}
.rw-ebar{display:inline-block;position:relative;width:110px;height:8px;border-radius:4px;background:var(--surface-2,#1a1c22);vertical-align:middle}
.rw-emid{position:absolute;left:50%;top:-3px;bottom:-3px;width:1px;background:var(--text-3)}
.rw-efill{position:absolute;top:0;bottom:0;border-radius:3px}
.rw-stack{display:inline-flex;width:130px;height:8px;border-radius:4px;overflow:hidden;background:var(--surface-2,#1a1c22);vertical-align:middle}
.rw-stack .c{background:var(--green,#34d399)}.rw-stack .u{background:var(--amber,#f5a623)}.rw-stack .e{background:var(--red,#e5484d)}
.rw-spark{vertical-align:middle}.rw-zero{stroke:var(--text-3);stroke-dasharray:2 2;stroke-width:1}
.rw-party{display:inline-flex;align-items:center;gap:6px}
.rw-swatch{width:10px;height:10px;border-radius:2px;display:inline-block}
.rw-empty{padding:14px 16px;border:1px dashed var(--border);border-radius:12px;color:var(--text-2);font-size:.88rem}
.rw-cols{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:18px}
@media(max-width:900px){.rw-cols{grid-template-columns:1fr}}
.rw-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px}
.rw-stat{padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface)}
.rw-stat .l{font-size:.72rem;color:var(--text-3);font-weight:600}
.rw-stat .v{font-size:1.15rem;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums}
.rw-stat .v.bad{color:var(--red,#e5484d)}.rw-stat .v.warn{color:var(--amber,#f5a623)}
.rw-list{list-style:none;margin:0;padding:0;font-size:.84rem}
.rw-list li{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid color-mix(in srgb,var(--border) 60%,transparent)}
.rw-list li:last-child{border-bottom:0}
details.rw-how{font-size:.84rem;color:var(--text-2);margin-top:10px}
details.rw-how summary{cursor:pointer;color:var(--text-3);font-weight:600}
details.rw-how ul{margin:8px 0 0 18px;padding:0;line-height:1.55}
`;

function verdictStrip(v) {
  const tiles = [
    ["sectors", "Sectors", "#sectors"],
    ["balance", "Balance", "#balance"],
    ["politics", "Politics", "#politics"],
    ["infra", "Infra", "#infra"],
    ["exploits", "Exploits", "#exploits"],
  ];
  return `<div class="rw-strip">${tiles.map(([k, label, href]) => {
    const t = v[k] || { level: "none" };
    return `<a class="rw-tile ${esc(t.level)}" href="${href}"><div class="k">${dot(t.level)}${label}<span class="w">${LEVEL_WORD[t.level] || ""}</span></div><div class="h">${esc(t.headline || "-")}</div><div class="d">${esc(t.detail || "")}</div></a>`;
  }).join("")}</div>`;
}

function sectorsSection(s, history) {
  const sec = s.sectors;
  const th = { ...rwModel.THRESHOLDS, ...s.thresholds };
  const firstRevised = history.find((h) => h.siteMetricsVersion === sec.siteMetricsVersion);
  const methodNote = firstRevised && history.some((h) => h.turn < firstRevised.turn)
    ? `<p class="rw-muted">Site returns and profitability use the revised calculation from turn ${esc(firstRevised.turn)}.</p>` : "";
  const maxRet = Math.max(4, ...sec.lanes.map((l) => l.returnPct || 0), ...sec.lanes.map((l) => l.primePct || 0)) * 1.1;
  const rows = sec.lanes.map((l) => {
    const playerCell = l.playerCorps ? `${l.playerCorps}${l.playerProfitableShare != null ? ` <span class="rw-muted">(${pct(l.playerProfitableShare)} profitable)</span>` : ""}` : '<span class="rw-muted">0</span>';
    const payback = l.paybackVerdict ?? rwModel.paybackVerdict(l.paybackTurns);
    const paybackLabel = l.paybackTurns == null ? payback.label : `${l.paybackTurns} turns · ${payback.label}`;
    return `<tr>
      <td>${dot(l.verdict.level, l.verdict.why)} <span class="nm">${esc(l.label)}</span>${l.verdict.level === "ok" ? "" : `<div class="rw-why">${esc(l.verdict.why)}</div>`}</td>
      <td>${returnBar(l.returnPct, l.primePct, maxRet)}</td>
      <td class="n">${l.committedReturnPct == null ? "-" : `${fixed(l.committedReturnPct)}%`}</td>
      <td class="n">${signed(l.excessPp)}</td>
      <td class="n">${pct(l.profitableShare)}</td>
      <td class="n">${fixed(l.marginMedian)}%</td>
      <td class="n">${dot(payback.level)} ${esc(paybackLabel)}</td>
      <td class="n">${money(l.plantCostAnchor)}</td>
      <td class="n">${pct(l.sellThrough)}</td>
      <td class="n">${l.sites}${l.idle ? ` <span style="color:var(--amber,#f5a623)" title="Built but sold nothing this turn">(${l.idle} idle)</span>` : ""}${l.mothballed ? ` <span class="rw-muted">+${l.mothballed} mothballed</span>` : ""}${l.building ? ` <span class="rw-muted" title="Under construction">+${l.building}</span>` : ""}</td>
      <td class="n">${playerCell}</td>
    </tr>`;
  }).join("");
  return `<section class="rw-sec" id="sectors">
  <h2>Sector returns and payback</h2>
  <p class="q">Target payback is ${th.paybackTargetMinTurns} to ${th.paybackTargetMaxTurns} turns. Under ${th.paybackTooFastTurns} is too fast, and over ${th.paybackTargetMaxTurns} is slow.</p>
  <div class="rw-key"><span><b>${sec.viable}</b> viable</span><span><b>${sec.weak}</b> to watch</span><span><b>${sec.failing}</b> need action</span><span>Highest return <b>${esc(sec.bestLane || "-")}</b>, lowest <b>${esc(sec.worstLane || "-")}</b>, ${fixed(sec.returnSpreadPp)} points apart</span><span>World median <b>${fixed(sec.worldReturnPct)}%</b> a year</span></div>
  ${methodNote}
  ${sectorCharts(s, history)}
  <h3>Now</h3>
  <div class="rw-tw"><table class="rw-t">
    <thead><tr><th>Sector</th><th>Site return / yr <span class="rw-muted">(tick = prime)</span></th><th class="n">Committed capital return / yr</th><th class="n">vs prime</th><th class="n">Sites in profit</th><th class="n">Margin</th><th class="n">Pays back</th><th class="n">Plant cost</th><th class="n">Sell-through</th><th class="n">Sites</th><th class="n">Player cos.</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
  <details class="rw-how"><summary>How this is measured</summary><ul>
    <li>Site return is the median annualized profit divided by paid operating capacity cost. Committed capital return divides total annualized profit of those sites by their total paid operating capacity and construction in progress.</li>
    <li>Sector profit is stored per real day (24 turns). The tracker uses the rate for the currency in which the profit was recorded.</li>
    <li>Payback uses paid operating capacity and settled profit per turn. Payback from ${th.paybackTooFastTurns} to under ${th.paybackTargetMinTurns} turns is fast. Fast and slow paybacks both merit a watch.</li>
    <li>Viability requires at least ${pct(th.viableProfitableShare)} of sites in profit and a median return at least ${th.viableExcessPp} points above the host prime rate. A return below prime or fewer than ${pct(th.weakProfitableShare)} of sites in profit needs action.</li>
    <li>Operating sites include idle sites. Mothballed sites and sites entirely under construction are counted separately. Sell-through uses units sold divided by units offered on settled turns.</li>
  </ul></details>
</section>`;
}

function balanceSection(s, history) {
  const b = s.balance;
  const th = s.thresholds;
  const maxAbs = Math.max(4, ...b.countries.map((c) => Math.abs(c.edgePp || 0)));
  const crows = b.countries.map((c) => `<tr>
      <td>${dot(c.level, c.why)} <span class="nm">${esc(c.country)}</span></td>
      <td>${edgeBar(c.edgePp, maxAbs)}</td>
      <td class="n">${fixed(c.returnPct)}%</td>
      <td class="n">${fixed(c.primePct, 2)}%</td>
      <td class="n">${pct(c.profitableShare)}</td>
      <td class="n">${c.sites}</td>
      <td class="n">${c.playerSites}</td>
    </tr>`).join("");
  const forms = b.forms;
  const formsHtml = forms.playerCorps === 0
    ? `<div class="rw-empty">No player companies yet. As players found companies this compares each legal form's after-tax margin with the same sector, and how often players pick each form. A form nearly everyone picks, or nobody picks, is the signal.</div>`
    : `<div class="rw-tw"><table class="rw-t"><thead><tr><th>Legal form</th><th class="n">Companies</th><th class="n">Picked since reset</th><th>After-tax margin vs same sector</th></tr></thead><tbody>${forms.forms.map((f) => `<tr>
        <td>${dot(f.level)} <span class="nm">${esc(f.label)}</span></td>
        <td class="n">${f.corps}</td>
        <td class="n">${f.foundedSinceReset} <span class="rw-muted">(${pct(f.choiceShare)})</span></td>
        <td>${edgeBar(f.edgePp, Math.max(th.formEdgeBadPp, ...forms.forms.map((x) => Math.abs(x.edgePp || 0))))}</td>
      </tr>`).join("")}</tbody></table></div>`;
  return `<section class="rw-sec" id="balance">
  <h2>Balance: is any country or company type overpowered?</h2>
  <p class="q">Each site is compared with the same sector in other countries, so a country is not "strong" just because it hosts high-margin sectors. The bar is how many points a year a new plant there earns above or below the same sector elsewhere.</p>
  <div class="rw-cols">
    <div><h3>Host countries</h3>${countryChart(s, history)}<div class="rw-tw" style="margin-top:10px"><table class="rw-t"><thead><tr><th>Country</th><th>Edge vs same sector elsewhere</th><th class="n">Return</th><th class="n">Prime</th><th class="n">In profit</th><th class="n">Sites</th><th class="n">Player sites</th></tr></thead><tbody>${crows || '<tr><td colspan="7" class="rw-muted">No operating sites</td></tr>'}</tbody></table></div></div>
    <div><h3>Company legal forms</h3>${formsChart(s, history)}${formsHtml}</div>
  </div>
  <details class="rw-how"><summary>How this is measured</summary><ul>
    <li>Country edge: median over its sites of (site return minus the world median return of that sector). Watch at ±${th.edgeWarnPp} points, act at ±${th.edgeBadPp}.</li>
    <li>Legal forms exist only on player-founded companies. Edge uses after-tax margin (net income before dividends over revenue) against player companies in the same sector; watch at ±${th.formEdgeWarnPp} points, act at ±${th.formEdgeBadPp}. Choice share counts companies founded since tracking began; watch above ${pct(th.choiceWarnShare)} once ${th.minCorpsForChoice} companies exist.</li>
  </ul></details>
</section>`;
}

function politicsSection(s, history) {
  const p = s.politics;
  const th = s.thresholds;
  const turn = s.world.turn;
  const frows = p.fields.map((r) => `<tr>
      <td>${dot(r.level, r.why)} <span class="nm">${esc(r.country)}</span>${r.level === "ok" ? "" : `<div class="rw-why">${esc(r.why)}</div>`}</td>
      <td>${stack([{ n: r.contested, cls: "c", label: "Contested" }, { n: r.uncontested, cls: "u", label: "One side only" }, { n: r.empty, cls: "e", label: "No candidate" }])}</td>
      <td class="n">${r.races}</td>
      <td class="n">${r.contested}</td>
      <td class="n">${r.uncontested}</td>
      <td class="n">${r.empty}</td>
      <td class="n">${r.parties}${r.partiesWithoutNpps ? ` <span class="rw-muted">(${r.partiesWithoutNpps} with no NPPs)</span>` : ""}</td>
      <td class="n">${r.nppsFree} <span class="rw-muted">of ${r.npps}</span></td>
      <td class="n">${r.turnsToDeadline == null ? "-" : `${r.turnsToDeadline} turns`}</td>
    </tr>`).join("");
  const resultsTurn = p.fields.map((r) => r.resultsTurn).filter((v) => v != null).sort((a, b) => a - b)[0];
  const waitNote = resultsTurn != null ? `First results at turn ${resultsTurn}${turn != null ? ` (${resultsTurn - turn} turns away)` : ""}.` : "";
  const crows = p.competitiveness.map((c) => `<tr>
      <td>${dot(c.level)} <span class="nm">${esc(c.country)}</span></td>
      <td class="n">${c.races} <span class="rw-muted">(${c.decided} decided)</span></td>
      <td class="n">${fixed(c.marginMedianPp)} pts</td>
      <td class="n">${pct(c.closeShare)}</td>
      <td class="n">${pct(c.landslideShare)}</td>
    </tr>`).join("");
  const compHtml = crows
    ? `<div class="rw-tw"><table class="rw-t"><thead><tr><th>Country</th><th class="n">Races with votes</th><th class="n">Median winning margin</th><th class="n">Close (&lt;${th.closeMarginPp} pts)</th><th class="n">Landslides (${th.landslideMarginPp}+)</th></tr></thead><tbody>${crows}</tbody></table></div>`
    : `<div class="rw-empty">No votes counted yet. ${esc(waitNote)}</div>`;
  const seated = p.dominance.some((d) => d.seated > 0 || d.executive);
  const drows = p.dominance.map((d) => {
    return `<tr>
      <td>${dot(d.level, d.why)} <span class="nm">${esc(d.country)}</span></td>
      <td>${d.seats.length ? d.seats.map((x) => `${partyChip(x)} <span class="rw-muted">${x.seats}</span>`).join(" &nbsp;") : '<span class="rw-muted">nobody seated</span>'}</td>
      <td class="n">${d.largest ? pct(d.largest.share) : "-"}</td>
      <td class="n">${fixed(d.enp, 2)}</td>
      <td>${partyChip(d.executive)}</td>
      <td class="n">${d.tenureTurns == null ? "-" : years(d.tenureTurns, th.turnsPerYear)}</td>
      <td class="n">${d.handovers}</td>
      <td class="why">${d.level === "ok" || d.level === "none" ? (d.byDesign ? "One-party state by constitution" : "") : esc(d.why)}</td>
    </tr>`;
  }).join("");
  return `<section class="rw-sec" id="politics">
  <h2>Politics: enough candidates, close races, nobody rules forever?</h2>
  <p class="q">Three checks. Every race needs at least two sides before the primary deadline, which is where NPP supply shows. Races should be close, not landslides. And no party should hold a supermajority or stay in power for years unchallenged.</p>
  ${politicsCharts(s, history)}
  <h3>Candidate fields now (NPP supply)</h3>
  <div class="rw-tw"><table class="rw-t"><thead><tr><th>Country</th><th>Contested / one side / empty</th><th class="n">Races</th><th class="n">Contested</th><th class="n">One side</th><th class="n">Empty</th><th class="n">Parties</th><th class="n">NPPs not running</th><th class="n">Primary deadline</th></tr></thead><tbody>${frows}</tbody></table></div>
  <div class="rw-cols" style="margin-top:6px">
    <div><h3>Who holds power</h3>${seated
      ? `<div class="rw-tw"><table class="rw-t"><thead><tr><th>Country</th><th>Main chamber</th><th class="n">Largest</th><th class="n">Eff. parties</th><th>Governs</th><th class="n">For</th><th class="n">Handovers</th><th></th></tr></thead><tbody>${drows}</tbody></table></div>`
      : `<div class="rw-empty">Nobody is seated yet: the reset starts with every office empty and a founding election. ${esc(waitNote)}</div>`}</div>
    <div><h3>How close are races</h3>${compHtml}</div>
  </div>
  <details class="rw-how"><summary>How this is measured</summary><ul>
    <li>A side is a party, or a single independent candidate. Contested = two or more sides. Red when races are still empty ${th.emptyRaceAlarmTurns} turns or less before the primary deadline.</li>
    <li>Winning margin = top side's vote share minus the runner-up's, from the latest count. Watch when under 30% of races are close, act under 15%.</li>
    <li>Effective parties (Laakso-Taagepera) from main-chamber seats; 2 means two even parties, near 1 means one party dominates. Act when one party holds ${pct(th.supermajorityShare)} of seats; watch when the same party governs ${years(th.longHoldTurns, th.turnsPerYear)} or holds the presidency and both US chambers. China is one-party by constitution and is not flagged for it.</li>
  </ul></details>
</section>`;
}

function infraSection(s) {
  const t = s.infra.turns;
  const b = s.infra.builds;
  const stat = (l, v, cls = "") => `<div class="rw-stat"><div class="l">${l}</div><div class="v ${cls}">${v}</div></div>`;
  const phases = (s.infra.slowPhases || []).map((p) => `<li><span>${esc(p.phase)}</span><span class="rw-muted">${secs(p.ms)}</span></li>`).join("");
  const rel = b.releases.map((r) => `<tr>
      <td>${dot(r.ok ? "ok" : "bad")} ${esc(r.kind)}</td>
      <td><code>${esc(r.sha)}</code></td>
      <td>${r.finishedAt ? esc(ago(r.finishedAt)) : "-"}</td>
      <td class="n">${mins(r.buildS)}</td>
      <td class="n">${mins(r.shipS)}</td>
      <td class="n">${mins(r.swapS)}</td>
      <td class="n">${mins(r.totalS)}</td>
      <td class="n">${mins(r.leadS)}</td>
      <td class="n">${r.retries ? `<span style="color:var(--amber,#f5a623)">${r.retries}</span>` : "0"}</td>
    </tr>`).join("");
  return `<section class="rw-sec" id="infra">
  <h2>Infra: are turns and releases fast and clean?</h2>
  <p class="q">Turn time against the turn cadence (a turn that eats half its hour leaves no room for growth), failures, memory, and how long a merged change takes to reach players.</p>
  <div class="rw-cols">
    <div>
      <h3>Turns <span class="rw-muted rw-small">last ${t.count}</span></h3>
      <div class="rw-stats">
        ${stat("Last turn", secs(t.last && t.last.ms))}
        ${stat("Median", secs(t.p50Ms))}
        ${stat("p95", secs(t.p95Ms), t.p95Share >= s.thresholds.turnP95BadShare ? "bad" : t.p95Share >= s.thresholds.turnP95WarnShare ? "warn" : "")}
        ${stat("Share of cadence", t.p95Share == null ? "-" : pct(t.p95Share), "")}
        ${stat("Failed", t.failures, t.failures ? "bad" : "")}
        ${stat("Late starts", t.late, t.late ? "warn" : "")}
        ${stat("Peak memory", t.peakRssMb ? `${(t.peakRssMb / 1024).toFixed(1)} GB` : "-")}
      </div>
      ${turnChart(s)}
    </div>
    <div>
      <h3>Slowest phases, last turn</h3>
      <ul class="rw-list">${phases || '<li class="rw-muted">No phase timings</li>'}</ul>
      <p class="rw-muted rw-small">Phases run in parallel groups, so these overlap and do not add up to the turn.</p>
    </div>
  </div>
  <h3>Releases <span class="rw-muted rw-small">last ${b.count}</span></h3>
  <div class="rw-stats">
    ${stat("Image build", mins(b.buildMedianS))}
    ${stat("Ship", mins(b.shipMedianS))}
    ${stat("Deploy total", mins(b.totalMedianS))}
    ${stat("Commit to live", b.commitToLiveMedianMin == null ? "-" : `${b.commitToLiveMedianMin} min`, b.commitToLiveMedianMin > s.thresholds.releaseLeadWarnMin ? "warn" : "")}
    ${stat("Dev merge to live", b.devToLiveMedianMin == null ? "-" : `${b.devToLiveMedianMin} min`)}
    ${stat("Failed", b.failed, b.failed ? "bad" : "")}
    ${stat("Needed retries", b.retried, b.retried ? "warn" : "")}
  </div>
  ${releaseChart(s)}
  <div class="rw-tw" style="margin-top:10px"><table class="rw-t"><thead><tr><th>Service</th><th>Commit</th><th>Finished</th><th class="n">Build</th><th class="n">Ship</th><th class="n">Swap</th><th class="n">Total</th><th class="n">Commit to live</th><th class="n">Retries</th></tr></thead><tbody>${rel || '<tr><td colspan="9" class="rw-muted">No releases recorded</td></tr>'}</tbody></table></div>
  <details class="rw-how"><summary>How this is measured</summary><ul>
    <li>Turn times come from the engine's turn logs, which expire after a day; the tracker keeps its own copy per turn so the whole reset stays visible.</li>
    <li>Watch when p95 turn time passes ${pct(s.thresholds.turnP95WarnShare)} of the cadence, act at ${pct(s.thresholds.turnP95BadShare)} or on any failed turn.</li>
    <li>Releases group the deploy loop's retries into one release per service and commit. Build is the worker image build; web reuses that image. Commit to live runs from the main merge to the service serving it.</li>
  </ul></details>
</section>`;
}

const SIGNAL_WORD = {
  device_fingerprint_exact: "same device", device_fingerprint_fuzzy: "similar device", ip_exact_nonCF: "same home IP",
  coordinated_login_timing: "log in together", email_pattern_family: "related emails", referral_link: "referral chain",
  shared_fingerprint: "same device", ip_sharing: "same IP", shared_tracking_cookie: "same browser",
  login_time_cluster: "log in together", login_ip_scatter: "many IPs", coordinated_login_pattern: "log in together",
  coordinated_party_funding: "fund the same party", time_velocity: "too many too fast", cash_mismatch: "cash mismatch",
};
const word = (t) => SIGNAL_WORD[t] || String(t || "").replace(/_/g, " ");

function exploitsSection(s, history) {
  const e = s.exploits;
  if (!e) {
    return `<section class="rw-sec" id="exploits"><h2>Exploits: is anyone cheating or breaking the economy?</h2><div class="rw-empty">The exploit read failed on the last snapshot. Other sections are unaffected.</div></section>`;
  }
  const stat = (l, v, cls = "") => `<div class="rw-stat"><div class="l">${l}</div><div class="v ${cls}">${v}</div></div>`;
  const th = EXPLOIT_THRESHOLDS;
  const rings = e.rings.top.map((r) => `<tr>
      <td>${dot(r.playing && r.confidence >= th.ringConfident ? "warn" : "none")} ${r.members.map((m) => (m ? esc(m) : '<span class="rw-muted">no character</span>')).join(" + ")}</td>
      <td class="n">${pct(r.confidence)}</td>
      <td class="why">${esc(r.signals.map(word).join(", "))}</td>
    </tr>`).join("");
  const flags = e.flags.top.map((f) => `<tr>
      <td>${dot(f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : "none")} <span class="nm">${esc(f.name)}</span>${f.country ? ` <span class="rw-muted">${esc(f.country)}</span>` : ""}</td>
      <td>${esc(f.severity)}</td>
      <td class="why">${esc(f.types.map(word).join(", "))}</td>
    </tr>`).join("");
  const jumps = e.wealth.rows.map((j) => `<tr>
      <td>${dot(j.flagged ? "warn" : "none")} <span class="nm">${esc(j.name)}</span></td>
      <td class="n">${money(j.before)}</td><td class="n">${money(j.after)}</td>
      <td class="n">+${money(j.gain)}</td><td class="n">${j.ratio == null ? "-" : `${j.ratio}x`}</td>
    </tr>`).join("");
  const moneyRows = e.money.top.map((m) => `<li><span>${esc(m.subject)} <span class="rw-muted">${esc(m.kind)} · ${esc(m.types.map(word).join(", "))}</span></span><span class="rw-muted">${m.count} moves · ${money(m.anchor)}</span></li>`).join("");
  const led = e.ledger;
  const ledLvl = led.status === "red" ? "bad" : led.status === "amber" ? "warn" : "";
  return `<section class="rw-sec" id="exploits">
  <h2>Exploits: is anyone cheating or breaking the economy?</h2>
  <p class="q">What the game's own detectors flagged in this world: likely alt-account rings, unreviewed abuse flags, suspicious money moves, players whose cash jumped far beyond everyone else, whether the money ledger still balances, and accounts hammering the API. Flags are leads for staff review, not proof.</p>
  <div class="rw-stats">
    ${stat("Likely alt rings", e.rings.confident, e.rings.confident ? "warn" : "")}
    ${stat("Open abuse flags", e.flags.total, e.flags.high ? "warn" : "")}
    ${stat("High severity", e.flags.high, e.flags.high ? "warn" : "")}
    ${stat("Flagged money moves", e.money.flagged, e.money.flagged ? "warn" : "")}
    ${stat("Wealth jumps", e.wealth.flagged, e.wealth.flagged ? "warn" : "")}
    ${stat("Ledger", esc(led.status), ledLvl)}
    ${stat("API floods, 2 h", e.flood.recentActors, e.flood.recentActors ? "bad" : "")}
  </div>
  ${exploitChart(history)}
  <div class="rw-cols" style="margin-top:14px">
    <div>
      <h3>Likely alt rings <span class="rw-muted rw-small">${e.rings.open} open${e.rings.waiting ? `, ${e.rings.waiting} not playing this world yet` : ""}, scored ${esc(ago(e.rings.scoringAt))}${e.rings.scoringOn ? "" : " · scoring is off or dry-run"}</span></h3>
      <div class="rw-tw"><table class="rw-t"><thead><tr><th>Accounts (current character)</th><th class="n">Confidence</th><th>Why</th></tr></thead><tbody>${rings || '<tr><td colspan="3" class="rw-muted">No open rings</td></tr>'}</tbody></table></div>
      <h3>Open abuse flags, this world</h3>
      <div class="rw-tw"><table class="rw-t"><thead><tr><th>Character</th><th>Severity</th><th>Flags</th></tr></thead><tbody>${flags || '<tr><td colspan="3" class="rw-muted">No open flags</td></tr>'}</tbody></table></div>
    </div>
    <div>
      <h3>Biggest wealth gains${e.wealth.compared != null ? ` <span class="rw-muted rw-small">since turn ${esc(e.wealth.compared)}</span>` : ""}</h3>
      <div class="rw-tw"><table class="rw-t"><thead><tr><th>Character</th><th class="n">Before</th><th class="n">Now</th><th class="n">Gain</th><th class="n">x</th></tr></thead><tbody>${jumps || `<tr><td colspan="5" class="rw-muted">${e.wealth.compared == null ? "Needs one more turn to compare" : "Nobody gained"}</td></tr>`}</tbody></table></div>
      <h3>Flagged money moves, by account</h3>
      <ul class="rw-list">${moneyRows || '<li class="rw-muted">None</li>'}</ul>
      <h3>Ledger and API</h3>
      <ul class="rw-list">
        <li><span>Ledger check, turn ${esc(led.turn ?? "-")}</span><span class="rw-muted">${led.unbalanced} unbalanced · ${led.divergent} divergent · ${led.entries.toLocaleString("en-US")} entries</span></li>
        <li><span>API abuse scans this world</span><span class="rw-muted">${e.flood.scans} scans · ${e.flood.worldActors} accounts flagged · last ${esc(ago(e.flood.lastScanAt))}</span></li>
        <li><span>Audit anomalies</span><span class="rw-muted">${e.anomalies.count ? esc(e.anomalies.types.map(word).join(", ")) : "none"}</span></li>
      </ul>
    </div>
  </div>
  <details class="rw-how"><summary>How this is measured</summary><ul>
    <li>Alt rings come from the alt-scoring engine (device, IP, login timing, referrals). Shown when open and re-scored in the last ${th.ringFreshHours} h; "likely" means ${pct(th.ringConfident)} confidence or more with at least two of its accounts playing this world. Rings are account-level, so they carry over a reset; a ring with no character yet has not played this world.</li>
    <li>Abuse flags are the game's suspicious-character list, unreviewed and updated since this world began. Dismissing a flag in admin removes it here.</li>
    <li>Flagged money moves are player, player-company and party money moves the transaction log marked suspect. Index fund and system trades are left out: the fund cron trips the speed check by design.</li>
    <li>Wealth gain is personal cash plus savings (the leaderboard definition) compared with the previous turn. Flagged when the gain is at least ${money(th.jumpMinGainAnchor)} and ${th.jumpMedianMultiple}x the median player, and worth at least ${th.jumpMinRatio}x what it was. Median player now: ${money(e.medianWorth)} across ${e.players} characters.</li>
    <li>Red means the money ledger does not balance or an account flooded the API in the last ${th.floodWindowHours} h. Amber means something needs a staff look.</li>
  </ul></details>
</section>`;
}

function exploitChart(history) {
  const pts = (k) => history.map((h) => [h.turn, h.x ? h.x[k] : null]);
  return `<div class="rwc-grid2">${lineChart([
    { name: "Likely alt rings", short: "rings", slot: 1, points: pts("ringsConfident") },
    { name: "High-severity flags", short: "high flags", slot: 2, points: pts("flagsHigh") },
    { name: "Wealth jumps", short: "jumps", slot: 3, points: pts("jumps") },
  ], { title: "Exploit signals per turn", sub: "Counts at each turn", yKind: "num", yMin: 0, empty: "Starts with the first tracked turn" })}${lineChart([
    { name: "Open abuse flags", short: "flags", slot: 4, points: pts("flags") },
    { name: "Flagged money moves", short: "money", slot: 5, points: pts("money") },
  ], { title: "Abuse flags and flagged money", sub: "Running totals this world", yKind: "num", yMin: 0, empty: "Starts with the first tracked turn" })}</div>`;
}

// ── over-time charts ─────────────────────────────────────────────────────────

const STATUS = { ok: "#0ca30c", warn: "#fab219", bad: "#d03b3b" };

function sectorCharts(s, history) {
  const counts = history.filter((h) => h.sectors).map((h) => [h.turn, {
    ok: h.sectors.viable,
    warn: h.sectors.thin,
    bad: h.sectors.failing ?? h.sectors.below,
  }]);
  const head = lineChart([
    { name: "Viable", short: "viable", color: STATUS.ok, points: counts.map(([t, c]) => [t, c.ok]) },
    { name: "Watch", short: "watch", color: STATUS.warn, points: counts.map(([t, c]) => [t, c.warn]) },
    { name: "Needs action", short: "action", color: STATUS.bad, points: counts.map(([t, c]) => [t, c.bad]) },
  ], { title: "Sectors by verdict", sub: "Counts by the investment checks used on each turn", yKind: "num", yMin: 0 });
  const world = lineChart([
    { name: "World median return", slot: 1, points: history.map((h) => [h.turn, h.sectors ? h.sectors.worldReturn : null]) },
  ], { title: "World median return on a new plant", sub: "Percent a year, all sectors", yKind: "pct1", yMin: 0, empty: "Starts with the next turn" });
  // Small multiples share one y scale so sectors compare honestly.
  const vals = history.flatMap((h) => Object.values(h.lanes || {}).map((e) => e[3])).filter((v) => v != null && Number.isFinite(v));
  const yMin = Math.min(-2, ...vals);
  const yMax = Math.max(4, ...vals);
  const multiples = s.sectors.lanes.map((l) => lineChart([
    { name: "Points over prime", slot: 1, points: history.map((h) => [h.turn, h.lanes && h.lanes[l.lane] ? h.lanes[l.lane][3] : null]) },
  ], { compact: true, title: l.label, yKind: "pp", yMin, yMax, refs: [{ y: 0 }], empty: "No sites" }).replace('<div class="rwc-title">', `<div class="rwc-title">${dot(l.verdict.level)}`).replace(/(<div class="rwc-title">.*?)<\/div>/, `$1 <span class="rw-muted" style="margin-left:auto;font-weight:600">${fixed(l.returnPct)}%</span></div>`));
  return `<div class="rwc-grid2">${head}${world}</div>
  <h3>Each sector: points a year above the prime rate <span class="rw-muted rw-small">(dashed line = prime; above it the sector pays)</span></h3>
  <div class="rwc-multi">${multiples.join("")}</div>`;
}

function countryChart(s, history) {
  const countries = s.balance.countries.filter((c) => c.sites >= s.thresholds.minSitesForVerdict).map((c) => c.country).sort();
  return lineChart(countries.slice(0, 8).map((c, i) => ({ name: c, short: c, slot: i + 1, points: history.map((h) => [h.turn, h.countries ? h.countries[c] : null]) })),
    { title: "Edge vs the same sector elsewhere", sub: "Points a year of new-plant return; 0 is even", yKind: "pp", refs: [{ y: 0 }], yMin: -2, yMax: 2 });
}

function formsChart(s, history) {
  const forms = s.balance.forms.forms.map((f) => f.form).slice(0, 8);
  if (!forms.length) return "";
  return lineChart(forms.map((f, i) => ({ name: rwModel.legalFormLabel(f), slot: i + 1, points: history.map((h) => [h.turn, h.forms && h.forms[f] ? h.forms[f][0] : null]) })),
    { title: "Share of new companies by legal form", yKind: "pct", yMin: 0, yMax: 1, refs: [{ y: s.thresholds.choiceWarnShare, label: "watch" }] });
}

function politicsCharts(s, history) {
  const fields = lineChart([
    { name: "Contested", short: "contested", slot: 1, points: history.map((h) => [h.turn, h.politics ? h.politics.contested : null]) },
    { name: "One side", short: "one side", slot: 2, points: history.map((h) => [h.turn, h.politics ? (h.politics.uncontested ?? (h.politics.races - h.politics.contested - h.politics.empty)) : null]) },
    { name: "No candidate", short: "empty", slot: 3, points: history.map((h) => [h.turn, h.politics ? h.politics.empty : null]) },
  ], { title: "Race fields", sub: "Races with two or more sides, one side, or nobody", yKind: "num", yMin: 0 });
  const countries = s.politics.dominance.map((d) => d.country).sort();
  const largest = lineChart(countries.map((c, i) => ({ name: c, short: c, slot: i + 1, points: history.map((h) => [h.turn, h.politics && h.politics.largest ? h.politics.largest[c] : null]) })),
    { title: "Largest party's share of the main chamber", sub: "Dashed line: two-thirds supermajority", yKind: "pct", yMin: 0, yMax: 1, refs: [{ y: s.thresholds.supermajorityShare, label: "2/3" }], empty: "Nobody seated yet. Founding results come when the first races close." });
  const closeC = s.politics.competitiveness.map((c) => c.country).sort();
  const close = lineChart(closeC.map((c, i) => ({ name: c, short: c, slot: countries.indexOf(c) + 1 || i + 1, points: history.map((h) => [h.turn, h.politics && h.politics.close ? h.politics.close[c] : null]) })),
    { title: "Share of close races", sub: `Winning margin under ${s.thresholds.closeMarginPp} points`, yKind: "pct", yMin: 0, yMax: 1, refs: [{ y: 0.3, label: "watch below" }], empty: "No votes counted yet" });
  return `<div class="rwc-grid2">${fields}${largest}</div><div class="rwc-grid2" style="margin-top:14px">${close}</div>`;
}

function turnChart(s) {
  const series = s.infra.turnSeries || [];
  const dur = lineChart([{ name: "Turn time", slot: 1, points: series.map((t) => [t.turn, t.ms == null ? null : t.ms / 1000]) }],
    { title: "Turn time", sub: "Seconds per turn", yKind: "sec", yMin: 0, empty: "No turns yet" });
  const mem = lineChart([{ name: "Peak memory", slot: 7, points: series.map((t) => [t.turn, t.rssMb == null ? null : t.rssMb / 1024]) }],
    { title: "Peak memory", sub: "GB per turn", yKind: "dec2", yMin: 0, empty: "No turns yet" });
  return `<div style="display:flex;flex-direction:column;gap:12px">${dur}${mem}</div>`;
}

function releaseChart(s) {
  const ser = (s.infra.builds.series || []);
  const pts = (kind) => ser.filter((r) => r.kind === kind).map((r) => [new Date(r.at).getTime(), r.leadMin]);
  const lead = lineChart([
    { name: "Worker", short: "worker", slot: 1, points: pts("worker") },
    { name: "Web", short: "web", slot: 2, points: pts("web") },
  ], { title: "Commit to live, per release", sub: "Minutes from the main merge to the service serving it", xKind: "time", yKind: "min", yMin: 0 });
  const build = lineChart([
    { name: "Image build", slot: 1, points: ser.filter((r) => r.kind === "worker" && r.buildS != null).map((r) => [new Date(r.at).getTime(), r.buildS / 60]) },
  ], { title: "Image build time, per release", sub: "Minutes to build the release image", xKind: "time", yKind: "min", yMin: 0 });
  return `<div class="rwc-grid2">${lead}${build}</div>`;
}

function makeResetWatchBody({ snapshot, history = [], staleAfterMs = 20 * 60 * 1000 }) {
  if (!snapshot) {
    return { extraCss: CSS + CHART_CSS, body: `<div class="rw"><div class="rw-head"><div><h1>Reset Watch</h1><div class="rw-sub">No snapshot yet. The collector writes one every few minutes.</div></div></div></div>` };
  }
  const s = snapshot;
  const w = s.world;
  const stale = Date.now() - new Date(s.generatedAt).getTime() > staleAfterMs;
  const tracked = history.length;
  const body = `<div class="rw">
  <div class="rw-head">
    <div><h1>Reset Watch</h1>
      <div class="rw-sub">${esc(w.label || `${w.preset || ""} · ${w.iteration && w.iteration.type} ${w.iteration && w.iteration.number}`)}${w.startedAt ? ` · reset ${esc(new Date(w.startedAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))} ET` : ""} · turn ${esc(w.turn)} · ${esc(w.year)}${w.paused ? ' · <b style="color:var(--red,#e5484d)">paused</b>' : ""} · ${tracked} turn${tracked === 1 ? "" : "s"} tracked</div></div>
    <div class="rw-sub">${stale ? '<b style="color:var(--amber,#f5a623)">Snapshot is stale</b> · ' : ""}updated ${esc(ago(s.generatedAt))}${w.nextTurn ? ` · next turn ${esc(new Date(w.nextTurn).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }))} ET` : ""}</div>
  </div>
  ${verdictStrip(s.verdicts || {})}
  ${sectorsSection(s, history)}
  ${balanceSection(s, history)}
  ${politicsSection(s, history)}
  ${infraSection(s)}
  ${exploitsSection(s, history)}
</div>
<script>${CHART_JS}</script>
<script>setTimeout(function(){location.reload()},300000)</script>`;
  return { extraCss: CSS + CHART_CSS, body };
}

module.exports = { makeResetWatchBody };
