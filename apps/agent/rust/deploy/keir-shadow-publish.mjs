#!/usr/bin/env node
// Render the Keir 4.0 shadow report (shadow-rs/latest.json) as an ops report
// and publish it through the report-publish MCP, replacing the same slug each
// pass. Runs as ExecStartPost of keir-shadow-rs.service. No dependencies.
//   keir-shadow-publish.mjs [--in latest.json] [--html out.html] [--dry-run]
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const input = opt("--in", "/var/lib/keir-operator/shadow-rs/latest.json");
const htmlOut = opt("--html", "/var/lib/keir-operator/shadow-rs/latest.html");
const dry = args.includes("--dry-run");
const SLUG = "keir-4-shadow";

const r = JSON.parse(fs.readFileSync(input, "utf8"));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = (ms) => (ms == null ? "n/a" : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`);
const when = new Date(r.at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET";

const agreement = (r.agreement_24h || []).map((a) => `<tr><td>${esc(a.kind)}</td><td>${a.agreed} / ${a.total}</td><td>${a.total ? Math.round((100 * a.agreed) / a.total) : 0}%</td></tr>`).join("") || `<tr><td colspan="3">no comparisons yet</td></tr>`;
const labels = {}; for (const l of r.labels || []) labels[l.label] = (labels[l.label] || 0) + 1;
const labelRows = Object.entries(labels).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}</td></tr>`).join("");
const m = r.metrics || {};
const metricRows = [
  ["Tickets in cohort", m.tickets], ["Closed", m.closed], ["Open (censored)", m.open_censored],
  ["Time to closure median / p90", `${h(m.time_to_closure?.median_ms)} / ${h(m.time_to_closure?.p90_ms)} (n=${m.time_to_closure?.count ?? 0})`],
  ["Decision latency median / p90", `${h(m.decision_latency?.median_ms)} / ${h(m.decision_latency?.p90_ms)} (n=${m.decision_latency?.count ?? 0})`],
  ["Decisions unanswered", m.decisions_unanswered], ["Longest Keir-only run", m.longest_keir_run], ["Oldest open ticket age", h(m.oldest_open_age_ms)],
].map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
const jev = r.jev || {};
const tagBlocks = Object.entries(jev.intake_tags || {}).map(([dim, counts]) => `<div class="k4-card"><h4>${esc(dim)}</h4><table>${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}</td></tr>`).join("")}</table></div>`).join("") || "<p>No intake tags yet.</p>";
const screenRows = Object.entries(jev.post_screens || {}).map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}</td></tr>`).join("") || `<tr><td colspan="2">No post screens yet.</td></tr>`;
const review = (r.review_queue || []).map((x) => `<tr><td>${esc(x.kind)}</td><td>${esc(x.ticket ?? x.job ?? x.decision ?? "")}</td><td><code>${esc(JSON.stringify(x.detail ?? x).slice(0, 200))}</code></td></tr>`).join("") || `<tr><td colspan="3">Nothing needs a human right now.</td></tr>`;
const openTasks = (r.open_tasks || []).map((t) => `<tr><td>${esc(t.id)}</td><td>${esc(t.state)}</td><td>${t.attempts}</td></tr>`).join("") || `<tr><td colspan="3">none</td></tr>`;
const events = (r.events?.kinds || []).slice(0, 12).map((k) => `<tr><td>${esc(k.kind)}</td><td>${k.n}</td></tr>`).join("");

