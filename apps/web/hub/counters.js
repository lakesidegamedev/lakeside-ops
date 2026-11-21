"use strict";

// hub/counters.js: the automatic counts page (/kanban/counters). Keir's
// tool-gap and failure counts live here instead of on the work board, one row
// per signature, most frequent and most recent first. This is the list the
// studio reads to decide which tool to build next; a row becomes a board card
// only when someone promotes it (kanban_counter_promote).
// Server-rendered, no client script: every value is escaped here.

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function ago(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const h = Math.max(0, Math.round((now - t) / 3_600_000));
  if (h < 1) return "within the hour";
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const STATUS = {
  counting: ["Counting", "var(--text-2)"],
  "card open": ["Card open", "var(--accent)"],
  addressed: ["Addressed", "var(--green, #3fb950)"],
  "seen again after its card closed": ["Seen again after its card closed", "#f85149"],
};

const CSS = `
.ct{max-width:1400px;margin:0 auto;padding:20px 24px 64px}
.ct .sub{color:var(--text-3);font-size:12.5px;margin-top:4px;max-width:900px}
.ct table{width:100%;border-collapse:collapse;margin-top:16px;font-size:12.5px}
.ct th{text-align:left;font-weight:560;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3);padding:6px 8px;border-bottom:1px solid var(--border)}
.ct td{padding:8px;border-bottom:1px solid var(--border);vertical-align:top}
.ct td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.ct .sig{font-family:var(--mono, monospace);font-size:11px;color:var(--text-3)}
.ct .ex{color:var(--text-3);font-size:11.5px;margin-top:3px}
.ct .fam{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3)}
.ct .tabs{display:flex;gap:6px;margin-top:12px}
.ct .tabs a{height:26px;line-height:26px;padding:0 10px;border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text-2);text-decoration:none;font-size:12px}
.ct .tabs a.on{background:var(--surface-3);color:var(--text)}
`;

function makeCountersBody({ list, error = null, family = "", now = Date.now() }) {
  const rows = list ? list.counters : [];
  const tab = (f, label) => `<a href="/kanban/counters${f ? `?family=${encodeURIComponent(f)}` : ""}" class="${family === f ? "on" : ""}">${esc(label)}</a>`;
  const body = `<div class="ct">
<div class="page-h"><div><h1>Automatic counts</h1>
<div class="sub">Keir's tool gaps (reads it wanted and had no tool for, tool calls that failed) and failure alerts, counted here instead of filed as board cards. Most frequent first. To build something, promote a row to one card with kanban_counter_promote; the row keeps counting and shows that card. <a href="/kanban">Back to the work board</a></div></div></div>
<div class="tabs">${tab("", "All")}${tab("tool gap", "Tool gaps")}${tab("failure alert", "Failure alerts")}</div>
${error ? `<p class="sub">The counter list could not be read: ${esc(error)}</p>` : ""}
${!error && !rows.length ? `<p class="sub">Nothing counted yet.</p>` : ""}
${rows.length ? `<table><thead><tr><th>What</th><th class="n">Last 7 days</th><th class="n">Last 30 days</th><th class="n">Tasks</th><th>Tickets</th><th>Last seen</th><th>Status</th></tr></thead><tbody>
${rows.map((c) => {
    const [label, color] = STATUS[c.status] || [c.status, "var(--text-2)"];
    const card = c.card ? ` <a href="/kanban#item-${Number(c.card.id)}">#${Number(c.card.id)}</a>` : "";
    return `<tr><td><div class="fam">${esc(c.family)}</div><div>${esc(c.title)}</div><div class="sig">${esc(c.signature)}</div>${c.samples && c.samples[0] ? `<div class="ex">${esc(String(c.samples[0]).slice(0, 180))}</div>` : ""}</td>
<td class="n">${Number(c.last_7_days)}</td><td class="n">${Number(c.last_30_days)}</td><td class="n">${c.tasks == null ? "" : Number(c.tasks)}</td>
<td>${esc((c.tickets || []).slice(-6).join(", "))}</td><td>${esc(ago(c.last_seen, now))}</td><td style="color:${color}">${esc(label)}${card}</td></tr>`;
  }).join("\n")}
</tbody></table>` : ""}
</div>`;
  return { extraCss: CSS, body };
}

module.exports = { makeCountersBody };
