// ─── TICKETS: ANALYTICS REPORT ────────────────────────────────────────────
// Pure aggregation (computeTicketReport, unit-testable, no I/O) plus a
// server-rendered SVG report body (makeTicketReportBody) for /tickets/report.
// Charts are inline SVG so the page needs no client JS and no new deps.
//
// Ticket doc shape (Mongo `tickets` collection):
//   { ticketNumber, title, status, category, tags[],
//     createdAt, updatedAt, closedAt, statusHistory: [{ status, at }] }
// A ticket counts as resolved when it has a closedAt/terminal-history
// timestamp or its status is in DONE_STATUSES.

const DONE_STATUSES = new Set(["closed", "resolved", "completed", "wont_fix", "not_implementing"]);

function toDate(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function dayKeyUTC(d) {
  return d.toISOString().slice(0, 10);
}

function startOfDayUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function startOfWeekUTC(d) {
  // Monday-start weeks.
  const shift = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - shift));
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

function shortLabel(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// Resolution timestamp: closedAt wins, else the latest DONE entry in
// statusHistory, else updatedAt when the status itself is terminal.
function terminalAt(t) {
  const c = toDate(t.closedAt);
  if (c) return c;
  const hist = Array.isArray(t.statusHistory) ? t.statusHistory : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    if (DONE_STATUSES.has(hist[i] && hist[i].status)) {
      const d = toDate(hist[i].at);
      if (d) return d;
    }
  }
  if (DONE_STATUSES.has(t.status)) return toDate(t.updatedAt);
  return null;
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function computeTicketReport(tickets, opts = {}) {
  const now = toDate(opts.now) || new Date();
  const today = startOfDayUTC(now);
  const list = Array.isArray(tickets) ? tickets : [];

  const norm = [];
  for (const t of list) {
    const created = toDate(t.createdAt);
    if (!created) continue; // cannot place on a timeline without this
    const doneAt = terminalAt(t);
    norm.push({
      number: t.ticketNumber,
      title: t.title || "(untitled)",
      status: t.status || "open",
      category: t.category || "uncategorized",
      tags: Array.isArray(t.tags) ? t.tags : [],
      created,
      doneAt,
      resolved: !!doneAt,
      hours: doneAt ? (doneAt - created) / 3600000 : null,
    });
  }

  const total = norm.length;
  const outstandingNow = norm.filter((t) => !t.resolved);

  // ── Daily outstanding reconstruction ──
  let first = null;
  for (const t of norm) {
    const d = startOfDayUTC(t.created);
    if (!first || d < first) first = d;
  }
  const openedByDay = new Map();
  const closedByDay = new Map();
  for (const t of norm) {
    const k = dayKeyUTC(startOfDayUTC(t.created));
    openedByDay.set(k, (openedByDay.get(k) || 0) + 1);
    if (t.doneAt) {
      const ck = dayKeyUTC(startOfDayUTC(t.doneAt));
      closedByDay.set(ck, (closedByDay.get(ck) || 0) + 1);
    }
  }
  const daily = [];
  if (first) {
    let out = 0;
    for (let d = first; d <= today; d = addDays(d, 1)) {
      const k = dayKeyUTC(d);
      out += (openedByDay.get(k) || 0) - (closedByDay.get(k) || 0);
      daily.push({ date: k, label: shortLabel(d), opened: openedByDay.get(k) || 0, closed: closedByDay.get(k) || 0, outstanding: out });
    }
  }
  const peakOutstanding = daily.reduce((m, d) => Math.max(m, d.outstanding), 0);

  // ── Weekly opened vs closed ──
  const weeks = new Map();
  function weekBucket(d) {
    const s = startOfWeekUTC(d);
    const k = dayKeyUTC(s);
    if (!weeks.get(k)) weeks.set(k, { week: k, label: shortLabel(s), opened: 0, closed: 0, hours: [] });
    return weeks.get(k);
  }
  if (first) {
    for (let d = startOfWeekUTC(first); d <= today; d = addDays(d, 7)) weekBucket(d);
  }
  for (const t of norm) {
    weekBucket(t.created).opened += 1;
    if (t.doneAt) weekBucket(t.doneAt).closed += 1;
    if (t.resolved && t.hours != null && t.hours >= 0) weekBucket(t.created).hours.push(t.hours);
  }
  const weekly = [...weeks.values()]
    .sort((a, b) => (a.week < b.week ? -1 : 1))
    .map((w) => {
      w.hours.sort((a, b) => a - b);
      return { week: w.week, label: w.label, opened: w.opened, closed: w.closed, medianHours: median(w.hours), n: w.hours.length };
    });

  // ── Resolution timing (valid non-negative durations only) ──
  const hours = norm.filter((t) => t.resolved && t.hours != null && t.hours >= 0).map((t) => t.hours).sort((a, b) => a - b);
  const timing = {
    n: hours.length,
    medianHours: median(hours),
    meanHours: mean(hours),
    p90Hours: hours.length ? hours[Math.min(hours.length - 1, Math.floor(hours.length * 0.9))] : null,
    within24h: hours.length ? hours.filter((h) => h <= 24).length / hours.length : null,
    within7d: hours.length ? hours.filter((h) => h <= 168).length / hours.length : null,
  };

  // ── Category + tag breakdowns ──
  const byCategory = new Map();
  const byTag = new Map();
  for (const t of norm) {
    const c = byCategory.get(t.category) || { category: t.category, total: 0, resolved: 0, hours: [] };
    c.total += 1;
    if (t.resolved) c.resolved += 1;
    if (t.resolved && t.hours != null && t.hours >= 0) c.hours.push(t.hours);
    byCategory.set(t.category, c);
    for (const tag of t.tags) byTag.set(tag, (byTag.get(tag) || 0) + 1);
  }
  const categories = [...byCategory.values()]
    .map((c) => {
      c.hours.sort((a, b) => a - b);
      return { category: c.category, total: c.total, resolved: c.resolved, open: c.total - c.resolved, medianHours: median(c.hours) };
    })
    .sort((a, b) => b.total - a.total);
  const topTags = [...byTag.entries()].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n).slice(0, 15);

  // ── Recent flow ──
  const since = (days) => norm.filter((t) => t.created >= new Date(today.getTime() - days * 86400000)).length;
  const closedSince = (days) => norm.filter((t) => t.doneAt && t.doneAt >= new Date(today.getTime() - days * 86400000)).length;

  // Currently outstanding, oldest first.
  const backlog = outstandingNow
    .map((t) => ({ number: t.number, title: t.title, status: t.status, category: t.category, ageHours: (now - t.created) / 3600000 }))
    .sort((a, b) => b.ageHours - a.ageHours);

  return {
    generatedAt: now.toISOString(),
    total,
    resolvedCount: total - outstandingNow.length,
    outstandingCount: outstandingNow.length,
    peakOutstanding,
    openedLast7d: since(7),
    openedLast30d: since(30),
    closedLast7d: closedSince(7),
    closedLast30d: closedSince(30),
    timing,
    daily,
    weekly,
    categories,
    topTags,
    backlog,
  };
}

