// reset-watch-charts.js: server-rendered SVG line charts for Reset Watch.
//
// Over-time line charts are the primary view on the page. Each chart ships:
// 2px lines, end dots with a surface ring, recessive hairline grid, one y
// axis, a legend for two or more series plus direct end labels for up to
// four, a crosshair tooltip listing every series at the hovered turn, and a
// collapsible data table so no value depends on hover or on color alone.
// Categorical colors follow the series identity in a fixed order (validated
// for adjacent-pair colorblind separation in both themes).

"use strict";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const SLOTS = 8;
let seq = 0;

function niceStep(span, target) {
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function fmtValue(v, kind) {
  if (v == null || !Number.isFinite(v)) return "-";
  switch (kind) {
    case "pct": return `${Math.round(v * 100)}%`;
    case "pct1": return `${v.toFixed(1)}%`;
    case "pp": return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
    case "sec": return v >= 120 ? `${(v / 60).toFixed(1)}m` : `${Math.round(v)}s`;
    case "min": return `${Math.round(v)} min`;
    case "dec2": return v.toFixed(2);
    default: return Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : `${Math.round(v * 10) / 10}`;
  }
}

function fmtX(x, kind) {
  if (kind === "time") {
    const d = new Date(x);
    return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  return `T${x}`;
}

// series: [{ name, slot (1-8) | color, points: [[x, y], ...] }]
// opts: { title, sub, yKind, xKind ("turn"|"time"), refs: [{ y, label }], height, yMin, yMax, compact, empty }
function lineChart(series, opts = {}) {
  const id = `rwc${++seq}`;
  const xKind = opts.xKind || "turn";
  const live = series.filter((s) => s.points.some(([, y]) => y != null && Number.isFinite(y)));
  const head = opts.title ? `<div class="rwc-head"><div class="rwc-title">${esc(opts.title)}</div>${opts.sub ? `<div class="rwc-sub">${esc(opts.sub)}</div>` : ""}</div>` : "";
  if (!live.length) {
    return `<figure class="rwc${opts.compact ? " compact" : ""}">${head}<div class="rwc-empty">${esc(opts.empty || "No data yet")}</div></figure>`;
  }
  const xs = [...new Set(live.flatMap((s) => s.points.filter(([, y]) => y != null && Number.isFinite(y)).map(([x]) => x)))].sort((a, b) => a - b);
  const W = opts.compact ? 260 : 640;
  const H = opts.height || (opts.compact ? 92 : 220);
  const padL = opts.compact ? 34 : 46;
  const padR = !opts.compact && live.length <= 4 ? 96 : 12;
  const padT = 10;
  const padB = opts.compact ? 18 : 26;
  const ys = live.flatMap((s) => s.points.map(([, y]) => y)).filter((y) => y != null && Number.isFinite(y));
  for (const r of opts.refs || []) ys.push(r.y);
  let yMin = opts.yMin != null ? Math.min(opts.yMin, ...ys) : Math.min(...ys);
  let yMax = opts.yMax != null ? Math.max(opts.yMax, ...ys) : Math.max(...ys);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const step = niceStep(yMax - yMin, opts.compact ? 2 : 4);
  yMin = Math.floor(yMin / step) * step;
  yMax = Math.ceil(yMax / step) * step;
  const xMin = xs[0];
  const xMax = xs[xs.length - 1];
  const sx = (x) => padL + (xMax === xMin ? (W - padL - padR) / 2 : ((x - xMin) / (xMax - xMin)) * (W - padL - padR));
  const sy = (y) => padT + (1 - (y - yMin) / (yMax - yMin)) * (H - padT - padB);
  const grid = [];
  for (let v = yMin; v <= yMax + step / 2; v += step) {
    const y = sy(v).toFixed(1);
    grid.push(`<line class="rwc-grid" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/><text class="rwc-tick" x="${padL - 6}" y="${y}" dy="0.32em" text-anchor="end">${esc(fmtValue(v, opts.yKind))}</text>`);
  }
  const xticks = [];
  const nx = Math.min(opts.compact ? 2 : 5, xs.length);
  for (let i = 0; i < nx; i++) {
    const x = xs[Math.round((i / Math.max(1, nx - 1)) * (xs.length - 1))];
    xticks.push(`<text class="rwc-tick" x="${sx(x).toFixed(1)}" y="${H - 6}" text-anchor="${nx === 1 ? "middle" : i === 0 ? "start" : i === nx - 1 ? "end" : "middle"}">${esc(fmtX(x, xKind))}</text>`);
  }
  const refs = (opts.refs || []).map((r) => {
    const y = sy(r.y).toFixed(1);
    return `<line class="rwc-ref" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>${r.label && !opts.compact ? `<text class="rwc-reflabel" x="${padL + 4}" y="${y}" dy="-0.4em">${esc(r.label)}</text>` : ""}`;
  });
  const colorOf = (s, i) => s.color || `var(--rwc-${((s.slot || i + 1) - 1) % SLOTS + 1})`;
  const paths = live.map((s, i) => {
    const pts = s.points.filter(([, y]) => y != null && Number.isFinite(y));
    const color = colorOf(s, i);
    // Break the line across gaps (missing turns) rather than bridging them.
    let d = "";
    let prevX = null;
    for (const [x, y] of pts) {
      const gap = prevX != null && xKind === "turn" && x - prevX > 1;
      d += `${d && !gap ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`;
      prevX = x;
    }
    const [lx, ly] = pts[pts.length - 1];
    return { color, d, lx, ly, text: `${fmtValue(ly, opts.yKind)} ${s.short || s.name}` };
  });
  // Direct end labels for up to four series, nudged apart so they never collide.
  const labels = [];
  if (!opts.compact && live.length <= 4) {
    const placed = paths.map((p) => ({ p, y: sy(p.ly) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < placed.length; i++) if (placed[i].y - placed[i - 1].y < 12) placed[i].y = placed[i - 1].y + 12;
    const over = placed.length ? placed[placed.length - 1].y - (H - padB) : 0;
    if (over > 0) for (const q of placed) q.y -= over;
    for (const q of placed) labels.push(`<text class="rwc-end" x="${(sx(q.p.lx) + 8).toFixed(1)}" y="${q.y.toFixed(1)}" dy="0.32em">${esc(q.p.text)}</text>`);
  }
  const marks = paths.map((p) => `<path d="${p.d}" fill="none" stroke="${p.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${sx(p.lx).toFixed(1)}" cy="${sy(p.ly).toFixed(1)}" r="4" fill="${p.color}" class="rwc-dot"/>`).join("") + labels.join("");
  const legend = live.length >= 2
    ? `<div class="rwc-legend">${live.map((s, i) => `<span><i style="background:${colorOf(s, i)}"></i>${esc(s.name)}</span>`).join("")}</div>`
    : "";
  const data = {
    xs,
    xKind,
    yKind: opts.yKind || "num",
    box: [padL, W - padR, padT, H - padB, W, H],
    sx: xs.map((x) => +sx(x).toFixed(1)),
    series: live.map((s, i) => {
      const m = new Map(s.points.map(([x, y]) => [x, y]));
      return { name: s.name, color: colorOf(s, i), ys: xs.map((x) => (m.has(x) ? m.get(x) : null)) };
    }),
  };
  const tableRows = xs.slice(-40).reverse().map((x) => `<tr><td>${esc(fmtX(x, xKind))}</td>${data.series.map((s) => `<td class="n">${esc(fmtValue(s.ys[xs.indexOf(x)], opts.yKind))}</td>`).join("")}</tr>`).join("");
  const table = opts.compact ? "" : `<details class="rwc-table"><summary>Data</summary><div class="rw-tw"><table class="rw-t"><thead><tr><th>${xKind === "time" ? "When" : "Turn"}</th>${data.series.map((s) => `<th class="n">${esc(s.name)}</th>`).join("")}</tr></thead><tbody>${tableRows}</tbody></table></div></details>`;
  return `<figure class="rwc${opts.compact ? " compact" : ""}" id="${id}">${head}${legend}<div class="rwc-plot"><svg viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="${esc(opts.title || "chart")}">${grid.join("")}${refs.join("")}${xticks.join("")}${marks}<line class="rwc-cross" x1="0" x2="0" y1="${padT}" y2="${H - padB}" visibility="hidden"/></svg><div class="rwc-tip" hidden></div></div><script type="application/json" class="rwc-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>${table}</figure>`;
}

const CHART_CSS = `
.rw{--rwc-1:#3987e5;--rwc-2:#d95926;--rwc-3:#199e70;--rwc-4:#c98500;--rwc-5:#d55181;--rwc-6:#008300;--rwc-7:#9085e9;--rwc-8:#e66767}
:root[data-theme="light"] .rw{--rwc-1:#2a78d6;--rwc-2:#eb6834;--rwc-3:#1baf7a;--rwc-4:#eda100;--rwc-5:#e87ba4;--rwc-6:#008300;--rwc-7:#6250d6;--rwc-8:#e34948}
.rwc{margin:0;padding:12px 14px 10px;border:1px solid var(--border);border-radius:12px;background:var(--surface);min-width:0}
.rwc.compact{padding:10px 10px 6px}
.rwc-head{display:flex;flex-direction:column;gap:2px;margin-bottom:6px}
.rwc-title{font-weight:700;font-size:.9rem;color:var(--text)}
.rwc.compact .rwc-title{font-size:.8rem;display:flex;align-items:center;gap:6px}
.rwc-sub{font-size:.78rem;color:var(--text-3)}
.rwc-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:.76rem;color:var(--text-2);margin:0 0 6px}
.rwc-legend span{display:inline-flex;align-items:center;gap:6px}
.rwc-legend i{display:inline-block;width:14px;height:2px;border-radius:1px}
.rwc-plot{position:relative}
.rwc svg{display:block;width:100%;height:auto;overflow:visible;outline:none}
.rwc svg:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.rwc-grid{stroke:var(--border);stroke-width:1;vector-effect:non-scaling-stroke}
.rwc-ref{stroke:var(--text-3);stroke-width:1;stroke-dasharray:4 3;vector-effect:non-scaling-stroke}
.rwc-reflabel{fill:var(--text-3);font-size:10px}
.rwc-tick{fill:var(--text-3);font-size:10px;font-variant-numeric:tabular-nums}
.rwc.compact .rwc-tick{font-size:9px}
.rwc-end{fill:var(--text-2);font-size:10.5px;font-variant-numeric:tabular-nums}
.rwc-dot{stroke:var(--surface);stroke-width:2}
.rwc-cross{stroke:var(--text-3);stroke-width:1;vector-effect:non-scaling-stroke}
.rwc-tip{position:absolute;z-index:5;pointer-events:none;min-width:120px;padding:7px 9px;border-radius:8px;border:1px solid var(--border-2,var(--border));background:var(--surface-2,var(--surface));box-shadow:0 6px 18px rgba(0,0,0,.25);font-size:.76rem;color:var(--text-2)}
.rwc-tip .x{color:var(--text-3);margin-bottom:3px}
.rwc-tip .r{display:flex;align-items:center;gap:7px;white-space:nowrap}
.rwc-tip .r i{display:inline-block;width:12px;height:2px;border-radius:1px}
.rwc-tip .r b{color:var(--text);font-variant-numeric:tabular-nums;min-width:44px}
.rwc-empty{padding:18px 4px;color:var(--text-3);font-size:.84rem}
.rwc-table{margin-top:6px;font-size:.78rem}
.rwc-table summary{cursor:pointer;color:var(--text-3);font-weight:600}
.rwc-table .rw-tw{margin-top:6px;max-height:260px;overflow:auto}
.rwc-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media(max-width:900px){.rwc-grid2{grid-template-columns:1fr}}
.rwc-multi{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
`;

// One shared hover handler for every chart on the page. Untrusted labels go
// in with textContent only.
const CHART_JS = `
(function(){
  function fv(v,k){if(v==null||!isFinite(v))return"-";switch(k){case"pct":return Math.round(v*100)+"%";case"pct1":return v.toFixed(1)+"%";case"pp":return(v>0?"+":"")+v.toFixed(1);case"sec":return v>=120?(v/60).toFixed(1)+"m":Math.round(v)+"s";case"min":return Math.round(v)+" min";case"dec2":return v.toFixed(2);default:return Math.abs(v)>=1000?(Math.round(v/100)/10)+"k":String(Math.round(v*10)/10)}}
  function fx(x,k){if(k==="time"){return new Date(x).toLocaleString("en-US",{timeZone:"America/New_York",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}return"Turn "+x}
  document.querySelectorAll(".rwc").forEach(function(fig){
    var el=fig.querySelector(".rwc-data"),svg=fig.querySelector("svg"),tip=fig.querySelector(".rwc-tip");if(!el||!svg||!tip)return;
    var d;try{d=JSON.parse(el.textContent)}catch(e){return}
    var cross=svg.querySelector(".rwc-cross"),idx=d.xs.length-1;
    function show(i){idx=Math.max(0,Math.min(d.xs.length-1,i));var x=d.sx[idx];cross.setAttribute("x1",x);cross.setAttribute("x2",x);cross.setAttribute("visibility","visible");
      while(tip.firstChild)tip.removeChild(tip.firstChild);var h=document.createElement("div");h.className="x";h.textContent=fx(d.xs[idx],d.xKind);tip.appendChild(h);
      d.series.forEach(function(s){var r=document.createElement("div");r.className="r";var k=document.createElement("i");k.style.background=s.color;var b=document.createElement("b");b.textContent=fv(s.ys[idx],d.yKind);var n=document.createElement("span");n.textContent=s.name;r.appendChild(k);r.appendChild(b);r.appendChild(n);tip.appendChild(r)});
      tip.hidden=false;var rect=svg.getBoundingClientRect(),px=x/d.box[4]*rect.width,w=tip.offsetWidth;tip.style.left=Math.max(0,Math.min(rect.width-w,px+12>rect.width-w?px-w-12:px+12))+"px";tip.style.top="4px"}
    function hide(){cross.setAttribute("visibility","hidden");tip.hidden=true}
    svg.addEventListener("pointermove",function(e){var rect=svg.getBoundingClientRect(),vx=(e.clientX-rect.left)/rect.width*d.box[4],best=0,bd=Infinity;for(var i=0;i<d.sx.length;i++){var dd=Math.abs(d.sx[i]-vx);if(dd<bd){bd=dd;best=i}}show(best)});
    svg.addEventListener("pointerleave",hide);svg.addEventListener("blur",hide);svg.addEventListener("focus",function(){show(idx)});
    svg.addEventListener("keydown",function(e){if(e.key==="ArrowLeft"){show(idx-1);e.preventDefault()}else if(e.key==="ArrowRight"){show(idx+1);e.preventDefault()}else if(e.key==="Escape")hide()});
  });
})();
`;

module.exports = { lineChart, CHART_CSS, CHART_JS, fmtValue };