const html = `<style>
.k4{max-width:1100px;margin:0 auto;padding:1rem;font:14px/1.45 system-ui,sans-serif;color:#e6e8ec}
.k4 h1{font-size:1.5rem;margin:.2rem 0}.k4 h2{font-size:1.1rem;margin:1.4rem 0 .5rem;border-bottom:1px solid #2a2f3a;padding-bottom:.25rem}
.k4 .meta{color:#9aa3b2}.k4 table{border-collapse:collapse;width:100%;margin:.4rem 0}.k4 td,.k4 th{border-bottom:1px solid #22262f;padding:.3rem .5rem;text-align:left;vertical-align:top}
.k4 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.75rem}.k4-card{background:#161a22;border:1px solid #262b36;border-radius:8px;padding:.6rem .8rem}.k4-card h4{margin:0 0 .3rem;font-size:.95rem;color:#c7cdd8}
.k4 code{font-size:12px;color:#b9c2d0}.k4 .ok{color:#4ade80}.k4 .warn{color:#fbbf24}
</style>
<div class="k4">
<h1>Keir 4.0 shadow</h1>
<p class="meta">Last pass ${esc(when)} · operator release ${esc(r.release || "unknown")} · ledger ${r.ledger?.jobs ?? 0} jobs, ${r.ledger?.tasks ?? 0} tasks, ${r.ledger?.attempts ?? 0} attempts · support owner ${esc(r.ledger?.support_owner || "n/a")} · event sink ${r.events?.count ?? 0} rows</p>
<p>The Rust harness reads the live Node operator's ledger and event sink every ten minutes and reports where the two agree on card stages and economy promotions, how tickets are labelled, completion and friction metrics, Jev tags, and what needs a human. It writes nothing to Discord, GitHub or the game.</p>
<h2>Human review queue</h2>
<table><tr><th>Kind</th><th>Ticket / job</th><th>Detail</th></tr>${review}</table>
<h2>Agreement, last 24 h</h2>
<table><tr><th>Decision</th><th>Agreed / total</th><th></th></tr>${agreement}</table>
<div class="grid"><div class="k4-card"><h4>Card stages the facts do not support</h4><p class="${(r.card_stage_findings || []).length ? "warn" : "ok"}">${(r.card_stage_findings || []).length}</p></div><div class="k4-card"><h4>Promotions outside the owner-awake window</h4><p class="${(r.promotion_findings || []).length ? "warn" : "ok"}">${(r.promotion_findings || []).length}</p></div></div>
<h2>Completion and friction</h2>
<table>${metricRows}</table>
<p class="meta">Open tickets are censored observations, not zero. A 14-day outcome needs 14 days of observation; labels below are provisional until then.</p>
<h2>Outcome labels</h2>
<table><tr><th>Label</th><th>Tickets</th></tr>${labelRows}</table>
<h2>Jev intake tags</h2>
<div class="grid">${tagBlocks}</div>
<h2>Jev post screens</h2>
<table><tr><th>Label</th><th>Posts</th></tr>${screenRows}</table>
<h2>Open tasks</h2>
<table><tr><th>Task</th><th>State</th><th>Attempts</th></tr>${openTasks}</table>
<h2>Event sink, by kind</h2>
<table>${events}</table>
<p class="meta">Source: /var/lib/keir-operator/shadow-rs/latest.json and harness.db. Runbooks: ops-knowledge keir-40-phase1-runtime-notes, keir-35-post-shape-jev-gates-rust-lanes, lakeside-harness-cli-runbook.</p>
</div>`;

fs.writeFileSync(htmlOut, html);
if (dry) { console.log(`rendered ${html.length} chars to ${htmlOut}`); process.exit(0); }

// Publish through the report-publish MCP registered for this box (write-scoped token).
const cfg = JSON.parse(fs.readFileSync(process.env.KEIR_MCP_CONFIG || "/root/.claude.json", "utf8")).mcpServers["report-publish"];
if (!cfg?.url) { console.error("report-publish MCP not configured"); process.exit(0); }
const agreed = (r.agreement_24h || []).reduce((n, a) => n + (a.agreed || 0), 0);
const compared = (r.agreement_24h || []).reduce((n, a) => n + (a.total || 0), 0);
const takeaway = compared
  ? `The Rust harness agreed with the Node operator on ${agreed} of ${compared} decisions in the last 24 hours (${Math.round((100 * agreed) / compared)}%).`
  : "No shadow comparisons in the last 24 hours, so there is no agreement figure yet.";
const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "publish_report", arguments: {
  slug: SLUG, title: "Keir 4.0 shadow", category: "Keir", icon: "🦀", badge: r.release ? String(r.release).slice(0, 7) : "live", author: "keir-shadow-rs",
  summary: "Live view of the Keir 4.0 Rust harness shadowing the Node operator: agreement, outcome labels, completion and friction metrics, Jev tags and the human review queue. Refreshed every ten minutes.",
  takeaway, library_category: "keir", report_type: "Tracker",
  html } } };
const res = await fetch(cfg.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(cfg.headers || {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
const text = await res.text();
const line = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) || text;
let out; try { out = JSON.parse(line.trim()); } catch { out = { raw: text.slice(0, 300) }; }
const summary = out?.result?.content?.map((c) => c.text).join(" ") || JSON.stringify(out).slice(0, 300);
console.log(`published ${SLUG}: ${res.status} ${summary.slice(0, 200)}`);