// ─── Rendering ──────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDur(hours) {
  if (hours == null) return "—";
  if (hours < 1) return Math.round(hours * 60) + "m";
  if (hours < 48) return (Math.round(hours * 10) / 10) + "h";
  return (Math.round((hours / 24) * 10) / 10) + "d";
}

function fmtPct(x) {
  if (x == null) return "—";
  return Math.round(x * 100) + "%";
}

const REPORT_CSS = `
.tr-wrap{max-width:1020px;margin:0 auto;padding:var(--s-5,24px) var(--s-4,16px);display:flex;flex-direction:column;gap:18px}
.tr-head h1{font-size:1.45rem;font-weight:800;letter-spacing:-.02em;margin:0 0 6px;display:flex;align-items:center;gap:.55rem}
.tr-head p{color:var(--text-3);font-size:.88rem;margin:0;max-width:680px}
.tr-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.tr-card{border:1px solid var(--border);border-radius:12px;background:var(--surface);padding:12px 14px}
.tr-card .v{font-size:1.5rem;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.tr-card .l{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);margin-top:2px}
.tr-card .s{font-size:.75rem;color:var(--text-3);margin-top:2px}
.tr-panel{border:1px solid var(--border);border-radius:14px;background:var(--surface);padding:16px 18px}
.tr-panel h2{font-size:1.02rem;font-weight:700;margin:0 0 4px;display:flex;align-items:center;gap:8px}
.tr-panel .sub{font-size:.8rem;color:var(--text-3);margin:0 0 12px}
.tr-panel svg{width:100%;height:auto;display:block}
.tr-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:.75rem;color:var(--text-3);margin-top:8px}
.tr-legend span{display:inline-flex;align-items:center;gap:5px}
.tr-dot{width:10px;height:10px;border-radius:3px;display:inline-block}
.tr-table{width:100%;border-collapse:collapse;font-size:.85rem}
.tr-table th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);padding:.4rem .6rem;border-bottom:1px solid var(--border)}
.tr-table td{padding:.45rem .6rem;border-bottom:1px solid var(--border);vertical-align:top}
.tr-table tr:last-child td{border-bottom:none}
.tr-table a{color:var(--accent);text-decoration:none}
.tr-table a:hover{text-decoration:underline}
.tr-num{font-family:var(--mono);font-size:.78rem;color:var(--text-3)}
.tr-back{font-size:.85rem;margin-top:4px}
.tr-back a{color:var(--accent);text-decoration:none}
`;

// Line + area chart of one numeric series. points: [{label, value}].
function lineChart(points, { height = 200, formatY = (v) => String(v) } = {}) {
  const W = 760, H = height, PL = 44, PR = 10, PT = 10, PB = 26;
  const iw = W - PL - PR, ih = H - PT - PB;
  const max = Math.max(1, ...points.map((p) => p.value));
  const n = points.length;
  const x = (i) => (n === 1 ? PL + iw / 2 : PL + (i / (n - 1)) * iw);
  const y = (v) => PT + ih - (v / max) * ih;
  let d = "";
  points.forEach((p, i) => { d += (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p.value).toFixed(1); });
  const area = d + `L${x(n - 1).toFixed(1)} ${(PT + ih).toFixed(1)}L${x(0).toFixed(1)} ${(PT + ih).toFixed(1)}Z`;
  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const v = (max * g) / 4, gy = y(v);
    grid += `<line x1="${PL}" y1="${gy.toFixed(1)}" x2="${W - PR}" y2="${gy.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>` +
      `<text x="${PL - 6}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--text-3)">${esc(formatY(Math.round(v)))}</text>`;
  }
  let labels = "";
  const every = Math.max(1, Math.ceil(n / 8));
  points.forEach((p, i) => {
    if (i % every === 0 || i === n - 1) {
      labels += `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--text-3)">${esc(p.label)}</text>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img"><path d="${area}" fill="var(--accent-soft)"/>${grid}<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2"/>${labels}</svg>`;
}

// Grouped bars for [{label, a, b}] with legend names.
function groupBars(rows, { height = 210, aName = "Opened", bName = "Closed" } = {}) {
  const W = 760, H = height, PL = 36, PR = 10, PT = 10, PB = 26;
  const iw = W - PL - PR, ih = H - PT - PB;
  const max = Math.max(1, ...rows.flatMap((r) => [r.a, r.b]));
  const y = (v) => PT + ih - (v / max) * ih;
  const slot = rows.length ? iw / rows.length : iw;
  const bw = Math.max(2, Math.min(22, (slot - 8) / 2));
  let bars = "";
  rows.forEach((r, i) => {
    const cx = PL + slot * i + slot / 2;
    const ah = ((r.a / max) * ih).toFixed(1), bh = ((r.b / max) * ih).toFixed(1);
    bars += `<rect x="${(cx - bw - 1).toFixed(1)}" y="${y(r.a).toFixed(1)}" width="${bw}" height="${ah}" rx="2" fill="var(--accent)"><title>${esc(r.label)}: ${esc(aName)} ${r.a}</title></rect>` +
      `<rect x="${(cx + 1).toFixed(1)}" y="${y(r.b).toFixed(1)}" width="${bw}" height="${bh}" rx="2" fill="#7aa0ff"><title>${esc(r.label)}: ${esc(bName)} ${r.b}</title></rect>`;
  });
  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const v = (max * g) / 4, gy = y(v);
    grid += `<line x1="${PL}" y1="${gy.toFixed(1)}" x2="${W - PR}" y2="${gy.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>` +
      `<text x="${PL - 6}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--text-3)">${Math.round(v)}</text>`;
  }
  let labels = "";
  const every = Math.max(1, Math.ceil(rows.length / 10));
  rows.forEach((r, i) => {
    if (i % every === 0 || i === rows.length - 1) {
      labels += `<text x="${(PL + slot * i + slot / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--text-3)">${esc(r.label)}</text>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${grid}${bars}${labels}</svg>` +
    `<div class="tr-legend"><span><i class="tr-dot" style="background:var(--accent)"></i>${esc(aName)}</span><span><i class="tr-dot" style="background:#7aa0ff"></i>${esc(bName)}</span></div>`;
}

// Horizontal bars for [{label, value, hint}].
function hbars(rows, { height = 24 } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.map((r) => {
    const pct = Math.max(1.5, (r.value / max) * 100);
    return `<div style="display:grid;grid-template-columns:150px 1fr auto;gap:10px;align-items:center;margin:5px 0;font-size:.83rem">` +
      `<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-2)">${esc(r.label)}</span>` +
      `<span style="background:var(--glass-2);border-radius:5px;height:${height - 10}px;display:block"><span style="display:block;height:100%;width:${pct.toFixed(1)}%;background:var(--accent);border-radius:5px;opacity:.85"></span></span>` +
      `<span class="tr-num" style="min-width:64px;text-align:right">${esc(r.hint != null ? r.hint : String(r.value))}</span></div>`;
  }).join("");
}

function statCard(value, label, sub) {
  return `<div class="tr-card"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div>` +
    (sub ? `<div class="s">${esc(sub)}</div>` : "") + `</div>`;
}

function makeTicketReportBody(r, opts = {}) {
  // showBacklog=false renders the public variant: all aggregate stats and
  // charts, but no per-ticket titles (those live behind the admin /tickets
  // pages). Defaults preserve the full admin view.
  const showBacklog = opts.showBacklog !== false;
  const backHref = opts.backHref || "/tickets";
  // Token map (ticketNumber -> opaque /t/ token) so backlog rows link to the
  // one page per ticket instead of the numeric staff alias.
  const tokens = opts.tokens || {};
  if (!r || !r.total) {
    return {
      extraCss: REPORT_CSS,
      body: `<div class="tr-wrap"><div class="tr-head"><h1>Ticket Report</h1><p>No tickets with usable dates found.</p></div></div>`,
    };
  }
  const t = r.timing;
  const cards = [
    statCard(String(r.total), "Total tickets", `${r.openedLast30d} opened · ${r.closedLast30d} closed in last 30d`),
    statCard(String(r.outstandingCount), "Outstanding now", `peak ${r.peakOutstanding} over period`),
    statCard(fmtDur(t.medianHours), "Median time to close", t.n ? `over ${t.n} closed` : "none closed yet"),
    statCard(fmtDur(t.meanHours), "Mean resolution", t.p90Hours != null ? `p90 ${fmtDur(t.p90Hours)}` : ""),
    statCard(fmtPct(t.within24h), "Closed in 24h", fmtPct(t.within7d) + " within 7 days"),
    statCard(String(r.openedLast7d), "Opened last 7d", String(r.closedLast7d) + " closed last 7d"),
  ].join("");

  const flow = r.weekly.map((w) => ({ label: w.label, a: w.opened, b: w.closed }));
  const resolutionWeeks = r.weekly.filter((w) => w.medianHours != null);
  const resolutionBars = hbars(
    resolutionWeeks.map((w) => ({ label: `wk ${w.label}`, value: w.medianHours, hint: `${fmtDur(w.medianHours)} (n=${w.n})` })),
    {}
  );
  const categoryBars = hbars(
    r.categories.map((c) => ({ label: c.category, value: c.total, hint: `${c.total} · ${c.open} open · med ${fmtDur(c.medianHours)}` })),
    {}
  );
  const tagBars = r.topTags.length
    ? hbars(r.topTags.map((x) => ({ label: "#" + x.tag, value: x.n, hint: String(x.n) })), {})
    : `<p class="sub">No tags recorded.</p>`;

  const backlogRows = !showBacklog
    ? `<tr><td colspan="5">Sign in as an admin to see the live per-ticket backlog.</td></tr>`
    : r.backlog.length
      ? r.backlog.map((b) => { const tok = tokens[String(b.number)]; return `<tr><td class="tr-num"><a href="${tok ? `/t/${esc(tok)}` : `/tickets/${esc(b.number)}`}">#${esc(b.number)}</a></td>` +
        `<td>${esc(b.title)}</td><td>${esc(b.category)}</td><td>${esc(String(b.status).replace(/_/g, " "))}</td>` +
        `<td class="tr-num">${esc(fmtDur(b.ageHours))}</td></tr>`; }).join("")
      : `<tr><td colspan="5">Backlog is clear.</td></tr>`;

  const body = `<div class="tr-wrap">
  <div class="tr-head"><h1>Ticket Report</h1><p>Support ticket analytics — backlog, flow, categories and resolution times. Generated ${esc(r.generatedAt)}.</p></div>
  <div class="tr-cards">${cards}</div>
  <div class="tr-panel"><h2>Outstanding tickets over time</h2><p class="sub">Open backlog at end of each day (opened minus closed, cumulative). Peak ${r.peakOutstanding}.</p>${lineChart(r.daily.map((d) => ({ label: d.label, value: d.outstanding })))}</div>
  <div class="tr-panel"><h2>Opened vs closed per week</h2><p class="sub">Monday-start weeks across the whole period.</p>${groupBars(flow)}</div>
  <div class="tr-panel"><h2>Median time to close by week opened</h2><p class="sub">Weeks with no closed tickets are omitted.</p>${resolutionBars || '<p class="sub">No closed tickets yet.</p>'}</div>
  <div class="tr-panel"><h2>Tickets by category</h2><p class="sub">Total, still-open count, and median resolution per category.</p>${categoryBars}</div>
  <div class="tr-panel"><h2>Top tags</h2><p class="sub">Most-used triage tags across all tickets.</p>${tagBars}</div>
  <div class="tr-panel"><h2>Currently outstanding</h2><p class="sub">${r.backlog.length} ticket(s) awaiting resolution, oldest first.</p>
    <table class="tr-table"><thead><tr><th>#</th><th>Title</th><th>Category</th><th>Status</th><th>Age</th></tr></thead><tbody>${backlogRows}</tbody></table></div>
  <div class="tr-back"><a href="${esc(backHref)}">← ${esc(backHref === "/tickets" ? "Back to tickets" : "Back to dashboard")}</a></div>
</div>`;
  return { extraCss: REPORT_CSS, body };
}

module.exports = { DONE_STATUSES, computeTicketReport, makeTicketReportBody, terminalAt };

